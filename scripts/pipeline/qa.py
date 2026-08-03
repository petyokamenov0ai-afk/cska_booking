#!/usr/bin/env python3
"""
QA tooling for verifying the extraction against the drawing.

    python scripts/pipeline/qa.py gaps [CODE ...]
        Every interior gap in the seat numbering, with the PDF coordinate where
        the missing seat *should* be (interpolated from its row neighbours).

    python scripts/pipeline/qa.py shape CODE
        The subsector's decoded seats and their extent, for cross-checking the
        emitted overview tile.

    python scripts/pipeline/qa.py crop CODE ROW SEAT [--half PT] [--dpi N] [--out FILE]
        Render the drawing around one decoded seat, with the pipeline's own
        row/seat labels drawn on top. This is the ground-truth check: read the
        numbers printed in the seat glyphs and compare them with the labels.

    python scripts/pipeline/qa.py gapcrop CODE ROW SEAT [...]
        Same, but centred on a *missing* seat number's expected position, so you
        can see whether the drawing has a seat there at all.

Coordinates are PDF points in the unrotated page space (what stage 1 uses).
"""
from __future__ import annotations

import argparse
import pickle
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import fitz
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(__file__).resolve().parent / "build"
PDF = ROOT / "SEATS_CSKA.pdf"


def load():
    with (BUILD / "seats.pkl").open("rb") as fh:
        d = pickle.load(fh)
    seats = d["seats"]
    sub = [str(c) for c in d["sub_of_seat"]]
    by: dict[str, dict[int, dict[int, dict]]] = defaultdict(lambda: defaultdict(dict))
    for i, s in enumerate(seats):
        by[sub[i]][s["row"]][s["seat"]] = s
    return by


def gaps_of(rows: dict[int, dict[int, dict]]):
    """(row, missing_seat, expected_x, expected_y) for interior gaps only."""
    out = []
    for row, seats in sorted(rows.items()):
        nums = sorted(seats)
        for a, b in zip(nums, nums[1:]):
            if b - a <= 1:
                continue
            pa, pb = seats[a], seats[b]
            span = b - a
            for k in range(1, span):
                t = k / span
                out.append((
                    row, a + k,
                    pa["x"] + (pb["x"] - pa["x"]) * t,
                    pa["y"] + (pb["y"] - pa["y"]) * t,
                    b - a - 1,
                ))
    return out


def cmd_gaps(args) -> None:
    by = load()
    codes = args.codes or sorted(by)
    grand = 0
    for code in codes:
        rows = by.get(code)
        if rows is None:
            print(f"{code}: unknown subsector")
            continue
        g = gaps_of(rows)
        grand += len(g)
        print(f"\n=== {code}: {sum(len(r) for r in rows.values())} seats, "
              f"{len(rows)} rows, {len(g)} missing seat number(s) ===")
        runs: dict[tuple[int, int], list[int]] = defaultdict(list)
        for row, num, x, y, width in g:
            runs[(row, width)].append(num)
        for (row, width), nums in sorted(runs.items()):
            sample = [e for e in g if e[0] == row and e[1] == nums[0]][0]
            print(f"  row {row:3d}  missing {nums if len(nums) <= 8 else str(nums[:8]) + '…'}"
                  f"  (run of {width})  expected near PDF ({sample[2]:.1f}, {sample[3]:.1f})")
    print(f"\nTOTAL missing seat numbers across {len(codes)} subsector(s): {grand}")


def cmd_shape(args) -> None:
    by = load()
    rows = by.get(args.code)
    if rows is None:
        sys.exit(f"unknown subsector {args.code}")
    pts = np.array([[s["x"], s["y"]] for r in rows.values() for s in r.values()])
    print(f"{args.code}: {len(pts)} seats, rows {min(rows)}..{max(rows)}")
    print(f"  PDF bbox x {pts[:,0].min():.1f}..{pts[:,0].max():.1f}  "
          f"y {pts[:,1].min():.1f}..{pts[:,1].max():.1f}")
    for row in sorted(rows):
        nums = sorted(rows[row])
        first, last = rows[row][nums[0]], rows[row][nums[-1]]
        print(f"  row {row:3d}: seats {nums[0]:3d}..{nums[-1]:3d} ({len(nums):3d} present)  "
              f"ends PDF ({first['x']:7.1f},{first['y']:7.1f}) -> ({last['x']:7.1f},{last['y']:7.1f})")


