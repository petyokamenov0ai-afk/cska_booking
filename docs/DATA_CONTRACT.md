# `data/stadium.json` — geometry data contract

Produced by `scripts/pipeline/` from `SEATS_CSKA.pdf`
(`22142-AR-SEATS NUMBERING-R01.pdf`, A0 CAD export of the Bulgarian Army Stadium).
Consumed by `prisma/seed.ts` and by the map components.

**This file is the single source of truth for the shape of the geometry data.**
Anything reading or writing `stadium.json` must match it exactly.

## Coordinate spaces

There are two, and they are deliberately different:

1. **Overview space** — one shared space for the whole bowl, used by
   `stadium-overview.svg` and by `Subsector.svgPath`. Landscape.
   Origin top-left, y grows downward (SVG convention).
   Sector А (South) is at the bottom, В (North) top, Б (East) right, Г (West) left.
2. **Subsector-local space** — one per subsector, used by `Seat.x/y`. This is
   overview space translated and **uniformly** scaled: no rotation, no
   normalisation. Every block therefore keeps the orientation it actually has in
   the bowl, and its true shape.

   The consequence is that orientation is **per stand**, given by `pitchSide`:

   | Sector | Side of the bowl | `pitchSide` | Rows | Row 1 | Seat 1→N |
   |---|---|---|---|---|---|
   | А · Юг | bottom | `top` | horizontal | top | left → right |
   | Б · Изток | right | `left` | **vertical** | left | bottom → top |
   | В · Север | top | `bottom` | horizontal | bottom | right → left |
   | Г · Запад | left | `right` | **vertical** | right | top → bottom |

   Row 1 is always the one nearest the pitch, and later rows recede away from it.
   Renderers draw the pitch as a band on `pitchSide` and must put row labels on
   the axis the rows actually run along — see `components/stadium/SeatMap.tsx`.

   Anything measuring "seat spacing" must be orientation-free (nearest-neighbour
   distance in 2-D, not spacing along x): on Б/Г every seat in a row shares an x,
   so an x-based estimate collapses to zero.

Both spaces are in abstract SVG units (derived from PDF points), not pixels.

## Schema

```jsonc
{
  "generatedAt": "2026-07-30T12:00:00.000Z",
  "source": "SEATS_CSKA.pdf",
  "overview": {
    "width": 2220,           // number — overview space extent
    "height": 1615,
    "viewBox": "0 0 2220 1615",
    "pitch": "M 700 400 L …" // SVG path of the pitch rectangle, overview space
  },
  "stats": {
    "seatTotal": 14231,      // sum over all subsectors
    "subsectorCount": 22
  },
  "sectors": [
    {
      "code": "А",           // Cyrillic, as on the drawing
      "latin": "A",
      "name": "South",       // English
      "nameBg": "Юг",
      "order": 1,            // 1..4, А Б В Г
      "subsectors": [
        {
          "code": "А1",      // Cyrillic, unique across the stadium
          "latin": "A1",
          "order": 1,        // 1..22, drawing order
          "viewBox": "0 0 1000 640",   // subsector-local space
          "width": 1000,
          "height": 640,
          "pitchSide": "top",          // top | bottom | left | right (see above)
          "svgPath": "M 12 630 L …",   // outline, OVERVIEW space, closed path
          "centroid": { "x": 1180.4, "y": 1502.1 }, // overview space, for labels
          "seatCount": 512,
          "rowCount": 24,
          "rows": [ { "row": 1, "count": 20, "firstSeat": 1, "lastSeat": 20 } ],
          "seats": [
            {
              "row": 1,          // integer, as printed on the drawing
              "number": 1,       // integer, as printed on the drawing
              "x": 14.2,         // subsector-local, seat centre
              "y": 612.8,
              "angle": 0,        // degrees, seat rotation for rendering (0 = upright)
              "type": "STANDARD",// STANDARD | WHEELCHAIR | COMPANION | VIP
              "white": false     // true = light "ЦСКА"-letter seat (В stand)
            }
          ]
        }
      ]
    }
  ]
}
```

## Invariants (enforced by `scripts/pipeline/validate.ts`)

**Fatal** — `validate.ts` fails the build on these:

- `(subsector.code, seat.row, seat.number)` is unique across the file. This is the
  key the whole booking model rests on.
- Every `seat.row >= 1` and `seat.number >= 1`.
- Every seat lies inside its subsector's `viewBox`.
- `sectors[].subsectors[].seats.length === seatCount`, and `stats.seatTotal` is the sum.
- Sector codes are exactly `А Б В Г` (Cyrillic); subsector codes are
  `А1–А5, Б6–Б11, В12–В16, Г17–Г22`, optionally suffixed `-2`, `-3`, … (below).

**Advisory** — reported as warnings, because the source drawing genuinely
violates them in a handful of places (see docs/PIPELINE.md → Known limitations):

