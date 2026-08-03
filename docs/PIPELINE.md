# Phase 1 — the seat-data pipeline

How `SEATS_CSKA.pdf` (`22142-AR-SEATS NUMBERING-R01`, A0 CAD export of the
Bulgarian Army Stadium) becomes `data/stadium.json`.

```
python scripts/pipeline/01_extract.py           # PDF -> build/vectors.pkl
python scripts/pipeline/02_glyphs.py            # -> build/glyphs.pkl + glyph_templates.png
python scripts/pipeline/03_decode.py            # -> build/seats.pkl  (+ verification report)
python scripts/pipeline/04_emit.py              # -> data/stadium.json
npx tsx scripts/pipeline/05_overview_layout.ts  # overview outlines (22 shapes) + data/stadium-overview.svg
npx tsx scripts/pipeline/validate.ts            # enforces docs/DATA_CONTRACT.md
```

**Stage 5 is not optional after stage 4.** Stage 4 writes traced, noisy block
outlines; stage 5 replaces all 25 of them with the club's own printed sector map
and is what `data/stadium-overview.svg` is now emitted from. Re-running stage 4
alone therefore leaves the overview looking like it did before the reference
existed.

Interpreter: `.venv-pipeline` (`python3 -m venv .venv-pipeline &&
.venv-pipeline/bin/pip install pymupdf numpy opencv-python-headless scipy scikit-learn pillow`).
Everything under `scripts/pipeline/build/` is a regenerable cache and is
git-ignored; the two emitted artifacts in `data/` are committed, because deploys
seed from them and cannot run Python.

## What the drawing actually turned out to be

The implementation plan assumed seat data would have to come from **high-DPI
rendering + colour-blob detection**, because `pdftotext` returns only the 22
subsector captions. That assumption was wrong in a way that made the job much
easier and the result exact:

- **Every seat prints its own row number and seat number inside it**, as vector
  outlines. So the numbers never have to be inferred from position, and the
  "which direction does numbering run" question in the plan (§3 step 4) does not
  arise — the drawing states the answer 16,033 times.
- **A glyph contour is a *closed* black stroked subpath**; seat outlines, grid
  lines and other furniture are *open* polylines. That one distinction separates
  text from geometry across the whole sheet.
- Colour-blob detection would in fact have failed in the curved corners: those
  seats are drawn as rotated 3-D-style icons that Distiller decomposed into
  thousands of unusable slivers (112k of the 214k red rects have area < 0.5pt²).
  The printed numbers survive intact everywhere, so they — not the seat bodies —
  are the reliable seat marker.
- The **"ЦСКА" letters on the В stand are drawn unfilled**, not light-filled.
  "No red body" is what identifies them (946 seats, 886 of them in В12–В16).
- The drawing marks its own subsector boundaries with **yellow lines**. They are
  load-bearing: an aisle *inside* a subsector looks exactly like the gap
  *between* two subsectors otherwise.

## Stage 1 — extract

Pulls closed black glyph contours, the yellow boundary segments, seat-body fills,
and the 22 captions.

Two subtleties, both of which silently lose seats if ignored:

- **Split subpaths.** Distiller sometimes emits one glyph outline as two
  subpaths — the outline plus a stub a fraction of a point long that closes it.
  Testing closure on raw subpaths threw away ~1,300 digits, which turned "16"
  into "1" and corrupted whole rows. Stage 1 welds pieces on coincident
  endpoints *before* testing closure. Loosening the closure tolerance instead
  does not work: beyond 0.25pt the distribution is continuous, so there is no
  safe cutoff.
- **Sector А's captions are Latin.** Cyrillic А (U+0410) and Latin A (U+0041)
  render identically and the CAD tool emitted Latin A for both caption lines, so
  `А1` never appears as Cyrillic in the text layer. Both scripts are mapped onto
  the canonical Cyrillic letter.

The drawing also has a **defect**: the Б10 block is captioned `Б11 / B10`, so two
blocks claim to be Б11. It is resolved by requiring each sector's block numbers
to be a bijection onto its expected range, which forces the inner one to Б10.

## Stage 2 — glyphs, numbers, seats

Measured layout: digits within a number sit ~0.9pt apart, the two numbers of a
seat ~1.7pt apart, neighbouring seats ~5.6pt apart. Two levels of distance
clustering therefore recover numbers, then seats, unambiguously.

Body-vs-counter is decided by **containment**, never by size — a large "0"'s
counter is bigger than a whole digit at the smaller of the two text sizes used.

