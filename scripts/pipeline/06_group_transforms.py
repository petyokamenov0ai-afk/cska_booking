#!/usr/bin/env python3
"""
Stage 6 — measure the true relative placement of grouped-corner members.

The two Б corners are drawn as continuous fans on the plan, but stage 4 emits
each numbering zone (Б6, Б6-2; Б10-2, Б11, Б11-2) in its OWN local frame, so
the app cannot reassemble the corner from data/stadium.json alone. This stage
recovers the lost placement by registering each member's seat cloud directly
onto the drawing:

  1. rasterise page 1 of SEATS_CSKA.pdf (the whole bowl in one shared space —
     the render is already in overview orientation, А bottom / В top / Б right,
     so a member's local frame maps onto it by a uniform scale + translation,
     never a rotation);
  2. blob-detect the seat glyphs in the corner region (dark red fills);
  3. for each member, FFT-correlate its rasterised seat cloud against the blob
     raster across a broad scale sweep (the aisle pattern makes the optimum
     unambiguous), then refine with a few ICP rounds; a match fraction >= 0.9
     is required;
  4. express every member's transform relative to its group lead and write
     data/stadium-groups.json, which `lib/subsectorGroup.ts` applies at merge
     time. An overlay PNG per group is written next to the JSON for eyeballing.

    python scripts/pipeline/06_group_transforms.py

Requires poppler (pdftoppm) plus numpy / scipy / Pillow. Rerun only when the
drawing or stage 4's local frames change.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import label
from scipy.signal import fftconvolve
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / "SEATS_CSKA.pdf"
OUT = ROOT / "data" / "stadium-groups.json"
BUILD = Path(__file__).resolve().parent / "build"
DPI = 200
LOCAL_PITCH_X = 22.0  # stage 4's along-row seat pitch, in local units
CELL = 6.0  # correlation raster cell, px

# Group lead first; the lead's frame is the group's shared canvas.
GROUPS = {
    "Б6": ["Б6", "Б6-2"],
    "Б11": ["Б10-2", "Б11", "Б11-2"],
}
# Fraction of the rendered page that safely contains each corner (x0,y0,x1,y1).
CORNER_CROP = {
    "Б6": (0.55, 0.50, 1.00, 1.00),
    "Б11": (0.55, 0.00, 1.00, 0.50),
}


def load_subsectors() -> dict[str, dict]:
    data = json.loads((ROOT / "data" / "stadium.json").read_text())
    subs: dict[str, dict] = {}
    for sector in data["sectors"]:
        for sub in sector["subsectors"]:
            subs[sub["code"]] = sub
    return subs


def render_page() -> np.ndarray:
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(DPI), "-f", "1", "-l", "1", str(PDF), f"{td}/page"],
            check=True,
        )
        (png,) = Path(td).glob("page*.png")
        return np.asarray(Image.open(png).convert("RGB"))


def _centroids(mask: np.ndarray, lo: int, hi: int) -> np.ndarray:
    labels, count = label(mask)
    if count == 0:
        return np.empty((0, 2))
    areas = np.bincount(labels.ravel())[1:]
    ys, xs = np.nonzero(labels)
    vals = labels[ys, xs]
    sx = np.bincount(vals, weights=xs)[1:]
    sy = np.bincount(vals, weights=ys)[1:]
    keep = (areas >= lo) & (areas <= hi)
    return np.column_stack([sx[keep] / areas[keep], sy[keep] / areas[keep]])


def seat_blobs(img: np.ndarray, crop: tuple[float, float, float, float]) -> np.ndarray:
    """Centroids of seat glyphs inside the crop, in render pixels.

    Two families: RED seats are maroon fills; WHITE seats (the Б6 corner draws
    a large share of its seats unfilled) are seat-sized white pockets enclosed
    by dark linework. Both must be found — a zone drawn mostly white would
    otherwise have nothing to lock onto and alias one block over. Stray
    non-seat enclosures (stair symbols, fixtures) that slip through are
    harmless: registration only asks that every SEAT lands on a blob, never
    the reverse.
    """
    h, w, _ = img.shape
    x0, y0, x1, y1 = (int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h))
    tile = img[y0:y1, x0:x1].astype(np.int16)
    r, g, b = tile[..., 0], tile[..., 1], tile[..., 2]
    # Seat fills are maroon/red; the linework is grey, the pitch pale green.
    red = (r > 70) & (r - g > 30) & (r - b > 25) & (g < 160)
    red_pts = _centroids(red, 8, 900)
    # White seats: near-white pockets fully enclosed by ink. The page
    # background is one giant component, so a seat-sized area cap isolates
    # the enclosed pockets.
    bright = (r > 205) & (g > 205) & (b > 205)
    white_pts = _centroids(bright, 25, 500)
    print(f"  {len(red_pts)} red + {len(white_pts)} white seat blobs")
    pts = np.vstack([red_pts, white_pts])
    return pts + (x0, y0)


def rasterise(points: np.ndarray, origin: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    grid = np.zeros(shape, dtype=np.float32)
    ij = np.floor((points - origin) / CELL).astype(int)
    ok = (ij[:, 0] >= 0) & (ij[:, 0] < shape[1]) & (ij[:, 1] >= 0) & (ij[:, 1] < shape[0])
    grid[ij[ok, 1], ij[ok, 0]] = 1.0
    return grid


def icp(points: np.ndarray, blobs: np.ndarray, tree: cKDTree, sigma: float, t: np.ndarray):
    """Refine (sigma, t) on matched pairs; returns (sigma, t, match_frac, rms)."""
    for _ in range(15):
        pitch_px = sigma * LOCAL_PITCH_X
        p = points * sigma + t
        d, j = tree.query(p, distance_upper_bound=0.6 * pitch_px)
        ok = np.isfinite(d)
        if ok.sum() < 30:
            break
        src, dst = points[ok], blobs[j[ok]]
        sm, dm = src.mean(axis=0), dst.mean(axis=0)
        s0, d0 = src - sm, dst - dm
        sigma = float((s0 * d0).sum() / (s0 * s0).sum())
        t = dm - sigma * sm
    pitch_px = sigma * LOCAL_PITCH_X
    p = points * sigma + t
    d, _ = tree.query(p, distance_upper_bound=0.5 * pitch_px)
    ok = np.isfinite(d)
    rms = float(np.sqrt((d[ok] ** 2).mean())) if ok.any() else float("inf")
    return sigma, t, float(ok.mean()), rms


def register(points: np.ndarray, blobs: np.ndarray) -> tuple[float, np.ndarray, float, float]:
    """Best (sigma, t) mapping local `points` onto `blobs` via FFT correlation.

    The straight stands are near-periodic grids, so the single highest
    correlation peak can be an alias one block over. Every per-sigma peak is
    therefore ICP-refined and the winner is chosen by refined rms — a true
    lock lands well under a pixel, an alias converges to several pixels.
    """
    origin = blobs.min(axis=0) - 4 * CELL
    extent = blobs.max(axis=0) - origin + 4 * CELL
    shape = (int(extent[1] / CELL) + 1, int(extent[0] / CELL) + 1)
    bgrid = rasterise(blobs, origin, shape)
    # Tolerant target: a hit counts within one cell of a blob.
    bgrid = np.minimum(
        fftconvolve(bgrid, np.ones((3, 3), dtype=np.float32), mode="same"), 1.0
    )

    candidates = []  # (score, sigma, t)
    for sigma in np.linspace(0.55, 1.45, 31):
        p = points * sigma
        pmin = p.min(axis=0)
        pshape_x = int((p[:, 0].max() - pmin[0]) / CELL) + 1
        pshape_y = int((p[:, 1].max() - pmin[1]) / CELL) + 1
        pgrid = rasterise(p, pmin, (pshape_y, pshape_x))
        # A sigma this large cannot fit inside the (possibly restricted) blob
        # window at all — skip it rather than let 'valid' convolution throw.
        if pgrid.shape[0] > bgrid.shape[0] or pgrid.shape[1] > bgrid.shape[1]:
            continue
        corr = fftconvolve(bgrid, pgrid[::-1, ::-1], mode="valid")
        peak = np.unravel_index(np.argmax(corr), corr.shape)
        score = corr[peak] / len(points)
        t = origin + np.array([peak[1], peak[0]]) * CELL - pmin
        candidates.append((float(score), float(sigma), t))

    candidates.sort(key=lambda c: -c[0])
    tree = cKDTree(blobs)
    best = None  # (frac, -rms) maximised
    for _, sigma0, t0 in candidates[:8]:
        sigma, t, frac, rms = icp(points, blobs, tree, sigma0, t0.copy())
        if frac < 0.9:
            continue
        if best is None or rms < best[3]:
            best = (sigma, t, frac, rms)
    if best is None:
        # Nothing survived the gate; report the strongest candidate as-is.
        _, sigma0, t0 = candidates[0]
        best = icp(points, blobs, tree, sigma0, t0.copy())
        best = (best[0], best[1], best[2], best[3])
    return best


def overlay(lead: str, blobs: np.ndarray, fits, subs) -> None:
    BUILD.mkdir(exist_ok=True)
    origin = blobs.min(axis=0) - 20
    size = (blobs.max(axis=0) - origin + 40).astype(int)
    im = Image.new("RGB", (int(size[0]), int(size[1])), "white")
    dr = ImageDraw.Draw(im)
    for x, y in blobs - origin:
        dr.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(200, 200, 200))
    colours = [(47, 158, 99), (31, 111, 235), (192, 57, 43)]
    for colour, (code, (sigma, t)) in zip(colours, fits.items()):
        pts = np.array([[s["x"], s["y"]] for s in subs[code]["seats"]]) * sigma + t - origin
        for x, y in pts:
            dr.ellipse([x - 2, y - 2, x + 2, y + 2], fill=colour)
    path = BUILD / f"group-overlay-{lead}.png"
    im.save(path)
    print(f"  overlay -> {path}")


def main() -> None:
    subs = load_subsectors()
    img = render_page()
    out: dict[str, dict[str, dict[str, float]]] = {}

    for lead, members in GROUPS.items():
        print(f"group {lead}: {members}")
        blobs = seat_blobs(img, CORNER_CROP[lead])
        fits: dict[str, tuple[float, np.ndarray]] = {}
        # The lead is a curved fan and locks unambiguously; flat members are
        # then matched only against blobs near the lead, so a periodic straight
        # grid one block over cannot alias.
        for code in [lead] + [c for c in members if c != lead]:
            pts = np.array([[s["x"], s["y"]] for s in subs[code]["seats"]])
            pool = blobs
            if code != lead:
                s_l, t_l = fits[lead]
                lead_pts = np.array([[s["x"], s["y"]] for s in subs[lead]["seats"]])
                placed = lead_pts * s_l + t_l
                lo = placed.min(axis=0)
                hi = placed.max(axis=0)
                margin = 0.9 * (hi - lo).max()
                near = (
                    (blobs[:, 0] > lo[0] - margin) & (blobs[:, 0] < hi[0] + margin)
                    & (blobs[:, 1] > lo[1] - margin) & (blobs[:, 1] < hi[1] + margin)
                )
                pool = blobs[near]
            sigma, t, frac, rms = register(pts, pool)
            print(f"  {code}: match {frac:.3f} rms {rms:.2f}px sigma {sigma:.4f}")
            # Red-fill centroids lock well under a pixel; zones drawn mostly as
            # WHITE seats (Б6-2) match against enclosed-pocket centroids, which
            # are a few px sloppier — hence the 5 px ceiling. With hundreds of
            # matched pairs the fitted translation is still sub-pixel.
            if frac < 0.9 or rms > 5.0:
                raise SystemExit(f"{code}: registration failed (match {frac:.3f}, rms {rms:.2f})")
            fits[code] = (sigma, t)
        fits = {code: fits[code] for code in members}
        overlay(lead, blobs, fits, subs)
        s_l, t_l = fits[lead]
        out[lead] = {}
        for code in members:
            s_m, t_m = fits[code]
            # local_member -> local_lead: p_l = (s_m * p_m + t_m - t_l) / s_l
            out[lead][code] = {
                "scale": round(s_m / s_l, 6),
                "dx": round(float((t_m[0] - t_l[0]) / s_l), 2),
                "dy": round(float((t_m[1] - t_l[1]) / s_l), 2),
            }

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
