#!/usr/bin/env tsx
/**
 * Database seed — geometry from `data/stadium.json` + the single stadium row.
 *
 *   npm run db:seed
 *   npx tsx prisma/seed.ts [--dry-run] [--refresh-geometry] [--file <path>]
 *
 * Guarantees:
 *   * **Idempotent.** Sectors/subsectors are upserted on their unique `code`;
 *     seats are inserted with `skipDuplicates`; the stadium row has a fixed id.
 *   * **Never destructive to bookings.** Nothing here touches Reservation or
 *     ReservationSeat. Geometry seats that vanish from the file are deactivated,
 *     not deleted, when a reservation still references them.
 *   * **Fast.** Seats go in via `createMany` batched at 5 000 rows across
 *     subsectors, so ~14 k seats is a handful of round trips.
 *   * **Re-asserts the double-booking guard** (the partial unique index that
 *     Prisma's datamodel cannot express) so it can never silently go missing.
 *
 * Re-running re-asserts the stadium row's permanently-open sales window.
 * Bookings are left alone.
 *
 * Flags:
 *   --dry-run           compute and print the whole plan, touch no database.
 *   --refresh-geometry  re-diff x/y/angle/type/white even for subsectors whose
 *                       seat count already matches (use after re-running the
 *                       PDF pipeline with corrected coordinates).
 *   --file <path>       explicit geometry file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { SeatGeometry, StadiumFile } from '../lib/types';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/** Rows per `createMany`. 5 000 × 9 columns stays well under Postgres' 65 535 bind params. */
const SEAT_CHUNK = 5_000;

/** Rows per batched update transaction when geometry drifts. */
const UPDATE_CHUNK = 500;

/** Must match lib/stadiumEvent.ts — the one hidden "stadium" event row. */
const STADIUM_EVENT_ID = 'stadium';
const ALWAYS_OPEN_FROM = new Date('2000-01-01T00:00:00.000Z');
const ALWAYS_OPEN_UNTIL = new Date('2100-01-01T00:00:00.000Z');

/* ------------------------------------------------------------------ *
 * Geometry loading
 * ------------------------------------------------------------------ */

const REPO_ROOT = resolve(__dirname, '..');

interface Cli {
  dryRun: boolean;
  refreshGeometry: boolean;
  file?: string;
}

function parseCli(argv: string[]): Cli {
  const fileIdx = argv.indexOf('--file');
  return {
    dryRun: argv.includes('--dry-run'),
    refreshGeometry: argv.includes('--refresh-geometry'),
    file: fileIdx >= 0 ? argv[fileIdx + 1] : undefined,
  };
}

/** Same resolution rule as `lib/stadium.ts`: real file first, fixture second. */
function resolveGeometryPath(explicit: string | undefined): string {
  if (explicit) return resolve(process.cwd(), explicit);
  const primary = resolve(REPO_ROOT, 'data', 'stadium.json');
  if (existsSync(primary)) return primary;
  return resolve(REPO_ROOT, 'data', 'stadium.sample.json');
}

