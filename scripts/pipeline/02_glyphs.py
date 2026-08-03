#!/usr/bin/env python3
"""
Stage 2 — turn 47k loose digit contours into seats, and learn the digit shapes.

Structure of the drawing that this stage exploits (measured, not assumed):

  * digits inside one number sit ~0.9pt apart, centre to centre
  * the two numbers of a seat (row + seat) sit ~1.7pt apart, stacked
  * neighbouring seats are ~5.6pt apart

so a two-level distance clustering recovers numbers, then seats, unambiguously.

Each seat's text has a local frame. In the straight stands it is axis aligned; in
the curved corners it rotates with the arc. The frame is recovered per seat from
its own glyph layout:

    u = the axis between the two stacked numbers, signed to point AWAY from the
        bowl centre (a reference that is smooth everywhere, including corners)
    b = the baseline axis, perpendicular to u

Glyphs are then rasterised in that frame, so the same digit always produces the
same bitmap regardless of where it sits in the bowl, and clustering the bitmaps
yields one template per digit. The templates are written out as a contact sheet
for a human to label once (digits are not text in this PDF, so there is nothing
to read them from).

    python scripts/pipeline/02_glyphs.py
"""
from __future__ import annotations

import pickle
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "scripts" / "pipeline" / "build"

# A digit body is text-sized: ~1.10pt tall (small) or ~1.38pt (large), so its
# rotation-invariant diameter lands in this band. Counters are excluded by
# containment, not by size, so this band only has to reject non-text contours.
BODY_MIN_DIAM, BODY_MAX_DIAM = 1.00, 1.55

# distance thresholds (pt), from the measured layout above
DIGIT_GAP = 1.25   # groups digits of one number
NUMBER_GAP = 2.60  # groups the two numbers of one seat
# Where to cut a seat's glyphs into its two numbers. No absolute threshold works
# — the drawing uses two text sizes, so the number spacing runs from ~1.1 to
# ~1.8pt and overlaps the digit spacing. But the two digits *within* a number sit
# side by side, i.e. at the same position along the stacking axis, so the largest
# gap along that axis is always the split. Accept it when it is clearly the
# dominant gap rather than when it clears a fixed distance.
NUMBER_SPLIT_MIN = 0.75
NUMBER_SPLIT_RATIO = 3.0

# normalised glyph raster
GW, GH = 16, 22
SS = 4  # supersampling for the fill


def load() -> dict:
    src = BUILD / "vectors.pkl"
    if not src.exists():
        sys.exit("run 01_extract.py first")
    with src.open("rb") as fh:
        return pickle.load(fh)


def split_bodies_and_counters(
    contours: list[dict],
) -> tuple[list[dict], list[dict], list[list[int]]]:
    """Split closed contours into digit bodies and their counters.

    Decided purely by containment: a contour whose bounding box sits inside
    another's is a counter (the hole of an 0/4/6/8/9). Size cannot be used —
    a large "0"'s counter is bigger than a small text size's whole digit.
    """
    boxes = np.array([c["bb"] for c in contours])
    areas = np.array([c["area"] for c in contours])
    centres = np.array([c["c"] for c in contours])
    tree = cKDTree(centres)

    parent = np.full(len(contours), -1, np.int32)
    for i in range(len(contours)):
        x0, y0, x1, y1 = boxes[i]
        best, best_area = -1, np.inf
        # a container's centroid is within ~1pt of the counter it holds
        for j in tree.query_ball_point(centres[i], 1.0):
            if j == i or areas[j] <= areas[i]:
                continue
            jx0, jy0, jx1, jy1 = boxes[j]
            if jx0 - 0.04 <= x0 and jy0 - 0.04 <= y0 and jx1 + 0.04 >= x1 and jy1 + 0.04 >= y1:
                if areas[j] < best_area:
                    best, best_area = j, areas[j]
        parent[i] = best

    # A digit body is a top-level contour of text size. Contours that are neither
    # contained nor text-sized are sub-glyph specks elsewhere in the drawing.
    body_idx = [
        i for i in range(len(contours))
        if parent[i] < 0 and BODY_MIN_DIAM <= contours[i]["diam"] <= BODY_MAX_DIAM
    ]
    remap = {orig: k for k, orig in enumerate(body_idx)}
    bodies = [contours[i] for i in body_idx]
    counters: list[dict] = []
    holes: list[list[int]] = [[] for _ in bodies]
    for i in range(len(contours)):
        p = parent[i]
        if p < 0:
            continue
        # a counter's parent is always a body (counters are never nested here)
        while parent[p] >= 0:
            p = parent[p]
        if p not in remap:
            continue  # parent was rejected as non-text
        holes[remap[p]].append(len(counters))
        counters.append(contours[i])
    return bodies, counters, holes


