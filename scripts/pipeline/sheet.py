#!/usr/bin/env python3
"""Render a large, readable contact sheet of glyph templates for labelling."""
from __future__ import annotations

import pickle
import sys
from pathlib import Path

import cv2
import numpy as np

BUILD = Path(__file__).resolve().parent / "build"
MIN_COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 50
COLS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
Z = 7

with (BUILD / "glyphs.pkl").open("rb") as fh:
    g = pickle.load(fh)
templates, tcount, tholes = g["templates"], g["tcount"], g["tholes"]
keep = [t for t in range(len(templates)) if tcount[t] >= MIN_COUNT]
keep.sort(key=lambda t: -tcount[t])
print(f"{len(keep)} templates with >={MIN_COUNT} members "
      f"covering {sum(tcount[t] for t in keep)}/{sum(tcount)}")

GH, GW = templates[0].shape
CW, CH = GW * Z + 10, GH * Z + 26
rows = (len(keep) + COLS - 1) // COLS
sheet = np.full((rows * CH, COLS * CW), 245, np.uint8)
for k, t in enumerate(keep):
    r, c = divmod(k, COLS)
    tile = (templates[t] * 255).astype(np.uint8)
    tile = cv2.resize(255 - tile, (GW * Z, GH * Z), interpolation=cv2.INTER_CUBIC)
    y0, x0 = r * CH + 2, c * CW + 5
    sheet[y0:y0 + GH * Z, x0:x0 + GW * Z] = tile
    cv2.rectangle(sheet, (x0 - 2, y0 - 2), (x0 + GW * Z + 1, y0 + GH * Z + 1), 180, 1)
    cv2.putText(sheet, f"#{t} n={tcount[t]} h={tholes[t]}",
                (x0 - 2, y0 + GH * Z + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.42, 0, 1, cv2.LINE_AA)
out = BUILD / "glyph_templates_big.png"
cv2.imwrite(str(out), sheet)
print("wrote", out, sheet.shape)
