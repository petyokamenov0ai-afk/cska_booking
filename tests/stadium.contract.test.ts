/**
 * Geometry contract tests — every invariant in `docs/DATA_CONTRACT.md`, run over
 * `data/stadium.sample.json` and over `data/stadium.json` **when it exists**.
 *
 * Two layers, deliberately:
 *
 * 1. **`scripts/pipeline/validate.ts` as a subprocess.** That script is the gate
 *    the pipeline must pass, and it is the authority on the invariants. It ends
 *    in `process.exit(main())`, so it cannot be imported — running it is how you
 *    reuse it. If it exits non-zero, its own grouped report is printed here.
 * 2. **Independent assertions, one `it` per invariant.** A single opaque exit
 *    code tells you nothing about *which* rule broke, and a test that only calls
 *    the validator cannot catch a bug *in* the validator. These re-derive each
 *    rule from the contract text, so the two layers have to agree.
 *
 * Also cross-checks `lib/stadium.ts`, which is what the app actually reads the
 * file through: the Cyrillic keys must resolve and their Latin homoglyphs must
 * not (`getSubsectorGeometry('A1') === null`, Latin A U+0041).
 *
 * No database — this suite always runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  getSectorCodeForSubsector,
  getSubsectorGeometry,
  listSubsectors,
  loadStadium,
  resetStadiumCache,
} from '@/lib/stadium';
import type { StadiumFile, SubsectorGeometry } from '@/lib/types';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

/* ------------------------------------------------------------------ *
 * The expected stadium — docs/DATA_CONTRACT.md § Invariants.
 * Written out with explicit codepoints so a Latin homoglyph slipping into the
 * pipeline output fails here rather than 404-ing in production.
 * ------------------------------------------------------------------ */

