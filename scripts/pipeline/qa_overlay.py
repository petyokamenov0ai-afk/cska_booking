#!/usr/bin/env python3
"""
Draw decoded seats on top of the rendered drawing so the extraction can be
eyeballed against the source. This is the pipeline's ground-truth check.

    python scripts/pipeline/qa_overlay.py <cx> <cy> <half> [dpi] [out.png]

Coordinates are PDF points in the unrotated page space that stage 1 uses.
Green cross + label = a decoded seat; the label is "row/seat".
"""
from __future__ import annotations

import pickle
import sys
from pathlib import Path

import cv2
import fitz
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(__file__).resolve().parent / "build"

cx, cy, half = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 400
out = sys.argv[5] if len(sys.argv) > 5 else str(BUILD / "qa_overlay.png")

with (BUILD / "seats.pkl").open("rb") as fh:
    d = pickle.load(fh)
seats = d["seats"]
sub = d.get("sub_of_seat")

doc = fitz.open(ROOT / "SEATS_CSKA.pdf")
page = doc[0]
page.set_rotation(0)
clip = fitz.Rect(cx - half, cy - half, cx + half, cy + half)
pm = page.get_pixmap(clip=clip, dpi=dpi)
img = np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, pm.n).copy()
if pm.n == 4:
    img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
else:
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

scale = dpi / 72.0
n = 0
for i, s in enumerate(seats):
    if not (clip.x0 <= s["x"] <= clip.x1 and clip.y0 <= s["y"] <= clip.y1):
        continue
    px = int((s["x"] - clip.x0) * scale)
    py = int((s["y"] - clip.y0) * scale)
    cv2.drawMarker(img, (px, py), (0, 160, 0), cv2.MARKER_CROSS, 9, 1)
    txt = f"{s['row']}/{s['seat']}"
    cv2.putText(img, txt, (px + 4, py - 3), cv2.FONT_HERSHEY_PLAIN, 0.75,
                (0, 120, 255), 1, cv2.LINE_AA)
    if sub is not None:
        cv2.putText(img, str(sub[i]), (px + 4, py + 11), cv2.FONT_HERSHEY_PLAIN, 0.6,
                    (200, 0, 0), 1, cv2.LINE_AA)
    n += 1

cv2.imwrite(out, img)
print(f"{out}: {img.shape[1]}x{img.shape[0]}px, {n} decoded seats in view, clip={clip}")
