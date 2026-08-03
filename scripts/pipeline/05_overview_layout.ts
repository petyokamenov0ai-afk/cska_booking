#!/usr/bin/env tsx
/**
 * Overview layout — rebuilds the block outlines in `data/stadium.json` from the club's own
 * printed sector map, `data/overview-reference.svg`.
 *
 *   npx tsx scripts/pipeline/05_overview_layout.ts
 *     [--in <path>] [--out <path>] [--reference <path>] [--dry-run] [--quiet]
 *
 * ## 22 shapes over 25 subsectors
 *
 * The reference draws 22 blocks; we hold 25 independently-numbered ones, because
 * `03_decode.py` had to split three of the drawing's regions to keep `(subsector, row,
 * seat)` unique. The overview now draws what the ticket map draws — **22 shapes** — with
 * two of them covering more than one of ours:
 *
 *     Б11 (corner wedge)  ←  Б10-2 + Б11 + Б11-2   924 seats
 *     Б6  (corner wedge)  ←  Б6    + Б6-2          805 seats
 *
 * This is a **presentation-only** merge and nothing else. All 25 subsectors stay separately
 * bookable, routable and seat-mapped: `/subsectors/Б11-2` still resolves, its level-3 seat
 * map is untouched, `stats.subsectorCount` is still 25 and the level-2 card list still
 * lists every one of them. The merge exists only because three seat maps cannot be
 * stitched into one — each subsector's seats live in its OWN local coordinate space and
 * this file records no local→overview transform, so a merged seat map is not derivable
 * without re-running the Python pipeline.
 *
 * Every member of a group carries the same `svgPath`, the same `centroid` and an
 * `overviewGroup` naming the block. A consumer that ignores `overviewGroup` draws the
 * correct polygon two or three times over — identical pixels, no gap; the map component
 * deduplicates so the hit test is not decided by paint order.
 *
 * ## Why it is safe to rewrite these numbers at all
 *
 * `svgPath` and `centroid` are purely presentational. Level-3 seat maps are drawn from
 * subsector-LOCAL `seats[].x/y`, which this file never reads and never writes; nothing
 * about booking, seat identity or availability depends on a vertex here. The blast radius
 * is the block silhouettes on the overview, `SectorZoom`'s framing rect, and the caption
 * sizes `OverviewMap.fitLabelSize` derives from `pathMetrics().fill`.
 *
 * ## What replaced what
 *
 * `04_emit.py` traces the outlines out of a rasterised label field, so its walls wobble and
 * its corners arrive as 16–18 tiny chords. `05_regularise.ts` (deleted) existed to put a
 * straightness prior back by fitting a two-ring annulus to those hulls — an inference about
 * what the drawing meant. The reference *is* the drawing: 22 hand-authored polygons,
 * straight by construction, from the system that actually sells these seats. It is not
 * chained after this stage because re-fitting an annulus to reference outlines would
 * silently undo them.
 *
 * An earlier draft of this stage went the other way and *split* the two reference wedges
 * into 25 shapes along cut lines derived from the seat clouds. That is gone: the cuts were
 * ours, not the drawing's, and the user's decision is that the overview shows the map the
 * ticket system prints. No fitted or empirical constant survives in this file — every
 * number below is a guard rail, not a parameter.
 *
 * ## The invariant that must not break
 *
 * The 22 rings are one gap-free, overlap-free partition of the bowl annulus. A hairline
 * between two blocks is invisible at level 1 and glaring at level-2 zoom. This is made true
 * *structurally*, not checked afterwards: every coordinate is interned once into a shared
 * node table keyed on its 1-decimal grid position, and a ring is an array of node *ids*.
 * Two blocks that share a boundary share the ids, so the coordinate is looked up rather
 * than recomputed and a disagreement between the two owners of a seam is not representable.
 * The ledger / T-junction / loop / area checks below then confirm it on the final rounded
 * polygons, which is where a bug would actually show.
 *
 * ## Idempotence
 *
 * The output is a pure function of the reference SVG, `BLOCKS`, `overview.pitch` and the 25
 * `code`/`order` values — none of which this stage writes. The draft's one feedback path
 * (`--calibrate`, which read `centroid`, a value this stage overwrites) is gone with the
 * splitting. That is still proved rather than argued: the whole transform runs twice in
 * process and the bytes must match before anything is written.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * Frozen constants — guard rails, every one of them
 * ------------------------------------------------------------------ */

/** The grid every emitted coordinate lives on, and the grid nodes are interned on. */
const GRID = 0.1;

/** Shortest tolerable edge. A shorter one means two nodes nearly collided on the grid. */
const MIN_SEGMENT = 4.0;

/** Sharpest tolerable interior angle. Anything sharper is a spike, not a block corner. */
const MIN_ANGLE_DEG = 5.0;

/** Two nodes closer than this were one node before rounding, and the seam is about to tear. */
const MIN_NODE_GAP = 2.0;

/** A caption anchored closer than this to its own edge would overhang it. */
const CENTROID_CLEARANCE = 20.0;

/** Minimum air between a block and the drawn pitch rectangle. */
const PITCH_CLEARANCE = 20.0;

/** Anisotropy budget. Beyond this the reference is not a picture of this stadium. */
const MAX_ANISOTROPY = 0.005;

/** How far Σ block area may miss the traced annulus before a sliver is being hidden. */
const AREA_TOLERANCE = 1.0;

/** A node this close to a foreign edge's interior is on it — a T-junction, not a neighbour. */
const TJUNCTION_EPS = 0.05;

/** Seat density band, as a multiple of the stadium mean. Outside it: warn, never block. */
const DENSITY_LO = 0.6;
const DENSITY_HI = 1.4;

/**
 * The 22 Cyrillic codes the reference must carry, in ring order. Read from `<title>`, never
 * from `<g id>`: the ids are Latin transliterations produced downstream of the Cyrillic
 * name, and the drawing they came from has a known captioning defect (docs/PIPELINE.md), so
 * the Cyrillic title is the only unambiguous key.
 */
const REF_CODES = [
  'А1', 'А2', 'А3', 'А4', 'А5',
  'Б6', 'Б7', 'Б8', 'Б9', 'Б10', 'Б11',
  'В12', 'В13', 'В14', 'В15', 'В16',
  'Г17', 'Г18', 'Г19', 'Г20', 'Г21', 'Г22',
] as const;

/** The four reference blocks drawn as 7-vertex corner wedges; the other 18 have 4 vertices. */
const REF_WEDGES = new Set(['Б6', 'Б11', 'Г17', 'Г22']);

/**
 * The 22 shapes the overview draws, and which of our subsectors each covers.
 *
 * `block` is ALWAYS the code of one of its own members (asserted, K1) — that is what makes
 * `overviewGroup` self-consistent and lets a member find itself in its own group.
 * `members` are in `order`, asserted contiguous (K3).
 *
 * The two multi-member entries exist because `03_decode.py` synthesised `-2` suffixes that
 * split seat clouds the printed ticket map never split. This is PRESENTATION ONLY: all 25
 * subsectors stay separately bookable, routable and seat-mapped. See docs/DATA_CONTRACT.md.
 */
