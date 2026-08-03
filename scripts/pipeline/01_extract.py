#!/usr/bin/env python3
"""
Stage 1 — pull the raw vector facts out of SEATS_CSKA.pdf and cache them.

What the drawing actually contains (established by inspection, see docs/PIPELINE.md):

  * Every seat is drawn as a small filled red (or white, for the "ЦСКА" letters)
    rounded rect with a black outline, and **both its row number and its seat
    number are printed inside it** as vector glyph outlines.
  * Those glyph outlines are the only reliable, orientation-independent seat
    marker in the file: the straight stands use axis-aligned rects, but the
    curved corner subsectors draw rotated 3-D-ish seat icons that Distiller
    decomposed into thousands of unusable slivers. The numbers survive intact
    everywhere.
  * A glyph contour is a *closed* black stroked subpath. Seat outlines, grid
    lines and everything else are *open* polylines. That single distinction
    separates text from furniture cleanly.

So this stage caches:
  - glyph contours (closed, black, diameter 0.25..1.55pt), split into
    "outer" (a digit body) and "inner" (a counter, e.g. the hole in an 8)
  - the 22 subsector labels, which ARE real text
  - the page geometry

Everything downstream works off the cache, so re-running later stages is fast.

    python scripts/pipeline/01_extract.py
"""
from __future__ import annotations

import math
import pickle
import sys
from pathlib import Path

import numpy as np

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    sys.exit("PyMuPDF missing — run: .venv-pipeline/bin/pip install pymupdf")

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / "SEATS_CSKA.pdf"
BUILD = ROOT / "scripts" / "pipeline" / "build"

# A glyph contour is closed to within this tolerance (pt), after stitching.
CLOSE_TOL = 0.05
# Endpoints this close are the same point, for stitching split subpaths.
JOIN_TOL = 0.03
# Only glyph-scale pieces take part in stitching. Seat outlines and other
# furniture are longer than this, so they can never be welded into a "glyph".
STITCH_MAX_DIAM = 1.65
# Glyph contours (digit bodies *and* counters) live in this diameter band (pt).
# Two text sizes are used in the drawing, ~1.10pt and ~1.38pt tall, so a digit
# body is ~1.05..1.50 and a counter ~0.20..1.05 — the ranges touch, which is why
# body-vs-counter is decided by containment in stage 2, never by size.
# Below 0.15 the file is full of sub-glyph specks that are not text at all.
DIAM_MIN, DIAM_MAX = 0.15, 1.60

BLACK_MAX = 0.01  # a "black" stroke: max channel below this

# Accessible / wheelchair-adjacent seats are drawn in pure red — outline *and*
# numerals — instead of black. Taking only black strokes silently dropped them
# (~29 seats in row 26 across a dozen subsectors, all with legible printed
# numbers). Their glyphs are otherwise identical, so they just need admitting.
RED_MIN, RED_OTHER_MAX = 0.85, 0.2


def is_glyph_stroke(col) -> bool:
    """A stroke colour that seat numbers are drawn in: black, or accessible red."""
    if max(col) <= BLACK_MAX:
        return True
    return col[0] >= RED_MIN and col[1] <= RED_OTHER_MAX and col[2] <= RED_OTHER_MAX

# The drawing marks its own subsector boundaries with yellow lines. They are the
# authoritative partition of the bowl — aisles inside a subsector look identical
# to gaps between subsectors otherwise, so these lines are load-bearing.
YELLOW = (0.992, 0.82, 0.008)
YELLOW_TOL = (0.03, 0.05, 0.05)


def path_points(path: dict) -> list[tuple[float, float]]:
    """Flatten a cdrawings path into its point sequence."""
    pts: list[tuple[float, float]] = []
    for item in path.get("items", ()):
        for p in item[1:]:
            if isinstance(p, (tuple, list)) and len(p) == 2:
                pts.append((float(p[0]), float(p[1])))
    return pts


