#!/usr/bin/env python3
"""Authoring aid: tracks the largest frontal face in a clip and writes per-frame boxes (source px).

This is how *we* produce coordinates for the demo (we are not selling detection). Output is smoothed so
the redaction box doesn't jitter. usage: track-face.py IN.mp4 OUT.json
"""
import json, sys
import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter

src, out = sys.argv[1:3]
cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
alt = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml")
scale = 0.5
boxes = []
while True:
    ok, frame = cap.read()
    if not ok: break
    g = cv2.cvtColor(cv2.resize(frame, None, fx=scale, fy=scale), cv2.COLOR_BGR2GRAY)
    g = cv2.equalizeHist(g)
    found = cascade.detectMultiScale(g, 1.1, 5, minSize=(80, 80))
    if len(found) == 0:
        found = alt.detectMultiScale(g, 1.08, 3, minSize=(80, 80))
    if len(found):
        x, y, w, h = max(found, key=lambda b: b[2] * b[3])
        boxes.append([x / scale, y / scale, w / scale, h / scale])
    else:
        boxes.append([np.nan] * 4)
a = np.array(boxes, dtype=float)
miss = np.isnan(a[:, 0]).mean()
idx = np.arange(len(a))
for c in range(4):
    good = ~np.isnan(a[:, c])
    a[:, c] = np.interp(idx, idx[good], a[good, c])
    a[:, c] = median_filter(a[:, c], size=9, mode="nearest")
    a[:, c] = gaussian_filter1d(a[:, c], 3)
json.dump({"fps": fps, "width": W, "height": H, "frames": [[round(v, 1) for v in row] for row in a.tolist()]}, open(out, "w"))
print(f"{len(a)} frames, {miss:.1%} missed detections; mean face {a[:,2].mean():.0f}x{a[:,3].mean():.0f}px")