const BLOCKS: ReadonlyArray<{ block: string; members: readonly string[] }> = [
  { block: 'А1', members: ['А1'] },
  { block: 'А2', members: ['А2'] },
  { block: 'А3', members: ['А3'] },
  { block: 'А4', members: ['А4'] },
  { block: 'А5', members: ['А5'] },
  // Grouping A — as decided by the user. To adopt the measured alternative (our Б6-2 lies
  // ~95 % inside reference Б7, not Б6 — see docs/PIPELINE.md and warning W3), swap these
  // two lines to:
  //   { block: 'Б6', members: ['Б6'] },
  //   { block: 'Б7', members: ['Б6-2', 'Б7'] },
  // Nothing else in this stage, the types, the components or the assertions changes; both
  // forms satisfy K1–K5.
  { block: 'Б6', members: ['Б6', 'Б6-2'] },              // orders 6,7     — 805 seats
  { block: 'Б7', members: ['Б7'] },
  { block: 'Б8', members: ['Б8'] },
  { block: 'Б9', members: ['Б9'] },
  { block: 'Б10', members: ['Б10'] },
  { block: 'Б11', members: ['Б10-2', 'Б11', 'Б11-2'] },  // orders 12,13,14 — 924 seats
  { block: 'В12', members: ['В12'] },
  { block: 'В13', members: ['В13'] },
  { block: 'В14', members: ['В14'] },
  { block: 'В15', members: ['В15'] },
  { block: 'В16', members: ['В16'] },
  { block: 'Г17', members: ['Г17'] },
  { block: 'Г18', members: ['Г18'] },
  { block: 'Г19', members: ['Г19'] },
  { block: 'Г20', members: ['Г20'] },
  { block: 'Г21', members: ['Г21'] },
  { block: 'Г22', members: ['Г22'] },
];

/**
 * The recorded containment finding, printed when it cannot be re-measured (see W3).
 *
 * Measured once against a pristine `04_emit.py` output, by reconstructing each block's seat
 * cloud in overview space and testing it against the reference polygons. It is not
 * re-derivable from a file this stage has already written, because the derivation anchors
 * on `centroid` — the seat mean — and this stage replaces that with the polygon anchor.
 */
const RECORDED_CONTAINMENT =
  'Б6-2 sits 86–92 % inside reference Б7 and only 8–14 % inside reference Б6, the block it is ' +
  'now drawn as part of. (The other grouping is the measured one: Б10-2 is 87–93 % inside ' +
  'reference Б11, Б11-2 92–98 %.)';

/* ------------------------------------------------------------------ *
 * Small geometry
 * ------------------------------------------------------------------ */

interface XY {
  x: number;
  y: number;
}

const round1 = (v: number): number => Math.round(v * (1 / GRID)) / (1 / GRID);
const round2 = (p: XY): XY => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

/** Twice the signed area. Positive means clockwise on screen, because y grows downward. */
function shoelace2(ring: readonly XY[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

const area = (ring: readonly XY[]): number => Math.abs(shoelace2(ring)) / 2;

/**
 * Shoelace *area* centroid — winding-agnostic, because the signed area appears in both
 * numerator and denominator, so Г17 and Г22 need no special case.
 *
 * This is the reference's own convention rather than an approximation of it: its `lbl-cyr`
 * anchors reproduce each polygon's area centroid to |Δx| ≤ 0.06 with a constant +2 unit
 * vertical offset for the two-line caption, i.e. the SVG was machine-generated from area
 * centroids. Computing it therefore reproduces the ticket system's own label placement —
 * which is why the `<text>` anchors are read only to confirm that, and then discarded.
 */
function areaCentroid(ring: readonly XY[]): XY {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

function pointInPolygon(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance from `p` to segment `a`–`b`, and the clamped parameter along it. */
function pointSegment(p: XY, a: XY, b: XY): { dist: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { dist: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t };
}

function distToRing(p: XY, ring: readonly XY[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(best, pointSegment(p, ring[i], ring[(i + 1) % ring.length]).dist);
  }
  return best;
}

function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const on = (p: XY, q: XY, r: XY): boolean =>
    Math.abs(o(p, q, r)) < 1e-9 &&
    Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 &&
    Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

/** True when no two non-adjacent edges of the ring touch. */
function isSimple(ring: readonly XY[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegment(a, c, d).dist,
    pointSegment(b, c, d).dist,
    pointSegment(c, a, b).dist,
    pointSegment(d, a, b).dist,
  );
}

/** Smallest interior angle of the ring, in degrees. */
function minInteriorAngle(ring: readonly XY[]): number {
  let best = 180;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[(i + ring.length - 1) % ring.length];
    const q = ring[i];
    const r = ring[(i + 1) % ring.length];
    const a = Math.atan2(p.y - q.y, p.x - q.x);
    const b = Math.atan2(r.y - q.y, r.x - q.x);
    let d = Math.abs(a - b) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    best = Math.min(best, d);
  }
  return best;
}

const bbox = (pts: readonly XY[]): { x: number; y: number; w: number; h: number } => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
};

/**
 * Deepest interior point of a ring, to 2 dp — the fallback anchor when a block's area
 * centroid does not clear its own edges. Coarse grid over the bounding box, then six
 * halvings around the best cell; deterministic, so it cannot make a run non-idempotent.
 *
 * Unreachable on today's reference (every block clears by ≥ 4.4×) and specified anyway, so
 * that a redrawn genuinely-concave wedge has a defined answer instead of a runtime decision.
 */
function poleOfInaccessibility(ring: readonly XY[]): XY {
  const b = bbox(ring);
  const clearance = (p: XY): number => (pointInPolygon(p, ring) ? distToRing(p, ring) : -Infinity);
  let step = Math.min(b.w, b.h) / 8;
  let best = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let bestC = clearance(best);
  for (let x = b.x; x <= b.x + b.w; x += step) {
    for (let y = b.y; y <= b.y + b.h; y += step) {
      const c = clearance({ x, y });
      if (c > bestC) {
        bestC = c;
        best = { x, y };
      }
    }
  }
  for (let round = 0; round < 6; round += 1) {
    step /= 2;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const p = { x: best.x + dx * step, y: best.y + dy * step };
        const c = clearance(p);
        if (c > bestC) {
          bestC = c;
          best = p;
        }
      }
    }
  }
  return round2(best);
}

/* ------------------------------------------------------------------ *
 * Reference parsing
 * ------------------------------------------------------------------ */

const REF_POLYGON = /<polygon class="sector" points="([^"]+)"><title>([^<]+)<\/title>/g;
const REF_GROUP = /<g id="sector-([A-Za-z0-9]+)">/g;
const REF_LABEL = /<text class="lbl lbl-cyr" x="([\d.]+)" y="([\d.]+)">([^<]+)<\/text>/g;
const REF_PITCH = /<g id="pitch">\s*<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/;

interface Reference {
  rings: Map<string, XY[]>;
  order: string[];
  ids: string[];
  /** `lbl-cyr` anchors, in reference space. Read to confirm the centroid rule, then dropped. */
  labels: Map<string, XY>;
  pitch: { x: number; y: number; w: number; h: number };
}