def cluster_chain(points: np.ndarray, eps: float) -> np.ndarray:
    """Single-link connected components under a distance threshold."""
    n = len(points)
    tree = cKDTree(points)
    pairs = tree.query_pairs(eps, output_type="ndarray")
    parent = np.arange(n)

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = np.array([find(i) for i in range(n)])
    _, labels = np.unique(roots, return_inverse=True)
    return labels


def rasterise(pts: np.ndarray, holes: list[np.ndarray], origin: np.ndarray,
              b: np.ndarray, u: np.ndarray, scale: float) -> np.ndarray:
    """Fill the glyph in its local (b, u) frame into a GH x GW byte image."""
    def to_local(p: np.ndarray) -> np.ndarray:
        d = p - origin
        return np.stack([(d @ b) * scale, (d @ u) * scale], axis=-1)

    cx, cy = GW * SS / 2.0, GH * SS / 2.0
    img = np.zeros((GH * SS, GW * SS), np.uint8)

    def poly(p: np.ndarray) -> np.ndarray:
        q = to_local(p)
        # u points "up" in reading order; raster y grows downward
        xy = np.stack([q[:, 0] * SS + cx, -q[:, 1] * SS + cy], axis=-1)
        return np.round(xy).astype(np.int32)

    cv2.fillPoly(img, [poly(pts)], 255)
    for h in holes:
        cv2.fillPoly(img, [poly(h)], 0)
    return cv2.resize(img, (GW, GH), interpolation=cv2.INTER_AREA)


