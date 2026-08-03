#!/usr/bin/env tsx
/**
 * `data/stadium.json` validator — the gate between the PDF pipeline and the app.
 *
 * Asserts every invariant in `docs/DATA_CONTRACT.md`. Run it after the pipeline
 * emits geometry and before seeding; the seed trusts the file completely.
 *
 *   npx tsx scripts/pipeline/validate.ts [file] [--strict] [--quiet]
 *
 *   file      defaults to data/stadium.json, falling back to
 *             data/stadium.sample.json (same rule as lib/stadium.ts).
 *   --strict  treat warnings as errors.
 *   --quiet   suppress the success summary tables.
 *
 * Exit codes: 0 = valid · 1 = invariant violations · 2 = usage / unreadable file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import type { StadiumFile } from '../../lib/types';

/* ------------------------------------------------------------------ *
 * The expected stadium (docs/DATA_CONTRACT.md § Invariants)
 * ------------------------------------------------------------------ */

/** CYRILLIC codes: А U+0410, Б U+0411, В U+0412, Г U+0413. */
const EXPECTED_SECTORS = [
  { code: 'А', latin: 'A', order: 1 }, // А — South
  { code: 'Б', latin: 'B', order: 2 }, // Б — East
  { code: 'В', latin: 'V', order: 3 }, // В — North
  { code: 'Г', latin: 'G', order: 4 }, // Г — West
] as const;

const SUBSECTOR_NUMBERS: Record<string, readonly number[]> = {
  'А': [1, 2, 3, 4, 5],
  'Б': [6, 7, 8, 9, 10, 11],
  'В': [12, 13, 14, 15, 16],
  'Г': [17, 18, 19, 20, 21, 22],
};

/** А1…А5, Б6…Б11, В12…В16, Г17…Г22 — 22 codes, in drawing order. */
const EXPECTED_SUBSECTORS: readonly string[] = EXPECTED_SECTORS.flatMap((s) =>
  (SUBSECTOR_NUMBERS[s.code] ?? []).map((n) => `${s.code}${n}`),
);

/** Angle spread (degrees) above which a block counts as a curved corner fan. */
const CURVED_ANGLE_SPREAD = 15;

/** Tolerance for float equality on declared width/height vs viewBox. */
const EPS = 1e-6;

/* ------------------------------------------------------------------ *
 * Structural schema (zod) — shape only; semantics are checked below
 * ------------------------------------------------------------------ */

const seatSchema = z.object({
  row: z.number().int(),
  number: z.number().int(),
  x: z.number().finite(),
  y: z.number().finite(),
  angle: z.number().finite(),
  type: z.enum(['STANDARD', 'WHEELCHAIR', 'COMPANION', 'VIP']),
  white: z.boolean(),
});

const rowSchema = z.object({
  row: z.number().int(),
  count: z.number().int(),
  firstSeat: z.number().int(),
  lastSeat: z.number().int(),
});

const subsectorSchema = z.object({
  code: z.string().min(1),
  latin: z.string().min(1),
  order: z.number().int(),
  viewBox: z.string().min(1),
  width: z.number().finite(),
  height: z.number().finite(),
  pitchSide: z.enum(['top', 'bottom', 'left', 'right']),
  svgPath: z.string().min(1),
  centroid: z.object({ x: z.number().finite(), y: z.number().finite() }),
  // Optional on purpose: `asStadiumFile` below is a compile-time cross-check
  // against `lib/types.ts`, and a required field there would break it — and
  // `data/stadium.sample.json`, which draws 22 blocks over 22 subsectors and so
  // carries no groups at all.
  overviewGroup: z.string().min(1).optional(),
  seatCount: z.number().int(),
  rowCount: z.number().int(),
  rows: z.array(rowSchema),
  seats: z.array(seatSchema),
});

const sectorSchema = z.object({
  code: z.string().min(1),
  latin: z.string().min(1),
  name: z.string().min(1),
  nameBg: z.string().min(1),
  order: z.number().int(),
  subsectors: z.array(subsectorSchema),
});

const stadiumFileSchema = z.object({
  generatedAt: z.string().min(1),
  source: z.string().min(1),
  overview: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
    viewBox: z.string().min(1),
    pitch: z.string().min(1),
  }),
  stats: z.object({
    seatTotal: z.number().int(),
    subsectorCount: z.number().int(),
  }),
  sectors: z.array(sectorSchema),
});

type ParsedStadium = z.infer<typeof stadiumFileSchema>;