function parseReference(svg: string): Reference {
  const rings = new Map<string, XY[]>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  REF_POLYGON.lastIndex = 0;
  while ((m = REF_POLYGON.exec(svg)) !== null) {
    const cyr = m[2].split('/')[0].trim();
    if (rings.has(cyr)) throw new Error(`reference has two polygons titled "${cyr}"`);
    let pts = m[1]
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad point "${pair}" in ${cyr}`);
        return { x, y };
      });
    // Normalise winding to clockwise-on-screen, keeping vertex 0 fixed so ring rotation —
    // and therefore the node table and the emitted string — is stable across runs. The
    // reference draws Г17 and Г22 the other way round; leaving that alone makes four
    // perfectly good shared edges read as same-direction overlaps to the ledger, which is
    // an overlap report about orientation rather than about geometry.
    if (shoelace2(pts) < 0) pts = [pts[0], ...pts.slice(1).reverse()];
    rings.set(cyr, pts);
    order.push(cyr);
  }

  const ids: string[] = [];
  REF_GROUP.lastIndex = 0;
  while ((m = REF_GROUP.exec(svg)) !== null) ids.push(m[1]);

  const labels = new Map<string, XY>();
  REF_LABEL.lastIndex = 0;
  while ((m = REF_LABEL.exec(svg)) !== null) labels.set(m[3].trim(), { x: Number(m[1]), y: Number(m[2]) });

  const p = REF_PITCH.exec(svg);
  if (!p) throw new Error('reference has no <g id="pitch"><rect …> — cannot derive the mapping');
  return {
    rings,
    order,
    ids,
    labels,
    pitch: { x: Number(p[1]), y: Number(p[2]), w: Number(p[3]), h: Number(p[4]) },
  };
}

/** `Б11` → `B11`, the transliteration the reference uses for its `<g id>`. Warning only. */
function latinise(cyr: string): string {
  const head = { А: 'A', Б: 'B', В: 'V', Г: 'G' }[cyr[0] as 'А' | 'Б' | 'В' | 'Г'];
  return head === undefined ? cyr : head + cyr.slice(1);
}

/* ------------------------------------------------------------------ *
 * Tiling ledger
 *
 * The one check that catches a torn or doubled partition. Edges are keyed on their two
 * endpoints; an edge with two owners traversed in *opposite* directions is a shared
 * boundary, one with two owners in the *same* direction is an overlap, and anything with
 * three owners is a bug. Everything with one owner is free boundary.
 * ------------------------------------------------------------------ */

interface Ledger {
  shared: number;
  perimeter: number;
  overOwned: number;
  sameDirection: number;
  perimeterEdges: Array<[string, string]>;
}

function buildLedger(rings: ReadonlyMap<string, readonly string[]>): Ledger {
  const owners = new Map<string, string[]>();
  for (const [code, ring] of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      const dir = a < b ? '+' : '-';
      const list = owners.get(key) ?? [];
      list.push(`${code}${dir}`);
      owners.set(key, list);
    }
  }
  let shared = 0;
  let perimeter = 0;
  let overOwned = 0;
  let sameDirection = 0;
  const perimeterEdges: Array<[string, string]> = [];
  for (const [key, list] of owners) {
    if (list.length === 1) {
      perimeter += 1;
      const [a, b] = key.split(' ');
      perimeterEdges.push([a, b]);
    } else if (list.length === 2) {
      shared += 1;
      if (list[0].endsWith('+') === list[1].endsWith('+')) sameDirection += 1;
    } else {
      overOwned += 1;
    }
  }
  return { shared, perimeter, overOwned, sameDirection, perimeterEdges };
}

/**
 * A node lying in the *interior* of somebody else's edge. The ledger cannot see this — both
 * sides are single-owner edges and every count comes out right — but it renders as a wedge
 * of background exactly where the two blocks are supposed to meet. It is the one remaining
 * way a node-interned partition can still tear, so the nearest miss is reported too.
 */
function findTJunctions(
  nodes: readonly XY[],
  rings: ReadonlyMap<string, readonly number[]>,
): { count: number; nearest: number } {
  let count = 0;
  let nearest = Infinity;
  for (const ring of rings.values()) {
    for (let i = 0; i < ring.length; i += 1) {
      const ia = ring[i];
      const ib = ring[(i + 1) % ring.length];
      for (let n = 0; n < nodes.length; n += 1) {
        if (n === ia || n === ib) continue;
        const { dist, t } = pointSegment(nodes[n], nodes[ia], nodes[ib]);
        if (t > 1e-9 && t < 1 - 1e-9) {
          nearest = Math.min(nearest, dist);
          if (dist < TJUNCTION_EPS) count += 1;
        }
      }
    }
  }
  return { count, nearest };
}

/**
 * Walk the free-boundary edges. A correct bowl has exactly two closed loops — the outer wall
 * and the pitch-side ring — and every node on them has degree exactly 2. Three loops means a
 * hole opened up in the middle; a degree of 1 or 3 means the boundary branches. The ledger
 * sees neither.
 */
function perimeterLoops(edges: ReadonlyArray<[string, string]>): { loops: number[]; badDegree: number } {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  let badDegree = 0;
  for (const list of adj.values()) if (list.length !== 2) badDegree += 1;
  const seen = new Set<string>();
  const loops: number[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      size += 1;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    loops.push(size);
  }
  return { loops: loops.sort((a, b) => a - b), badDegree };
}

/** Areas of the free-boundary loops, ascending — so [inner, outer] for a healthy bowl. */
function perimeterRingAreas(edges: ReadonlyArray<[string, string]>, nodes: readonly XY[]): number[] {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<string>();
  const areas: number[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: XY[] = [];
    let prev = '';
    let cur = start;
    for (;;) {
      seen.add(cur);
      loop.push(nodes[Number(cur)]);
      const next = (adj.get(cur) ?? []).find((n) => n !== prev);
      if (next === undefined || next === start) break;
      prev = cur;
      cur = next;
    }
    areas.push(area(loop));
  }
  return areas.sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ *
 * The file shape this stage touches
 * ------------------------------------------------------------------ */

interface Subsector {
  code: string;
  latin: string;
  order: number;
  svgPath: string;
  centroid: XY;
  overviewGroup?: string;
  seatCount: number;
  seats: Array<{ x: number; y: number }>;
}

interface StadiumFile {
  overview: { width: number; height: number; viewBox: string; pitch: string };
  stats: { subsectorCount: number };
  sectors: Array<{ latin: string; code: string; subsectors: Subsector[] }>;
}

const flatten = (json: StadiumFile): Subsector[] => json.sectors.flatMap((s) => s.subsectors);

function parsePolyline(d: string, where: string): XY[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length % 2 !== 0 || nums.length < 6) {
    throw new Error(`${where}: svgPath does not look like an M/L polyline`);
  }
  const pts: XY[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: Number(nums[i]), y: Number(nums[i + 1]) });
  // Emitted paths repeat vertex 0 before Z; drop it so ring length means vertex count.
  const last = pts[pts.length - 1];
  if (Math.abs(last.x - pts[0].x) < 1e-9 && Math.abs(last.y - pts[0].y) < 1e-9) pts.pop();
  return pts;
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

interface Check {
  id: string;
  what: string;
  ok: boolean;
  detail: string;
}

class Checks {
  readonly list: Check[] = [];
  readonly warnings: string[] = [];

  add(id: string, what: string, ok: boolean, detail: string): void {
    this.list.push({ id, what, ok, detail });
  }

  warn(text: string): void {
    this.warnings.push(text);
  }

  get failed(): Check[] {
    return this.list.filter((c) => !c.ok);
  }
}

/* ------------------------------------------------------------------ *
 * The transform
 * ------------------------------------------------------------------ */

/**
 * Ref space → overview space.
 *
 * Derived at runtime from the two pitch rectangles rather than hard-coded, so that if
 * `04_emit.py` ever changes the overview extent this stage follows instead of silently
 * desynchronising. The scale is deliberately *anisotropic* (AY/AX = 1.0024):
 * `overview.pitch` is out of scope and stays exactly where it is, so forcing one uniform
 * scale would leave the bowl's inner ring out of register with the drawn pitch along one
 * axis. The price is 0.24 % aspect distortion per block — 0.7 units on a 300-unit edge —
 * well below the 1-decimal grid's visual threshold.
 */
function makeTransform(ref: Reference, ourPitch: { x: number; y: number; w: number; h: number }) {
  const AX = ourPitch.w / ref.pitch.w;
  const AY = ourPitch.h / ref.pitch.h;
  const T = (p: XY): XY => ({
    x: ourPitch.x + (p.x - ref.pitch.x) * AX,
    y: ourPitch.y + (p.y - ref.pitch.y) * AY,
  });
  return { AX, AY, T };
}

/** One drawn shape, and the subsectors it covers. */
interface Block {
  code: string;
  sector: string;
  members: Subsector[];
  /** Rounded ring, as node coordinates — the polygon the emitted string encodes exactly. */
  ring: XY[];
  d: string;
  centroid: XY;
  anchor: 'area' | 'pole';
  seats: number;
  area: number;
}

interface Built {
  nodes: XY[];
  ringIds: Map<string, number[]>;
  blocks: Block[];
  paths: Map<string, string>;
  centroids: Map<string, XY>;
  groups: Map<string, string | undefined>;
  ledger: Ledger;
  /** Worst |Δ| between a block's area centroid and the reference's own `lbl-cyr` anchor. */
  labelAgreement: { dx: number; dy: number };
}

function build(ref: Reference, json: StadiumFile, checks: Checks): Built {
  const ourPitch = bbox(parsePolyline(json.overview.pitch, 'overview.pitch'));
  const { AX, AY, T } = makeTransform(ref, ourPitch);

  checks.add('C1', 'reference pitch rect found', ref.pitch.w > 0 && ref.pitch.h > 0, `${ref.pitch.w}×${ref.pitch.h}`);
  checks.add('C2', 'overview.pitch is a rectangle', ourPitch.w > 0 && ourPitch.h > 0, `${ourPitch.w.toFixed(1)}×${ourPitch.h.toFixed(1)}`);
  checks.add(
    'C3', 'reference and overview pitches are the same shape',
    Math.abs(AX / AY - 1) <= MAX_ANISOTROPY,
    `AX ${AX.toFixed(6)}  AY ${AY.toFixed(6)}  |AX/AY−1| ${Math.abs(AX / AY - 1).toFixed(7)}`,
  );
  const corner = T({ x: ref.pitch.x + ref.pitch.w, y: ref.pitch.y + ref.pitch.h });
  const cornerErr = Math.max(
    Math.abs(corner.x - (ourPitch.x + ourPitch.w)),
    Math.abs(corner.y - (ourPitch.y + ourPitch.h)),
  );
  checks.add('C4', 'mapping reproduces overview.pitch exactly', cornerErr <= 1e-9, `max corner error ${cornerErr.toExponential(1)}`);

  /* ---- intern: one rounding, one coordinate per node ---- *
   * This is what makes a hairline gap unrepresentable rather than merely unlikely. Two
   * blocks sharing a seam share the node *ids*, so they cannot round the shared coordinate
   * differently in the last digit — there is only one copy of it. */
  const nodes: XY[] = [];
  const index = new Map<string, number>();
  const intern = (p: XY): number => {
    const x = round1(p.x);
    const y = round1(p.y);
    const key = `${x}|${y}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ x, y });
      index.set(key, id);
    }
    return id;
  };

  const ringIds = new Map<string, number[]>();
  for (const { block } of BLOCKS) {
    const src = ref.rings.get(block);
    if (!src) throw new Error(`reference is missing block ${block}`);
    const ids: number[] = [];
    // T() in exact float64 is the only geometric operation applied to a reference vertex.
    for (const p of src.map(T)) {
      const id = intern(p);
      if (ids.length === 0 || ids[ids.length - 1] !== id) ids.push(id);
    }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    ringIds.set(block, ids);
  }

  const ledger = buildLedger(new Map([...ringIds].map(([c, r]) => [c, r.map(String)])));

  /* ---- fan out 22 → 25 ---- *
   * The path is formatted ONCE per block and the same string object handed to every member,
   * so "all members carry a byte-identical svgPath" is a property of this code rather than
   * something a downstream check has to hope for. Same for the centroid point. */
  const byCode = new Map(flatten(json).map((s) => [s.code, s]));
  const sectorOf = new Map<string, string>();
  for (const sec of json.sectors) for (const sub of sec.subsectors) sectorOf.set(sub.code, sec.code);

  const blocks: Block[] = [];
  const paths = new Map<string, string>();
  const centroids = new Map<string, XY>();
  const groups = new Map<string, string | undefined>();
  let worstDx = 0;
  let worstDy = 0;

  for (const { block, members } of BLOCKS) {
    const ring = ringIds.get(block)!.map((i) => nodes[i]);
    const d = formatPath(ring);
    // Centroid of the ROUNDED ring, so it is recoverable from `svgPath` alone by any
    // validator and cannot drift from the polygon the file actually draws.
    let centroid = round2(areaCentroid(ring));
    let anchor: 'area' | 'pole' = 'area';
    if (!pointInPolygon(centroid, ring) || distToRing(centroid, ring) < CENTROID_CLEARANCE) {
      centroid = poleOfInaccessibility(ring);
      anchor = 'pole';
    }

    const lbl = ref.labels.get(block);
    if (lbl) {
      // Reference space, and the reference nudges the two-line caption down by a constant 2.
      const exact = areaCentroid(ref.rings.get(block)!);
      worstDx = Math.max(worstDx, Math.abs(exact.x - lbl.x));
      worstDy = Math.max(worstDy, Math.abs(exact.y - (lbl.y - 2.0)));
    }

    const resolved = members.map((code) => {
      const sub = byCode.get(code);
      if (!sub) throw new Error(`block ${block} names a subsector the file does not have: ${code}`);
      return sub;
    });
    for (const sub of resolved) {
      paths.set(sub.code, d);
      centroids.set(sub.code, centroid);
      groups.set(sub.code, members.length > 1 ? block : undefined);
    }
    blocks.push({
      code: block,
      sector: sectorOf.get(block) ?? '?',
      members: resolved,
      ring,
      d,
      centroid,
      anchor,
      seats: resolved.reduce((a, s) => a + s.seatCount, 0),
      area: area(ring),
    });
  }

  return { nodes, ringIds, blocks, paths, centroids, groups, ledger, labelAgreement: { dx: worstDx, dy: worstDy } };
}

