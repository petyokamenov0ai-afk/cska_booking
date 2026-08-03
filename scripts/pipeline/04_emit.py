#!/usr/bin/env python3
"""
Stage 4 — turn decoded seats into data/stadium.json (see docs/DATA_CONTRACT.md).

The overview outlines written here are a scaffold: stage 5
(scripts/pipeline/05_overview_layout.ts) replaces all 25 of them with the club's
own printed sector map, and emits data/stadium-overview.svg from those. Running
this stage without then running stage 5 leaves the overview map noisy.

Two coordinate spaces are produced:

  * overview space — the whole bowl, landscape, with sector А at the bottom,
    В top, Б right, Г left. This is a proper rotation of the PDF's own space
    (X = ymax - y, Y = x - xmin), never a mirror, so left/right on the map match
    the drawing.
  * subsector-local space — one per subsector, rotated so rows run horizontally
    with row 1 (nearest the pitch) at the top and seat numbers increasing to
    the right, which is how a spectator reads a seat map.

    python scripts/pipeline/04_emit.py
"""
from __future__ import annotations

import json
import pickle
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from scipy.spatial import ConvexHull, cKDTree

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(__file__).resolve().parent / "build"

SECTOR_META = {
    "А": {"latin": "A", "name": "South", "nameBg": "Юг", "order": 1},
    "Б": {"latin": "B", "name": "East", "nameBg": "Изток", "order": 2},
    "В": {"latin": "V", "name": "North", "nameBg": "Север", "order": 3},
    "Г": {"latin": "G", "name": "West", "nameBg": "Запад", "order": 4},
}
LATIN = {"А": "A", "Б": "B", "В": "V", "Г": "G"}

LOCAL_PITCH_X = 22.0   # subsector-local units between adjacent seats
LOCAL_PITCH_Y = 26.0   # ... and between adjacent rows
LOCAL_PAD = 18.0
HULL_PAD = 9.0
# Gaussian kernel (raster cells) used to take the staircase off the bowl outline.
BOWL_BLUR = 21
# Simplification tolerance (overview units) for a free edge that cannot be drawn
# from the global bowl rings (fallback path only — see _outline_from_labels).
OUTER_SIMPLIFY = 14.0
# The free boundary of the bowl (outer wall and pitch-side edge) is drawn as two
# globally smoothed rings, not per tile: per-tile edges end at slightly different
# depths, which is exactly the zig-zag between blocks. The raster contour is
# reduced to control points at this tolerance, interpolated as a closed
# Catmull-Rom spline sampled at this step, polished with a circular Gaussian of
# this sigma (which is what flattens the shallow dents where block depths
# differ), and arcs of it are emitted after a final simplification at this
# (sub-unit) tolerance.
RING_CTRL_EPS = 5.0
RING_STEP = 2.0
RING_GAUSS = 30.0
RING_EMIT_EPS = 0.75
# How far a boundary junction may travel when projected onto its ring.
CURVE_SNAP_MAX = 80.0
# A boundary flatter than this over its whole length is drawn as one straight
# line. Seams between two subsectors are always drawn straight regardless — see
# _outline_from_labels.
STRAIGHT_TOL = 8.0
# How far a junction may be pulled to where its boundaries actually converge.
# Generous enough to close the notches the raster leaves, small enough that a
# genuine corner cannot be dragged onto a neighbour.
SNAP_MAX = 30.0
# Length of boundary used to estimate its direction at a junction.
TANGENT_SPAN = 40.0
# Distance over which a junction's shift decays along a curved edge, so moving
# the end does not kink it.
BLEND_SPAN = 120.0
WHITE_MEAN = 0.80      # fill brightness above which a seat is a "ЦСКА" seat


def round2(v: float) -> float:
    return float(round(v, 2))