/**
 * Compile-time cross-check: the schema above must describe exactly the
 * `StadiumFile` the rest of the app consumes. If `lib/types.ts` and
 * `docs/DATA_CONTRACT.md` drift apart, this stops compiling.
 */
function asStadiumFile(file: ParsedStadium): StadiumFile {
  return file;
}

/* ------------------------------------------------------------------ *
 * Issue collection
 * ------------------------------------------------------------------ */

type Severity = 'error' | 'warning';

interface Issue {
  severity: Severity;
  /** Stable rule id, e.g. "duplicate-seat". Used to group the report. */
  rule: string;
  /** Where it happened, e.g. "А1 row 4". */
  where: string;
  message: string;
}

class Report {
  private readonly issues: Issue[] = [];

  error(rule: string, where: string, message: string): void {
    this.issues.push({ severity: 'error', rule, where, message });
  }

  warn(rule: string, where: string, message: string): void {
    this.issues.push({ severity: 'warning', rule, where, message });
  }

  get errors(): Issue[] {
    return this.issues.filter((i) => i.severity === 'error');
  }

  get warnings(): Issue[] {
    return this.issues.filter((i) => i.severity === 'warning');
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

function parseViewBox(viewBox: string): ViewBox | null {
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [minX, minY, width, height] = nums as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { minX, minY, width, height };
}

/** Renders a string with its codepoints, so Cyrillic/Latin homoglyphs are visible. */
function withCodepoints(s: string): string {
  const cps = [...s].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  return `"${s}" (${cps.join(' ')})`;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Groups by rule and prints at most `cap` examples per rule. */
function printIssues(issues: Issue[], label: string, cap = 12): void {
  const byRule = new Map<string, Issue[]>();
  for (const issue of issues) {
    const bucket = byRule.get(issue.rule);
    if (bucket) bucket.push(issue);
    else byRule.set(issue.rule, [issue]);
  }
  for (const [rule, list] of byRule) {
    console.error(`\n  ${label} [${rule}] × ${list.length}`);
    for (const issue of list.slice(0, cap)) {
      console.error(`    ${issue.where}: ${issue.message}`);
    }
    if (list.length > cap) {
      console.error(`    … and ${list.length - cap} more`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Semantic validation
 * ------------------------------------------------------------------ */

function validate(file: StadiumFile, report: Report): void {
  validateHeader(file, report);
  validateSectorCodes(file, report);
  validateSubsectorCodes(file, report);
  validateOverviewBlocks(file, report);

  let seatTotal = 0;
  const globalSeatKeys = new Set<string>();

  for (const sector of file.sectors) {
    for (const sub of sector.subsectors) {
      seatTotal += sub.seats.length;
      validateSubsectorGeometry(file, sector.latin, sub, report);
      validateSeats(sub, globalSeatKeys, report);
      validateRowSummaries(sub, report);
    }
  }

  if (file.stats.seatTotal !== seatTotal) {
    report.error(
      'stats-seat-total',
      'stats',
      `stats.seatTotal = ${file.stats.seatTotal} but the sectors contain ${seatTotal} seats`,
    );
  }
  const subsectorCount = file.sectors.reduce((n, s) => n + s.subsectors.length, 0);
  if (file.stats.subsectorCount !== subsectorCount) {
    report.error(
      'stats-subsector-count',
      'stats',
      `stats.subsectorCount = ${file.stats.subsectorCount} but the file contains ${subsectorCount} subsectors`,
    );
  }
}

function validateHeader(file: StadiumFile, report: Report): void {
  if (Number.isNaN(Date.parse(file.generatedAt))) {
    report.error('generated-at', 'generatedAt', `not a parseable date: "${file.generatedAt}"`);
  }

  const vb = parseViewBox(file.overview.viewBox);
  if (!vb) {
    report.error('overview-viewbox', 'overview', `unparseable viewBox "${file.overview.viewBox}"`);
    return;
  }
  if (Math.abs(vb.width - file.overview.width) > EPS || Math.abs(vb.height - file.overview.height) > EPS) {
    report.error(
      'overview-viewbox',
      'overview',
      `viewBox "${file.overview.viewBox}" disagrees with width/height ${num(file.overview.width)}×${num(file.overview.height)}`,
    );
  }
  if (!/^\s*[Mm]/.test(file.overview.pitch)) {
    report.error('pitch-path', 'overview.pitch', 'path does not start with a moveto (M)');
  }
}

function validateSectorCodes(file: StadiumFile, report: Report): void {
  const actual = file.sectors.map((s) => s.code);
  const expected: readonly string[] = EXPECTED_SECTORS.map((s) => s.code);

  for (const code of expected) {
    if (!actual.includes(code)) {
      report.error('sector-codes', 'sectors', `missing sector ${withCodepoints(code)}`);
    }
  }
  for (const code of actual) {
    if (!expected.includes(code)) {
      report.error(
        'sector-codes',
        'sectors',
        `unexpected sector ${withCodepoints(code)} — codes must be Cyrillic А Б В Г`,
      );
    }
  }
  if (new Set(actual).size !== actual.length) {
    report.error('sector-codes', 'sectors', `duplicate sector codes in [${actual.join(', ')}]`);
  }

  for (const sector of file.sectors) {
    const spec = EXPECTED_SECTORS.find((s) => s.code === sector.code);
    if (!spec) continue;
    if (sector.latin !== spec.latin) {
      report.error(
        'sector-latin',
        `sector ${sector.code}`,
        `latin = "${sector.latin}", expected "${spec.latin}"`,
      );
    }
    if (sector.order !== spec.order) {
      report.error('sector-order', `sector ${sector.code}`, `order = ${sector.order}, expected ${spec.order}`);
    }
  }
}

function validateSubsectorCodes(file: StadiumFile, report: Report): void {
  const actual = file.sectors.flatMap((s) => s.subsectors.map((sub) => sub.code));
  const seen = new Set<string>();

  for (const code of actual) {
    if (seen.has(code)) {
      report.error('subsector-codes', 'subsectors', `duplicate subsector code ${withCodepoints(code)}`);
    }
    seen.add(code);
    // A few of the drawing's 22 labelled regions contain more than one
    // independently-numbered block — inside the Б11 corner fan, for instance,
    // each block restarts at seat 1. Folding those into one code would break
    // (subsector, row, seat) uniqueness, which the whole booking model depends
    // on, so the pipeline emits them as "<parent>-2", "<parent>-3".
    const parent = code.replace(/-\d+$/, '');
    if (!EXPECTED_SUBSECTORS.includes(parent)) {
      report.error(
        'subsector-codes',
        'subsectors',
        `unexpected subsector code ${withCodepoints(code)} — expected one of ${EXPECTED_SUBSECTORS.join(', ')}` +
          ` (optionally suffixed -2, -3, … for an independently-numbered sub-block)`,
      );
    } else if (parent !== code) {
      report.warn(
        'subsector-split',
        'subsectors',
        `${code} is an extra independently-numbered block inside ${parent} — verify against the drawing`,
      );
    }
  }
  for (const code of EXPECTED_SUBSECTORS) {
    if (!seen.has(code)) {
      report.error('subsector-codes', 'subsectors', `missing subsector ${withCodepoints(code)}`);
    }
  }

  // Subsectors must sit under their own sector, and `order` must be 1..22 in
  // drawing order across the whole file.
  const orders: number[] = [];
  for (const sector of file.sectors) {
    for (const sub of sector.subsectors) {
      orders.push(sub.order);
      if (!sub.code.startsWith(sector.code)) {
        report.error(
          'subsector-parent',
          sub.code,
          `listed under sector ${withCodepoints(sector.code)} but its code does not start with it`,
        );
      }
      const expectedLatin = `${sector.latin}${sub.code.slice(sector.code.length)}`;
      if (sub.latin !== expectedLatin) {
        report.error(
          'subsector-latin',
          sub.code,
          `latin = "${sub.latin}", expected "${expectedLatin}" (see the Б10/Б11 label defect in DATA_CONTRACT.md)`,
        );
      }
    }
  }
  const sortedOrders = [...orders].sort((a, b) => a - b);
  const expectedOrders = Array.from({ length: orders.length }, (_, i) => i + 1);
  if (sortedOrders.join(',') !== expectedOrders.join(',')) {
    report.error(
      'subsector-order',
      'subsectors',
      `order values must be exactly 1..${orders.length}, got [${sortedOrders.join(', ')}]`,
    );
  } else if (orders.join(',') !== expectedOrders.join(',')) {
    report.warn('subsector-order', 'subsectors', `orders are complete but not listed ascending: [${orders.join(', ')}]`);
  }
}

/* ------------------------------------------------------------------ *
 * Overview blocks
 *
 * The map draws one shape per distinct `overviewGroup ?? code`. Where a block
 * covers several subsectors, every member must carry the identical outline —
 * otherwise the map's dedup picks one of several disagreeing polygons and the
 * others silently stop being drawn. And the shapes it does draw must not
 * overlap: a torn or doubled block renders as a visible hole or a wrong-coloured
 * wedge, not as a cosmetic wobble, so these are errors.
 *
 * Severity is split, and the split is empirical rather than aesthetic. The group
 * rules are file-agnostic — any conforming file must satisfy them, and
 * `data/stadium.sample.json` (22 blocks over 22 subsectors, no groups) does so
 * vacuously — so they are errors. The *overlap* rules are not: the sample is a
 * synthetic decorative layout whose corner rectangles genuinely intersect (А1
 * with Г21/Г22, and three more corners), and rewriting that fixture to tile
 * would be real regression risk on the app's fallback path for no user-visible
 * gain. So overlap is reported here as a warning on any file, and gated as a
 * hard failure where the tiling is actually a requirement: in
 * `05_overview_layout.ts`, which refuses to write, and in
 * `tests/stadium.contract.test.ts`, scoped to `data/stadium.json`. Those two also
 * carry the properties that need the whole partition at once — the free boundary
 * closing into exactly two loops, and Σ areas matching the annulus.
 * ------------------------------------------------------------------ */

interface Pt {
  x: number;
  y: number;
}

/** `M x y L x y … Z` → ring, with the repeated closing vertex dropped. */
function polylinePoints(d: string): Pt[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 6 || nums.length % 2 !== 0) return [];
  const pts: Pt[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: Number(nums[i]), y: Number(nums[i + 1]) });
  const last = pts[pts.length - 1];
  if (Math.abs(last.x - pts[0].x) < EPS && Math.abs(last.y - pts[0].y) < EPS) pts.pop();
  return pts;
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * A *proper* crossing — both segments strictly straddle each other. Collinear
 * touching is deliberately not a crossing: that is what a correctly shared seam
 * looks like, and reporting it would make an exact tiling fail.
 */
function properlyCrosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function strictlyInside(p: Pt, ring: readonly Pt[]): boolean {
  // On the boundary is not inside — neighbours share whole edges and vertices.
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < T_JUNCTION_EPS) return false;
  }
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A vertex this close to the interior of a foreign edge is *on* it — a T-junction. */
const T_JUNCTION_EPS = 0.05;

function validateOverviewBlocks(file: StadiumFile, report: Report): void {
  const subs = file.sectors.flatMap((sector) => sector.subsectors.map((sub) => ({ sector, sub })));
  const byCode = new Map(subs.map((entry) => [entry.sub.code, entry]));

  /* ---- group well-formedness ---- */
  const members = new Map<string, typeof subs>();
  for (const entry of subs) {
    const key = entry.sub.overviewGroup;
    if (key === undefined) continue;
    const lead = byCode.get(key);
    if (!lead) {
      report.error('overview-group', entry.sub.code, `overviewGroup "${key}" is not a subsector in this file`);
      continue;
    }
    if (lead.sector.code !== entry.sector.code) {
      report.error(
        'overview-group',
        entry.sub.code,
        `overviewGroup "${key}" lives in sector ${lead.sector.code}, not ${entry.sector.code} — a block cannot span two stands`,
      );
    }
    if (lead.sub.overviewGroup !== key) {
      report.error(
        'overview-group',
        entry.sub.code,
        `overviewGroup "${key}" does not carry that group itself — the block code must be one of its own members`,
      );
    }
    (members.get(key) ?? members.set(key, []).get(key)!).push(entry);
  }

  for (const [code, group] of members) {
    if (group.length < 2) {
      report.error('overview-group', code, 'a block with one member must not be grouped at all');
    }
    const orders = group.map((entry) => entry.sub.order).sort((a, b) => a - b);
    if (orders.some((o, i) => i > 0 && o !== orders[i - 1] + 1)) {
      report.error('overview-group', code, `members are not contiguous in order: [${orders.join(', ')}]`);
    }
    const [first, ...rest] = group;
    for (const entry of rest) {
      if (entry.sub.svgPath !== first.sub.svgPath) {
        report.error(
          'overview-group-geometry',
          code,
          `${entry.sub.code} and ${first.sub.code} are drawn as one block but carry different svgPath values`,
        );
      }
      if (entry.sub.centroid.x !== first.sub.centroid.x || entry.sub.centroid.y !== first.sub.centroid.y) {
        report.error(
          'overview-group-geometry',
          code,
          `${entry.sub.code} and ${first.sub.code} are drawn as one block but carry different centroids`,
        );
      }
    }
  }

  /* ---- one distinct shape per distinct block ---- */
  const blockKeys = new Set(subs.map((entry) => entry.sub.overviewGroup ?? entry.sub.code));
  const distinctPaths = new Set(subs.map((entry) => entry.sub.svgPath));
  if (blockKeys.size !== distinctPaths.size) {
    report.error(
      'overview-blocks',
      'overview',
      `${blockKeys.size} block(s) but ${distinctPaths.size} distinct outline(s) — either two blocks share a shape or one block's members disagree`,
    );
  }

  /* ---- the blocks must not overlap ---- */
  const rings = [...blockKeys]
    .map((code) => {
      const lead = byCode.get(code) ?? subs.find((e) => (e.sub.overviewGroup ?? e.sub.code) === code)!;
      return { code, ring: polylinePoints(lead.sub.svgPath) };
    })
    .filter((entry) => entry.ring.length >= 3);

  const owners = new Map<string, string[]>();
  for (const { code, ring } of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const ka = `${a.x},${a.y}`;
      const kb = `${b.x},${b.y}`;
      const key = ka < kb ? `${ka} ${kb}` : `${kb} ${ka}`;
      (owners.get(key) ?? owners.set(key, []).get(key)!).push(`${code}${ka < kb ? '+' : '-'}`);
    }
  }
  for (const [key, list] of owners) {
    if (list.length > 2) {
      report.warn('overview-overlap', key, `edge owned by ${list.length} blocks (${list.join(', ')})`);
    } else if (list.length === 2 && list[0].endsWith('+') === list[1].endsWith('+')) {
      report.warn(
        'overview-overlap',
        key,
        `${list.join(' and ')} traverse a shared edge in the same direction — they overlap rather than abut`,
      );
    }
  }

  for (let i = 0; i < rings.length; i += 1) {
    for (let j = i + 1; j < rings.length; j += 1) {
      const a = rings[i];
      const b = rings[j];
      let overlap = false;
      for (let m = 0; m < a.ring.length && !overlap; m += 1) {
        for (let n = 0; n < b.ring.length && !overlap; n += 1) {
          overlap = properlyCrosses(
            a.ring[m], a.ring[(m + 1) % a.ring.length],
            b.ring[n], b.ring[(n + 1) % b.ring.length],
          );
        }
      }
      if (!overlap) overlap = a.ring.some((p) => strictlyInside(p, b.ring)) || b.ring.some((p) => strictlyInside(p, a.ring));
      if (overlap) {
        report.warn('overview-overlap', `${a.code}/${b.code}`, 'block outlines enclose a common area');
      }
    }
  }

  const allVertices = rings.flatMap(({ ring }) => ring);
  for (const { code, ring } of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      for (const p of allVertices) {
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        if (t <= EPS || t >= 1 - EPS) continue;
        if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < T_JUNCTION_EPS) {
          report.warn(
            'overview-overlap',
            code,
            `a vertex (${num(p.x)}, ${num(p.y)}) sits inside this block's edge — a T-junction tears open when zoomed`,
          );
        }
      }
    }
  }
}

function validateSubsectorGeometry(
  file: StadiumFile,
  sectorLatin: string,
  sub: StadiumFile['sectors'][number]['subsectors'][number],
  report: Report,
): void {
  void sectorLatin;

  const vb = parseViewBox(sub.viewBox);
  if (!vb) {
    report.error('viewbox', sub.code, `unparseable viewBox "${sub.viewBox}"`);
  } else if (Math.abs(vb.width - sub.width) > EPS || Math.abs(vb.height - sub.height) > EPS) {
    report.error(
      'viewbox',
      sub.code,
      `viewBox "${sub.viewBox}" disagrees with width/height ${num(sub.width)}×${num(sub.height)}`,
    );
  }

  if (!/^\s*[Mm]/.test(sub.svgPath)) {
    report.error('svg-path', sub.code, 'svgPath does not start with a moveto (M)');
  }
  if (!/[Zz]\s*$/.test(sub.svgPath)) {
    report.error('svg-path', sub.code, 'svgPath is not closed (must end with Z)');
  }

  const { centroid } = sub;
  if (
    centroid.x < 0 ||
    centroid.y < 0 ||
    centroid.x > file.overview.width ||
    centroid.y > file.overview.height
  ) {
    report.error(
      'centroid',
      sub.code,
      `centroid (${num(centroid.x)}, ${num(centroid.y)}) is outside the overview space ` +
        `${num(file.overview.width)}×${num(file.overview.height)}`,
    );
  }

  if (sub.seats.length === 0) {
    report.error('empty-subsector', sub.code, 'has no seats');
  }
  if (sub.seatCount !== sub.seats.length) {
    report.error(
      'seat-count',
      sub.code,
      `seatCount = ${sub.seatCount} but seats.length = ${sub.seats.length}`,
    );
  }

  const rowNumbers = new Set(sub.seats.map((s) => s.row));
  if (sub.rowCount !== rowNumbers.size) {
    report.error(
      'row-count',
      sub.code,
      `rowCount = ${sub.rowCount} but the seats span ${rowNumbers.size} distinct rows`,
    );
  }
}

function validateSeats(
  sub: StadiumFile['sectors'][number]['subsectors'][number],
  globalSeatKeys: Set<string>,
  report: Report,
): void {
  const vb = parseViewBox(sub.viewBox);

  interface Positioned {
    row: number;
    number: number;
    x: number;
    y: number;
  }
  const byRow = new Map<number, Positioned[]>();

  for (const seat of sub.seats) {
    const label = `${sub.code} row ${seat.row} seat ${seat.number}`;

    if (seat.row < 1) {
      report.error('seat-row-range', label, `row must be >= 1, got ${seat.row}`);
    }
    if (seat.number < 1) {
      report.error('seat-number-range', label, `number must be >= 1, got ${seat.number}`);
    }

    // (subsector, row, number) unique across the whole file.
    const key = `${sub.code} ${seat.row} ${seat.number}`;
    if (globalSeatKeys.has(key)) {
      report.error('duplicate-seat', label, 'duplicate (subsector, row, number)');
    }
    globalSeatKeys.add(key);

    // Inside its own viewBox.
    if (vb) {
      const maxX = vb.minX + vb.width;
      const maxY = vb.minY + vb.height;
      if (seat.x < vb.minX || seat.x > maxX || seat.y < vb.minY || seat.y > maxY) {
        report.error(
          'seat-outside-viewbox',
          label,
          `centre (${num(seat.x)}, ${num(seat.y)}) is outside viewBox "${sub.viewBox}" ` +
            `(x ${num(vb.minX)}..${num(maxX)}, y ${num(vb.minY)}..${num(maxY)})`,
        );
      }
    }

    const bucket = byRow.get(seat.row);
    if (bucket) bucket.push(seat);
    else byRow.set(seat.row, [seat]);
  }

  // Angle is the seat's rotation in the drawing, so a wide spread means the block
  // is a curved corner fan rather than a straight stand.
  const angles = sub.seats.map((seat) => seat.angle);
  const curved =
    angles.length > 1 && Math.max(...angles) - Math.min(...angles) > CURVED_ANGLE_SPREAD;
  validateRowOrdering(sub.code, byRow, sub.pitchSide, curved, report);
}

/**
 * Orientation is per stand, so both checks are axis-aware (`pitchSide`):
 *   - within a row, `number` increases along the seat axis — x for a top/bottom
 *     pitch (А/В, horizontal rows), y for left/right (Б/Г, vertical rows);
 *   - across rows, row 1 is the one nearest the pitch and later rows recede away
 *     from it.
 */
function validateRowOrdering(
  code: string,
  byRow: Map<number, Array<{ row: number; number: number; x: number; y: number }>>,
  pitchSide: 'top' | 'bottom' | 'left' | 'right',
  curved: boolean,
  report: Report,
): void {
  // In a corner fan the rows radiate, so no single axis orders them. Seat
  // *identity* is still checked strictly everywhere; only the positional
  // ordering relaxes to a warning for these blocks.
  const positional = curved ? report.warn.bind(report) : report.error.bind(report);
  // `along` runs with the seats, `across` with the row numbers.
  const horizontal = pitchSide === 'top' || pitchSide === 'bottom';
  const along = (s: { x: number; y: number }) => (horizontal ? s.x : s.y);
  const across = (s: { x: number; y: number }) => (horizontal ? s.y : s.x);
  const alongAxis = horizontal ? 'x' : 'y';
  const acrossAxis = horizontal ? 'y' : 'x';
  // Rows recede in +across for a top/left pitch, in -across for bottom/right.
  const recedesPositive = pitchSide === 'top' || pitchSide === 'left';
  const rowMeanY = new Map<number, number>();

  for (const [row, seats] of byRow) {
    const sorted = [...seats].sort((a, b) => along(a) - along(b) || a.number - b.number);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.x === prev.x && cur.y === prev.y) {
        // Two seats at the same point is always a bug. Sharing only one
        // coordinate is normal in a curved corner, where a row follows an arc.
        report.error(
          'coincident-seats',
          `${code} row ${row}`,
          `seats ${prev.number} and ${cur.number} are both at (${num(cur.x)}, ${num(cur.y)})`,
        );
      }
    }

    // Numbering must follow position along the row, but the *direction* is the
    // drawing's, not ours: seats count up with +x on А, -x on В, -y on Б, +y on
    // Г. So the requirement is monotonic in one consistent direction, either one.
    const seq = sorted.map((seat) => seat.number);
    const ascending = seq.every((n, i) => i === 0 || n > seq[i - 1]);
    const descending = seq.every((n, i) => i === 0 || n < seq[i - 1]);
    if (seq.length > 2 && !ascending && !descending) {
      // Advisory: a couple of rows (the А2 outer strip, the Б11 corner fan) have
      // one row number spanning two physically separated groups of seats, so
      // position and numbering genuinely disagree. Identities stay unique.
      report.warn(
        'non-monotonic-numbering',
        `${code} row ${row}`,
        `seat numbers do not run monotonically along ${alongAxis}: ` +
          `${seq.slice(0, 12).join(', ')}${seq.length > 12 ? ', …' : ''}`,
      );
    }
    rowMeanY.set(row, seats.reduce((acc, s) => acc + across(s), 0) / seats.length);
  }