/* ------------------------------------------------------------------ *
 * Emission
 * ------------------------------------------------------------------ */

/**
 * One decimal, and vertex 0 repeated before `Z` — the convention already in the file.
 * The decimal count is not cosmetic: it is the same grid the nodes were interned on, so the
 * text is a lossless record of the node table and any validator can recover the exact
 * partition by re-reading it.
 */
function formatPath(ring: readonly XY[]): string {
  const f = (n: number): string => {
    const r = Math.round(n * 10) / 10;
    return (Object.is(r, -0) ? 0 : r).toFixed(1);
  };
  const parts = ring.map((p, i) => `${i === 0 ? 'M' : 'L'} ${f(p.x)} ${f(p.y)}`);
  parts.push(`L ${f(ring[0].x)} ${f(ring[0].y)}`, 'Z');
  return parts.join(' ');
}

/**
 * Python's `float.__repr__`, which is what wrote every other number in this file. Both
 * languages print shortest-round-trip, so they agree everywhere except on integral values,
 * where Python writes `758` as `758.0`.
 */
function pyFloat(v: number): string {
  const r = Math.round(v * 100) / 100;
  const s = String(Object.is(r, -0) ? 0 : r);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/**
 * `svgPath` and `centroid` are adjacent in the emitted JSON and `overviewGroup` goes
 * immediately after them, so matching all three as one literal *proves* that adjacency
 * instead of assuming it — a positional mix-up between independent 25-element passes becomes
 * impossible. The group suffix is optional on the way in and unconditionally regenerated on
 * the way out: that is what makes a second run a no-op, and what lets a block become grouped
 * or ungrouped without orphaning a key.
 *
 * The file is spliced rather than re-serialised because `JSON.stringify` does not reproduce
 * `json.dumps`' 1.5 MB byte for byte, and a presentational fix has no business rewriting
 * 16 447 seats' worth of unrelated numbers or reordering a single key.
 */
const LITERAL =
  /"svgPath":"([^"]*)","centroid":\{"x":(-?[\d.eE+-]+),"y":(-?[\d.eE+-]+)\}(?:,"overviewGroup":"([^"]*)")?/g;

function splice(
  raw: string,
  codes: readonly string[],
  paths: ReadonlyMap<string, string>,
  centroids: ReadonlyMap<string, XY>,
  groups: ReadonlyMap<string, string | undefined>,
): string {
  let i = 0;
  LITERAL.lastIndex = 0;
  const next = raw.replace(LITERAL, () => {
    if (i >= codes.length) throw new Error('more literals in the file than subsectors');
    const code = codes[i];
    i += 1;
    const c = centroids.get(code)!;
    const g = groups.get(code);
    return (
      `"svgPath":"${paths.get(code)!}","centroid":{"x":${pyFloat(c.x)},"y":${pyFloat(c.y)}}` +
      (g === undefined ? '' : `,"overviewGroup":"${g}"`)
    );
  });
  if (i !== codes.length) throw new Error(`replaced ${i} literals but have ${codes.length} subsectors`);
  return next;
}

/**
 * Both texts with every literal blanked to one constant — group suffix included, so this
 * still proves nothing else moved even when a group key is added or removed.
 */
function mask(text: string): string {
  LITERAL.lastIndex = 0;
  return text.replace(LITERAL, '"svgPath":" ","centroid":{"x":0,"y":0}');
}

/**
 * How many *leaves* differ between two parses — 75 at most: 25 paths, 25 centroid pairs and
 * 25 group fields, counted one each. Returns -1 when anything outside the spliced literals
 * moved, which is the failure this exists to catch.
 */
function countLeafDiffs(a: string, b: string): number {
  const pa = flatten(JSON.parse(a) as StadiumFile);
  const pb = flatten(JSON.parse(b) as StadiumFile);
  if (pa.length !== pb.length) return -1;
  let n = 0;
  for (let i = 0; i < pa.length; i += 1) {
    if (pa[i].svgPath !== pb[i].svgPath) n += 1;
    if (pa[i].centroid.x !== pb[i].centroid.x || pa[i].centroid.y !== pb[i].centroid.y) n += 1;
    if ((pa[i].overviewGroup ?? null) !== (pb[i].overviewGroup ?? null)) n += 1;
  }
  const strip = (s: string): string => {
    LITERAL.lastIndex = 0;
    return s.replace(LITERAL, '');
  };
  return strip(a) === strip(b) ? n : -1;
}

/**
 * A visual check nobody reads programmatically. It used to be emitted by `04_emit.py` next
 * to `stadium.json`; now that the outlines come from here instead, it is written here, or it
 * would go on disagreeing with the map the app actually draws.
 *
 * **22** paths, not 25: three stacked identical copies of the Б11 wedge would be a new way
 * of being stale. `data-members` is what makes the merge readable at a glance.
 */
function overviewSvg(json: StadiumFile, blocks: readonly Block[]): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${json.overview.viewBox}">`,
    '  <!-- generated by scripts/pipeline/05_overview_layout.ts from data/overview-reference.svg -->',
    '  <!-- debug artifact: nothing reads this, it exists to be looked at -->',
    '  <!-- 22 shapes over 25 subsectors; see data-members -->',
    '  <g id="pitch">',
    `    <path d="${json.overview.pitch}" fill="#e8f3e8" stroke="#b9d6b9" stroke-width="3"/>`,
    '  </g>',
  ];
  for (const sec of json.sectors) {
    parts.push(`  <g id="sector-${sec.latin}" data-code="${sec.code}">`);
    for (const block of blocks.filter((b) => b.sector === sec.code)) {
      const lead = block.members.find((m) => m.code === block.code) ?? block.members[0];
      parts.push(
        `    <path id="${lead.latin}" data-code="${block.code}" data-latin="${lead.latin}" ` +
          `data-members="${block.members.map((m) => m.code).join(' ')}" data-seats="${block.seats}" ` +
          `d="${block.d}" fill="#c9302c" stroke="#fff" stroke-width="2"/>`,
        `    <circle cx="${pyFloat(block.centroid.x)}" cy="${pyFloat(block.centroid.y)}" r="6" fill="#fff" opacity=".8"/>`,
      );
    }
    parts.push('  </g>');
  }
  parts.push('</svg>', '');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Verification — every check here blocks the write
 * ------------------------------------------------------------------ */

