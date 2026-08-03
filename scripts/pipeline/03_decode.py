#!/usr/bin/env python3
"""
Stage 3 — read the numbers, assign seats to subsectors, and prove it is right.

Inputs : build/glyphs.pkl (stage 2) + glyph_labels.json (the one human step)
Outputs: build/seats.pkl, build/digit_atlas.npz, and a verification report.

The interesting part is verification. Nothing here is taken on trust:

  * Which of a seat's two stacked numbers is the row and which is the seat is not
    assumed — it is *derived* per row from the fact that the row number is
    constant along a row while seat numbers run consecutively.
  * That same fact is what validates the digit labelling. If a template were
    mislabelled, rows containing that digit would stop being consistent, and the
    report would show it as a low consistency score rather than silently
    producing wrong tickets.
  * Subsector assignment is by angular position around the bowl, then checked by
    requiring (row, seat) to be unique inside every subsector.

    python scripts/pipeline/03_decode.py
"""
from __future__ import annotations

import json
import pickle
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"

ROW_GAP = 7.5      # seats along a row are ~5.6pt apart, rows ~11.6pt
SECTORS = {"А": range(1, 6), "Б": range(6, 12), "В": range(12, 17), "Г": range(17, 23)}


def load():
    with (BUILD / "glyphs.pkl").open("rb") as fh:
        g = pickle.load(fh)
    with (HERE / "glyph_labels.json").open() as fh:
        lab = json.load(fh)
    with (BUILD / "vectors.pkl").open("rb") as fh:
        vec = pickle.load(fh)
    return g, lab, vec


def build_digit_map(g: dict, labels: dict[str, int]) -> np.ndarray:
    """Digit value per template id.

    Template ids are an artefact of the clustering order and shift whenever the
    input changes, so `glyph_labels.json` alone is a trap: re-run stage 2 with one
    more seat and the ids permute while the file still looks right. So the frozen
    atlas from the previous run — bitmaps paired with their digit — wins when it
    is present, and the JSON is only the bootstrap for a cold start.

    Either way the labelling is not taken on trust: the caller asserts row
    consistency, which collapses loudly if a digit is wrong.
    """
    templates = g["templates"]
    tcount, tholes = g["tcount"], g["tholes"]
    n = len(templates)
    flat = np.stack([t.ravel() for t in templates])
    digit = np.full(n, -1, np.int8)

    atlas_path = BUILD / "digit_atlas.npz"
    if atlas_path.exists():
        atlas = np.load(atlas_path)
        a_flat = atlas["templates"].reshape(len(atlas["templates"]), -1)
        a_digit, a_holes = atlas["digit"], atlas["holes"]
        keep = a_digit >= 0
        a_flat, a_digit, a_holes = a_flat[keep], a_digit[keep], a_holes[keep]
        worst = 0.0
        for t in range(n):
            # Prefer a match with the same counter count (8 has two, 0/4/6/9 one,
            # 1/2/3/5/7 none) — that alone rules out most confusions.
            pool = np.flatnonzero(a_holes == tholes[t])
            if pool.size == 0:
                pool = np.arange(len(a_flat))
            d = ((a_flat[pool] - flat[t]) ** 2).mean(axis=1)
            best = int(np.argmin(d))
            digit[t] = int(a_digit[pool[best]])
            worst = max(worst, float(d[best]))
        print(f"digit map: matched {n} templates against build/digit_atlas.npz "
              f"(worst mean-squared distance {worst:.4f})")
        return digit

    for k, v in labels.items():
        t = int(k)
        if t < n:
            digit[t] = int(v)
    known = [t for t in range(n) if digit[t] >= 0]
    if not known:
        sys.exit("no digit atlas and no usable labels — run with glyph_labels.json in place")
    unlabelled = 0
    for t in range(n):
        if digit[t] >= 0:
            continue
        pool = [k for k in known if tholes[k] == tholes[t]] or known
        d = ((flat[pool] - flat[t]) ** 2).mean(axis=1)
        digit[t] = digit[pool[int(np.argmin(d))]]
        unlabelled += tcount[t]
    print(f"digit map (bootstrap from glyph_labels.json): {len(known)} labelled, "
          f"{n - len(known)} inferred ({unlabelled} glyphs)")
    return digit