- Within a row, `number` runs monotonically along the seat axis (x for `pitchSide`
  top/bottom, y for left/right) — in either direction, since the drawing's
  numbering direction differs per stand. A few rows break this, where one row
  number spans two physically separated groups of seats.
- Row 1 exists and is nearest the pitch, with later rows receding from it. Three
  corner blocks start at a higher row, and in the curved corner fans the rows
  radiate so no single axis orders them.

## Subsectors vs. the drawing's 22 captions

The drawing labels 22 regions, but three of them (`Б6`, `Б10`, `Б11`) contain more
than one **independently-numbered block** — inside the Б11 corner fan, for
instance, each block restarts at seat 1. Merging those under one code would break
`(subsector, row, seat)` uniqueness, so the pipeline emits the extras as
`Б6-2`, `Б10-2`, `Б11-2`.

So a conforming file has **25 subsectors**, of which 22 carry a caption code. The
suffix is purely a uniqueness device: `latin` and the parent sector are unchanged.
These three splits are flagged for human verification.

### `overviewGroup` — 22 shapes over 25 subsectors

The overview map draws what the ticket system prints: **22 shapes**. Two of them
cover more than one subsector, and `overviewGroup` is how the file says so.

| block | members (in `order`) | Σ seats |
|---|---|---|
| `Б11` | `Б10-2`, `Б11`, `Б11-2` | 924 |
| `Б6`  | `Б6`, `Б6-2`            | 805 |

Do not infer the grouping from the `-2` suffix: `Б10-2` belongs to the **`Б11`**
block, not to `Б10`. The suffixes are a uniqueness device stage 3 synthesised and
they carry no authority about which printed region a block sits in.

Rules a conforming file obeys, all asserted by `scripts/pipeline/validate.ts` and
`tests/stadium.contract.test.ts`:

- Present **iff** the block covers more than one subsector. The 20 drawn 1:1 omit it.
- Its value is always the `code` of one of the block's **own members**, in the same
  sector — so the named subsector carries the same `overviewGroup` as its siblings.
- Members are contiguous in `order`.
- Every member carries a **byte-identical `svgPath`** and an exactly-equal
  `centroid`: the outline and label anchor of the *drawn shape*, not of a member's
  own seats.
- The 22 distinct outlines are one exact partition of the bowl annulus — every
  interior seam a shared vertex pair, no T-junctions, free boundary closing into
  exactly two loops.

**It is presentation only.** All 25 subsectors stay separately bookable, routable
and seat-mapped: `/subsectors/Б11-2` resolves, its level-3 seat map is untouched,
`stats.subsectorCount` is 25, `SubsectorAvailabilityDTO` stays per-subsector, and
the level-2 card list under the map lists all of them. `overviewGroup` is never a
routing, booking or seat-map key, and there is no column for it in the database.

A merged seat map is not derivable and is not the point: each subsector's seats
live in their own local coordinate space and this file records no local→overview
transform, so the three Б11 seat maps cannot be stitched into one. A consumer that
ignores the field draws the correct polygon two or three times over — identical
pixels, no gap — but should deduplicate, or paint order decides its hit test.

## Notes for consumers

- **Codes are Cyrillic.** `А` (U+0410) is *not* Latin `A` (U+0041). Always key on
  `code`, and URL-encode it in routes. `latin` exists for display and for
  ASCII-safe fallbacks only.
- The drawing itself has one label defect: the Б10 block is captioned
  `Б11 / B10`. The pipeline normalises it to `Б10 / B10`; treat `Б10` as correct.
- `white` seats are ordinary bookable seats — the flag is cosmetic (they spell
  "ЦСКА" across the В stand) and must not be confused with `type`.
- `angle` is the seat's rotation in the *drawing*, so it is non-zero for whole
  stands, not just corners (the А/В stands read at 90°). Renderers may ignore it
  and draw upright seats without breaking anything.
- **`type` is currently `STANDARD` for every seat.** Wheelchair and companion
  positions exist on the drawing but are not yet detected, so do not rely on
  `type` for accessible-seating features until the pipeline gains a detector.

## Current real data

`data/stadium.json` as extracted: **16,033 seats**, 562 rows, 25 subsectors,
835 white ("ЦСКА") seats, overview space 2294 × 1692.

(Re-derive these with `npx tsx scripts/pipeline/validate.ts data/stadium.json`,
which prints the per-sector breakdown and the white/type tallies.)

## Development fixture

`data/stadium.sample.json` is a synthetic file that satisfies this contract
exactly (22 subsectors, plausible seat grids, 11,160 seats). It exists so the
database, API and UI can be built and tested before/independently of the PDF
extraction. Generate it with:

```
node scripts/pipeline/make-sample.mjs
```

Seeding picks `data/stadium.json` when present and falls back to
`data/stadium.sample.json`, so the app is always runnable.