function verify(json: StadiumFile, built: Built, checks: Checks, ref: Reference): void {
  const subs = flatten(json);
  const { nodes, ringIds, blocks, ledger } = built;

  /* ---- identity ---- */
  const codes = subs.map((s) => s.code);
  const expected = BLOCKS.flatMap((b) => b.members);
  checks.add(
    'J1', 'the file holds exactly the 25 subsectors BLOCKS names, in the same order',
    codes.length === 25 && codes.join('|') === expected.join('|'), `${codes.length} subsectors`,
  );
  checks.add('J2', 'stats.subsectorCount still agrees', json.stats.subsectorCount === 25, String(json.stats.subsectorCount));

  const orderOk = subs.every((s, i) => s.order === i + 1);
  checks.add('D1', 'document order equals order 1…25', orderOk, orderOk ? '1…25' : subs.map((s) => s.order).join(','));

  checks.add(
    'K1', 'every block code is the code of one of its own members',
    BLOCKS.every((b) => b.members.includes(b.block)),
    BLOCKS.filter((b) => !b.members.includes(b.block)).map((b) => b.block).join(',') || 'all 22',
  );
  checks.add(
    'K2', 'no block spans two stands',
    blocks.every((b) => b.members.every((m) => m.code[0] === b.code[0])),
    blocks.filter((b) => !b.members.every((m) => m.code[0] === b.code[0])).map((b) => b.code).join(',') || 'all 22',
  );
  const grouped = blocks.filter((b) => b.members.length > 1);
  const contiguous = grouped.every((b) => b.members.every((m, i) => i === 0 || m.order === b.members[i - 1].order + 1));
  checks.add(
    'K3', "each block's members are contiguous in order",
    contiguous, grouped.map((b) => `${b.code} = ${b.members.map((m) => m.order).join(',')}`).join(' · '),
  );
  const distinctGroups = new Set(subs.map((s) => built.groups.get(s.code) ?? s.code)).size;
  const distinctPaths = new Set([...built.paths.values()]).size;
  checks.add(
    'K4', 'deduplicating by overviewGroup draws exactly 22 shapes',
    distinctGroups === 22 && distinctPaths === 22, `${distinctGroups} group keys · ${distinctPaths} distinct paths`,
  );
  const drifted = blocks.filter((b) =>
    b.members.some((m) => built.paths.get(m.code) !== b.d ||
      built.centroids.get(m.code)!.x !== b.centroid.x || built.centroids.get(m.code)!.y !== b.centroid.y));
  checks.add(
    'K5', 'every member of a block carries a byte-identical path and an equal centroid',
    drifted.length === 0, drifted.map((b) => b.code).join(',') || 'identical by construction',
  );

  /* ---- tiling ---- */
  checks.add(
    'F1', 'every seam has exactly two owners, in opposite directions',
    ledger.overOwned === 0 && ledger.sameDirection === 0 && ledger.shared === 22,
    `${ledger.shared} shared · ${ledger.perimeter} free · ${ledger.overOwned} over-owned · ${ledger.sameDirection} same-direction`,
  );
  const tj = findTJunctions(nodes, ringIds);
  checks.add(
    'F2', 'no node lies in the interior of another block edge',
    tj.count === 0, `${tj.count} T-junctions · nearest node-to-foreign-edge ${tj.nearest.toFixed(2)} u`,
  );
  if (tj.nearest < 1.0) checks.warn(`a node passes within ${tj.nearest.toFixed(3)} u of a foreign edge — one nudge from a tear`);
  const { loops, badDegree } = perimeterLoops(ledger.perimeterEdges);
  checks.add(
    'F3', 'the free boundary closes into exactly two loops',
    loops.length === 2 && badDegree === 0, `loops [${loops.join(', ')}] · ${badDegree} node(s) of wrong degree`,
  );
  const total = blocks.reduce((a, b) => a + b.area, 0);
  const loopAreas = perimeterRingAreas(ledger.perimeterEdges, nodes);
  const annulus = loopAreas[loopAreas.length - 1] - loopAreas[0];
  checks.add(
    'F4', 'block areas sum to the annulus they tile',
    Math.abs(total - annulus) <= AREA_TOLERANCE,
    `Σ ${total.toFixed(1)} vs ${annulus.toFixed(1)} (Δ ${(total - annulus).toFixed(3)} u²)`,
  );

  /* ---- shape sanity ---- */
  let minSeg = Infinity;
  let minAngle = 180;
  let nonSimple = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.ring.length; i += 1) {
      const p = b.ring[i];
      const q = b.ring[(i + 1) % b.ring.length];
      minSeg = Math.min(minSeg, Math.hypot(q.x - p.x, q.y - p.y));
    }
    minAngle = Math.min(minAngle, minInteriorAngle(b.ring));
    if (!isSimple(b.ring)) nonSimple += 1;
  }
  checks.add('G1', 'no hairline edges', minSeg >= MIN_SEGMENT, `shortest ${minSeg.toFixed(2)} u`);
  checks.add(
    'G2', 'no spikes and no self-intersections',
    minAngle >= MIN_ANGLE_DEG && nonSimple === 0,
    `min interior angle ${minAngle.toFixed(2)}° · ${nonSimple} self-intersecting`,
  );
  let minNodeGap = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      minNodeGap = Math.min(minNodeGap, Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y));
    }
  }
  checks.add(
    'E1', 'no two nodes nearly collided on the grid',
    minNodeGap >= MIN_NODE_GAP, `${nodes.length} nodes, closest pair ${minNodeGap.toFixed(2)} u`,
  );

  /* ---- containment ---- */
  const W = json.overview.width;
  const H = json.overview.height;
  const all = blocks.flatMap((b) => b.ring);
  const bb = bbox(all);
  const inBox = all.every((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H);
  checks.add(
    'H2', 'every vertex is inside the overview box', inBox,
    `x ${bb.x.toFixed(1)}…${(bb.x + bb.w).toFixed(1)}  y ${bb.y.toFixed(1)}…${(bb.y + bb.h).toFixed(1)}  of ${W}×${H}`,
  );
  const margin = Math.min(bb.x, bb.y, W - (bb.x + bb.w), H - (bb.y + bb.h));
  if (margin < 5) checks.warn(`bowl clears the canvas edge by only ${margin.toFixed(2)} u — never pad a block outward`);

  const pitch = bbox(parsePolyline(json.overview.pitch, 'overview.pitch'));
  const pitchRing: XY[] = [
    { x: pitch.x, y: pitch.y }, { x: pitch.x + pitch.w, y: pitch.y },
    { x: pitch.x + pitch.w, y: pitch.y + pitch.h }, { x: pitch.x, y: pitch.y + pitch.h },
  ];
  let minPitch = Infinity;
  let overlaps = 0;
  for (const b of blocks) {
    if (b.ring.some((p) => pointInPolygon(p, pitchRing)) || pitchRing.some((p) => pointInPolygon(p, b.ring))) {
      overlaps += 1;
    }
    for (let i = 0; i < b.ring.length; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        minPitch = Math.min(
          minPitch,
          segmentDistance(b.ring[i], b.ring[(i + 1) % b.ring.length], pitchRing[j], pitchRing[(j + 1) % 4]),
        );
      }
    }
  }
  checks.add(
    'H1', 'no block touches the pitch',
    overlaps === 0 && minPitch >= PITCH_CLEARANCE, `${overlaps} overlapping · closest approach ${minPitch.toFixed(2)} u`,
  );

  /* ---- captions ---- */
  let worstClear = Infinity;
  let worstCode = '';
  let outside = 0;
  for (const b of blocks) {
    if (!pointInPolygon(b.centroid, b.ring)) outside += 1;
    const d = distToRing(b.centroid, b.ring);
    if (d < worstClear) {
      worstClear = d;
      worstCode = b.code;
    }
  }
  checks.add(
    'I1', 'every anchor sits strictly inside its own block, clear of the edges',
    outside === 0 && worstClear >= CENTROID_CLEARANCE, `${outside} outside · tightest ${worstCode} at ${worstClear.toFixed(2)} u`,
  );
  const contractOk = [...built.paths.values()].every((d) => /^\s*[Mm]/.test(d) && /[Zz]\s*$/.test(d));
  const centroidsInBox = [...built.centroids.values()].every((c) => c.x >= 0 && c.x <= W && c.y >= 0 && c.y <= H);
  checks.add(
    'I2', 'contract test would pass (M…Z paths, centroids in box)',
    contractOk && centroidsInBox && built.paths.size === 25, `${built.paths.size}/25 subsectors`,
  );

  /* ---- reference sanity, reported last because it is upstream of everything ---- */
  checks.add('A1', 'reference has the 22 expected blocks, keyed by <title>', ref.order.join('|') === REF_CODES.join('|'), `${ref.order.length} polygons`);
  const shapes = [...ref.rings].every(([c, r]) => (REF_WEDGES.has(c) ? r.length === 7 : r.length === 4));
  checks.add(
    'A2', 'reference shapes are unchanged (18 four-vertex, 4 seven-vertex wedges)',
    shapes, [...ref.rings].map(([c, r]) => `${c}:${r.length}`).join(' '),
  );
  const idMismatch = ref.order.filter((c, i) => latinise(c) !== ref.ids[i]);
  if (idMismatch.length > 0) checks.warn(`W1  <g id> disagrees with <title> for ${idMismatch.join(', ')} — the title wins`);
  const refLedger = buildLedger(new Map([...ref.rings].map(([c, r]) => [c, r.map((p) => `${p.x},${p.y}`)])));
  checks.add(
    'B1', 'the reference itself tiles exactly',
    refLedger.shared === 22 && refLedger.perimeter === 56 && refLedger.overOwned === 0 && refLedger.sameDirection === 0,
    `${refLedger.shared} shared · ${refLedger.perimeter} free · ${refLedger.overOwned} over-owned · ${refLedger.sameDirection} same-direction`,
  );
  const refNodes: XY[] = [];
  const refIdx = new Map<string, number>();
  const refRings = new Map<string, number[]>();
  for (const [c, r] of ref.rings) {
    refRings.set(c, r.map((p) => {
      const k = `${p.x},${p.y}`;
      let id = refIdx.get(k);
      if (id === undefined) {
        id = refNodes.length;
        refNodes.push(p);
        refIdx.set(k, id);
      }
      return id;
    }));
  }
  const refTj = findTJunctions(refNodes, refRings);
  checks.add('B2', 'the reference has no T-junctions', refTj.count === 0, `${refTj.count} · nearest ${refTj.nearest.toFixed(2)} ref units`);
}

