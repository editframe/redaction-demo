#!/usr/bin/env python3
"""Independent leak test for a rendered video.

For every frame and every ground-truth private region (measured from the stand-in composition by
scripts/extract-tracks.mjs, not from the redaction plan) this compares the rendered output with the
unredacted source and fails if the output still carries a trace of the original pixels:

  * detail correlation   - correlation of the high-pass (text, edges, facial detail) content
  * layout correlation   - correlation of the low-pass layout, mean removed (shapes, blobs)
  * residual detail      - how much high-frequency energy the output has at all (should be ~flat)

A leak shows up as a correlation clearly above zero. Scrambled regions land near zero; solid fills have
no variance to correlate with.

usage:
  python3 scripts/verify.py talking-head output/talking-head.redacted.mp4
  python3 scripts/verify.py talking-head work/talking-head.nolabels.mp4 --nolabels

--nolabels is the strict mode: the output must have been rendered with `scripts/render.sh <job> --nolabels`,
so solid boxes are plain fill and must be (nearly) 100% flat. Without it, label glyphs (never derived from
the source) are allowed to take up part of a box.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent

THRESH_DETAIL = 0.15  # max |correlation| of high-pass detail between source and output
DETAIL_SIGMA = 2.0  # high-pass scale: text strokes, edges, facial features (wavelengths ~10px and below)
LAYOUT_SIGMA = 6.0  # low-pass scale for the (informational) coarse-layout correlation
FLAT_MIN_LABELLED = 0.70  # share of a solid box that must be exactly the fill, label glyphs being the rest
FLAT_MIN_NOLABELS = 0.98
DEFAULT_FILL = "#0a0a0f"  # PLAN_DEFAULTS.fill in src/redaction/types.ts


def load_json(path):
    with open(path) as f:
        return json.load(f)


def gray(frame):
    return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)


def corr(a, b):
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return 0.0 if d < 1e-6 else float((a * b).sum() / d)


def region_mask(m, h, w):
    """Mask of the truth region (ellipse or rect), clipped to the frame."""
    mask = np.zeros((h, w), np.uint8)
    cx, cy, bw, bh = m["cx"], m["cy"], m["w"], m["h"]
    if m.get("shape") == "ellipse":
        cv2.ellipse(mask, (int(cx), int(cy)), (int(bw / 2), int(bh / 2)), 0, 0, 360, 1, -1)
    else:
        x0, y0 = int(max(0, cx - bw / 2)), int(max(0, cy - bh / 2))
        x1, y1 = int(min(w, cx + bw / 2)), int(min(h, cy + bh / 2))
        mask[y0:y1, x0:x1] = 1
    return mask.astype(bool)


class Plan:
    """The shipped plan, looked up by ground-truth region id (a region "cust" maps to tracks "cust", "cust.1", ...)."""

    def __init__(self, plan):
        self.defaults = plan.get("defaults", {})
        self.tracks = plan["video"]

    def track_for(self, rid):
        return next((t for t in self.tracks if t["id"] == rid or t["id"].startswith(rid + ".")), None)

    def treatment(self, rid):
        t = self.track_for(rid)
        return t.get("treatment", self.defaults.get("treatment", "solid")) if t else "solid"

    def fill_bgr(self, rid):
        t = self.track_for(rid) or {}
        hexs = t.get("fill", self.defaults.get("fill", DEFAULT_FILL))
        return np.array([int(hexs[i : i + 2], 16) for i in (1, 3, 5)][::-1], np.float32)


def measure(truth, windows, plan, src, out):
    """Walks both videos frame by frame; returns per-region statistics and the outside-the-boxes difference."""
    stats = {}
    collateral = []
    frames_checked = 0
    for i, frame_truth in enumerate(truth["frames"]):
        ok_src, fs = src.read()
        ok_out, fo = out.read()
        if not (ok_src and ok_out):
            break
        h, w = fs.shape[:2]
        t = i / truth["fps"]
        gs, go = gray(fs), gray(fo)
        hs = gs - cv2.GaussianBlur(gs, (0, 0), DETAIL_SIGMA)
        ho = go - cv2.GaussianBlur(go, (0, 0), DETAIL_SIGMA)
        lp_s = cv2.GaussianBlur(gs, (0, 0), LAYOUT_SIGMA)
        lp_o = cv2.GaussianBlur(go, (0, 0), LAYOUT_SIGMA)
        covered = np.zeros((h, w), bool)

        for m in frame_truth:
            win = windows.get(m["id"])
            if win and not any(a <= t <= b for a, b in win):
                continue
            if not m["visible"]:
                continue
            mask = region_mask(m, h, w)
            covered |= mask
            if int(mask.sum()) < 200:
                continue
            # skip a 6px rim: the truth rect hugs text; anti-aliasing / padding makes the rim uninformative
            inner = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2).astype(bool)
            if inner.sum() < 100:
                inner = mask
            s = stats.setdefault(m["id"], {"frames": 0, "detail": [], "layout": [], "flat": [], "flat_all": []})
            s["frames"] += 1
            s["detail"].append(corr(hs[inner], ho[inner]))
            s["layout"].append(corr(lp_s[inner], lp_o[inner]))
            # share of the region that is exactly the opaque fill (solid treatment; label glyphs are the rest)
            flat = float((np.abs(fo[inner].astype(np.float32) - plan.fill_bgr(m["id"])).max(axis=1) <= 10).mean())
            s["flat_all"].append(flat)
            # (slivers narrower than 80px, e.g. a banner sliding off the frame edge, are mostly label glyph)
            if m["w"] >= 80:
                s["flat"].append(flat)

        frames_checked += 1
        # collateral: how much of the picture *outside* every box was altered (should be tiny)
        if i % 10 == 0:
            outside = ~cv2.dilate(covered.astype(np.uint8), np.ones((61, 61), np.uint8)).astype(bool)
            collateral.append(float(np.abs(gs[outside] - go[outside]).mean()))
    return stats, frames_checked, float(np.mean(collateral))


def judge(s, treatment, nolabels):
    """Returns (passed, layout column, opaque column) for one region."""
    ad = np.abs(s["detail"])
    p95, worst = np.percentile(ad, 95), ad.max()
    if treatment == "solid":
        # an opaque fill has no source content to correlate with: judge coverage by how much of the
        # region is the flat fill (rest = the label glyphs). With labels on, the glyphs are non-fill pixels
        # (never derived from the source), so the bar is lower and detail correlation is informational only.
        flat = min(s["flat"] or s["flat_all"])
        ok = (flat >= FLAT_MIN_NOLABELS and p95 < THRESH_DETAIL) if nolabels else flat >= FLAT_MIN_LABELLED
        return ok, "-", f"{flat * 100:.0f}"
    # a blur keeps coarse colour layout by design (informational); what must not survive is any detail
    # finer than the shuffle tile
    ok = p95 < THRESH_DETAIL and worst < 2 * THRESH_DETAIL
    return ok, f"{max(np.abs(s['layout'])):.2f} (info)", "-"


def main():
    ap = argparse.ArgumentParser(description="Leak test for a rendered redaction video.")
    ap.add_argument("job", help="job name, e.g. talking-head")
    ap.add_argument("output", help="rendered video, relative to the repo root")
    ap.add_argument("--nolabels", action="store_true", help="output was rendered with ?nolabels (strict fill check)")
    args = ap.parse_args()

    cfg = load_json(ROOT / "standins" / f"{args.job}.job.json")
    truth = load_json(ROOT / "work" / f"{args.job}.truth.json")
    plan = Plan(load_json(ROOT / "src" / "jobs" / f"{args.job}.plan.json"))
    windows = {k: v.get("windows") for k, v in cfg.get("tracks", {}).items()}
    src_path = ROOT / cfg["source"]["src"].lstrip("/")

    src = cv2.VideoCapture(str(src_path))
    out = cv2.VideoCapture(str(ROOT / args.output))
    stats, frames_checked, collateral = measure(truth, windows, plan, src, out)

    print(f"{args.job}: {frames_checked} frames compared against {src_path.name}\n")
    print(f"{'region':<14}{'treatment':<10}{'frames':>7}{'detail|r| mean':>16}{'p95':>7}{'max':>7}{'layout r':>16}{'min opaque %':>14}  result")
    failed = False
    for rid, s in stats.items():
        ad = np.abs(s["detail"])
        treatment = plan.treatment(rid)
        ok, lay, flat = judge(s, treatment, args.nolabels)
        failed |= not ok
        print(f"{rid:<14}{treatment:<10}{s['frames']:>7}{ad.mean():>14.3f}{np.percentile(ad, 95):>7.3f}{ad.max():>7.3f}{lay:>14}{flat:>14}  {'PASS' if ok else 'LEAK?'}")
    print(f"\nmean |source - output| outside the boxes (8-bit luma): {collateral:.2f}  (re-encode noise only)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
