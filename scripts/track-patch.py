#!/usr/bin/env python3
"""Authoring aid: follow the NASA chest patch through the clip.

1. colour template-match the patch (cut from frame 0) in a wide window around where the head predicts it
2. keep only confident matches that agree with their neighbours (a hand or ring in front gives a weak or
   wild match)
3. fill the gaps with the patch's *offset from the head*, interpolated, so during an occlusion it still
   moves with the speaker; smooth.

Writes {fps, frames:[[cx, cy, size], ...]} for standins/talking-head.html.

usage: python3 scripts/track-patch.py <clip.mp4> <face-track.json> <out.json> <cx0> <cy0> <size>
"""
import json, sys
import cv2, numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter

clip, facef, outf = sys.argv[1:4]
cx0, cy0, size = float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
face = json.load(open(facef))
fr = np.array(face["frames"], float)
cap = cv2.VideoCapture(clip)
frames = []
while True:
    ok, f = cap.read()
    if not ok:
        break
    frames.append(f)
n = len(frames)
fc = np.stack([fr[:n, 0] + fr[:n, 2] / 2, fr[:n, 1] + fr[:n, 3] / 2], 1)  # face centres
half = int(size * 0.5)
tpl = frames[0][int(cy0) - half:int(cy0) + half, int(cx0) - half:int(cx0) + half]
off0 = np.array([cx0, cy0]) - fc[0]
R = 110
raw = np.full((n, 2), np.nan)
score = np.zeros(n)
for i, f in enumerate(frames):
    p = fc[i] + off0
    x0, y0 = int(max(0, p[0] - R - half)), int(max(0, p[1] - R - half))
    win = f[y0:y0 + 2 * (R + half), x0:x0 + 2 * (R + half)]
    res = cv2.matchTemplate(win, tpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(res)
    score[i] = mx
    raw[i] = (x0 + loc[0] + half, y0 + loc[1] + half)
offs = raw - fc
good = score > 0.72
# reject matches that disagree with the running median offset of the confident ones
for _ in range(2):
    idx = np.nonzero(good)[0]
    med = np.stack([np.interp(np.arange(n), idx, median_filter(offs[idx, k], size=31, mode="nearest")) for k in (0, 1)], 1)
    good &= np.hypot(*(offs - med).T) < 22
idx = np.nonzero(good)[0]
filled = np.stack([np.interp(np.arange(n), idx, offs[idx, k]) for k in (0, 1)], 1)
filled = gaussian_filter1d(filled, 2.5, axis=0, mode="nearest")
pos = fc + filled
print(f"{n} frames, confident {good.mean() * 100:.0f}% (median score {np.median(score[good]):.2f}); "
      f"x {pos[:, 0].min():.0f}-{pos[:, 0].max():.0f}, y {pos[:, 1].min():.0f}-{pos[:, 1].max():.0f}")
json.dump({"fps": face["fps"], "frames": [[float(a), float(b), size] for a, b in pos]}, open(outf, "w"))