/* ------------------------------------------------------------------ *
 * Non-blocking warnings — the standing record of the grouping trade-off
 * ------------------------------------------------------------------ */

/**
 * W2 — seats per unit area, against the stadium mean.
 *
 * Fires every run under the decided grouping, and is deliberately non-blocking: it exists so
 * the trade-off stays visible in the log rather than resurfacing later as a suspected
 * regression. Grouping moves seats between neighbours on paper without moving them on the
 * ground — Б6-2's 229 seats are *drawn* in Б6 while they physically sit in the reference's
 * Б7 — so an adjacent high/low pair is the signature of a grouping choice. A lone outlier is
 * not: А4 is simply a sparse block in the drawing itself and reads low with or without any
 * of this.
 */
function densityWarnings(blocks: readonly Block[], checks: Checks): Map<string, number> {
  const totalSeats = blocks.reduce((a, b) => a + b.seats, 0);
  const totalArea = blocks.reduce((a, b) => a + b.area, 0);
  const mean = totalSeats / totalArea;
  const ratios = new Map<string, number>();
  const off: string[] = [];
  for (const b of blocks) {
    const r = b.seats / b.area / mean;
    ratios.set(b.code, r);
    if (r < DENSITY_LO || r > DENSITY_HI) off.push(`${b.code} ${r.toFixed(2)}×`);
  }
  if (off.length > 0) {
    checks.warn(
      `W2  seat density outside ${DENSITY_LO}–${DENSITY_HI}× the stadium mean: ${off.join(', ')} — non-blocking; ` +
        'an adjacent high/low pair is the signature of a grouping choice, a lone outlier is the drawing',
    );
  }
  return ratios;
}