def render(cx: float, cy: float, half: float, dpi: int, out: str,
           marks: list[tuple[float, float, str, tuple[int, int, int]]]) -> None:
    doc = fitz.open(PDF)
    page = doc[0]
    page.set_rotation(0)
    clip = fitz.Rect(cx - half, cy - half, cx + half, cy + half)
    pm = page.get_pixmap(clip=clip, dpi=dpi)
    img = np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, pm.n).copy()
    img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR if pm.n == 4 else cv2.COLOR_RGB2BGR)
    scale = dpi / 72.0
    for x, y, text, colour in marks:
        px, py = int((x - clip.x0) * scale), int((y - clip.y0) * scale)
        cv2.drawMarker(img, (px, py), colour, cv2.MARKER_CROSS, 11, 2)
        cv2.putText(img, text, (px + 5, py - 4), cv2.FONT_HERSHEY_PLAIN, 0.9, colour, 1, cv2.LINE_AA)
    cv2.imwrite(out, img)
    print(f"wrote {out}  ({img.shape[1]}x{img.shape[0]}px)  clip={clip}  {len(marks)} label(s)")


def cmd_crop(args) -> None:
    by = load()
    rows = by.get(args.code)
    if rows is None:
        sys.exit(f"unknown subsector {args.code}")
    seat = rows.get(args.row, {}).get(args.seat)
    if seat is None:
        sys.exit(f"{args.code} row {args.row} seat {args.seat} was not decoded — "
                 f"use `gapcrop` to inspect a missing number")
    cx, cy = seat["x"], seat["y"]
    marks = []
    for row, seats in rows.items():
        for num, s in seats.items():
            if abs(s["x"] - cx) <= args.half and abs(s["y"] - cy) <= args.half:
                marks.append((s["x"], s["y"], f"{row}/{num}", (0, 140, 255)))
    render(cx, cy, args.half, args.dpi, args.out, marks)


def cmd_gapcrop(args) -> None:
    by = load()
    rows = by.get(args.code)
    if rows is None:
        sys.exit(f"unknown subsector {args.code}")
    hit = [g for g in gaps_of(rows) if g[0] == args.row and g[1] == args.seat]
    if not hit:
        sys.exit(f"{args.code} row {args.row} seat {args.seat} is not a gap")
    _, _, cx, cy, _ = hit[0]
    marks = [(cx, cy, f"MISSING {args.row}/{args.seat}", (0, 0, 255))]
    for row, seats in rows.items():
        for num, s in seats.items():
            if abs(s["x"] - cx) <= args.half and abs(s["y"] - cy) <= args.half:
                marks.append((s["x"], s["y"], f"{row}/{num}", (0, 140, 255)))
    render(cx, cy, args.half, args.dpi, args.out, marks)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)

    g = sp.add_parser("gaps"); g.add_argument("codes", nargs="*"); g.set_defaults(fn=cmd_gaps)
    s = sp.add_parser("shape"); s.add_argument("code"); s.set_defaults(fn=cmd_shape)

    for name, fn in (("crop", cmd_crop), ("gapcrop", cmd_gapcrop)):
        c = sp.add_parser(name)
        c.add_argument("code"); c.add_argument("row", type=int); c.add_argument("seat", type=int)
        c.add_argument("--half", type=float, default=26.0)
        c.add_argument("--dpi", type=int, default=700)
        c.add_argument("--out", default=str(BUILD / f"qa_{name}.png"))
        c.set_defaults(fn=fn)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