def tile_paths(
    ov: np.ndarray,
    codes_of_seat: np.ndarray,
    codes: list[str],
    reach: float = 32.0,
    cell: float = 1.0,
    smooth: int = 26,
    max_hole_units: float = 60_000.0,
) -> dict[str, str]:
    """Outline every subsector as a tile of one continuous bowl.

    Per-subsector convex hulls leave a white wedge at every aisle and vomitory,
    which reads as broken rather than as a stadium. Instead the bowl is rasterised
    once: a cell belongs to the bowl if it is within `reach` of any seat, and to
    the subsector of its nearest seat.

    `reach` closes a gap of up to `2 * reach`, and the widest real gaps are the
    corner transitions А5<->Б6 and А1<->Г22 at ~59 units, so 32 closes the ring.
    The innermost seats clear the pitch by ~75 units, so it cannot bleed onto the
    grass.

    **Smooth the bowl, never the tile.** Running MORPH_CLOSE on each tile's own
    mask lets neighbours grow into each other — it produced ~4,800 sq units of
    overlap and pushed tiles outside the bowl. Every operation here is applied to
    the union, once; the labels are then read back from the same nearest-seat
    field, so no shaping step can make two tiles disagree about their seam.
    _outline_from_labels turns that label field into the actual polygons.
    """
    x0, y0 = ov.min(axis=0) - reach * 2
    x1, y1 = ov.max(axis=0) + reach * 2
    w = int(np.ceil((x1 - x0) / cell))
    h = int(np.ceil((y1 - y0) / cell))

    gx, gy = np.meshgrid(
        x0 + (np.arange(w) + 0.5) * cell,
        y0 + (np.arange(h) + 0.5) * cell,
    )
    grid = np.stack([gx.ravel(), gy.ravel()], axis=1)

    index = {code: i for i, code in enumerate(codes)}
    seat_label = np.array([index[str(c)] for c in codes_of_seat], dtype=np.int32)
    dist, nearest = cKDTree(ov).query(grid, workers=-1)

    # Shape the bowl once, as one region, then read the labels back inside it.
    # Everything here only moves the OUTER edge; internal seams come from the
    # nearest-seat field and so stay shared to the pixel.
    bowl = (dist <= reach).reshape(h, w).astype(np.uint8)
    # 1. close the notches where rows end at different lengths
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (smooth * 2 + 1,) * 2)
    bowl = cv2.morphologyEx(bowl, cv2.MORPH_CLOSE, k)
    # 1b. fill small enclosed holes. Where two blocks meet around a vomitory the
    #     ring closes around a patch no seat is within `reach` of — MORPH_CLOSE
    #     cannot reach into it, and it came out as a white blob sitting inside
    #     the bowl (one at А1<->Г22, one at А5<->Б6). The pitch is an enclosed
    #     hole too and obviously must stay, so only holes below `max_hole` are
    #     filled; the real ones are ~4k cells against the pitch's ~1.7M.
    flood = bowl.copy()
    cv2.floodFill(flood, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
    count, blobs, stats, _ = cv2.connectedComponentsWithStats(
        (flood == 0).astype(np.uint8), 8)
    max_hole = int(max_hole_units / (cell * cell))
    filled = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] <= max_hole]
    if filled:
        areas = [int(stats[i, cv2.CC_STAT_AREA] * cell * cell) for i in filled]
        print(f"  filled {len(filled)} enclosed gap(s) in the bowl: "
              f"{sorted(areas, reverse=True)} sq units")
        bowl[np.isin(blobs, filled)] = 1
    # 2. blur-and-threshold to take the coarse staircase off the outline before
    #    it is traced. Without this the outer edge keeps steps a whole row deep,
    #    which survive simplification and read as a serrated fringe along the
    #    stands even though no tile is misplaced.
    blur = cv2.GaussianBlur(bowl * 255, (BOWL_BLUR | 1, BOWL_BLUR | 1), 0)
    bowl = (blur > 127).astype(np.uint8)
    label = np.where(bowl.ravel().astype(bool), seat_label[nearest], -1).reshape(h, w)

    return _outline_from_labels(label, bowl, index, x0, y0, cell)


def _chain(segments: list[tuple[tuple[int, int], tuple[int, int]]]) -> list[list[tuple[int, int]]]:
    """Join unit boundary segments end to end into polylines (or rings)."""
    adj: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    for p, q in segments:
        adj[p].append(q)
        adj[q].append(p)

    used: set[frozenset] = set()
    polylines: list[list[tuple[int, int]]] = []
    # Start from junctions/ends first so open chains come out whole, then rings.
    starts = [n for n, nb in adj.items() if len(nb) != 2] or list(adj)
    for start in starts:
        for first in adj[start]:
            if frozenset((start, first)) in used:
                continue
            line = [start, first]
            used.add(frozenset((start, first)))
            while True:
                cur, prev = line[-1], line[-2]
                nxt = [n for n in adj[cur]
                       if n != prev and frozenset((cur, n)) not in used]
                # Stop at a junction: three regions meet there, so it is a
                # corner of three tiles at once and has to stay one point.
                if len(adj[cur]) != 2 or not nxt:
                    break
                used.add(frozenset((cur, nxt[0])))
                line.append(nxt[0])
            polylines.append(line)
    return polylines


def _simplify(line: list[tuple[int, int]], eps: float) -> list[tuple[int, int]]:
    """Douglas-Peucker, endpoints preserved."""
    if len(line) < 3 or eps <= 0:
        return line
    arr = np.array(line, np.int32).reshape(-1, 1, 2)
    out = cv2.approxPolyDP(arr, eps, False).reshape(-1, 2)
    return [tuple(int(v) for v in p) for p in out]