Each seat gets a local frame from its own glyph layout: `u` = the axis between
the two stacked numbers, signed to point away from the bowl centre (a reference
that stays smooth through the corners); `b` = the perpendicular baseline. Glyphs
are rasterised in that frame, so the same digit yields the same bitmap anywhere
in the bowl. Handedness matters: pairing `u` with `(u.y, -u.x)` is a
*reflection* and renders every glyph mirrored; the proper rotation is
`(-u.y, u.x)`.

Clustering the bitmaps gives **12 templates covering 100% of 54,154 glyphs** —
ten digits plus a second "2" variant and a "4" whose counter is absent at the
smaller size.

## Stage 3 — decode, then prove it

`glyph_labels.json` maps template → digit. This is the one irreducibly human
step (the numbers are not text, so there is nothing to read them from), and it
is guarded three ways:

1. **Counter count must match the digit** — 8 has two, 0/4/6/9 have one,
   1/2/3/5/7 have none. All 12 templates agree.
2. **Frequency must look like numbers 1–40** — 1 and 2 dominant, 7/8/9/0 rare.
   It does.
3. **Row consistency** — the row number must stay constant along a row while
   seat numbers run consecutively. A mislabelled digit breaks this loudly.

Nothing else is assumed either:

- **Which number is the row** is derived, not assumed: seats are chained into
  rows spatially and the constant number wins. The vote is **984 to 0** for the
  number printed farther from the pitch.
- **Subsector assignment** starts from the yellow boundaries used as walls that
  adjacency may not cross, then merges the resulting pieces under a hard
  constraint: two pieces may only merge if their `(row, seat)` sets are
  **disjoint**, because that key must be unique within a subsector. Merges are
  ranked by how much they *complete rows* (a subsector split down the middle has
  half-rows on each side that join into 1..M). Codes are then fixed by a
  monotone cyclic alignment of block angles to caption angles — assigning each
  block to its individually-nearest caption instead lets one caption swallow two
  blocks while its neighbour gets none, silently losing a subsector.

Verification output on the current data: **560 of 562 rows** have strictly
monotonic seat numbering, and **zero** duplicate `(subsector, row, seat)` keys.

`qa_overlay.py <cx> <cy> <half> [dpi]` draws decoded seats over the rendered
drawing for spot checks. Verified by eye in the straight stands and the curved
corners; e.g. at Г19 the pipeline reads `row 7 / seats 13,14,15,16` exactly where
the drawing prints `13/7, 14/7, 15/7, 16/7`.

## Stage 4 — emit

Overview space is a proper rotation of the PDF's own portrait space
(`X = ymax - y`, `Y = x - xmin`), giving a landscape bowl with А at the bottom,
В top, Б right, Г left. Determinant is +1, so the map is never mirrored.

Subsector-local space is that same overview space, translated and *uniformly*
scaled per subsector — no rotation. Each block therefore keeps its real shape and
the orientation it has in the bowl, so the pitch ends up on the side the pitch
really is: above А, below В, left of Б, right of Г. `pitchSide` records which,
and rows run vertically on Б/Г as a result.

Overview outlines are **one tiled partition of the whole bowl**, not per-block
hulls (hulls leave a white wedge at every aisle, and per-block edges step up
and down in depth — the zig-zag). The bowl is rasterised once and labelled by
nearest seat, so internal seams are shared to the pixel and drawn as single
straight lines between junctions. Those traced outlines are a scaffold: stage 5
replaces all 25 of them, and only the seat data below survives from here.

## Stage 5 — overview layout

`05_overview_layout.ts` rebuilds `svgPath`, `centroid` and `overviewGroup` on all
25 subsectors from `data/overview-reference.svg`, the club ticket system's own
printed sector map. Nothing else in the file is touched — the run splices 25
literals and proves textually that every other byte and the whole key order are
unchanged.

Why read a map instead of tracing one: a raster trace has no straightness prior,
so a wall that is straight to 0.25° in the drawing comes out as a ±10-unit wave
and a corner as 16–18 tiny chords. The predecessor stage (`05_regularise.ts`,
deleted; no live references remain) fitted a two-ring annulus to those hulls to
put the prior back — an inference about a shape the reference simply states.

### 22 shapes over 25 subsectors

The reference draws 22 blocks; we have 25, because stage 3 had to split three of
the drawing's regions to keep `(subsector, row, seat)` unique. **The overview
draws the reference's 22.** Two shapes therefore cover more than one subsector:

    Б11 (corner wedge)  ←  Б10-2 + Б11 + Б11-2    924 seats
    Б6  (corner wedge)  ←  Б6    + Б6-2           805 seats