def main() -> None:
    data = load()
    contours = data["contours"]
    print(f"closed contours {len(contours)}")

    outers, inners, holes = split_bodies_and_counters(contours)
    print(f"digit bodies {len(outers)}, counters {len(inners)}")
    nholes = np.array([len(h) for h in holes])
    print("counters per digit:", {int(k): int(v) for k, v in
                                  zip(*np.unique(nholes, return_counts=True))})

    centres = np.array([o["c"] for o in outers])

    # --- glyphs -> numbers -> seats ------------------------------------------
    num_lab = cluster_chain(centres, DIGIT_GAP)
    n_numbers = num_lab.max() + 1
    sizes = np.bincount(num_lab)
    print(f"numbers: {n_numbers}  digits/number: "
          f"{ {int(k): int(v) for k, v in zip(*np.unique(sizes, return_counts=True))} }")

    num_centre = np.zeros((n_numbers, 2))
    np.add.at(num_centre, num_lab, centres)
    num_centre /= sizes[:, None]

    seat_lab = cluster_chain(num_centre, NUMBER_GAP)
    n_seats = seat_lab.max() + 1
    per_seat = np.bincount(seat_lab)
    print(f"seats: {n_seats}  numbers/seat: "
          f"{ {int(k): int(v) for k, v in zip(*np.unique(per_seat, return_counts=True))} }")

    bowl = centres.mean(axis=0)
    print(f"bowl centre: ({bowl[0]:.0f}, {bowl[1]:.0f})")

    glyph_of_number: dict[int, list[int]] = {}
    for gi, nl in enumerate(num_lab):
        glyph_of_number.setdefault(int(nl), []).append(gi)

    def frame_from(c0: np.ndarray, c1: np.ndarray):
        """Local (u, b) from the two number centroids, u pointing off-pitch."""
        axis = c1 - c0
        norm = float(np.hypot(*axis))
        if norm < 1e-6:
            return None
        u = axis / norm
        mid = (c0 + c1) / 2
        if u @ (mid - bowl) < 0:
            u = -u
        # Baseline: perpendicular to u. The handedness matters — pairing u with
        # (u.y, -u.x) is a *reflection*, which renders every glyph mirrored;
        # (-u.y, u.x) is the proper rotation.
        return u, np.array([-u[1], u[0]]), mid

    seats: list[dict] = []
    merged_candidates: list[int] = []
    for s in range(n_seats):
        nums = np.flatnonzero(seat_lab == s)
        if len(nums) == 2:
            fr = frame_from(num_centre[nums[0]], num_centre[nums[1]])
            if fr is None:
                continue
            u, b, mid = fr
            seats.append({
                "glyphs": [glyph_of_number[int(nums[0])], glyph_of_number[int(nums[1])]],
                "centre": mid, "u": u, "b": b,
            })
        elif len(nums) == 1 and len(glyph_of_number[int(nums[0])]) >= 2:
            # A seat whose two numbers fused into one cluster — see below.
            # Two glyphs count: a single-digit row over a single-digit seat
            # ("4" over "1") fuses into something that looks exactly like one
            # ordinary two-digit number, which is why row 4/5's leading seats
            # went missing. The split test below tells the two cases apart.
            merged_candidates.append(int(nums[0]))
    print(f"seats with two numbers: {len(seats)}  "
          f"(fused-number candidates: {len(merged_candidates)})")

    # --- recover the fused ones ----------------------------------------------
    # A glyph's centroid sits where its ink is, so a top-heavy "7" and a
    # bottom-heavy "4"/"5"/"9" pull toward each other. When the row number ends
    # in one and the seat number begins with the other, the two numbers fall
    # inside DIGIT_GAP, merge into a single 3-4 digit cluster, and the seat is
    # lost — concentrated exactly in rows ending 4/5/9 with seats ending 1/2/7.
    #
    # Estimating the split axis from the merged cluster's own 3-4 points is
    # unreliable (it silently mis-orients the glyph frame and poisons the shape
    # templates). Every seat in a row shares an orientation, so borrow `u` from
    # the nearest already-recovered seat and split along that instead.
    if seats and merged_candidates:
        good = np.array([s["centre"] for s in seats])
        tree = cKDTree(good)
        recovered = 0
        for nl in merged_candidates:
            gis = glyph_of_number[nl]
            pts = centres[gis]
            u = seats[int(tree.query(pts.mean(axis=0))[1])]["u"]
            proj = pts @ u
            order = np.argsort(proj)
            gaps = np.diff(proj[order])
            cut = int(np.argmax(gaps)) + 1
            first = [gis[i] for i in order[:cut]]
            second = [gis[i] for i in order[cut:]]
            if not (1 <= len(first) <= 2 and 1 <= len(second) <= 2):
                continue
            # Only split where the two halves are genuinely *stacked*. Digits of
            # one number sit side by side across `u`, so for a real two-digit
            # number the separation along `u` is small and the separation along
            # `b` is large — splitting that would invent a seat.
            b = np.array([-u[1], u[0]])
            d = centres[second].mean(axis=0) - centres[first].mean(axis=0)
            if abs(d @ u) <= abs(d @ b):
                continue
            c0 = centres[first].mean(axis=0)
            c1 = centres[second].mean(axis=0)
            fr = frame_from(c0, c1)
            if fr is None:
                continue
            u2, b2, mid = fr
            # `frame_from` orients u off-pitch; keep the groups in that order.
            lo, hi = (first, second) if (c0 - c1) @ u2 > 0 else (second, first)
            seats.append({"glyphs": [lo, hi], "centre": mid, "u": u2, "b": b2})
            recovered += 1
        print(f"recovered from fused numbers: {recovered}")

    # --- rasterise every glyph in its seat's frame ---------------------------
    records = []
    for si, seat in enumerate(seats):
        gis = [int(gi) for group in seat["glyphs"] for gi in group]
        # text size: glyph extent along u, median over the seat
        exts = []
        for gi in gis:
            p = outers[gi]["pts"].astype(np.float64)
            proj = (p - seat["centre"]) @ seat["u"]
            exts.append(proj.max() - proj.min())
        ref = float(np.median(exts))
        if not (0.6 < ref < 2.2):
            continue
        scale = (GH - 6) / ref  # leave a margin
        for gi in gis:
            o = outers[gi]
            img = rasterise(
                o["pts"].astype(np.float64),
                [inners[h]["pts"].astype(np.float64) for h in holes[gi]],
                np.array(o["c"]), seat["b"], seat["u"], scale,
            )
            records.append({
                "seat": si, "number": 0 if gi in set(int(x) for x in seat["glyphs"][0]) else 1, "glyph": gi,
                "img": img, "nholes": len(holes[gi]),
                "pos": float((np.array(o["c"]) - seat["centre"]) @ seat["b"]),
                "off": float((np.array(o["c"]) - seat["centre"]) @ seat["u"]),
                "ref": ref,
            })
    print(f"rasterised glyphs: {len(records)}")

    # --- cluster bitmaps into digit templates --------------------------------
    X = np.stack([r["img"] for r in records]).reshape(len(records), -1).astype(np.float32) / 255.0
    order = np.argsort([-r["ref"] for r in records])  # start from the crispest
    templates: list[np.ndarray] = []
    tcount: list[int] = []
    tholes: list[int] = []
    assign = np.full(len(records), -1, np.int32)
    THRESH = 0.055  # mean squared difference per pixel
    for idx in order:
        v = X[idx]
        nh = records[idx]["nholes"]
        best, bestd = -1, 1e9
        for t, c in enumerate(templates):
            if tholes[t] != nh:
                continue
            d = float(((v - c) ** 2).mean())
            if d < bestd:
                best, bestd = t, d
        if best >= 0 and bestd < THRESH:
            assign[idx] = best
            n = tcount[best]
            templates[best] = (templates[best] * n + v) / (n + 1)
            tcount[best] = n + 1
        else:
            assign[idx] = len(templates)
            templates.append(v.copy())
            tcount.append(1)
            tholes.append(nh)
    print(f"templates: {len(templates)}")
    big = [(t, c) for t, c in enumerate(tcount) if c >= 200]
    print(f"templates with >=200 members: {len(big)} "
          f"covering {sum(c for _, c in big)}/{len(records)} "
          f"({100*sum(c for _,c in big)/len(records):.1f}%)")

    # --- contact sheet -------------------------------------------------------
    keep = sorted(range(len(templates)), key=lambda t: -tcount[t])[:60]
    cols = 10
    rows = (len(keep) + cols - 1) // cols
    CELL_W, CELL_H = GW * 4, GH * 4 + 14
    sheet = np.full((rows * CELL_H, cols * CELL_W), 255, np.uint8)
    for k, t in enumerate(keep):
        r, c = divmod(k, cols)
        tile = (templates[t].reshape(GH, GW) * 255).astype(np.uint8)
        tile = cv2.resize(255 - tile, (GW * 4, GH * 4), interpolation=cv2.INTER_NEAREST)
        y0, x0 = r * CELL_H, c * CELL_W
        sheet[y0:y0 + GH * 4, x0:x0 + GW * 4] = tile
        cv2.putText(sheet, f"{t}:{tcount[t]}", (x0 + 1, y0 + GH * 4 + 11),
                    cv2.FONT_HERSHEY_PLAIN, 0.7, 0, 1, cv2.LINE_AA)
    sheet_path = BUILD / "glyph_templates.png"
    cv2.imwrite(str(sheet_path), sheet)
    print(f"wrote {sheet_path}  ({rows}x{cols} tiles, label these once)")

    with (BUILD / "glyphs.pkl").open("wb") as fh:
        pickle.dump({
            "records": [{k: v for k, v in r.items() if k != "img"} for r in records],
            "assign": assign,
            "templates": [t.reshape(GH, GW) for t in templates],
            "tcount": tcount,
            "tholes": tholes,
            "seats": seats,
            "bowl": bowl,
            "GW": GW, "GH": GH,
        }, fh, protocol=4)
    print(f"wrote {BUILD/'glyphs.pkl'}")


if __name__ == "__main__":
    main()