  const rows = [...rowMeanY.keys()].sort((a, b) => a - b);
  if (rows.length === 0) return;

  // Row 1 must exist and be the one nearest the pitch.
  const firstRow = rows[0];
  if (firstRow !== 1) {
    // Advisory: the corner blocks do not all start at row 1 — a fan's front
    // rows can belong to the neighbouring block of the same labelled region.
    report.warn('row-1-missing', code, `lowest row number is ${firstRow}, expected 1`);
  }
  const firstAcross = rowMeanY.get(firstRow)!;
  for (const row of rows) {
    if (row === firstRow) continue;
    const value = rowMeanY.get(row)!;
    const receding = recedesPositive ? value > firstAcross : value < firstAcross;
    if (!receding) {
      positional(
        'row-1-not-nearest-pitch',
        code,
        `pitch is on the ${pitchSide}, so rows must recede in ` +
          `${recedesPositive ? '+' : '-'}${acrossAxis} from row ${firstRow} ` +
          `(mean ${acrossAxis}=${num(firstAcross)}), but row ${row} is at ${num(value)}`,
      );
      break;
    }
  }

  // Rows should march away from the pitch monotonically, i.e. downwards. A local
  // inversion is a numbering bug in practice, but not a hard invariant in
  // DATA_CONTRACT.md — warn.
  for (let i = 1; i < rows.length; i += 1) {
    const prevRow = rows[i - 1];
    const curRow = rows[i];
    const cur = rowMeanY.get(curRow)!;
    const prev = rowMeanY.get(prevRow)!;
    if (recedesPositive ? cur <= prev : cur >= prev) {
      report.warn(
        'rows-not-stacked',
        code,
        `row ${curRow} (mean ${acrossAxis}=${num(cur)}) does not recede from row ${prevRow} ` +
          `(mean ${acrossAxis}=${num(prev)}) with the pitch on the ${pitchSide}`,
      );
    }
    if (curRow !== prevRow + 1) {
      report.warn('row-gap', code, `row numbering jumps from ${prevRow} to ${curRow}`);
    }
  }
}