/**
 * W3 — how much of each member's seat cloud actually falls inside the block it is drawn as
 * part of.
 *
 * Only measurable against a file whose `centroid` is still the seat mean `04_emit.py` wrote:
 * seats are stored in subsector-LOCAL coordinates and this file records no local→overview
 * transform, so the cloud can only be reconstructed by anchoring it on that mean — which
 * this stage overwrites with the polygon anchor. On an already-laid-out file the recorded
 * finding is printed instead, explicitly labelled as recorded rather than re-measured, so
 * the log never claims a measurement it did not make.
 */
function containmentWarning(json: StadiumFile, built: Built, ref: Reference, checks: Checks): void {
  const subs = flatten(json);
  const drift = Math.max(...subs.map((s) => {
    const c = areaCentroid(parsePolyline(s.svgPath, s.code));
    return Math.max(Math.abs(c.x - s.centroid.x), Math.abs(c.y - s.centroid.y));
  }));
  if (drift < 0.05) {
    checks.warn(`W3  recorded (not re-measured — this file's centroids are polygon anchors): ${RECORDED_CONTAINMENT}`);
    return;
  }

  // `s` — the local→overview scale — is one number for the whole bowl (04_emit.py divides a
  // globally constant seat pitch into LOCAL_PITCH_X) but is written down nowhere, so the
  // cloud is swept across its plausible range and only the best case is reported. A member
  // that is outside its block at *every* scale is outside it, full stop.
  const ourPitch = bbox(parsePolyline(json.overview.pitch, 'overview.pitch'));
  const { T } = makeTransform(ref, ourPitch);
  const refT = new Map([...ref.rings].map(([c, r]) => [c, r.map(T)]));
  const low: string[] = [];
  for (const block of built.blocks) {
    const poly = refT.get(block.code)!;
    for (const m of block.members) {
      const mx = m.seats.reduce((a, t) => a + t.x, 0) / m.seats.length;
      const my = m.seats.reduce((a, t) => a + t.y, 0) / m.seats.length;
      const best = Math.max(...[2.9, 3.0, 3.1, 3.2, 3.3].map((s) =>
        m.seats.filter((t) =>
          pointInPolygon({ x: m.centroid.x + (t.x - mx) / s, y: m.centroid.y + (t.y - my) / s }, poly),
        ).length / m.seats.length));
      if (best < 0.6) low.push(`${m.code}→${block.code} ${(best * 100).toFixed(0)} %`);
    }
  }
  if (low.length > 0) {
    checks.warn(`W3  seat cloud mostly outside the block it is drawn as part of: ${low.join(', ')} — measured; deliberate, see BLOCKS and docs/PIPELINE.md`);
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function table(rows: string[][], right: readonly number[]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)));
  return rows.map((r) =>
    r.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd(),
  );
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