const SECTORS = [
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

const EXPECTED_SUBSECTOR_CODES: readonly string[] = SECTORS.flatMap((sector) =>
  (SUBSECTOR_NUMBERS[sector.code] ?? []).map((number) => `${sector.code}${number}`),
);

const EPS = 1e-6;

/* ------------------------------------------------------------------ *
 * Files under test
 * ------------------------------------------------------------------ */

interface Candidate {
  /** Repo-relative, as a human would refer to it. */
  name: string;
  path: string;
}

const CANDIDATES: Candidate[] = ['data/stadium.json', 'data/stadium.sample.json']
  .map((name) => ({ name, path: `${PROJECT_ROOT}${name}` }))
  .filter((candidate) => existsSync(candidate.path));

/** The fixture must exist: `npm run pipeline:sample` generates it. */
it('data/stadium.sample.json exists (the development fixture)', () => {
  expect(
    existsSync(`${PROJECT_ROOT}data/stadium.sample.json`),
    'run `npm run pipeline:sample` to generate the fixture',
  ).toBe(true);
});

function parseViewBox(
  viewBox: string,
): { minX: number; minY: number; width: number; height: number } | null {
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const numbers = parts.map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const [minX, minY, width, height] = numbers as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { minX, minY, width, height };
}

function everySubsector(file: StadiumFile): SubsectorGeometry[] {
  return file.sectors.flatMap((sector) => sector.subsectors);
}

/** Codepoint dump, so a homoglyph failure is readable in the diff. */
function codepoints(value: string): string {
  return [...value]
    .map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * The suite, once per present file
 * ------------------------------------------------------------------ */

for (const candidate of CANDIDATES) {
  describe(candidate.name, () => {
    const file = JSON.parse(readFileSync(candidate.path, 'utf8')) as StadiumFile;
    const subsectors = everySubsector(file);

    it('passes scripts/pipeline/validate.ts (the pipeline gate)', () => {
      // The authority on the invariants. Spawned rather than imported because the
      // script ends in `process.exit(main())`.
      try {
        execFileSync('npx', ['tsx', 'scripts/pipeline/validate.ts', candidate.name, '--quiet'], {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          timeout: 120_000,
        });
      } catch (error) {
        const output = ['stdout', 'stderr']
          .map((stream) =>
            typeof error === 'object' && error !== null && stream in error
              ? String((error as Record<string, unknown>)[stream] ?? '')
              : '',
          )
          .join('\n')
          .trim();
        throw new Error(
          `validate.ts rejected ${candidate.name}:\n${output || (error as Error).message}`,
        );
      }
    });

    describe('header', () => {
      it('has a parseable generatedAt and a named source', () => {
        expect(Number.isNaN(Date.parse(file.generatedAt))).toBe(false);
        expect(file.source.length).toBeGreaterThan(0);
      });

      it('has an overview viewBox that agrees with width/height', () => {
        const viewBox = parseViewBox(file.overview.viewBox);
        expect(viewBox, `unparseable overview viewBox "${file.overview.viewBox}"`).not.toBeNull();
        expect(Math.abs(viewBox!.width - file.overview.width)).toBeLessThan(EPS);
        expect(Math.abs(viewBox!.height - file.overview.height)).toBeLessThan(EPS);
        // Landscape, per the coordinate-space section of the contract.
        expect(file.overview.width).toBeGreaterThan(file.overview.height);
      });

      it('has a pitch path starting with a moveto', () => {
        expect(file.overview.pitch).toMatch(/^\s*[Mm]/);
      });

      it('has stats that match the content', () => {
        const seatTotal = subsectors.reduce((sum, sub) => sum + sub.seats.length, 0);
        expect(file.stats.seatTotal).toBe(seatTotal);
        expect(file.stats.subsectorCount).toBe(subsectors.length);
      });
    });

    describe('codes are Cyrillic', () => {
      it('has exactly sectors А Б В Г with the right latin and order', () => {
        expect(file.sectors.map((sector) => sector.code)).toEqual(
          SECTORS.map((sector) => sector.code),
        );
        for (const sector of file.sectors) {
          const spec = SECTORS.find((entry) => entry.code === sector.code)!;
          expect(sector.latin, `${sector.code} (${codepoints(sector.code)})`).toBe(spec.latin);
          expect(sector.order).toBe(spec.order);
          expect(sector.name.length).toBeGreaterThan(0);
          expect(sector.nameBg.length).toBeGreaterThan(0);
          // The Bulgarian name must actually be Cyrillic.
          expect(sector.nameBg).toMatch(/[Ѐ-ӿ]/);
        }
      });

      it('has unique subsector codes, each under its own sector, latin derived from it', () => {
        const codes = subsectors.map((sub) => sub.code);
        expect(new Set(codes).size).toBe(codes.length);

        for (const sector of file.sectors) {
          for (const sub of sector.subsectors) {
            expect(sub.code.startsWith(sector.code), `${sub.code} under ${sector.code}`).toBe(true);
            expect(sub.latin).toBe(`${sector.latin}${sub.code.slice(sector.code.length)}`);
          }
        }
      });

      it('covers all 22 caption codes, with extras only as -N sub-blocks', () => {
        // The contract: codes are А1–А5, Б6–Б11, В12–В16, Г17–Г22, optionally
        // suffixed -2, -3, … Three of the drawing's captioned regions (Б6, Б10,
        // Б11) contain more than one independently-numbered block, each
        // restarting at seat 1; merging them would break (subsector, row, seat)
        // uniqueness, so the pipeline splits them. See docs/PIPELINE.md.
        const codes = [...subsectors.map((sub) => sub.code)].sort();
        const parentOf = (code: string) => code.replace(/-\d+$/, '');
        const extra = codes.filter((code) => !EXPECTED_SUBSECTOR_CODES.includes(parentOf(code)));
        const missing = EXPECTED_SUBSECTOR_CODES.filter((code) => !codes.includes(code));
        expect(
          { extra, missing },
          'the geometry file and docs/DATA_CONTRACT.md disagree about the catalogue of ' +
            'subsectors. Either the pipeline must merge/rename these blocks, or the ' +
            'contract (and lib/types.ts consumers, and scripts/pipeline/validate.ts) must ' +
            'be updated to bless them.',
        ).toEqual({ extra: [], missing: [] });
      });

      it('splits a -N sub-block only where it could not have been merged', () => {
        // A suffixed code is a uniqueness device, not a new region: `Б6-2` without
        // a `Б6` would be a naming bug. The justification for splitting is that
        // the two blocks CANNOT share one code — i.e. they collide on some
        // (row, seat), which is the key the booking model is built on.
        //
        // Note the split does NOT imply the extra block restarts at seat 1. In the
        // Б corner the drawing numbers straight across the radial aisle (verified
        // against the PDF), so Б11-2 legitimately starts at 4.
        const byCode = new Map(subsectors.map((sub) => [sub.code, sub]));
        for (const sub of subsectors) {
          const match = /^(.+)-\d+$/.exec(sub.code);
          if (match === null) continue;
          const parent = byCode.get(match[1]);
          expect(parent, `${sub.code} has no caption block ${match[1]}`).toBeDefined();

          const parentKeys = new Set(parent!.seats.map((seat) => `${seat.row}:${seat.number}`));
          const collisions = sub.seats.filter((seat) =>
            parentKeys.has(`${seat.row}:${seat.number}`),
          ).length;
          expect(
            collisions,
            `${sub.code} shares no (row, seat) with ${match[1]}, so the two should be one subsector`,
          ).toBeGreaterThan(0);
        }
      });

      it('never uses a Latin homoglyph in a code', () => {
        // This is the invariant that keeps URLs working: `А1` is U+0410, `A1` is
        // U+0041, and routes are keyed on `code`. A Latin letter slipping in here
        // produces a subsector nothing can ever look up.
        for (const sub of subsectors) {
          expect(
            /^[Ѐ-ӿ]/.test(sub.code),
            `${sub.code} = ${codepoints(sub.code)} must start with a Cyrillic letter`,
          ).toBe(true);
          expect(
            /[A-Za-z]/.test(sub.code),
            `${sub.code} = ${codepoints(sub.code)} contains a Latin letter`,
          ).toBe(false);
          // Digits, optionally with a `-N` suffix for a split block.
          expect(sub.code.slice(1), `${sub.code}: unexpected code shape`).toMatch(/^\d+(-\d+)?$/);
          expect(/^[A-Z]\d+(-\d+)?$/.test(sub.latin), `latin "${sub.latin}" must be ASCII`).toBe(
            true,
          );
        }
        // The Б10 label defect in the drawing (captioned "Б11 / B10") is
        // normalised by the pipeline: Б10/B10 present, and Б11 paired with B11.
        const b10 = subsectors.find((sub) => sub.code === 'Б10');
        const b11 = subsectors.find((sub) => sub.code === 'Б11');
        expect(b10?.latin).toBe('B10');
        expect(b11?.latin).toBe('B11');
      });

      it('numbers subsector order contiguously from 1 in drawing order', () => {
        expect(subsectors.map((sub) => sub.order)).toEqual(
          Array.from({ length: subsectors.length }, (_, index) => index + 1),
        );
      });
    });

    describe('per-subsector geometry', () => {
      it('has a viewBox that agrees with width/height and a closed svgPath', () => {
        for (const sub of subsectors) {
          const viewBox = parseViewBox(sub.viewBox);
          expect(viewBox, `${sub.code}: unparseable viewBox "${sub.viewBox}"`).not.toBeNull();
          expect(Math.abs(viewBox!.width - sub.width), sub.code).toBeLessThan(EPS);
          expect(Math.abs(viewBox!.height - sub.height), sub.code).toBeLessThan(EPS);
          expect(sub.svgPath, sub.code).toMatch(/^\s*[Mm]/);
          expect(sub.svgPath, `${sub.code}: outline must be closed`).toMatch(/[Zz]\s*$/);
        }
      });

      /**
       * The overview draws one shape per distinct `overviewGroup ?? code`. Two
       * of the real file's 22 shapes cover more than one subsector, because the
       * ticket map draws two corners whole where we hold two and three
       * independently-numbered blocks. Everything here is about that being a
       * *presentation* merge only: the 25 subsectors, their order and their seat
       * maps are asserted unchanged by the rest of this file.
       */
      it('groups subsectors into overview blocks consistently', () => {
        const byCode = new Map(
          file.sectors.flatMap((sector) => sector.subsectors.map((sub) => [sub.code, { sector, sub }] as const)),
        );
        const groups = new Map<string, SubsectorGeometry[]>();
        for (const sub of subsectors) {
          if (sub.overviewGroup === undefined) continue;
          const lead = byCode.get(sub.overviewGroup);
          expect(lead, `${sub.code}: overviewGroup "${sub.overviewGroup}" is not a subsector`).toBeDefined();
          expect(lead!.sector.code, `${sub.code}: a block cannot span two stands`).toBe(
            byCode.get(sub.code)!.sector.code,
          );
          // Self-membership: the block code is always one of its own members, so
          // a member can find itself in its own group.
          expect(lead!.sub.overviewGroup, `${sub.code}: ${sub.overviewGroup} does not carry its own group`).toBe(
            sub.overviewGroup,
          );
          (groups.get(sub.overviewGroup) ?? groups.set(sub.overviewGroup, []).get(sub.overviewGroup)!).push(sub);
        }

        for (const [code, members] of groups) {
          expect(members.length, `${code}: a one-member block must not be grouped`).toBeGreaterThan(1);
          const orders = members.map((sub) => sub.order).sort((a, b) => a - b);
          for (let i = 1; i < orders.length; i += 1) {
            expect(orders[i], `${code}: members must be contiguous in order`).toBe(orders[i - 1] + 1);
          }
          for (const sub of members) {
            expect(sub.svgPath, `${code}/${sub.code}: members must share one outline`).toBe(members[0].svgPath);
            expect(sub.centroid, `${code}/${sub.code}: members must share one anchor`).toEqual(members[0].centroid);
          }
        }

        // One shape per block, and no two blocks sharing a shape.
        const blockKeys = new Set(subsectors.map((sub) => sub.overviewGroup ?? sub.code));
        const distinctPaths = new Set(subsectors.map((sub) => sub.svgPath));
        expect(distinctPaths.size, 'distinct outlines must equal distinct blocks').toBe(blockKeys.size);
        // The merge must not have eaten a subsector on the way past.
        expect(subsectors.length).toBe(file.stats.subsectorCount);
      });

      // Only the real file claims to be a gap-free partition of the bowl. The
      // sample fixture is a synthetic decorative layout whose corner rectangles
      // genuinely overlap; see the severity note in scripts/pipeline/validate.ts.
      const partitionIt = candidate.name === 'data/stadium.json' ? it : it.skip;
      /**
       * Re-derived here from the emitted strings alone, deliberately independent
       * of `validate.ts` and of the stage that wrote them — a bug *in* the
       * validator would otherwise pass unseen. A hairline between two blocks is
       * invisible at level 1 and glaring at level-2 zoom, which is exactly the
       * failure this catches.
       */
      partitionIt('draws the blocks as one exact partition of the bowl annulus', () => {
        const rings = [...new Set(subsectors.map((sub) => sub.svgPath))].map((d) => {
          const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
          const last = pts[pts.length - 1];
          if (last.x === pts[0].x && last.y === pts[0].y) pts.pop();
          return pts;
        });
        expect(rings.length, 'the bowl is drawn as 22 shapes').toBe(22);

        // Directed-edge ledger: two owners in opposite directions is a seam, two
        // in the same direction is an overlap, three is a bug, one is free edge.
        const owners = new Map<string, string[]>();
        rings.forEach((ring, index) => {
          for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const ka = `${a.x},${a.y}`;
            const kb = `${b.x},${b.y}`;
            const key = ka < kb ? `${ka} ${kb}` : `${kb} ${ka}`;
            (owners.get(key) ?? owners.set(key, []).get(key)!).push(`${index}${ka < kb ? '+' : '-'}`);
          }
        });
        const free: [string, string][] = [];
        for (const [key, list] of owners) {
          expect(list.length, `${key}: owned by ${list.length} blocks`).toBeLessThanOrEqual(2);
          if (list.length === 1) free.push(key.split(' ') as [string, string]);
          else expect(list[0].endsWith('+'), `${key}: same-direction seam is an overlap`).not.toBe(list[1].endsWith('+'));
        }

        // T-junctions: a vertex inside a foreign edge. The ledger cannot see it,
        // and it renders as a wedge of background between two neighbours.
        const vertices = rings.flat();
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            for (const p of vertices) {
              const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
              if (t <= 1e-9 || t >= 1 - 1e-9) continue;
              const dist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
              expect(dist, `T-junction at (${p.x}, ${p.y})`).toBeGreaterThanOrEqual(0.05);
            }
          }
        }

        // The free boundary must close into exactly two loops — the outer wall
        // and the pitch-side ring. Three means a hole opened in the middle.
        const adjacency = new Map<string, string[]>();
        for (const [a, b] of free) {
          (adjacency.get(a) ?? adjacency.set(a, []).get(a)!).push(b);
          (adjacency.get(b) ?? adjacency.set(b, []).get(b)!).push(a);
        }
        for (const [node, list] of adjacency) {
          expect(list.length, `free boundary branches at ${node}`).toBe(2);
        }
        const shoelace = (ring: { x: number; y: number }[]): number => {
          let sum = 0;
          for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            sum += a.x * b.y - b.x * a.y;
          }
          return Math.abs(sum) / 2;
        };
        const seen = new Set<string>();
        const loopAreas: number[] = [];
        for (const start of adjacency.keys()) {
          if (seen.has(start)) continue;
          const loop: { x: number; y: number }[] = [];
          let previous = '';
          let current = start;
          for (;;) {
            seen.add(current);
            const [x, y] = current.split(',').map(Number);
            loop.push({ x, y });
            const next = adjacency.get(current)!.find((n) => n !== previous);
            if (next === undefined || next === start) break;
            previous = current;
            current = next;
          }
          loopAreas.push(shoelace(loop));
        }
        expect(loopAreas.length, 'the free boundary must be exactly two loops').toBe(2);

        // And the blocks must fill that annulus exactly: a silent double-cover or
        // a missing sliver shows up here and nowhere else.
        loopAreas.sort((a, b) => a - b);
        const covered = rings.reduce((sum, ring) => sum + shoelace(ring), 0);
        expect(Math.abs(covered - (loopAreas[1] - loopAreas[0]))).toBeLessThanOrEqual(1.0);
      });

      it('puts every centroid inside the overview space', () => {
        for (const sub of subsectors) {
          expect(sub.centroid.x, sub.code).toBeGreaterThanOrEqual(0);
          expect(sub.centroid.y, sub.code).toBeGreaterThanOrEqual(0);
          expect(sub.centroid.x, sub.code).toBeLessThanOrEqual(file.overview.width);
          expect(sub.centroid.y, sub.code).toBeLessThanOrEqual(file.overview.height);
        }
      });

      it('has seatCount / rowCount matching the seats it carries', () => {
        for (const sub of subsectors) {
          expect(sub.seats.length, `${sub.code}: seatCount`).toBe(sub.seatCount);
          expect(sub.seats.length, `${sub.code}: must not be empty`).toBeGreaterThan(0);
          expect(new Set(sub.seats.map((seat) => seat.row)).size, `${sub.code}: rowCount`).toBe(
            sub.rowCount,
          );
        }
      });

      it('has a rows[] summary that agrees with seats[] exactly', () => {
        for (const sub of subsectors) {
          const actual = new Map<number, { count: number; first: number; last: number }>();
          for (const seat of sub.seats) {
            const aggregate = actual.get(seat.row);
            if (aggregate === undefined) {
              actual.set(seat.row, { count: 1, first: seat.number, last: seat.number });
            } else {
              aggregate.count += 1;
              aggregate.first = Math.min(aggregate.first, seat.number);
              aggregate.last = Math.max(aggregate.last, seat.number);
            }
          }
          expect(sub.rows.length, `${sub.code}: rows[] length`).toBe(actual.size);
          for (const row of sub.rows) {
            const aggregate = actual.get(row.row);
            expect(aggregate, `${sub.code}: rows[] lists row ${row.row} with no seats`).toBeDefined();
            expect(row.count, `${sub.code} row ${row.row}: count`).toBe(aggregate!.count);
            expect(row.firstSeat, `${sub.code} row ${row.row}: firstSeat`).toBe(aggregate!.first);
            expect(row.lastSeat, `${sub.code} row ${row.row}: lastSeat`).toBe(aggregate!.last);
          }
        }
      });
    });

    describe('seat invariants', () => {
      it('has a unique (subsector, row, number) across the whole file', () => {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const sub of subsectors) {
          for (const seat of sub.seats) {
            const key = `${sub.code} ${seat.row} ${seat.number}`;
            if (seen.has(key)) duplicates.push(key);
            seen.add(key);
          }
        }
        expect(duplicates).toEqual([]);
        expect(seen.size).toBe(file.stats.seatTotal);
      });

      it('has row >= 1 and number >= 1 everywhere', () => {
        const bad: string[] = [];
        for (const sub of subsectors) {
          for (const seat of sub.seats) {
            if (seat.row < 1 || seat.number < 1 || !Number.isInteger(seat.row) || !Number.isInteger(seat.number)) {
              bad.push(`${sub.code} row ${seat.row} seat ${seat.number}`);
            }
          }
        }
        expect(bad).toEqual([]);
      });

      it('numbers seats monotonically along each row, whichever axis it runs on', () => {
        // Orientation is per stand (`pitchSide`): rows run horizontally on А/В and
        // VERTICALLY on Б/Г, and the numbering direction is the drawing's, not
        // ours — up with +x on А, -x on В, -y on Б, +y on Г. So the invariant is
        // "monotonic in one consistent direction", not "increasing with x".
        const coincident: string[] = [];
        const nonMonotonic: string[] = [];
        for (const sub of subsectors) {
          const horizontal = sub.pitchSide === 'top' || sub.pitchSide === 'bottom';
          const along = (seat: { x: number; y: number }) => (horizontal ? seat.x : seat.y);
          const byRow = new Map<number, typeof sub.seats>();
          for (const seat of sub.seats) {
            const bucket = byRow.get(seat.row);
            if (bucket === undefined) byRow.set(seat.row, [seat]);
            else bucket.push(seat);
          }
          for (const [row, seats] of byRow) {
            const sorted = [...seats].sort((a, b) => along(a) - along(b) || a.number - b.number);
            for (let i = 1; i < sorted.length; i += 1) {
              // Only a shared *point* is ambiguous; sharing one coordinate is
              // normal where a corner row follows an arc.
              if (sorted[i].x === sorted[i - 1].x && sorted[i].y === sorted[i - 1].y) {
                coincident.push(
                  `${sub.code} row ${row}: seats ${sorted[i - 1].number}/${sorted[i].number} share a point`,
                );
              }
            }
            const seq = sorted.map((seat) => seat.number);
            const ascending = seq.every((n, i) => i === 0 || n > seq[i - 1]);
            const descending = seq.every((n, i) => i === 0 || n < seq[i - 1]);
            if (seq.length > 2 && !ascending && !descending) {
              nonMonotonic.push(`${sub.code} row ${row}: ${seq.slice(0, 10).join(', ')}`);
            }
          }
        }
        // Two seats at the same point is always a bug.
        expect(coincident).toEqual([]);
        // Non-monotonic numbering is advisory: a couple of rows (А2's thin outer
        // strip, the Б11 corner fan) span two physically separated groups, so
        // position and numbering genuinely disagree. Identities stay unique.
        // Budgeted, not ignored. See docs/PIPELINE.md → Known limitations.
        expect(
          nonMonotonic.length,
          `too many non-monotonic rows:\n${nonMonotonic.slice(0, 10).join('\n')}`,
        ).toBeLessThanOrEqual(6);
      });

      it('stacks rows away from the pitch, on the axis the stand uses', () => {
        // The orientation invariant, and the one that matters most for rendering:
        // get it wrong and a subsector is drawn back to front. Row 1 is nearest
        // the pitch, and later rows recede away from it — downward when the pitch
        // is on top (А), upward for В, rightward for Б, leftward for Г.
        const bad: string[] = [];
        for (const sub of subsectors) {
          const horizontal = sub.pitchSide === 'top' || sub.pitchSide === 'bottom';
          const recedesPositive = sub.pitchSide === 'top' || sub.pitchSide === 'left';
          const acc = new Map<number, { total: number; count: number }>();
          for (const seat of sub.seats) {
            const value = horizontal ? seat.y : seat.x;
            const entry = acc.get(seat.row) ?? { total: 0, count: 0 };
            entry.total += value;
            entry.count += 1;
            acc.set(seat.row, entry);
          }
          const mean = new Map([...acc].map(([row, e]) => [row, e.total / e.count]));
          const rows = [...mean.keys()].sort((a, b) => a - b);
          const first = mean.get(rows[0])!;
          for (const row of rows.slice(1)) {
            const value = mean.get(row)!;
            const receding = recedesPositive ? value > first : value < first;
            if (!receding) {
              bad.push(
                `${sub.code}: pitch on the ${sub.pitchSide}, but row ${row} ` +
                  `(${value.toFixed(1)}) does not recede from row ${rows[0]} (${first.toFixed(1)})`,
              );
              break;
            }
          }
        }
        // Advisory only for the curved corner fans, where rows radiate and no
        // single axis orders them. Budgeted so a whole-stand inversion still fails.
        expect(bad.length, `rows not receding from the pitch:\n${bad.join('\n')}`)
          .toBeLessThanOrEqual(2);
      });

      it('has a row 1 in all but the blocks the contract exempts', () => {
        // Advisory in docs/DATA_CONTRACT.md: "Row 1 exists and has the largest y …
        // Three corner blocks start at a higher row." In a corner fan the front
        // rows can belong to the sibling block of the same captioned region.
        //
        // Booking is unaffected — (subsector, row, seat) is still unique — but a
        // *captioned* block missing row 1 (Б11 today) is worth a QA-overlay look,
        // so the offenders are printed rather than swallowed. Budgeted, not
        // ignored: strip row 1 from a fourth block and this goes red.
        const missing = subsectors
          .filter((sub) => !sub.seats.some((seat) => seat.row === 1))
          .map((sub) => `${sub.code} (lowest row ${Math.min(...sub.seats.map((s) => s.row))})`);
        if (missing.length > 0) {
          console.warn(
            `\n  ADVISORY ${candidate.name}: no row 1 in ${missing.length} subsector(s): ` +
              `${missing.join(', ')}\n`,
          );
        }
        expect(missing.length, `subsectors with no row 1: ${missing.join(', ')}`).toBeLessThanOrEqual(
          3,
        );
      });

      it('keeps every seat inside its own subsector viewBox', () => {
        const bad: string[] = [];
        for (const sub of subsectors) {
          const viewBox = parseViewBox(sub.viewBox);
          if (viewBox === null) continue;
          const maxX = viewBox.minX + viewBox.width;
          const maxY = viewBox.minY + viewBox.height;
          for (const seat of sub.seats) {
            if (
              seat.x < viewBox.minX ||
              seat.x > maxX ||
              seat.y < viewBox.minY ||
              seat.y > maxY
            ) {
              bad.push(
                `${sub.code} row ${seat.row} seat ${seat.number} at (${seat.x}, ${seat.y}) ` +
                  `outside "${sub.viewBox}"`,
              );
            }
          }
        }
        expect(bad.slice(0, 10)).toEqual([]);
      });

      it('uses only contract-legal seat types and finite coordinates', () => {
        const legal = new Set(['STANDARD', 'WHEELCHAIR', 'COMPANION', 'VIP']);
        for (const sub of subsectors) {
          for (const seat of sub.seats) {
            expect(legal.has(seat.type), `${sub.code}: seat type "${seat.type}"`).toBe(true);
            expect(Number.isFinite(seat.x) && Number.isFinite(seat.y)).toBe(true);
            expect(Number.isFinite(seat.angle)).toBe(true);
            expect(typeof seat.white).toBe('boolean');
          }
        }
      });

      it('keeps `white` cosmetic — every white seat is an ordinary STANDARD seat', () => {
        // docs/DATA_CONTRACT.md: "white seats are ordinary bookable seats — the
        // flag is cosmetic and must not be confused with `type`."
        for (const sub of subsectors) {
          for (const seat of sub.seats) {
            if (seat.white) {
              expect(seat.type, `${sub.code} row ${seat.row} seat ${seat.number}`).toBe('STANDARD');
            }
          }
        }
      });

      it('draws the white "ЦСКА" letter seats only on the В stand', () => {
        // The letters spell "ЦСКА" across В (North) and nowhere else, so white
        // seats on another stand are detection noise (a light seat tone picked up
        // outside the letter regions) — exactly the risk §11 flags for В-stand
        // letters and calls for a patches.json override.
        const whiteBySector = new Map<string, number>();
        for (const sector of file.sectors) {
          whiteBySector.set(
            sector.code,
            sector.subsectors.reduce(
              (sum, sub) => sum + sub.seats.filter((seat) => seat.white).length,
              0,
            ),
          );
        }
        const total = [...whiteBySector.values()].reduce((sum, count) => sum + count, 0);
        const onNorth = whiteBySector.get('В') ?? 0; // В — North
        expect(onNorth, 'no white seats on the В stand at all — the letters are lost').toBeGreaterThan(
          0,
        );

        const strays = [...whiteBySector]
          .filter(([code, count]) => code !== 'В' && count > 0)
          .map(([code, count]) => `sector ${code}: ${count} white seat(s)`);
        if (strays.length > 0) {
          console.warn(
            `\n  ADVISORY ${candidate.name}: white seats outside the В stand — ${strays.join(
              ', ',
            )}. Likely a light seat tone detected outside the letter regions; a ` +
              'patches.json override is the fix (IMPLEMENTATION_PLAN §11).\n',
          );
        }
        // The semantic claim ("they spell ЦСКА across the В stand") holds as long as
        // the letters are overwhelmingly on В. A budget rather than zero, because a
        // couple of stray light seats are cosmetic — `white` never affects booking —
        // while a detector that scattered them everywhere must still fail.
        expect(onNorth / total, `white seats by sector: ${JSON.stringify([...whiteBySector])}`)
          .toBeGreaterThan(0.95);
      });

      it('pairs every WHEELCHAIR space with COMPANION places somewhere in the bowl', () => {
        const wheelchair = subsectors.reduce(
          (sum, sub) => sum + sub.seats.filter((seat) => seat.type === 'WHEELCHAIR').length,
          0,
        );
        const companion = subsectors.reduce(
          (sum, sub) => sum + sub.seats.filter((seat) => seat.type === 'COMPANION').length,
          0,
        );
        // §1: "wheelchair spaces along the front promenade with companion
        // platforms next to them". Either both are present or neither is.
        if (wheelchair > 0) expect(companion).toBeGreaterThan(0);
        if (companion > 0) expect(wheelchair).toBeGreaterThan(0);
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * lib/stadium.ts — the app's only door to this file
 * ------------------------------------------------------------------ */

describe('lib/stadium.ts', () => {
  it('loads the same content the contract tests just checked', () => {
    resetStadiumCache();
    const file = loadStadium();
    // Preference order per the contract: stadium.json first, sample second.
    const expectedName = CANDIDATES[0]?.name ?? 'data/stadium.sample.json';
    const expected = JSON.parse(
      readFileSync(`${PROJECT_ROOT}${expectedName}`, 'utf8'),
    ) as StadiumFile;
    expect(file.stats).toEqual(expected.stats);
    expect(file.sectors.map((sector) => sector.code)).toEqual(
      expected.sectors.map((sector) => sector.code),
    );
  });

  it('resolves Cyrillic subsector codes and rejects their Latin homoglyphs', () => {
    resetStadiumCache();
    // Cyrillic А1 (U+0410 U+0031).
    const cyrillic = getSubsectorGeometry('А1');
    expect(cyrillic, 'А1 must resolve').not.toBeNull();
    expect(cyrillic!.latin).toBe('A1');
    expect(getSectorCodeForSubsector('А1')).toBe('А');

    // Latin A1 (U+0041 U+0031) must never resolve — routes are keyed on `code`,
    // never on `latin`, so a Latin URL is a 404, not a silent wrong subsector.
    expect(getSubsectorGeometry('A1')).toBeNull();
    expect(getSubsectorGeometry('B10')).toBeNull();
    expect(getSectorCodeForSubsector('A1')).toBeNull();
    expect(getSubsectorGeometry('')).toBeNull();
  });

  it('lists every subsector of the loaded file in drawing order', () => {
    // Structural check on the loader; the *catalogue* (22 codes) is asserted
    // against the file itself above, so a data change fails in one place only.
    resetStadiumCache();
    const file = loadStadium();
    const subsectors = listSubsectors();
    expect(subsectors).toHaveLength(file.stats.subsectorCount);
    expect(subsectors.map((sub) => sub.order)).toEqual(
      Array.from({ length: subsectors.length }, (_, index) => index + 1),
    );
    expect(new Set(subsectors.map((sub) => sub.code)).size).toBe(subsectors.length);
  });
});