/** `rows[]` is a summary of `seats[]` — it must agree exactly. */
function validateRowSummaries(
  sub: StadiumFile['sectors'][number]['subsectors'][number],
  report: Report,
): void {
  const actual = new Map<number, { count: number; first: number; last: number }>();
  for (const seat of sub.seats) {
    const agg = actual.get(seat.row);
    if (!agg) {
      actual.set(seat.row, { count: 1, first: seat.number, last: seat.number });
    } else {
      agg.count += 1;
      agg.first = Math.min(agg.first, seat.number);
      agg.last = Math.max(agg.last, seat.number);
    }
  }

  const declared = new Set<number>();
  for (const row of sub.rows) {
    if (declared.has(row.row)) {
      report.error('row-summary', `${sub.code} row ${row.row}`, 'listed twice in rows[]');
    }
    declared.add(row.row);

    const agg = actual.get(row.row);
    if (!agg) {
      report.error('row-summary', `${sub.code} row ${row.row}`, 'listed in rows[] but has no seats');
      continue;
    }
    if (row.count !== agg.count) {
      report.error('row-summary', `${sub.code} row ${row.row}`, `count = ${row.count}, actual ${agg.count}`);
    }
    if (row.firstSeat !== agg.first) {
      report.error(
        'row-summary',
        `${sub.code} row ${row.row}`,
        `firstSeat = ${row.firstSeat}, actual ${agg.first}`,
      );
    }
    if (row.lastSeat !== agg.last) {
      report.error(
        'row-summary',
        `${sub.code} row ${row.row}`,
        `lastSeat = ${row.lastSeat}, actual ${agg.last}`,
      );
    }
  }

  for (const row of [...actual.keys()].sort((a, b) => a - b)) {
    if (!declared.has(row)) {
      report.error('row-summary', `${sub.code} row ${row}`, 'has seats but is missing from rows[]');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Summary output
 * ------------------------------------------------------------------ */

function printSummary(file: StadiumFile): void {
  const rows: string[][] = [];
  const typeTotals = new Map<string, number>();
  let whiteTotal = 0;

  for (const sector of file.sectors) {
    for (const sub of sector.subsectors) {
      rows.push([
        String(sub.order),
        sub.code,
        sub.latin,
        String(sub.rowCount),
        String(sub.seats.length),
        `${num(sub.width)}×${num(sub.height)}`,
      ]);
      for (const seat of sub.seats) {
        typeTotals.set(seat.type, (typeTotals.get(seat.type) ?? 0) + 1);
        if (seat.white) whiteTotal += 1;
      }
    }
  }

  const header = ['#', 'code', 'latin', 'rows', 'seats', 'viewBox'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => [...r[i]].length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i >= 3 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');

  console.log('');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('');
  for (const sector of file.sectors) {
    const seats = sector.subsectors.reduce((n, s) => n + s.seats.length, 0);
    console.log(
      `  sector ${sector.code} / ${sector.latin}  ${sector.nameBg} · ${sector.name}  ` +
        `— ${sector.subsectors.length} subsectors, ${seats} seats`,
    );
  }
  const types = [...typeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`);
  console.log('');
  console.log(`  seat types: ${types.join(' · ')}`);
  console.log(`  white ("ЦСКА"-letter) seats: ${whiteTotal}`);
  console.log(`  total: ${file.stats.seatTotal} seats in ${file.stats.subsectorCount} subsectors`);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function resolveInputPath(explicit: string | undefined): string {
  const root = resolve(__dirname, '..', '..');
  if (explicit) return resolve(process.cwd(), explicit);
  const primary = resolve(root, 'data', 'stadium.json');
  if (existsSync(primary)) return primary;
  return resolve(root, 'data', 'stadium.sample.json');
}

function main(): number {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const positional = args.filter((a) => !a.startsWith('-'));
  const strict = flags.has('--strict');
  const quiet = flags.has('--quiet');

  const path = resolveInputPath(positional[0]);
  if (!existsSync(path)) {
    console.error(`validate: no such file: ${path}`);
    console.error('validate: run `npm run pipeline:sample` to generate the development fixture.');
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`validate: ${path} is not valid JSON: ${(err as Error).message}`);
    return 2;
  }

  console.log(`validate: ${path}`);

  const parsed = stadiumFileSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('\nFAILED — the file does not match docs/DATA_CONTRACT.md (structure):');
    const issues = parsed.error.issues.slice(0, 40);
    for (const issue of issues) {
      const where = issue.path.length ? issue.path.join('.') : '<root>';
      console.error(`    ${where}: ${issue.message}`);
    }
    if (parsed.error.issues.length > issues.length) {
      console.error(`    … and ${parsed.error.issues.length - issues.length} more`);
    }
    return 1;
  }

  const file = asStadiumFile(parsed.data);
  const report = new Report();
  validate(file, report);

  const { errors, warnings } = report;

  if (warnings.length > 0) {
    console.error(`\n${warnings.length} warning(s):`);
    printIssues(warnings, 'WARN');
  }

  if (errors.length > 0) {
    console.error(`\nFAILED — ${errors.length} invariant violation(s) in ${path}:`);
    printIssues(errors, 'ERROR');
    console.error('');
    return 1;
  }

  if (strict && warnings.length > 0) {
    console.error(`\nFAILED — --strict: ${warnings.length} warning(s) treated as errors.`);
    return 1;
  }

  if (!quiet) printSummary(file);
  console.log(
    `\nOK — every invariant in docs/DATA_CONTRACT.md holds` +
      (warnings.length > 0 ? ` (${warnings.length} warning(s))` : '') +
      '.',
  );
  return 0;
}

process.exit(main());