This is presentation only — see `docs/DATA_CONTRACT.md § overviewGroup`. All 25
stay separately bookable, routable and seat-mapped; the level-2 card list under
the map still lists every one of them, and the level-3 seat maps are untouched.
It is not avoidable by merging the seat maps instead: each subsector's seats live
in their own local coordinate space and `stadium.json` records no local→overview
transform, so three seat clouds cannot be stitched into one without re-running
the Python pipeline.

The 22↔25 relation lives in exactly one place, the `BLOCKS` table at the top of
the stage, and every assertion is derived from it.

### Recorded finding: Б6-2 physically belongs to reference Б7

Measured, not inferred from the `-N` suffixes: each block's seat cloud was
reconstructed in overview space and tested for containment, swept across the whole
plausible reconstruction scale. The answer:

    Б6-2  → ref Б7  86–92 %   (ref Б6: only 8–14 %)
    Б10-2 → ref Б11 87–93 %
    Б11-2 → ref Б11 92–98 %

So the Б11 grouping is the measured one. **The Б6 grouping is not**: our `Б6-2`
is drawn inside the region the official map calls Б6 while its seats sit in
official Б7. That is a deliberate product decision, and the stage keeps it on the
record rather than burying it — every run prints warning `W3` naming it, and `W2`
flags the seat density it produces (Б7 reads 0.41× the stadium mean). Both are
non-blocking. To adopt the measured alternative instead, swap the two commented
lines in `BLOCKS`; nothing else changes.

Renaming `Б6-2` to `Б7-2` would touch seat identity, routes and the database, so
the codes are left alone either way.

### Why it cannot tear

Gap-freeness is structural, not checked afterwards: every coordinate is interned
once into a shared node table keyed on its 1-decimal grid position, and a ring is
an array of node *ids*, so the two owners of a seam cannot disagree in the last
digit. The run then confirms it on the final rounded polygons anyway — 56 nodes,
22 shared seams, 56 free edges closing into exactly two loops, 0 T-junctions
(nearest miss 93 units), and block areas summing to the traced annulus to
0.000 u². Thirty checks in all; any failure writes nothing and exits non-zero.

The mapping is an anisotropic fit of the two pitch rectangles, derived at runtime
rather than hard-coded so the stage follows if stage 4 ever moves the overview
extent. `overview.width`, `height`, `viewBox` and `pitch` do not change.

The run is idempotent, and proves it before writing: the whole transform runs
twice in process and the bytes must match. There is no feedback path — nothing
this stage writes is an input to it.

`data/stadium-overview.svg` is a debug artifact nothing reads (`prisma/seed.ts`
seeds from `stadium.json` alone). It is re-emitted here rather than by stage 4,
because the outlines no longer come from stage 4, and it now carries **22**
`<path>`s with a `data-members` attribute — one per drawn shape, not three
stacked identical copies.

## Known limitations

Honest list, all reported by `validate.ts` as warnings rather than hidden:

- **Three regions contain more than one independently-numbered block.** Inside
  the Б11 corner fan, and at Б6/Б10, the drawing restarts seat numbering within
  one yellow region. Folding those into one code would break `(subsector, row,
  seat)` uniqueness, so they are emitted as `Б6-2`, `Б10-2`, `Б11-2` — 25
  subsectors for 22 captions. Stage 5 settled where they physically sit against
  the official map — `Б6-2` really is inside Б7 and `Б10-2` inside Б11 — but the
  **codes were not renamed**, because that would touch seat identity and routes.
  The overview draws the official map's 22 shapes over these 25 (`overviewGroup`),
  and deliberately groups `Б6-2` under `Б6` rather than under the Б7 the seats
  say — see "Recorded finding" above.
- **Two rows** (А2 row 15, in the thin outer strip at x≈1857pt, and Б11-2 row
  23) span two physically separated groups, so numbering and position disagree
  there. 25 seats total.
- **Seat types are all `STANDARD`.** Wheelchair and companion positions are
  *not* detected — the plan called for them, and they are visible on the drawing
  as distinct glyphs along the front promenade, but no detector was built. Any
  accessible-seating feature needs this filled in first.
- **Row 1 is missing** in three corner blocks (their front rows belong to the
  sibling block of the same region).
- The pitch outline is derived from the innermost seats rather than traced, so it
  is approximate decoration.
