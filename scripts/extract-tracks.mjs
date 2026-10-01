#!/usr/bin/env node
// Builds the redaction jobs for our two *synthetic* stand-in videos.
//
// WHY THIS EXISTS: for the demo we are not selling "find the private stuff". We have to supply the
// coordinates ourselves. Because the stand-in footage is generated from HTML we can do better than
// eyeballing: every private element is tagged data-pii, and this script seeks the stand-in composition
// frame by frame and measures exactly where each tagged element is. The output is
//
//   src/jobs/<name>.plan.json the redaction plan (video tracks + audio ranges) that <RedactedVideo> renders
//   work/<name>.truth.json    per-frame ground truth, used ONLY by scripts/verify.py as an independent
//                             check that the rendered output really covers every private pixel
//
// The plan is *generated* from standins/<name>.job.json (track styling, time windows, audio ranges), so
// change those there, not in the plan. `--check` regenerates in memory and fails if the plan on disk differs.
//
// For real customer footage a person (or the customer's own tooling) writes the plan instead.
//
// usage: node scripts/extract-tracks.mjs [--check] [talking-head] [screen-recording]   (dev server must be running)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ARGS = process.argv.slice(2);
const CHECK = ARGS.includes("--check");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.EF_BASE ?? "http://127.0.0.1:5173";
const FPS = 30;
const SIMPLIFY_TOLERANCE_PX = 1.5; // max edge error allowed when dropping redundant keyframes
const PADDING = 10; // px of slack added by the runtime around every box

// Keys are written with just enough precision to be repeatable run to run (and to keep the plan small).
const round = (v, decimals) => Math.round(v * 10 ** decimals) / 10 ** decimals;
const roundKey = (k) => ({ t: round(k.t, 4), x: round(k.x, 2), y: round(k.y, 2), w: round(k.w, 2), h: round(k.h, 2), r: round(k.r, 3) });

// ---------- in-page measurement (serialised into the browser) ----------
async function measureAll(page, { duration }) {
  return page.evaluate(
    async ({ duration, fps }) => {
      const tg = document.querySelector("ef-timegroup");
      await tg.updateComplete?.catch?.(() => {});
      const frames = [];
      const total = Math.round(duration * fps);

      const intersect = (a, b) => {
        const l = Math.max(a.left, b.left);
        const t = Math.max(a.top, b.top);
        const r = Math.min(a.right, b.right);
        const bt = Math.min(a.bottom, b.bottom);
        return { left: l, top: t, right: Math.max(l, r), bottom: Math.max(t, bt) };
      };

      const measure = () => {
        const rootRect = tg.getBoundingClientRect();
        const scale = rootRect.width / tg.offsetWidth;
        const out = [];
        for (const el of tg.querySelectorAll("[data-pii]")) {
          const cs = getComputedStyle(el);
          // effective opacity + display/visibility
          let opacity = 1;
          let hidden = cs.visibility === "hidden" || cs.display === "none";
          for (let p = el; p && p !== tg.parentElement; p = p.parentElement) {
            const pcs = getComputedStyle(p);
            opacity *= Number.parseFloat(pcs.opacity);
            if (pcs.display === "none") hidden = true;
          }
          const isSvg = el instanceof SVGGraphicsElement;
          let cx;
          let cy;
          let w;
          let h;
          let r = 0;
          if (isSvg) {
            const bb = el.getBBox();
            const m = el.getScreenCTM();
            if (!m) hidden = true;
            else {
              const pt = new DOMPoint(bb.x + bb.width / 2, bb.y + bb.height / 2).matrixTransform(m);
              cx = (pt.x - rootRect.left) / scale;
              cy = (pt.y - rootRect.top) / scale;
              w = (bb.width * Math.hypot(m.a, m.b)) / scale;
              h = (bb.height * Math.hypot(m.c, m.d)) / scale;
              r = (Math.atan2(m.b, m.a) * 180) / Math.PI;
            }
          } else {
            let rect = el.getBoundingClientRect();
            // clip to every overflow-clipping ancestor (scroll viewports, windows, the frame itself)
            // (ellipses keep their full shape even when part of it falls outside the frame)
            for (let p = el.parentElement; el.dataset.piiShape !== "ellipse" && p && p !== tg.parentElement; p = p.parentElement) {
              const pcs = getComputedStyle(p);
              if (pcs.overflowX !== "visible" || pcs.overflowY !== "visible") rect = intersect(rect, p.getBoundingClientRect());
            }
            cx = ((rect.left + rect.right) / 2 - rootRect.left) / scale;
            cy = ((rect.top + rect.bottom) / 2 - rootRect.top) / scale;
            w = (rect.right - rect.left) / scale;
            h = (rect.bottom - rect.top) / scale;
          }
          // inside the frame at all?
          const onScreen = !hidden && w > 2 && h > 2 && cx + w / 2 > 0 && cx - w / 2 < tg.offsetWidth && cy + h / 2 > 0 && cy - h / 2 < tg.offsetHeight;
          out.push({
            id: el.dataset.pii,
            label: el.dataset.piiLabel,
            shape: el.dataset.piiShape,
            visible: onScreen && opacity > 0.02,
            cx,
            cy,
            w,
            h,
            r,
          });
        }
        return out;
      };

      for (let i = 0; i < total; i++) {
        await tg.seekForRender(i / fps);
        frames.push(measure());
      }
      return frames;
    },
    { duration, fps: FPS },
  );
}

// ---------- track building ----------
const toKey = (t, m) => ({ t, x: m.cx - m.w / 2, y: m.cy - m.h / 2, w: m.w, h: m.h, r: m.r });