def polygon_area(a: np.ndarray) -> float:
    x, y = a[:, 0], a[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def diameter(a: np.ndarray) -> float:
    """Rotation-invariant size: max pairwise distance, subsampled for cost."""
    sub = a if len(a) <= 80 else a[:: max(1, len(a) // 80)]
    if len(sub) < 2:
        return 0.0
    d = sub[:, None, :] - sub[None, :, :]
    return float(np.sqrt((d * d).sum(-1)).max())


# Each subsector is captioned twice, stacked: Cyrillic code / "/" / Latin code.
# Sector А is a trap: Cyrillic А (U+0410) and Latin A (U+0041) render identically
# and the CAD tool emitted *Latin* A for both lines, so "А1" never appears as
# Cyrillic in the text layer. Map both scripts onto the canonical Cyrillic letter.
# Note these are distinct codepoints, so there is no real ambiguity:
#   Latin B (U+0042) -> Б,  Cyrillic В (U+0412) -> В.
SECTOR_OF_LETTER = {
    "А": "А", "A": "А",          # U+0410, U+0041
    "Б": "Б", "B": "Б",          # U+0411, U+0042
    "В": "В", "V": "В",          # U+0412, U+0056
    "Г": "Г", "G": "Г",          # U+0413, U+0047
}
EXPECTED_NUMBERS = {
    "А": range(1, 6),
    "Б": range(6, 12),
    "В": range(12, 17),
    "Г": range(17, 23),
}


def extract_labels(page) -> list[dict]:
    """Recover the 22 subsector labels from the (genuine) text layer.

    Both caption lines of a block sit at nearly the same x/y, so they are grouped
    by proximity. The drawing has one defect — the Б10 block is captioned
    "Б11 / B10" — which is resolved by requiring each sector's block numbers to
    be a bijection onto the expected range.
    """
    raw: list[tuple[str, int, float, float]] = []
    for w in page.get_text("words"):
        txt = w[4].strip()
        if len(txt) < 2:
            continue
        sector = SECTOR_OF_LETTER.get(txt[0])
        if sector is None or not txt[1:].isdigit():
            continue
        raw.append((sector, int(txt[1:]), (w[0] + w[2]) / 2, (w[1] + w[3]) / 2))

    labels: list[dict] = []
    for sector, expected in EXPECTED_NUMBERS.items():
        entries = [r for r in raw if r[0] == sector]
        # group the two caption lines of the same block together
        blocks: list[dict] = []
        for _, num, x, y in entries:
            for b in blocks:
                if abs(b["x"] - x) < 40 and abs(b["y"] - y) < 60:
                    b["cands"].append(num)
                    b["xs"].append(x)
                    b["ys"].append(y)
                    break
            else:
                blocks.append({"x": x, "y": y, "cands": [num], "xs": [x], "ys": [y]})

        wanted = list(expected)
        if len(blocks) != len(wanted):
            print(f"  WARNING sector {sector}: {len(blocks)} blocks, expected {len(wanted)}")

        # exact bijection blocks -> numbers, preferring each block's own candidates
        order = sorted(range(len(blocks)), key=lambda i: len(set(blocks[i]["cands"])))
        assign: dict[int, int] = {}

        def solve(k: int) -> bool:
            if k == len(order):
                return True
            bi = order[k]
            cands = [n for n in blocks[bi]["cands"] if n in wanted and n not in assign.values()]
            rest = [n for n in wanted if n not in assign.values() and n not in cands]
            for n in cands + rest:
                assign[bi] = n
                if solve(k + 1):
                    return True
                del assign[bi]
            return False

        if not solve(0):
            print(f"  WARNING sector {sector}: could not resolve block numbering")
            continue

        for bi, num in assign.items():
            b = blocks[bi]
            code = f"{sector}{num}"
            if num not in b["cands"]:
                print(f"  fixed drawing defect: block captioned {sector}{b['cands']} -> {code}")
            labels.append(
                {
                    "code": code,
                    "sector": sector,
                    "number": num,
                    "x": float(np.mean(b["xs"])),
                    "y": float(np.mean(b["ys"])),
                }
            )

    labels.sort(key=lambda lb: (list(EXPECTED_NUMBERS).index(lb["sector"]), lb["number"]))
    return labels


def stitch(pieces: list[np.ndarray]) -> list[np.ndarray]:
    """Weld polyline pieces that share endpoints back into whole contours.

    Distiller sometimes emits one glyph outline as two subpaths — the outline
    plus a stub a fraction of a point long that closes it. Testing closure on
    the raw subpaths therefore throws away real digits (a "6" becomes an
    unusable fragment, and its number silently loses a digit). Welding on
    coincident endpoints restores them without loosening the closure test.
    """
    n = len(pieces)
    ends = np.empty((n * 2, 2), np.float64)
    for i, p in enumerate(pieces):
        ends[2 * i] = p[0]
        ends[2 * i + 1] = p[-1]

    # union pieces whose endpoints coincide
    parent = np.arange(n)

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    from scipy.spatial import cKDTree  # local import: only needed here
    tree = cKDTree(ends)
    for a, b in tree.query_pairs(JOIN_TOL, output_type="ndarray"):
        ra, rb = find(a // 2), find(b // 2)
        if ra != rb:
            parent[ra] = rb

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out: list[np.ndarray] = []
    for members in groups.values():
        if len(members) == 1:
            out.append(pieces[members[0]])
            continue
        # greedily chain the pieces head-to-tail
        remaining = list(members)
        chain = list(pieces[remaining.pop(0)])
        progress = True
        while remaining and progress:
            progress = False
            for k, idx in enumerate(remaining):
                p = pieces[idx]
                if math.dist(chain[-1], p[0]) <= JOIN_TOL:
                    chain.extend(p[1:])
                elif math.dist(chain[-1], p[-1]) <= JOIN_TOL:
                    chain.extend(p[::-1][1:])
                elif math.dist(chain[0], p[-1]) <= JOIN_TOL:
                    chain[:0] = list(p[:-1])
                elif math.dist(chain[0], p[0]) <= JOIN_TOL:
                    chain[:0] = list(p[::-1][:-1])
                else:
                    continue
                remaining.pop(k)
                progress = True
                break
        out.append(np.asarray(chain, dtype=np.float64))
        for idx in remaining:  # anything that would not chain stays separate
            out.append(pieces[idx])
    return out


def main() -> None:
    if not PDF.exists():
        sys.exit(f"missing {PDF}")
    BUILD.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(PDF)
    page = doc[0]
    # cdrawings/text coordinates are in the *unrotated* mediabox space; make the
    # render space agree so QA overlays line up with extracted coordinates.
    page.set_rotation(0)
    W, H = page.rect.width, page.rect.height
    print(f"page: {W:.0f} x {H:.0f} pt (unrotated)")

    print("extracting vector paths ...")
    drawings = page.get_cdrawings()
    print(f"  {len(drawings)} paths")

    # Collect glyph-scale black/red polylines, then weld split subpaths and
    # only afterwards test closure — a closed contour is text, an open one is
    # furniture (seat outlines, grid lines), and that distinction is what makes
    # the whole extraction work.
    pieces: list[np.ndarray] = []
    for path in drawings:
        if path.get("type") != "s":
            continue
        col = path.get("color")
        if not col or len(col) < 3 or not is_glyph_stroke(col):
            continue
        pts = path_points(path)
        if len(pts) < 2:
            continue
        a = np.asarray(pts, dtype=np.float64)
        if diameter(a) > STITCH_MAX_DIAM:
            continue
        pieces.append(a)
    print(f"  glyph-scale black polylines: {len(pieces)}")

    welded = stitch(pieces)
    print(f"  after stitching split subpaths: {len(welded)}")

    contours: list[dict] = []
    for a in welded:
        if len(a) < 6:
            continue
        if math.dist(a[0], a[-1]) >= CLOSE_TOL:
            continue  # still open => furniture, not text
        d = diameter(a)
        if d < DIAM_MIN or d > DIAM_MAX:
            continue
        rec = {
            "pts": a.astype(np.float32),
            "diam": d,
            "area": polygon_area(a),
            "bb": (
                float(a[:, 0].min()),
                float(a[:, 1].min()),
                float(a[:, 0].max()),
                float(a[:, 1].max()),
            ),
            "c": (float(a[:, 0].mean()), float(a[:, 1].mean())),
            "n": len(a),
        }
        contours.append(rec)

    print(f"  closed glyph contours: {len(contours)}")

    labels = extract_labels(page)
    print(f"  subsector labels: {len(labels)} -> {[lb['code'] for lb in labels]}")

    # --- subsector boundary walls (the drawing's yellow lines) ---------------
    walls: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for path in drawings:
        col = path.get("color")
        if not col or len(col) < 3:
            continue
        if any(abs(col[k] - YELLOW[k]) > YELLOW_TOL[k] for k in range(3)):
            continue
        pts = path_points(path)
        for k in range(len(pts) - 1):
            if math.dist(pts[k], pts[k + 1]) > 0.5:
                walls.append((pts[k], pts[k + 1]))
    print(f"  subsector boundary segments: {len(walls)}")

    # --- seat body fills, to tell the light "ЦСКА" seats from the red ones ----
    # A seat body is a filled rect of roughly seat size. In the straight stands
    # it is exactly one rect; the curved corners are decomposed into slivers by
    # the exporter, which is fine — the letters only occur on the straight В
    # stand, and anything unmatched simply stays red.
    fills: list[tuple[float, float, float, float, float]] = []
    for path in drawings:
        f = path.get("fill")
        if not f or len(f) < 3:
            continue
        for item in path.get("items", ()):
            if item[0] != "re":
                continue
            x0, y0, x1, y1 = item[1]
            if (x1 - x0) * (y1 - y0) < 8.0:
                continue
            fills.append((x0, y0, x1, y1, float(sum(f) / 3.0)))
    print(f"  seat-sized fills: {len(fills)}")

    out = {
        "page": {"width": W, "height": H},
        "contours": contours,
        "labels": labels,
        "walls": walls,
        "fills": fills,
    }
    dest = BUILD / "vectors.pkl"
    with dest.open("wb") as fh:
        pickle.dump(out, fh, protocol=4)
    print(f"wrote {dest} ({dest.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