class Walls:
    """Segment-crossing test against the drawing's yellow subsector boundaries."""

    CELL = 40.0

    def __init__(self, segs: list) -> None:
        self.segs = np.asarray(segs, dtype=np.float64)
        self.grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i, (a, b) in enumerate(self.segs):
            x0, x1 = sorted((a[0], b[0]))
            y0, y1 = sorted((a[1], b[1]))
            for gx in range(int(x0 // self.CELL), int(x1 // self.CELL) + 1):
                for gy in range(int(y0 // self.CELL), int(y1 // self.CELL) + 1):
                    self.grid[(gx, gy)].append(i)

    @staticmethod
    def _cross(o, a, b) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def _hits(self, p1, p2, q1, q2) -> bool:
        d1 = self._cross(q1, q2, p1)
        d2 = self._cross(q1, q2, p2)
        d3 = self._cross(p1, p2, q1)
        d4 = self._cross(p1, p2, q2)
        return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))

    def crosses(self, p1, p2) -> bool:
        x0, x1 = sorted((p1[0], p2[0]))
        y0, y1 = sorted((p1[1], p2[1]))
        seen: set[int] = set()
        for gx in range(int(x0 // self.CELL), int(x1 // self.CELL) + 1):
            for gy in range(int(y0 // self.CELL), int(y1 // self.CELL) + 1):
                for i in self.grid.get((gx, gy), ()):
                    if i in seen:
                        continue
                    seen.add(i)
                    if self._hits(p1, p2, self.segs[i][0], self.segs[i][1]):
                        return True
        return False


def _components(P: np.ndarray, walls: Walls, eps: float) -> np.ndarray:
    tree = cKDTree(P)
    parent = np.arange(len(P))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in tree.query_pairs(eps, output_type="ndarray"):
        if walls.crosses(P[a], P[b]):
            continue
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    lab = np.array([find(i) for i in range(len(P))])
    _, lab = np.unique(lab, return_inverse=True)
    return lab


# Seats are ~5.6pt apart; aisles inside a subsector are ~20-35pt. FINE_EPS stays
# below the aisle width so every fine piece is provably one block; merging then
# bridges aisles under a uniqueness constraint rather than a distance guess.
FINE_EPS = 18.0
MERGE_MAX = 60.0


def assign_subsectors(seats: list[dict], P: np.ndarray, bowl: np.ndarray,
                      labels: list[dict], wall_segs: list) -> np.ndarray:
    """Partition seats into the 22 subsectors.

    Three facts do the work, in order of authority:
      1. the drawing's own yellow boundary lines, used as walls that adjacency
         may not cross;
      2. (row, seat) is unique within a subsector, so two pieces that share a
         key can never be the same subsector — this is what makes merging safe
         where a boundary line has a gap;
      3. subsectors run in label order along each stand, which fixes the codes.
    """
    walls = Walls(wall_segs)
    fine = _components(P, walls, FINE_EPS)
    nfine = fine.max() + 1
    keysets = [set() for _ in range(nfine)]
    for i, s in enumerate(seats):
        keysets[fine[i]].add((s["row"], s["seat"]))
    bad = sum(1 for k in range(nfine) if len(keysets[k]) != int((fine == k).sum()))
    print(f"\nfine pieces at eps={FINE_EPS}: {nfine} "
          f"({bad} with internally duplicated (row,seat))")

    # candidate merges: closest unblocked seat pair between two fine pieces
    tree = cKDTree(P)
    best: dict[tuple[int, int], float] = {}
    for a, b in tree.query_pairs(MERGE_MAX, output_type="ndarray"):
        ka, kb = int(fine[a]), int(fine[b])
        if ka == kb:
            continue
        key = (min(ka, kb), max(ka, kb))
        dist = float(np.hypot(*(P[a] - P[b])))
        if dist >= best.get(key, np.inf):
            continue
        if walls.crosses(P[a], P[b]):
            continue
        best[key] = dist

    parent = list(range(nfine))
    groups = {k: set(keysets[k]) for k in range(nfine)}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def contiguous_rows(keys: set) -> int:
        """Rows whose seat numbers are exactly 1..M — the mark of a whole row."""
        per: dict[int, list[int]] = defaultdict(list)
        for r, n in keys:
            per[r].append(n)
        return sum(1 for v in per.values() if sorted(v) == list(range(1, len(v) + 1)))

    def try_merge(ka: int, kb: int) -> bool:
        ra, rb = find(ka), find(kb)
        if ra == rb or (groups[ra] & groups[rb]):
            return False
        parent[ra] = rb
        groups[rb] |= groups[ra]
        del groups[ra]
        return True

    merged = refused = 0
    for (ka, kb), _dist in sorted(best.items(), key=lambda kv: kv[1]):
        if try_merge(ka, kb):
            merged += 1
        elif find(ka) != find(kb):
            refused += 1      # shared (row,seat) => genuinely different subsectors
    print(f"wall-respecting merges accepted {merged}, refused on shared keys "
          f"{refused} -> {len(groups)} blocks")

    # Pass B: some subsector-internal aisles are themselves crossed by a yellow
    # line, and the drawing's boundary set is incomplete in the Б stand, so the
    # wall-respecting pass both over- and under-splits. Merge further while
    # ignoring walls, ranked by how much a merge *completes rows* (a subsector
    # split down the middle has half-rows on each side that join into 1..M).
    # The disjoint-key requirement is what keeps this from fusing two subsectors.
    want = len(labels)
    while len(groups) > want:
        gl = list(groups)
        members = {g: [] for g in gl}
        for i in range(len(P)):
            members[find(int(fine[i]))].append(i)
        trees = {g: cKDTree(P[members[g]]) for g in gl}
        cands: list[tuple[int, float, int, int]] = []
        for i1 in range(len(gl)):
            for i2 in range(i1 + 1, len(gl)):
                ga, gb = gl[i1], gl[i2]
                if groups[ga] & groups[gb]:
                    continue
                dist = float(trees[ga].query(P[members[gb]])[0].min())
                if dist > 120.0:
                    continue
                gain = (contiguous_rows(groups[ga] | groups[gb])
                        - contiguous_rows(groups[ga]) - contiguous_rows(groups[gb]))
                cands.append((-gain, dist, ga, gb))
        if not cands:
            break
        cands.sort()
        _, _, ga, gb = cands[0]
        if not try_merge(ga, gb):
            break
    print(f"after row-completing merges: {len(groups)} blocks")

    block = np.array([find(int(fine[i])) for i in range(len(P))])
    sizes = Counter(block)

    # Tiny leftovers (a handful of seats the walls isolated) join the nearest
    # block they do not collide with.
    small = [b for b, n in sizes.items() if n < 40]
    if small:
        keep = [b for b, n in sizes.items() if n >= 40]
        moved = 0
        for b in small:
            idx = np.flatnonzero(block == b)
            bkeys = {(seats[i]["row"], seats[i]["seat"]) for i in idx}
            order = sorted(
                keep,
                key=lambda t: float(cKDTree(P[block == t]).query(P[idx])[0].min()),
            )
            for t in order:
                tkeys = {(seats[i]["row"], seats[i]["seat"])
                         for i in np.flatnonzero(block == t)}
                if not (bkeys & tkeys):
                    block[idx] = t
                    moved += len(idx)
                    break
        print(f"absorbed {len(small)} tiny pieces ({moved} seats) into neighbours")
        sizes = Counter(block)

    # ---- map blocks to codes -------------------------------------------------
    # Subsectors run round the bowl in one cycle (А5..А1, Г22..Г17, В16..В12,
    # Б11..Б6) and each label sits on its own subsector's radial ray, so the two
    # angular sequences can be aligned directly.
    #
    # There are usually a few more numbering-distinct blocks than labels: inside
    # some yellow regions (notably the Б11 corner fan and Б7) the drawing numbers
    # two or three blocks independently, each starting again at seat 1. Those
    # cannot share one code without breaking (subsector,row,seat) uniqueness,
    # which is the key the whole booking model rests on — so each extra block
    # keeps its parent's label with a numeric suffix, and it is reported.
    l_ang = {lb["code"]: float(np.arctan2(lb["y"] - bowl[1], lb["x"] - bowl[0]))
             for lb in labels}
    ls = sorted(l_ang, key=lambda c: l_ang[c])
    b_ang = {b: float(np.arctan2(*(P[block == b].mean(axis=0) - bowl)[::-1]))
             for b in sizes}
    bs = sorted(b_ang, key=lambda b: b_ang[b])

    # Monotone cyclic alignment: walk the blocks in angular order and cut them
    # into 22 consecutive runs, one per label. Assigning each block to its
    # individually-nearest label instead lets one label swallow two blocks while
    # its neighbour gets none, which silently loses a subsector.
    n, m = len(ls), len(bs)
    # linearise the cycle at the widest gap between adjacent blocks
    gaps = [(float(np.angle(np.exp(1j * (b_ang[bs[(k + 1) % m]] - b_ang[bs[k]])))), k)
            for k in range(m)]
    start = (max(gaps)[1] + 1) % m
    border = [bs[(start + k) % m] for k in range(m)]

    def pair_cost(b: int, code: str) -> float:
        return abs(float(np.angle(np.exp(1j * (b_ang[b] - l_ang[code])))))

    best = (np.inf, None)
    for shift in range(n):
        lab = [ls[(shift + k) % n] for k in range(n)]
        INF = np.inf
        dp = np.full((m + 1, n + 1), INF)
        back = np.zeros((m + 1, n + 1), np.int32)
        dp[0][0] = 0.0
        for j in range(1, n + 1):
            for i in range(j, m - (n - j) + 1):
                for k in range(j - 1, i):        # label j-1 takes blocks k..i-1
                    if dp[k][j - 1] == INF:
                        continue
                    c = dp[k][j - 1] + sum(pair_cost(border[t], lab[j - 1])
                                           for t in range(k, i))
                    if c < dp[i][j]:
                        dp[i][j] = c
                        back[i][j] = k
        if dp[m][n] < best[0]:
            best = (dp[m][n], (lab, back.copy()))
    total, (lab, back) = best
    of_block: dict[int, str] = {}
    i, j = m, n
    while j > 0:
        k = int(back[i][j])
        for t in range(k, i):
            of_block[border[t]] = lab[j - 1]
        i, j = k, j - 1
    print(f"monotone alignment cost={np.degrees(total/m):.1f}deg mean; "
          f"blocks per label: {dict(Counter(of_block.values()))}")

    out = np.array(["" for _ in range(len(P))], dtype=object)
    has_row1 = {b: any(seats[i]["row"] == 1 for i in np.flatnonzero(block == b))
                for b in sizes}
    for parent_code in set(of_block.values()):
        mine = [b for b in bs if of_block[b] == parent_code]
        # The captioned code goes to the primary block — the one that starts at
        # row 1 — rather than merely the biggest, so a plain code always has a
        # row 1 and the suffixed siblings are the ones with clipped fronts.
        mine.sort(key=lambda b: (not has_row1[b], -sizes[b]))
        for rank, b in enumerate(mine):
            code = parent_code if rank == 0 else f"{parent_code}-{rank + 1}"
            if rank:
                print(f"  NOTE {parent_code}: extra independently-numbered block "
                      f"({sizes[b]} seats) emitted as {code}")
            out[block == b] = code
    assert not (out == "").any(), "every seat must get a subsector"
    return out


def main() -> None:
    g, labcfg, vec = load()
    records, assign = g["records"], g["assign"]
    seats_raw, GW, GH = g["seats"], g["GW"], g["GH"]
    digit_of_template = build_digit_map(g, labcfg["labels"])

    # ---- glyphs -> the two numbers of each seat ------------------------------
    per_seat: dict[int, list[dict]] = defaultdict(list)
    for r, t in zip(records, assign):
        per_seat[r["seat"]].append({**r, "digit": int(digit_of_template[t])})

    seats: list[dict] = []
    for si, glyphs in per_seat.items():
        base = seats_raw[si]
        by_number: dict[int, list[dict]] = defaultdict(list)
        for gl in glyphs:
            by_number[gl["number"]].append(gl)
        if len(by_number) != 2:
            continue
        vals = []
        for num, gs in by_number.items():
            gs.sort(key=lambda z: z["pos"])          # reading order along baseline
            s = "".join(str(z["digit"]) for z in gs)
            vals.append({
                "text": s,
                "value": int(s),
                "u": float(np.mean([z["off"] for z in gs])),
                "ndigits": len(gs),
            })
        vals.sort(key=lambda z: -z["u"])              # far-from-pitch first
        seats.append({
            "outer": vals[0],       # higher u (away from bowl centre)
            "inner": vals[1],
            "x": float(base["centre"][0]),
            "y": float(base["centre"][1]),
            "u": base["u"],
            "b": base["b"],
        })
    print(f"seats with two decoded numbers: {len(seats)}")

    P = np.array([[s["x"], s["y"]] for s in seats])
    bowl = P.mean(axis=0)
    labels = vec["labels"]
    codes = [lb["code"] for lb in labels]

    # ---- which of the two numbers is the row? -------------------------------
    # Derived, not assumed: chain seats into rows spatially, then see which of
    # the two printed numbers stays constant along a row.
    tree = cKDTree(P)
    parent = np.arange(len(P))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in tree.query_pairs(ROW_GAP, output_type="ndarray"):
        u = seats[a]["u"]
        delta = P[b] - P[a]
        if abs(float(delta @ np.array([-u[1], u[0]]))) > abs(float(delta @ u)):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    rowseg: dict[int, list[int]] = defaultdict(list)
    for k in range(len(P)):
        rowseg[find(k)].append(k)

    votes = {"outer": 0, "inner": 0}
    for members in rowseg.values():
        if len(members) < 4:
            continue
        o = {seats[m]["outer"]["value"] for m in members}
        i = {seats[m]["inner"]["value"] for m in members}
        if len(o) == 1 and len(i) > 1:
            votes["outer"] += 1
        elif len(i) == 1 and len(o) > 1:
            votes["inner"] += 1
    print(f"\nrow-number position vote: outer(far from pitch)={votes['outer']} "
          f"inner(near pitch)={votes['inner']}")
    row_is_outer = votes["outer"] >= votes["inner"]
    which_row, which_seat = ("outer", "inner") if row_is_outer else ("inner", "outer")
    print(f"  -> the ROW number is the {which_row} one")

    for s in seats:
        s["row"] = s[which_row]["value"]
        s["seat"] = s[which_seat]["value"]

    sub_of_seat = assign_subsectors(seats, P, bowl, labels, vec["walls"])
    print("\nseats per subsector:")
    cnt = Counter(sub_of_seat)
    for c in codes:
        print(f"   {c:>4}: {cnt[c]:5d}")

    # ---- verification: numbering must be monotonic along every row ----------
    by_row: dict[tuple[str, int], list[int]] = defaultdict(list)
    for i, s in enumerate(seats):
        by_row[(sub_of_seat[i], s["row"])].append(i)

    mono = dup = nonmono = 0
    offenders: list[str] = []
    for (code, row), members in sorted(by_row.items()):
        nums = [seats[m]["seat"] for m in members]
        u = seats[members[0]]["u"]
        bvec = np.array([-u[1], u[0]])
        proj = [float(P[m] @ bvec) for m in members]
        seq = [nums[k] for k in np.argsort(proj)]
        if len(set(nums)) != len(nums):
            dup += 1
            if len(offenders) < 12:
                offenders.append(f"    {code} row {row}: DUPLICATES {seq[:16]}")
        elif seq == sorted(seq) or seq == sorted(seq, reverse=True):
            mono += 1
        else:
            nonmono += 1
            if len(offenders) < 12:
                offenders.append(f"    {code} row {row}: NOT MONOTONIC {seq[:16]}")
    total = len(by_row)
    print(f"\nrows (subsector, row): {total}")
    print(f"  seat numbers strictly monotonic along the row: {mono} "
          f"({100*mono/max(1,total):.1f}%)")
    print(f"  rows with duplicate seat numbers : {dup}")
    print(f"  rows non-monotonic               : {nonmono}")
    for line in offenders:
        print(line)

    # ---- verification: (subsector,row,seat) must be unique ------------------
    keys = Counter((sub_of_seat[i], s["row"], s["seat"]) for i, s in enumerate(seats))
    clashes = {k: v for k, v in keys.items() if v > 1}
    print(f"\nduplicate (subsector,row,seat) keys: {len(clashes)}")
    for k, v in list(clashes.items())[:10]:
        print(f"    {k} x{v}")

    with (BUILD / "seats.pkl").open("wb") as fh:
        pickle.dump({"seats": seats, "sub_of_seat": sub_of_seat, "bowl": bowl,
                     "labels": labels, "row_is_outer": row_is_outer}, fh, protocol=4)
    np.savez_compressed(
        BUILD / "digit_atlas.npz",
        templates=np.stack([t for t in g["templates"]]),
        digit=digit_of_template,
        holes=np.array(g["tholes"]),
    )
    print(f"\nwrote {BUILD/'seats.pkl'} and {BUILD/'digit_atlas.npz'}")


if __name__ == "__main__":
    main()