function lerpKey(a, b, k) {
  const mix = (p, q) => p + (q - p) * k;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), w: mix(a.w, b.w), h: mix(a.h, b.h), r: mix(a.r, b.r) };
}

// worst-case displacement (px) between two key states: edges, plus rotation expressed as arc length
function keyError(a, b) {
  const edge = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - (b.x + b.w)), Math.abs(a.y + a.h - (b.y + b.h)));
  const arc = (Math.abs(a.r - b.r) * Math.PI) / 180 * (Math.max(a.w, a.h) / 2);
  return edge + arc;
}

// Douglas–Peucker over time: keep only keys needed so linear interpolation stays within tolerance
function simplify(keys, tol) {
  if (keys.length <= 2) return keys;
  const keep = new Array(keys.length).fill(false);
  keep[0] = keep[keys.length - 1] = true;
  const recurse = (lo, hi) => {
    let worst = -1;
    let worstErr = 0;
    for (let i = lo + 1; i < hi; i++) {
      const k = (keys[i].t - keys[lo].t) / (keys[hi].t - keys[lo].t);
      const err = keyError(keys[i], lerpKey(keys[lo], keys[hi], k));
      if (err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    if (worst >= 0 && worstErr > tol) {
      keep[worst] = true;
      recurse(lo, worst);
      recurse(worst, hi);
    }
  };
  recurse(0, keys.length - 1);
  return keys.filter((_, i) => keep[i]);
}

function buildTracks(frames, trackConfig) {
  const byId = new Map();
  frames.forEach((list, i) => {
    const t = i / FPS;
    for (const m of list) {
      const cfg = trackConfig[m.id] ?? {};
      if (cfg.skip) continue;
      const windows = cfg.windows;
      const inWindow = !windows || windows.some(([a, b]) => t >= a && t <= b);
      if (!byId.has(m.id)) byId.set(m.id, { meta: m, frames: [] });
      byId.get(m.id).frames.push({ t, visible: m.visible && inWindow, m });
    }
  });

  const tracks = [];
  for (const [id, { meta, frames: fr }] of byId) {
    const cfg = trackConfig[id] ?? {};
    // contiguous visible runs
    const runs = [];
    let run = null;
    for (const f of fr) {
      if (f.visible) {
        if (!run) runs.push((run = []));
        run.push(toKey(f.t, f.m));
      } else run = null;
    }
    runs.forEach((keys, n) => {
      if (keys.length === 1) keys.push({ ...keys[0], t: keys[0].t + 1 / FPS });
      const simplified = simplify(keys, SIMPLIFY_TOLERANCE_PX);
      const track = { id: runs.length > 1 ? `${id}.${n + 1}` : id };
      const label = cfg.label ?? meta.label;
      if (label) track.label = label;
      track.shape = cfg.shape ?? meta.shape ?? "rect";
      if (cfg.padding !== undefined) track.padding = cfg.padding;
      if (cfg.treatment) track.treatment = cfg.treatment;
      if (cfg.scramble) track.scramble = cfg.scramble;
      track.keys = simplified.map(roundKey);
      tracks.push(track);
    });
  }
  return tracks;
}

// ---------- main ----------
async function run(name) {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "standins", `${name}.job.json`), "utf8"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => console.error("  [page error]", e.message));
  await page.goto(`${BASE}${cfg.standin}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("ef-timegroup")?.seekForRender);
  const duration = await page.evaluate(async () => {
    const tg = document.querySelector("ef-timegroup");
    await tg.waitForContentReady?.();
    return tg.duration ?? tg.durationMs / 1000;
  });
  console.log(`[${name}] measuring ${duration.toFixed(2)}s @ ${FPS}fps …`);
  const t0 = Date.now();
  const frames = await measureAll(page, { duration });
  await browser.close();
  console.log(`[${name}] measured ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const tracks = buildTracks(frames, cfg.tracks ?? {});
  const keyCount = tracks.reduce((n, t) => n + t.keys.length, 0);

  const plan = {
    version: 1,
    source: cfg.source,
    defaults: { padding: PADDING, timeMargin: 0.1, audioMargin: 0.06 },
    video: tracks,
    audio: cfg.audio,
  };
  if (!plan.audio) delete plan.audio;

  const planPath = path.join(ROOT, "src", "jobs", `${name}.plan.json`);
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  if (CHECK) {
    if ((existsSync(planPath) ? readFileSync(planPath, "utf8") : "") === planText) {
      console.log(`[${name}] plan is up to date`);
    } else {
      console.error(`[${name}] DRIFT: src/jobs/${name}.plan.json differs from what standins/${name}.job.json generates. Edit the job file and re-run without --check.`);
      process.exitCode = 1;
    }
    return;
  }

  mkdirSync(path.dirname(planPath), { recursive: true });
  mkdirSync(path.join(ROOT, "work"), { recursive: true });
  writeFileSync(planPath, planText);
  writeFileSync(path.join(ROOT, "work", `${name}.truth.json`), JSON.stringify({ fps: FPS, frames }));
  console.log(`[${name}] ${tracks.length} tracks, ${keyCount} keyframes -> src/jobs/${name}.plan.json`);
  for (const t of tracks) {
    const a = t.keys[0].t.toFixed(2);
    const b = t.keys[t.keys.length - 1].t.toFixed(2);
    console.log(`   ${t.id.padEnd(16)} ${a}s → ${b}s  ${String(t.keys.length).padStart(3)} keys  ${t.shape}`);
  }
}

const names = ARGS.filter((a) => !a.startsWith("--"));
for (const name of names.length ? names : ["talking-head", "screen-recording"]) await run(name);