interface Cli {
  input: string;
  output: string;
  reference: string;
  dryRun: boolean;
  quiet: boolean;
}

function parseCli(argv: readonly string[]): Cli {
  const root = resolve(__dirname, '..', '..');
  let input = resolve(root, 'data', 'stadium.json');
  let output: string | null = null;
  let reference = resolve(root, 'data', 'overview-reference.svg');
  let dryRun = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') input = resolve(process.cwd(), argv[++i] ?? '');
    else if (arg === '--out') output = resolve(process.cwd(), argv[++i] ?? '');
    else if (arg === '--reference') reference = resolve(process.cwd(), argv[++i] ?? '');
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: npx tsx scripts/pipeline/05_overview_layout.ts [--in <path>] [--out <path>]');
      console.log('       [--reference <path>] [--dry-run] [--quiet]');
      process.exit(0);
    } else throw new Error(`unknown argument "${arg}"`);
  }
  return { input, output: output ?? input, reference, dryRun, quiet };
}

function main(): number {
  const cli = parseCli(process.argv.slice(2));
  for (const p of [cli.input, cli.reference]) {
    if (!existsSync(p)) {
      console.error(`05_overview_layout: no such file: ${p}`);
      return 2;
    }
  }

  const raw = readFileSync(cli.input, 'utf8');
  const json = JSON.parse(raw) as StadiumFile;
  const ref = parseReference(readFileSync(cli.reference, 'utf8'));

  console.log(`05_overview_layout: ${cli.input}`);
  console.log(`                    ← ${cli.reference} (${ref.order.length} blocks over ${flatten(json).length} subsectors)`);

  const checks = new Checks();
  const built = build(ref, json, checks);
  verify(json, built, checks, ref);
  const density = densityWarnings(built.blocks, checks);
  containmentWarning(json, built, ref, checks);

  const codes = flatten(json).map((s) => s.code);
  const text = splice(raw, codes, built.paths, built.centroids, built.groups);

  checks.add(
    'L1', 'only svgPath, centroid and overviewGroup changed anywhere in the file',
    mask(raw) === mask(text), `${codes.length} literals spliced, ${raw.length} → ${text.length} bytes`,
  );
  // At most 75 leaves — 25 paths, 25 centroid pairs, 25 group fields — and nothing else,
  // ever. Zero is not a failure: that is what re-running on an already-laid-out file looks
  // like, and demanding a change here would make the stage fail precisely when it is right.
  const leafDiffs = countLeafDiffs(raw, text);
  checks.add(
    'L2', 'the re-parsed output differs from the input only in the spliced leaves',
    leafDiffs >= 0 && leafDiffs <= 75,
    leafDiffs < 0 ? 'a leaf outside the spliced literals moved' : `${leafDiffs} of 75 leaves changed`,
  );

  // Idempotence is a property of the transform — nothing this stage writes is an input to
  // it — but it is proved rather than argued, by running the whole thing on its own output.
  const json2 = JSON.parse(text) as StadiumFile;
  const built2 = build(ref, json2, new Checks());
  const text2 = splice(text, flatten(json2).map((s) => s.code), built2.paths, built2.centroids, built2.groups);
  checks.add(
    'M1', 'idempotent — a second full pass reproduces the bytes exactly',
    text2 === text, text2 === text ? 'byte-identical' : `${[...text].filter((c, i) => c !== text2[i]).length} bytes differ`,
  );

  /* ---- per-block report ---- */
  if (!cli.quiet) {
    const rows: string[][] = [['block', 'members', 'seats', 'verts', 'area', 'centroid', 'fill', 'clear', 'density']];
    for (const b of built.blocks) {
      const box = bbox(b.ring);
      rows.push([
        b.code,
        b.members.map((m) => m.code).join(' '),
        String(b.seats),
        String(b.ring.length),
        b.area.toFixed(0),
        `${b.centroid.x.toFixed(1)},${b.centroid.y.toFixed(1)}${b.anchor === 'pole' ? ' (pole)' : ''}`,
        Math.min(1, b.area / (box.w * box.h)).toFixed(3),
        `${distToRing(b.centroid, b.ring).toFixed(1)} u`,
        `${density.get(b.code)!.toFixed(2)}×`,
      ]);
    }
    console.log('');
    for (const line of table(rows, [2, 3, 4, 5, 6, 7, 8])) console.log(`  ${line}`);

    console.log('');
    console.log(`  shapes  ${built.blocks.length} drawn over ${flatten(json).length} subsectors · ${built.blocks.filter((b) => b.members.length > 1).length} grouped`);
    console.log(`  nodes   ${built.nodes.length} interned on the ${GRID} grid · ${built.ledger.shared} shared seams · ${built.ledger.perimeter} free edges`);
    console.log(`  labels  area centroid vs the reference's own lbl-cyr anchor: |Δx| ≤ ${built.labelAgreement.dx.toFixed(3)}, |Δy−2.0| ≤ ${built.labelAgreement.dy.toFixed(3)} (ref units) — anchors read, then discarded`);
  }

  console.log('');
  const checkRows: string[][] = [['', 'check', 'result']];
  for (const c of checks.list) checkRows.push([c.ok ? 'ok  ' : 'FAIL', `${c.id} ${c.what}`, c.detail]);
  for (const line of table(checkRows, [])) console.log(`  ${line}`);
  for (const w of checks.warnings) console.log(`  warn  ${w}`);
  console.log('');

  if (checks.failed.length > 0) {
    console.error(`FAILED — ${checks.failed.length} check(s) did not hold; nothing written:`);
    for (const c of checks.failed) console.error(`    ${c.id} ${c.what}: ${c.detail}`);
    return 1;
  }

  if (cli.dryRun) {
    console.log(`  --dry-run: nothing written (would have written ${cli.output})`);
    return 0;
  }
  writeFileSync(cli.output, text, 'utf8');
  console.log(`  wrote ${cli.output}`);
  const svgPath = resolve(dirname(cli.output), 'stadium-overview.svg');
  writeFileSync(svgPath, overviewSvg(json, built.blocks), 'utf8');
  console.log(`  wrote ${svgPath} (${built.blocks.length} paths)`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  // Every throw here is a structural precondition that did not hold — a reference that
  // stopped tiling, a block naming a subsector we do not have, a splice that lost count.
  // The message names the invariant; the stack is noise in a pipeline log.
  console.error(`05_overview_layout: ${(err as Error).message}`);
  process.exit(1);
}