def _fit_line(pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Total-least-squares line: (a point on it, its unit normal, worst residual)."""
    centre = pts.mean(axis=0)
    if len(pts) < 2:
        return centre, np.array([0.0, 1.0]), 0.0
    u = np.linalg.svd(pts - centre, full_matrices=False)[2][0]
    normal = np.array([-u[1], u[0]])
    return centre, normal, float(np.abs((pts - centre) @ normal).max())


def _blend(pts: np.ndarray, d0: np.ndarray, d1: np.ndarray, span: float) -> np.ndarray:
    """Shift a polyline's two ends by d0/d1, decaying to nothing in between.

    Used when a junction moves but the edge reaching it is a genuine curve:
    translating only the last vertex would leave a kink there.
    """
    step = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(step)])
    total = float(s[-1])
    if total <= 0:
        return pts + d0
    reach = min(span, total)
    w0 = np.clip(1.0 - s / reach, 0.0, 1.0)[:, None]
    w1 = np.clip(1.0 - (total - s) / reach, 0.0, 1.0)[:, None]
    return pts + w0 * d0 + w1 * d1


def _simplify_float(pts: np.ndarray, eps: float) -> np.ndarray:
    """Douglas-Peucker on a float polyline, endpoints preserved."""
    if len(pts) < 3 or eps <= 0:
        return pts
    arr = pts.astype(np.float32).reshape(-1, 1, 2)
    return cv2.approxPolyDP(arr, eps, False).reshape(-1, 2).astype(float)


def _sample_closed_cr(ctrl: np.ndarray, step: float) -> np.ndarray:
    """Sample a closed Catmull-Rom spline through `ctrl` at ~`step` spacing.

    The spline interpolates every control point, so the sampled ring follows
    the blurred bowl contour faithfully while staying smooth between them.
    """
    n = len(ctrl)
    if n < 3:
        return ctrl.astype(float)
    chunks = []
    for i in range(n):
        p0, p1, p2, p3 = (ctrl[(i - 1) % n].astype(float), ctrl[i].astype(float),
                          ctrl[(i + 1) % n].astype(float), ctrl[(i + 2) % n].astype(float))
        seg = float(np.linalg.norm(p2 - p1))
        k = max(2, int(np.ceil(seg / step)))
        t = np.linspace(0.0, 1.0, k, endpoint=False)[:, None]
        chunks.append(0.5 * ((2 * p1) + (-p0 + p2) * t
                             + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t ** 2
                             + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return np.concatenate(chunks)


def _smooth_ring(pts: np.ndarray, sigma: float, step: float) -> np.ndarray:
    """Circular Gaussian smoothing of a dense closed ring.

    Runs after the spline sampling: the spline still carries shallow dents
    where two blocks' depths differ by a few units, and a wide gentle kernel
    irons those out without touching the corner arcs (shrinkage is
    sigma²/(2·radius), under a unit at the bowl's corner radii).
    """
    radius = max(1, int(3.0 * sigma / step))
    k = np.arange(-radius, radius + 1)
    w = np.exp(-0.5 * (k * step / sigma) ** 2)
    w /= w.sum()
    pad = np.concatenate([pts[-radius:], pts, pts[:radius]])
    out = np.empty_like(pts)
    for axis in (0, 1):
        out[:, axis] = np.convolve(pad[:, axis], w, mode="valid")
    return out


def _bowl_curves(bowl: np.ndarray, cell: float) -> list[np.ndarray]:
    """The bowl's free boundary as dense smooth closed rings, in grid units.

    Contouring per tile is what made neighbouring blocks disagree about the
    shared outer/inner edge (the zig-zag): each tile's raster edge ends at a
    slightly different depth. Instead the two boundaries of the whole bowl —
    the outer wall and the pitch-side edge (the pitch hole's contour) — are
    traced once, smoothed once, and every free edge is then cut from them, so
    adjacent tiles meet on one continuous curve by construction.
    """
    contours, hierarchy = cv2.findContours(
        bowl, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    areas = [abs(cv2.contourArea(c)) for c in contours]
    outer = int(np.argmax(areas))
    order = [outer]
    if hierarchy is not None:
        hier = hierarchy[0]
        child = hier[outer][2]
        best, best_area = -1, 0.0
        while child >= 0:
            if areas[child] > best_area:
                best, best_area = child, areas[child]
            child = hier[child][0]
        if best >= 0:
            order.append(best)
    curves = []
    for ci in order:
        pts = contours[ci].reshape(-1, 2).astype(np.float32)
        ctrl = cv2.approxPolyDP(
            pts.reshape(-1, 1, 2), RING_CTRL_EPS / cell, True).reshape(-1, 2)
        dense = _sample_closed_cr(ctrl, RING_STEP / cell)
        curves.append(_smooth_ring(dense, RING_GAUSS / cell, RING_STEP / cell))
    print(f"  bowl rings: {[len(c) for c in curves]} sampled points")
    return curves


def _project(p: np.ndarray, curve: np.ndarray) -> tuple[float, np.ndarray]:
    """Nearest point on a closed polyline: (fractional vertex index, point)."""
    a = curve
    ab = np.roll(curve, -1, axis=0) - a
    denom = np.einsum("ij,ij->i", ab, ab)
    denom[denom == 0.0] = 1.0
    t = np.clip(np.einsum("ij,ij->i", p - a, ab) / denom, 0.0, 1.0)
    proj = a + ab * t[:, None]
    d2 = np.einsum("ij,ij->i", p - proj, p - proj)
    i = int(np.argmin(d2))
    return i + float(t[i]), proj[i]


def _arc_points(curve: np.ndarray, s0: float, p0: np.ndarray,
                s1: float, p1: np.ndarray) -> np.ndarray | None:
    """The ring's arc between two projected points, taken the short way round.

    A subsector's free edge spans a block's width — always the short arc of the
    ring between its two seam junctions. The exact projected positions become
    the arc's endpoints, so the seam chords meet the ring precisely.
    """
    n = len(curve)
    i0, i1 = int(np.floor(s0)) % n, int(np.floor(s1)) % n
    fwd = (i1 - i0) % n
    bwd = (i0 - i1) % n
    if fwd == 0 and bwd == 0:
        return None
    if fwd <= bwd:
        idx = [(i0 + k) % n for k in range(fwd + 1)]
    else:
        idx = [(i0 - k) % n for k in range(bwd + 1)]
    pts = curve[idx].copy()
    pts[0] = p0
    pts[-1] = p1
    return pts


def _outline_from_labels(label, bowl: np.ndarray, index: dict[str, int],
                         x0: float, y0: float, cell: float) -> dict[str, str]:
    """Build every tile's outline from ONE shared planar graph of boundaries.

    Contouring each tile separately and simplifying it is what produced the
    zig-zag: a seam belongs to two tiles, each traces its own side of it, and
    two independent simplifications of the same edge disagree — alternately
    leaving a white wedge and overlapping.

    So the boundary is extracted once, as segments on the grid *between* cells,
    keyed by the pair of regions they separate, chained into edges that meet at
    junctions. Both owners of an edge get the identical polyline, which is what
    makes the rest of this safe to do:

    * **A seam is drawn as one straight line.** The nearest-seat field is honest
      but ugly: where a corner block curves up behind a stand block, the true
      seam is an L that bites a rectangular notch out of the neighbour. Replacing
      it with the chord between its two junctions turns that into one diagonal.
      The tile then disagrees with the seat positions by a few units, which
      costs nothing — the overview draws tiles, never individual seats.
    * **A free edge is drawn as an arc of the global bowl ring.** Tracing each
      tile's own raster edge is what produced the zig-zag: adjacent blocks end
      at slightly different depths, so the outer wall and the pitch-side edge
      stepped up and down from block to block. Instead both free boundaries of
      the whole bowl are traced and smoothed once (`_bowl_curves`), every
      boundary junction is projected onto its ring, and each tile's free edge
      is the ring's arc between its two seam junctions — one continuous curve
      no matter how many blocks it crosses.
    * **Interior junctions are pulled onto where their boundaries converge.** A
      junction that never touches the free edge (three corner blocks meeting,
      say) sits wherever the raster happened to put it. Each arm contributes
      its tangent and the junction moves to their least-squares meeting point.
      Because the junction is one shared node, every tile that owns it moves
      with it.
    """
    L = np.full((label.shape[0] + 2, label.shape[1] + 2), -1, np.int32)
    L[1:-1, 1:-1] = label

    pair_segments: dict[tuple[int, int], list] = defaultdict(list)
    ys, xs = np.nonzero(L[:, :-1] != L[:, 1:])          # vertical cell edges
    for y, x in zip(ys.tolist(), xs.tolist()):
        a, b = int(L[y, x]), int(L[y, x + 1])
        pair_segments[(min(a, b), max(a, b))].append(((x + 1, y), (x + 1, y + 1)))
    ys, xs = np.nonzero(L[:-1, :] != L[1:, :])          # horizontal cell edges
    for y, x in zip(ys.tolist(), xs.tolist()):
        a, b = int(L[y, x]), int(L[y + 1, x])
        pair_segments[(min(a, b), max(a, b))].append(((x, y + 1), (x + 1, y + 1)))

    # ---- boundaries as a planar graph: shared nodes, shared edges -----------
    node_of: dict[tuple[int, int], int] = {}
    node_pos: list[np.ndarray] = []

    def node(p: tuple[int, int]) -> int:
        if p not in node_of:
            node_of[p] = len(node_pos)
            node_pos.append(np.array(p, float))
        return node_of[p]

    edges: list[dict] = []
    owned: dict[int, list[int]] = defaultdict(list)
    for (a, b), segments in pair_segments.items():
        for line in _chain(segments):
            if len(line) < 2:
                continue
            ei = len(edges)
            edges.append({"pts": np.array(line, float),
                          "n0": node(line[0]), "n1": node(line[-1]),
                          "seam": a >= 0})     # a < 0 means paired with the page
            for region in (a, b):
                if region >= 0:
                    owned[region].append(ei)

    # ---- the free boundary of the whole bowl as smooth rings -----------------
    curves = _bowl_curves(bowl, cell)

    # ---- move each junction to where its arms actually converge -------------
    incident: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for ei, e in enumerate(edges):
        if e["n0"] != e["n1"]:
            incident[e["n0"]].append((ei, 0))
            incident[e["n1"]].append((ei, 1))

    # A junction that ends a free edge belongs to one of the bowl rings: pull it
    # onto the ring itself. The raster put it a few units off the curve the edge
    # is really following, which showed up as a dent shared by the tiles meeting
    # there — and, block depths differing, as the zig-zag along the stands.
    proj_of: dict[int, tuple[int, float, np.ndarray]] = {}
    for n, arms in incident.items():
        if not any(not edges[ei]["seam"] for ei, _ in arms):
            continue
        p = node_pos[n]
        best = None
        for ci, curve in enumerate(curves):
            s, q = _project(p, curve)
            d = float(np.linalg.norm(q - p))
            if best is None or d < best[0]:
                best = (d, ci, s, q)
        if best is not None and best[0] <= CURVE_SNAP_MAX / cell:
            _, ci, s, q = best
            node_pos[n] = q
            proj_of[n] = (ci, s, q)

    # Interior junctions (seams only, e.g. three corner blocks meeting): move
    # each to the least-squares meeting point of its arms' tangents.
    span = max(2, int(TANGENT_SPAN / cell))
    snapped = 0
    for n, arms in incident.items():
        if n in proj_of or len(arms) < 2:
            continue
        rows, rhs = [], []
        for ei, end in arms:
            pts = edges[ei]["pts"]
            centre, normal, _ = _fit_line(pts[:span] if end == 0 else pts[-span:])
            rows.append(normal)
            rhs.append(float(normal @ centre))
        A = np.array(rows)
        M = A.T @ A
        # Arms that all run the same way leave the meeting point undetermined
        # along the boundary — sliding it there would do damage, not good.
        if not np.isfinite(np.linalg.cond(M)) or np.linalg.cond(M) > 40.0:
            continue
        p = np.linalg.solve(M, A.T @ np.array(rhs))
        if np.linalg.norm(p - node_pos[n]) <= SNAP_MAX / cell:
            node_pos[n] = p
            snapped += 1

    # ---- final geometry per boundary ---------------------------------------
    lines_drawn = 0
    arcs_drawn = 0
    for e in edges:
        p0, p1 = node_pos[e["n0"]], node_pos[e["n1"]]
        _, _, residual = _fit_line(e["pts"])
        if e["n0"] != e["n1"] and e["seam"]:
            e["poly"] = np.array([p0, p1])
            lines_drawn += 1
            continue
        a, b = proj_of.get(e["n0"]), proj_of.get(e["n1"])
        if a is not None and b is not None and a[0] == b[0]:
            arc = _arc_points(curves[a[0]], a[1], a[2], b[1], b[2])
            if arc is not None and len(arc) >= 3:
                e["poly"] = _simplify_float(arc, RING_EMIT_EPS / cell)
                arcs_drawn += 1
                continue
        # Fallback for a free edge the rings cannot describe (should not happen
        # in practice): its own simplified raster boundary, blended onto its
        # junctions so the ends still meet the neighbours exactly.
        if e["n0"] != e["n1"] and residual <= STRAIGHT_TOL / cell:
            e["poly"] = np.array([p0, p1])
            lines_drawn += 1
        else:
            simple = np.array(_simplify([(int(q[0]), int(q[1])) for q in e["pts"]],
                                        OUTER_SIMPLIFY / cell), float)
            e["poly"] = _blend(simple, p0 - simple[0], p1 - simple[-1],
                               BLEND_SPAN / cell)

    def ring(eis: list[int]) -> np.ndarray | None:
        """Walk a tile's edges head to tail, by node, into one closed loop."""
        head, tail = edges[eis[0]]["n0"], edges[eis[0]]["n1"]
        loop = list(edges[eis[0]]["poly"])
        used = {eis[0]}
        while len(used) < len(eis):
            for ei in eis:
                if ei in used:
                    continue
                e = edges[ei]
                if e["n0"] == tail:
                    loop.extend(e["poly"][1:])
                    tail = e["n1"]
                elif e["n1"] == tail:
                    loop.extend(e["poly"][::-1][1:])
                    tail = e["n0"]
                else:
                    continue
                used.add(ei)
                break
            else:
                return None            # disjoint pieces: not a single ring
        return np.array(loop) if tail == head else None

    out: dict[str, str] = {}
    for code, i in index.items():
        eis = owned.get(i)
        if not eis:
            continue
        loop = ring(eis)
        if loop is None or len(loop) < 4:
            # Fall back to the largest piece rather than emitting nothing.
            loop = max((edges[ei]["poly"] for ei in eis), key=len)
            if len(loop) < 4:
                continue
        keep = [loop[0]]
        for q in loop[1:]:
            if np.linalg.norm(q - keep[-1]) > 1e-6:
                keep.append(q)
        if len(keep) > 2 and np.linalg.norm(keep[0] - keep[-1]) <= 1e-6:
            keep.pop()
        pts = [(x0 + q[0] * cell, y0 + q[1] * cell) for q in keep]
        out[code] = "M " + " L ".join(f"{px:.1f} {py:.1f}" for px, py in pts) + " Z"
    print(f"  boundaries: {len(edges)} ({lines_drawn} seams straight, "
          f"{arcs_drawn} free edges as ring arcs), junctions: "
          f"{len(proj_of)} on rings, {snapped} interior snapped")
    return out


def hull_path(pts: np.ndarray, pad: float) -> str:
    """Padded convex hull of a point set as an SVG path."""
    if len(pts) < 3:
        x0, y0 = pts.min(axis=0) - pad
        x1, y1 = pts.max(axis=0) + pad
        return f"M {x0:.1f} {y0:.1f} L {x1:.1f} {y0:.1f} L {x1:.1f} {y1:.1f} L {x0:.1f} {y1:.1f} Z"
    h = pts[ConvexHull(pts).vertices]
    c = h.mean(axis=0)
    out = []
    for p in h:
        v = p - c
        norm = float(np.hypot(*v)) or 1.0
        q = p + v / norm * pad
        out.append(f"{q[0]:.1f} {q[1]:.1f}")
    return "M " + " L ".join(out) + " Z"


def main() -> None:
    with (BUILD / "seats.pkl").open("rb") as fh:
        dec = pickle.load(fh)
    with (BUILD / "vectors.pkl").open("rb") as fh:
        vec = pickle.load(fh)
    seats = dec["seats"]
    sub_of = dec["sub_of_seat"]
    P = np.array([[s["x"], s["y"]] for s in seats])
    print(f"seats: {len(seats)}")

    # ---- "ЦСКА" light seats: look up the fill each seat sits in --------------
    # The letter seats are drawn *unfilled* (they read as white against the page)
    # rather than with a light fill, so "no red body" is what marks them — and it
    # lands exactly on В12..В16, which is where the letters are.
    fills = np.asarray(vec.get("fills", []), dtype=np.float64)
    white = np.zeros(len(seats), bool)
    if len(fills):
        centres = np.stack([(fills[:, 0] + fills[:, 2]) / 2,
                            (fills[:, 1] + fills[:, 3]) / 2], axis=1)
        tree = cKDTree(centres)
        for i, p in enumerate(P):
            white[i] = True   # assume light until a dark body is found
            for j in tree.query_ball_point(p, 6.0):
                x0, y0, x1, y1, mean = fills[j]
                if x0 <= p[0] <= x1 and y0 <= p[1] <= y1:
                    white[i] = mean >= WHITE_MEAN
                    break
    # A seat in a curved corner has no seat-sized fill at all — the exporter
    # shredded its body into slivers — so "no fill" alone produces isolated false
    # positives there. The letters are contiguous shapes, so require neighbour
    # support: a light seat must have at least three light seats among its five
    # nearest neighbours.
    if white.any():
        tree = cKDTree(P)
        _, nn = tree.query(P, k=6)
        support = white[nn[:, 1:]].sum(axis=1)
        dropped = int((white & (support < 3)).sum())
        white &= support >= 3
        print(f"  dropped {dropped} isolated light seats (corner fill slivers)")
        # `white` means specifically "part of the ЦСКА lettering", which the
        # drawing puts on the В stand only (docs/DATA_CONTRACT.md). Anything the
        # fill probe flags elsewhere is an artefact of a shredded seat body, not
        # lettering, so it is not reported as such.
        outside = np.array([str(sub_of[i])[0] != "В" for i in range(len(P))])
        stray = int((white & outside).sum())
        if stray:
            print(f"  ignored {stray} light seat(s) outside the В stand "
                  f"(the lettering is only there)")
        white &= ~outside

    per_sector = defaultdict(int)
    for i in np.flatnonzero(white):
        per_sector[str(sub_of[i])[0]] += 1
    print(f"light 'ЦСКА' seats detected: {int(white.sum())} "
          f"(per sector: {dict(per_sector)})")

    # ---- overview space: rotate the PDF's portrait bowl to landscape ---------
    xmin, ymin = P.min(axis=0)
    xmax, ymax = P.max(axis=0)
    OX = ymax - P[:, 1]          # Б (small y) -> right, Г (large y) -> left
    OY = P[:, 0] - xmin          # А (large x) -> bottom, В (small x) -> top
    ov = np.stack([OX, OY], axis=1)
    ow, oh = float(ymax - ymin), float(xmax - xmin)
    margin = 40.0
    ov += margin
    ow += 2 * margin
    oh += 2 * margin
    print(f"overview space: {ow:.0f} x {oh:.0f}")

    # ---- group by subsector -------------------------------------------------
    by_code: dict[str, list[int]] = defaultdict(list)
    for i, c in enumerate(sub_of):
        by_code[str(c)].append(i)

    def sort_key(code: str) -> tuple[int, int, int]:
        sector = code[0]
        rest = code[1:].split("-")
        return (SECTOR_META[sector]["order"], int(rest[0]),
                int(rest[1]) if len(rest) > 1 else 1)

    codes = sorted(by_code, key=sort_key)

    # Which side of a block the pitch is on. Derived per *stand* (not per
    # subsector) from the direction to the bowl centre in overview space, so
    # every block of a stand agrees and the corners do not disagree with their
    # neighbours. Comes out as А->top, Б->left, В->bottom, Г->right.
    ov_centre = ov.mean(axis=0)
    pitch_side: dict[str, str] = {}
    for sector in SECTOR_META:
        mine = [i for i, c in enumerate(sub_of) if str(c)[0] == sector]
        if not mine:
            continue
        dx, dy = ov[mine].mean(axis=0) - ov_centre
        if abs(dx) > abs(dy):
            pitch_side[sector] = "left" if dx > 0 else "right"
        else:
            pitch_side[sector] = "top" if dy > 0 else "bottom"
    print("pitch side per sector:", pitch_side)

    # One tiled partition of the whole bowl, so neighbouring subsectors meet
    # instead of leaving a white wedge at every aisle.
    tiles = tile_paths(ov, np.array([str(c) for c in sub_of]), codes)
    missing = [c for c in codes if c not in tiles]
    if missing:
        print(f"  WARNING no tile for {missing} — falling back to a padded hull")
    print(f"overview tiles: {len(tiles)}/{len(codes)}")

    sectors_out: list[dict] = []
    order = 0
    total = 0

    for sector in sorted(SECTOR_META, key=lambda s: SECTOR_META[s]["order"]):
        subs_out = []
        for code in [c for c in codes if c[0] == sector]:
            idx = np.array(by_code[code])
            order += 1

            rows = np.array([seats[i]["row"] for i in idx])
            nums = np.array([seats[i]["seat"] for i in idx])

            # Subsector-local space is just overview space, translated and
            # uniformly scaled — no rotation. That keeps every block oriented the
            # way it actually sits in the bowl, so the pitch is on the side the
            # pitch really is: above sector А, below В, left of Б, right of Г.
            # Rows therefore run horizontally on А/В and VERTICALLY on Б/Г, and
            # seat-numbering direction is inherited from the drawing rather than
            # normalised. A uniform scale (never separate sx/sy) is what preserves
            # the block's true shape.
            q = ov[idx]
            spacing = float(np.median(cKDTree(q).query(q, k=2)[0][:, 1])) if len(q) > 1 else 1.0
            scale = LOCAL_PITCH_X / (spacing or 1.0)
            px = (q[:, 0] - q[:, 0].min()) * scale + LOCAL_PAD
            py = (q[:, 1] - q[:, 1].min()) * scale + LOCAL_PAD
            w = float(px.max()) + LOCAL_PAD
            h = float(py.max()) + LOCAL_PAD

            seats_out = []
            for k, i in enumerate(idx):
                # The PDF -> overview map sends (dx, dy) to (-dy, dx), i.e. a
                # +90 degree turn, so the drawn seat angle turns with it.
                bx, by = seats[i]["b"]
                seats_out.append({
                    "row": int(rows[k]),
                    "number": int(nums[k]),
                    "x": round2(px[k]),
                    "y": round2(py[k]),
                    "angle": round2(float(np.degrees(np.arctan2(bx, -by)))),
                    "type": "STANDARD",
                    "white": bool(white[i]),
                })
            seats_out.sort(key=lambda s: (s["row"], s["number"]))

            per_row: dict[int, list[int]] = defaultdict(list)
            for s in seats_out:
                per_row[s["row"]].append(s["number"])
            rows_summary = [
                {"row": r, "count": len(v), "firstSeat": min(v), "lastSeat": max(v)}
                for r, v in sorted(per_row.items())
            ]

            ocen = ov[idx].mean(axis=0)
            subs_out.append({
                "code": code,
                "latin": LATIN[sector] + code[1:],
                "order": order,
                "viewBox": f"0 0 {round2(w)} {round2(h)}",
                "width": round2(w),
                "height": round2(h),
                "pitchSide": pitch_side.get(sector, "top"),
                "svgPath": tiles.get(code) or hull_path(ov[idx], HULL_PAD),
                "centroid": {"x": round2(ocen[0]), "y": round2(ocen[1])},
                "seatCount": len(seats_out),
                "rowCount": len(rows_summary),
                "rows": rows_summary,
                "seats": seats_out,
            })
            total += len(seats_out)

        meta = SECTOR_META[sector]
        sectors_out.append({
            "code": sector, "latin": meta["latin"], "name": meta["name"],
            "nameBg": meta["nameBg"], "order": meta["order"], "subsectors": subs_out,
        })

    # ---- pitch ---------------------------------------------------------------
    # Bounded by the innermost seats of each stand, then a properly proportioned
    # pitch is inscribed in that gap.
    #
    # Two things this must not do. It must not centre on the *mean* seat position
    # — В has twice as many seats as А, so the mean sits ~100 units north of the
    # bowl and the pitch rides up under the В stand. And it must not pick the
    # inner edge from all seats at once, because the corner fans curve inward far
    # past the straight stands. So each edge comes from its own stand, using only
    # the middle 40% of that stand's length, where it is straight.
    sector_of_seat = np.array([str(c)[0] for c in sub_of])

    def inner_edge(sector: str, axis: int, take_max: bool) -> float:
        mine = sector_of_seat == sector
        if not mine.any():
            return float(ov[:, axis].mean())
        across = 1 - axis
        lo, hi = np.percentile(ov[mine, across], [30, 70])
        band = mine & (ov[:, across] >= lo) & (ov[:, across] <= hi)
        values = ov[band, axis]
        return float(values.max() if take_max else values.min())

    top = inner_edge("В", 1, True)      # В is the north stand: its largest y
    bottom = inner_edge("А", 1, False)  # А is the south stand: its smallest y
    left = inner_edge("Г", 0, True)     # Г is the west stand: its largest x
    right = inner_edge("Б", 0, False)   # Б is the east stand: its smallest x

    # A football pitch is 105 x 68 m. Inscribing that ratio keeps the decoration
    # honest instead of stretching it to whatever the stands happen to leave.
    PITCH_RATIO = 105.0 / 68.0
    INSET = 0.045
    free_w = (right - left) * (1 - 2 * INSET)
    free_h = (bottom - top) * (1 - 2 * INSET)
    pw, ph = (free_w, free_w / PITCH_RATIO)
    if ph > free_h:
        pw, ph = free_h * PITCH_RATIO, free_h
    pcx, pcy = (left + right) / 2, (top + bottom) / 2
    px0, py0 = pcx - pw / 2, pcy - ph / 2
    px1, py1 = pcx + pw / 2, pcy + ph / 2
    print(f"pitch: {pw:.0f} x {ph:.0f} at ({pcx:.0f},{pcy:.0f}) "
          f"inside x {left:.0f}..{right:.0f}, y {top:.0f}..{bottom:.0f}")
    pitch = (f"M {px0:.1f} {py0:.1f} L {px1:.1f} {py0:.1f} "
             f"L {px1:.1f} {py1:.1f} L {px0:.1f} {py1:.1f} Z")

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "SEATS_CSKA.pdf (22142-AR-SEATS NUMBERING-R01)",
        "overview": {
            "width": round2(ow), "height": round2(oh),
            "viewBox": f"0 0 {round2(ow)} {round2(oh)}", "pitch": pitch,
        },
        "stats": {"seatTotal": total, "subsectorCount": len(codes)},
        "sectors": sectors_out,
    }
    dest = ROOT / "data" / "stadium.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {dest} ({dest.stat().st_size/1e6:.1f} MB): "
          f"{total} seats in {len(codes)} subsectors")

    # ---- overview SVG -------------------------------------------------------
    # Not written here any more. The outlines this stage traces are replaced
    # wholesale by stage 5, so an SVG emitted at this point would be a third,
    # wrong copy of the map on disk — which is exactly what it had become.
    print("next: npx tsx scripts/pipeline/05_overview_layout.ts "
          "(overview outlines + data/stadium-overview.svg)")


if __name__ == "__main__":
    main()