function loadStadium(path: string): StadiumFile {
  if (!existsSync(path)) {
    throw new Error(
      `geometry file not found: ${path}\n` +
        'Run the PDF pipeline, or `npm run pipeline:sample` for the development fixture.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as StadiumFile;
}

/* ------------------------------------------------------------------ *
 * Pure planning — no database access
 * ------------------------------------------------------------------ */

interface SubsectorPlan {
  code: string;
  latin: string;
  order: number;
  sectorCode: string;
  viewBox: string;
  width: number;
  height: number;
  svgPath: string;
  centroidX: number;
  centroidY: number;
  seatCount: number;
  rowCount: number;
  seats: SeatGeometry[];
}

interface SectorPlan {
  code: string;
  latin: string;
  name: string;
  nameBg: string;
  order: number;
  subsectors: SubsectorPlan[];
}

function buildPlan(file: StadiumFile): SectorPlan[] {
  return file.sectors
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((sector) => {
      const subs = sector.subsectors.slice().sort((a, b) => a.order - b.order);
      return {
        code: sector.code,
        latin: sector.latin,
        name: sector.name,
        nameBg: sector.nameBg,
        order: sector.order,
        subsectors: subs.map((sub) => ({
          code: sub.code,
          latin: sub.latin,
          order: sub.order,
          sectorCode: sector.code,
          viewBox: sub.viewBox,
          width: sub.width,
          height: sub.height,
          svgPath: sub.svgPath,
          centroidX: sub.centroid.x,
          centroidY: sub.centroid.y,
          seatCount: sub.seats.length,
          rowCount: sub.rowCount,
          seats: sub.seats,
        })),
      };
    });
}

/**
 * The stadium has no match days, so there is exactly one hidden `Event` row —
 * see lib/stadiumEvent.ts for why it exists at all (the double-booking guard is
 * an index on `("eventId", "seatId")`). Sales are permanently open, and every
 * subsector is bookable.
 */
function stadiumEvents(): Array<{
  id: string;
  title: string;
  kickoffAt: Date;
  salesOpen: Date;
  salesClose: Date;
  status: 'DRAFT' | 'ON_SALE' | 'CLOSED';
}> {
  return [
    {
      id: STADIUM_EVENT_ID,
      title: 'Стадион „Българска армия“',
      kickoffAt: ALWAYS_OPEN_UNTIL,
      salesOpen: ALWAYS_OPEN_FROM,
      salesClose: ALWAYS_OPEN_UNTIL,
      status: 'ON_SALE',
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

interface SubsectorResult {
  order: number;
  code: string;
  latin: string;
  rows: number;
  geometrySeats: number;
  seatsBefore: number;
  created: number;
  updated: number;
  deactivated: number;
}

function printTable(results: SubsectorResult[]): void {
  const header = ['#', 'subsector', 'latin', 'rows', 'seats', 'in db', 'created', 'updated', 'off'];
  const body = results.map((r) => [
    String(r.order),
    r.code,
    r.latin,
    String(r.rows),
    String(r.geometrySeats),
    String(r.seatsBefore),
    String(r.created),
    String(r.updated),
    String(r.deactivated),
  ]);

  const widths = header.map((h, i) => Math.max([...h].length, ...body.map((row) => [...row[i]].length)));
  const render = (cells: string[]): string =>
    cells.map((c, i) => (i <= 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');

  console.log('');
  console.log(render(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(render(row));

  const total = (pick: (r: SubsectorResult) => number): string =>
    String(results.reduce((n, r) => n + pick(r), 0));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  console.log(
    render([
      '',
      `${results.length} subs`,
      '',
      total((r) => r.rows),
      total((r) => r.geometrySeats),
      total((r) => r.seatsBefore),
      total((r) => r.created),
      total((r) => r.updated),
      total((r) => r.deactivated),
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

const prisma = new PrismaClient({ log: ['warn', 'error'] });

/** The hand-written partial unique index from the init migration. */
const GUARD_INDEX = 'reservation_seat_active_uq';

/**
 * Belt and braces for the double-booking guard.
 *
 * The index is a *partial* unique index, which Prisma's datamodel cannot
 * express — it only exists because the init migration creates it by hand.
 * That makes it invisible to `prisma migrate diff`, and therefore droppable by
 * an unlucky `prisma migrate dev` run (`migrate deploy` never touches it).
 * Since every environment runs the seed right after migrating, recreating it
 * here idempotently means the storage-layer guarantee can never silently go
 * missing.
 *
 * If creation fails because conflicting active rows already exist, that is a
 * real double-booking in the data and the seed *should* stop.
 */
async function ensureDoubleBookingGuard(): Promise<void> {
  // Static DDL, no interpolated values — `Unsafe` only because Prisma's tagged
  // template cannot parameterise identifiers.
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${GUARD_INDEX}" ` +
      `ON "ReservationSeat" ("eventId", "seatId") WHERE "active"`,
  );

  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ${GUARD_INDEX}
  `;
  if (rows.length === 0) {
    throw new Error(`the ${GUARD_INDEX} partial unique index is missing and could not be created`);
  }
  console.log(`seed: double-booking guard OK — ${rows[0].indexdef}`);
}

/** Buffers seat rows across subsectors and flushes in `SEAT_CHUNK` batches. */
class SeatWriter {
  private buffer: Prisma.SeatCreateManyInput[] = [];
  private written = 0;

  async push(rows: Prisma.SeatCreateManyInput[]): Promise<void> {
    this.buffer.push(...rows);
    while (this.buffer.length >= SEAT_CHUNK) {
      await this.write(this.buffer.splice(0, SEAT_CHUNK));
    }
  }

  async flush(): Promise<number> {
    while (this.buffer.length > 0) {
      await this.write(this.buffer.splice(0, SEAT_CHUNK));
    }
    return this.written;
  }

  private async write(batch: Prisma.SeatCreateManyInput[]): Promise<void> {
    const { count } = await prisma.seat.createMany({ data: batch, skipDuplicates: true });
    this.written += count;
    console.log(`  … inserted ${count} seats (${this.written} total)`);
  }
}

function seatRow(subsectorId: string, seat: SeatGeometry): Prisma.SeatCreateManyInput {
  return {
    subsectorId,
    row: seat.row,
    number: seat.number,
    x: seat.x,
    y: seat.y,
    angle: seat.angle,
    type: seat.type,
    white: seat.white,
  };
}

function seatKey(seat: { row: number; number: number }): string {
  return `${seat.row}:${seat.number}`;
}

const COORD_EPS = 1e-9;

async function seedGeometry(
  plan: SectorPlan[],
  refreshGeometry: boolean,
): Promise<SubsectorResult[]> {
  const writer = new SeatWriter();
  const results: SubsectorResult[] = [];

  for (const sector of plan) {
    const sectorRow = await prisma.sector.upsert({
      where: { code: sector.code },
      create: {
        code: sector.code,
        latin: sector.latin,
        name: sector.name,
        nameBg: sector.nameBg,
        order: sector.order,
      },
      update: {
        latin: sector.latin,
        name: sector.name,
        nameBg: sector.nameBg,
        order: sector.order,
      },
    });
    console.log(`sector ${sector.code} / ${sector.latin} — ${sector.nameBg} · ${sector.name}`);

    for (const sub of sector.subsectors) {
      const geometry = {
        latin: sub.latin,
        viewBox: sub.viewBox,
        width: sub.width,
        height: sub.height,
        svgPath: sub.svgPath,
        centroidX: sub.centroidX,
        centroidY: sub.centroidY,
        seatCount: sub.seatCount,
        rowCount: sub.rowCount,
        order: sub.order,
      };
      const subRow = await prisma.subsector.upsert({
        where: { code: sub.code },
        create: { code: sub.code, sectorId: sectorRow.id, ...geometry },
        update: { sectorId: sectorRow.id, ...geometry },
      });
      const seatsBefore = await prisma.seat.count({ where: { subsectorId: subRow.id } });
      let created = 0;
      let updated = 0;
      let deactivated = 0;

      // Matching counts are not proof the geometry matches: a pipeline change
      // that moves every seat without adding one (a flipped orientation, say)
      // leaves the count identical, and skipping on count alone then serves
      // stale coordinates for ever. So probe a few seats and re-diff if they
      // have drifted.
      const stale = seatsBefore > 0 && (await geometryDrifted(subRow.id, sub));

      if (seatsBefore === 0) {
        // Fresh subsector — the fast path.
        await writer.push(sub.seats.map((seat) => seatRow(subRow.id, seat)));
        created = sub.seats.length;
      } else if (seatsBefore === sub.seatCount && !refreshGeometry && !stale) {
        // Counts match and the sampled coordinates agree: nothing to do.
        console.log(`  ${sub.code}: ${seatsBefore} seats already present — skipped`);
      } else {
        if (stale && !refreshGeometry) {
          console.log(`  ${sub.code}: coordinates changed in the geometry file — re-diffing`);
        }
        const reconciled = await reconcileSeats(subRow.id, sub, writer);
        created = reconciled.created;
        updated = reconciled.updated;
        deactivated = reconciled.deactivated;
      }

      results.push({
        order: sub.order,
        code: sub.code,
        latin: sub.latin,
        rows: sub.rowCount,
        geometrySeats: sub.seatCount,
        seatsBefore,
        created,
        updated,
        deactivated,
      });
    }
  }

  await writer.flush();
  return results;
}

/**
 * Cheap staleness probe: do a handful of the file's seats still sit where the
 * database thinks they do? Samples the corners of the numbering (first and last
 * row, first and last seat), which is exactly what a re-orientation moves.
 */
async function geometryDrifted(subsectorId: string, sub: SubsectorPlan): Promise<boolean> {
  const rows = sub.seats.map((s) => s.row);
  const probes: SeatGeometry[] = [];
  for (const row of [Math.min(...rows), Math.max(...rows)]) {
    const inRow = sub.seats.filter((s) => s.row === row);
    if (inRow.length === 0) continue;
    probes.push(inRow.reduce((a, b) => (a.number <= b.number ? a : b)));
    probes.push(inRow.reduce((a, b) => (a.number >= b.number ? a : b)));
  }
  for (const probe of probes) {
    const found = await prisma.seat.findFirst({
      where: { subsectorId, row: probe.row, number: probe.number },
      select: { x: true, y: true, angle: true, white: true },
    });
    if (found === null) return true;
    if (
      Math.abs(found.x - probe.x) > COORD_EPS ||
      Math.abs(found.y - probe.y) > COORD_EPS ||
      Math.abs(found.angle - probe.angle) > COORD_EPS ||
      found.white !== probe.white
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Slow path: the DB and the geometry file disagree. Insert what is missing,
 * update coordinates that moved, and deactivate seats the drawing dropped —
 * never delete, because a reservation may reference them.
 */
async function reconcileSeats(
  subsectorId: string,
  sub: SubsectorPlan,
  writer: SeatWriter,
): Promise<{ created: number; updated: number; deactivated: number }> {
  const existing = await prisma.seat.findMany({
    where: { subsectorId },
    select: { id: true, row: true, number: true, x: true, y: true, angle: true, type: true, white: true },
  });
  const byKey = new Map(existing.map((seat) => [seatKey(seat), seat]));

  const toCreate: Prisma.SeatCreateManyInput[] = [];
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  const wanted = new Set<string>();

  for (const seat of sub.seats) {
    const key = seatKey(seat);
    wanted.add(key);
    const current = byKey.get(key);
    if (!current) {
      toCreate.push(seatRow(subsectorId, seat));
      continue;
    }
    const drifted =
      Math.abs(current.x - seat.x) > COORD_EPS ||
      Math.abs(current.y - seat.y) > COORD_EPS ||
      Math.abs(current.angle - seat.angle) > COORD_EPS ||
      current.type !== seat.type ||
      current.white !== seat.white;
    if (drifted) {
      updates.push(
        prisma.seat.update({
          where: { id: current.id },
          // `active` is deliberately untouched — it is an admin decision.
          data: { x: seat.x, y: seat.y, angle: seat.angle, type: seat.type, white: seat.white },
        }),
      );
    }
  }

  const orphans = existing.filter((seat) => !wanted.has(seatKey(seat))).map((seat) => seat.id);

  await writer.push(toCreate);

  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    await prisma.$transaction(updates.slice(i, i + UPDATE_CHUNK));
  }

  let deactivated = 0;
  if (orphans.length > 0) {
    const res = await prisma.seat.updateMany({ where: { id: { in: orphans } }, data: { active: false } });
    deactivated = res.count;
    console.warn(
      `  ${sub.code}: ${deactivated} seat(s) are no longer in the drawing — deactivated, not deleted ` +
        '(reservations may reference them)',
    );
  }

  if (toCreate.length || updates.length || deactivated) {
    console.log(
      `  ${sub.code}: reconciled — +${toCreate.length} new, ~${updates.length} moved, -${deactivated} deactivated`,
    );
  }
  return { created: toCreate.length, updated: updates.length, deactivated };
}

async function seedEvents(): Promise<void> {
  for (const ev of stadiumEvents()) {
    const data = {
      title: ev.title,
      kickoffAt: ev.kickoffAt,
      salesOpen: ev.salesOpen,
      salesClose: ev.salesClose,
      status: ev.status,
    };
    await prisma.event.upsert({ where: { id: ev.id }, create: { id: ev.id, ...data }, update: data });

    const held = await prisma.reservation.count({ where: { eventId: ev.id } });
    console.log(
      `event ${ev.status.padEnd(7)} "${ev.title}" — kickoff ${ev.kickoffAt.toISOString()}, ` +
        `${held} existing reservation(s) left untouched`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Dry run
 * ------------------------------------------------------------------ */

function printDryRun(plan: SectorPlan[]): void {
  const results: SubsectorResult[] = plan.flatMap((sector) =>
    sector.subsectors.map((sub) => ({
      order: sub.order,
      code: sub.code,
      latin: sub.latin,
      rows: sub.rowCount,
      geometrySeats: sub.seatCount,
      seatsBefore: 0,
      created: sub.seatCount,
      updated: 0,
      deactivated: 0,
    })),
  );
  printTable(results);
  console.log('');
  for (const ev of stadiumEvents()) {
    console.log(
      `event ${ev.status.padEnd(7)} "${ev.title}" — kickoff ${ev.kickoffAt.toISOString()}`,
    );
  }
  console.log('\n--dry-run: nothing was written.');
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const path = resolveGeometryPath(cli.file);
  const file = loadStadium(path);
  const plan = buildPlan(file);

  const seatTotal = plan.reduce((n, s) => n + s.subsectors.reduce((m, x) => m + x.seatCount, 0), 0);
  console.log(`seed: geometry ${path}`);
  console.log(
    `seed: ${plan.length} sectors, ${plan.reduce((n, s) => n + s.subsectors.length, 0)} subsectors, ` +
      `${seatTotal} seats (file says ${file.stats.seatTotal})`,
  );
  if (seatTotal !== file.stats.seatTotal) {
    console.warn(
      `seed: WARNING stats.seatTotal (${file.stats.seatTotal}) disagrees with the seat arrays (${seatTotal}). ` +
        'Run `npx tsx scripts/pipeline/validate.ts` before seeding.',
    );
  }

  if (cli.dryRun) {
    printDryRun(plan);
    return;
  }

  await ensureDoubleBookingGuard();

  const results = await seedGeometry(plan, cli.refreshGeometry);
  await seedEvents();

  printTable(results);

  const [seats, events, reservations] = await Promise.all([
    prisma.seat.count(),
    prisma.event.count(),
    prisma.reservation.count(),
  ]);
  console.log('');
  console.log(`seed: done — ${seats} seats, ${events} events, ${reservations} reservation(s) preserved.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    console.error('\nseed: FAILED');
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
