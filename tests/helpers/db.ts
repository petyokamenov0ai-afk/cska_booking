/**
 * Integration-test database harness (IMPLEMENTATION_PLAN.md §10).
 *
 * The race, expiry and availability suites are integration tests **on purpose**:
 * the double-booking guard is a partial unique index, so the only thing that can
 * prove it works is a real Postgres. Mocks would prove the mock.
 *
 * What this module does, once per test file:
 *
 * 1. **Loads `.env`.** Vitest does not, and `@prisma/client` (unlike the Prisma
 *    CLI) never reads it, so without this `DATABASE_URL` is undefined under
 *    `npx vitest run` even with `docker compose up -d` running. Values already
 *    present in `process.env` always win, so CI can override.
 * 2. **Probes Postgres** with a hard timeout. If it is not there the suites
 *    `describe.skip` with a loud banner rather than failing — see `skipBanner`.
 * 3. **Applies migrations** (`prisma migrate deploy`) if the schema is missing,
 *    and re-asserts the hand-written partial unique index, which
 *    `prisma migrate dev` is known to want to drop (it is invisible to Prisma's
 *    datamodel — see prisma/schema.prisma).
 * 4. **Creates a dedicated test subsector** (`ТСТ1`) with a fixed set of seats
 *    carrying deterministic ids. Tests own their own geometry, so they neither
 *    depend on `npm run db:seed` having run nor break when
 *    `data/stadium.sample.json` changes.
 *
 * Between tests, `resetTestData()` deletes only rows the tests created
 * (`Event.id LIKE 'itest-%'`, which cascades to reservations/seat rows)
 * and re-activates the test seats. Geometry is kept, and a developer's seeded
 * demo events survive a test run untouched.
 *
 * Nothing here uses a second PrismaClient: the services under test import
 * `prisma` from `@/lib/db`, so the tests do too. `@prisma/client` resolves
 * `DATABASE_URL` lazily on first connect (verified), which is why loading the
 * env after the import is safe.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db';

// One `.env` loader for the whole suite, shared with `globalTeardown.ts`.
import { PROJECT_ROOT, loadDotEnv } from './env';

export { PROJECT_ROOT };

/** Hides the password when a connection string goes into a failure message. */
function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

/**
 * Ensures the pool is big enough for the concurrency the race test creates.
 *
 * Every `createHold` runs an interactive transaction, which occupies one
 * connection for its whole life. Prisma's default `connection_limit` is
 * `cpus * 2 + 1`; 20 simultaneous holds on a small machine would queue past
 * `pool_timeout` and surface as a transaction error that has nothing to do with
 * the behaviour under test. An explicit setting in the URL always wins.
 */
function withTestPoolSettings(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', '30');
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', '20');
    }
    return parsed.toString();
  } catch {
    return url; // not a URL we can parse; leave it exactly as the user wrote it
  }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export interface DatabaseStatus {
  /** True when the suites may run. */
  ok: boolean;
  /** Why not, when `ok` is false — printed by `skipBanner`. */
  reason?: string;
  /** Redacted connection string actually used. */
  url?: string;
  /** True when migrations had to be applied by this run. */
  migrated?: boolean;
  /**
   * True when `reservation_seat_active_uq` was missing and had to be created
   * here. Non-fatal (the race suite proves it enforces either way) but it means
   * something dropped the guard — most likely `prisma migrate dev`.
   */
  guardWasMissing?: boolean;
}

const CONNECT_TIMEOUT_MS = Number(process.env.TEST_DB_TIMEOUT_MS ?? 8_000);

const REQUIRED_TABLES = [
  'Sector',
  'Subsector',
  'Seat',
  'Event',
  'Reservation',
  'ReservationSeat',
] as const;

export const GUARD_INDEX_NAME = 'reservation_seat_active_uq';

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not answer within ${ms} ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Test geometry
 * ------------------------------------------------------------------ */

/** Cyrillic, deliberately outside the real А/Б/В/Г set so nothing collides. */
export const TEST_SECTOR_CODE = 'ТСТ';
export const TEST_SUBSECTOR_CODE = 'ТСТ1';
export const TEST_SUBSECTOR_LATIN = 'TST1';

/** Latin homoglyph of the subsector code — must never resolve to anything. */
export const TEST_SUBSECTOR_CODE_LATIN_LOOKALIKE = 'TCT1';

export const TEST_SECTOR_ID = 'itest-sector';
export const TEST_SUBSECTOR_ID = 'itest-subsector';

export const TEST_ROWS = 5;
export const TEST_SEATS_PER_ROW = 12;
export const TEST_SEAT_TOTAL = TEST_ROWS * TEST_SEATS_PER_ROW; // 60

export const TEST_SUBSECTOR_VIEWBOX = '0 0 600 400';
export const TEST_SUBSECTOR_WIDTH = 600;
export const TEST_SUBSECTOR_HEIGHT = 400;

/** Stable, human-readable seat ids: `itest-seat-r3-n07`. */
export function testSeatId(row: number, number: number): string {
  return `itest-seat-r${row}-n${String(number).padStart(2, '0')}`;
}

/** Every seat id of the test subsector, ordered by (row, number). */
export function allTestSeatIds(): string[] {
  const ids: string[] = [];
  for (let row = 1; row <= TEST_ROWS; row += 1) {
    for (let number = 1; number <= TEST_SEATS_PER_ROW; number += 1) {
      ids.push(testSeatId(row, number));
    }
  }
  return ids;
}

/**
 * `count` seat ids from the test subsector, ordered by (row, number).
 *
 * Deterministic, so a failing race test can be reproduced exactly.
 */
export function testSeatIds(count: number, offset = 0): string[] {
  const all = allTestSeatIds();
  if (offset + count > all.length) {
    throw new Error(
      `The test subsector has ${all.length} seats; asked for ${count} from offset ${offset}.`,
    );
  }
  return all.slice(offset, offset + count);
}

async function ensureTestGeometry(): Promise<void> {
  await prisma.sector.upsert({
    where: { id: TEST_SECTOR_ID },
    update: {},
    create: {
      id: TEST_SECTOR_ID,
      code: TEST_SECTOR_CODE,
      latin: 'TST',
      name: 'Test stand',
      nameBg: 'Тестова трибуна',
      order: 99,
    },
  });

  await prisma.subsector.upsert({
    where: { id: TEST_SUBSECTOR_ID },
    update: {
      seatCount: TEST_SEAT_TOTAL,
      rowCount: TEST_ROWS,
    },
    create: {
      id: TEST_SUBSECTOR_ID,
      sectorId: TEST_SECTOR_ID,
      code: TEST_SUBSECTOR_CODE,
      latin: TEST_SUBSECTOR_LATIN,
      viewBox: TEST_SUBSECTOR_VIEWBOX,
      width: TEST_SUBSECTOR_WIDTH,
      height: TEST_SUBSECTOR_HEIGHT,
      svgPath: 'M 0 0 L 600 0 L 600 400 L 0 400 Z',
      centroidX: 300,
      centroidY: 200,
      seatCount: TEST_SEAT_TOTAL,
      rowCount: TEST_ROWS,
      order: 99,
    },
  });

  const existing = await prisma.seat.count({ where: { subsectorId: TEST_SUBSECTOR_ID } });
  if (existing === TEST_SEAT_TOTAL) return;

  // Row 1 at the bottom (largest y), numbers increasing with x — the same
  // orientation docs/DATA_CONTRACT.md mandates for real geometry, so the test
  // fixture cannot teach anyone the wrong convention.
  const rows: Array<{
    id: string;
    subsectorId: string;
    row: number;
    number: number;
    x: number;
    y: number;
    angle: number;
    active: boolean;
  }> = [];
  for (let row = 1; row <= TEST_ROWS; row += 1) {
    for (let number = 1; number <= TEST_SEATS_PER_ROW; number += 1) {
      rows.push({
        id: testSeatId(row, number),
        subsectorId: TEST_SUBSECTOR_ID,
        row,
        number,
        x: 30 + (number - 1) * 45,
        y: TEST_SUBSECTOR_HEIGHT - 40 - (row - 1) * 60,
        angle: 0,
        active: true,
      });
    }
  }
  await prisma.seat.createMany({ data: rows, skipDuplicates: true });
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

let setupPromise: Promise<DatabaseStatus> | null = null;

async function tablesPresent(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ANY(${[...REQUIRED_TABLES]}::text[])
  `;
  return rows.length === REQUIRED_TABLES.length;
}

function runMigrateDeploy(url: string): string | null {
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      encoding: 'utf8',
    });
    return null;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error
        ? String((error as { stdout: unknown }).stdout)
        : '';
    return `${stdout}\n${stderr}`.trim() || (error as Error).message;
  }
}

/** `pg_indexes.indexdef` of the double-booking guard, or `null` if absent. */
export async function guardIndexDefinition(): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ${GUARD_INDEX_NAME}
  `;
  return rows[0]?.indexdef ?? null;
}

async function ensureGuardIndex(): Promise<boolean> {
  if ((await guardIndexDefinition()) !== null) return false;
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${GUARD_INDEX_NAME}" ` +
      `ON "ReservationSeat" ("eventId", "seatId") WHERE "active"`,
  );
  return true;
}

/**
 * Connects, migrates if needed, and installs the test geometry. Cached per
 * process, so four test files cost one setup each (Vitest isolates modules).
 *
 * Never throws: a missing database is a **skip**, not a failure.
 */
export function setupTestDatabase(): Promise<DatabaseStatus> {
  setupPromise ??= (async (): Promise<DatabaseStatus> => {
    loadDotEnv();

    const rawUrl = process.env.DATABASE_URL;
    if (rawUrl === undefined || rawUrl.trim().length === 0) {
      return {
        ok: false,
        reason:
          'DATABASE_URL is not set (and .env does not define it). ' +
          'Copy .env.example to .env, or export DATABASE_URL.',
      };
    }

    const url = withTestPoolSettings(rawUrl);
    process.env.DATABASE_URL = url;
    const redacted = redactUrl(url);

    try {
      await withTimeout(
        prisma.$queryRaw`SELECT 1`,
        CONNECT_TIMEOUT_MS,
        `Postgres at ${redacted}`,
      );
    } catch (error) {
      return {
        ok: false,
        url: redacted,
        reason:
          `cannot reach Postgres at ${redacted}\n  ${(error as Error).message}\n` +
          '  Start it with: docker compose up -d',
      };
    }

    let migrated = false;
    try {
      if (!(await tablesPresent())) {
        const failure = runMigrateDeploy(url);
        if (failure !== null) {
          return {
            ok: false,
            url: redacted,
            reason: `\`prisma migrate deploy\` failed:\n${failure}`,
          };
        }
        migrated = true;
        if (!(await tablesPresent())) {
          return {
            ok: false,
            url: redacted,
            reason:
              '`prisma migrate deploy` reported success but the tables are still missing. ' +
              'Is DATABASE_URL pointing at the schema you think it is?',
          };
        }
      }

      const guardWasMissing = await ensureGuardIndex();
      await ensureTestGeometry();
      await resetTestData();

      return { ok: true, url: redacted, migrated, guardWasMissing };
    } catch (error) {
      return {
        ok: false,
        url: redacted,
        reason: `database setup failed: ${(error as Error).message}`,
      };
    }
  })();

  return setupPromise;
}

/** Closes the pool so Vitest can exit. Safe to call when setup never ran. */
export async function teardownTestDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // Nothing to disconnect — the suite was skipped.
  }
}

/**
 * The loud explanatory message §10 asks for, printed once per skipped file.
 *
 * It names the exact command that makes the suite run, because a silently
 * skipped concurrency test is worse than no test: it looks green.
 */
export function skipBanner(status: DatabaseStatus, suite: string): string {
  return [
    '',
    '='.repeat(78),
    `SKIPPED: ${suite} — no PostgreSQL.`,
    '',
    `  ${status.reason ?? 'unknown reason'}`,
    '',
    '  These are integration tests by design: the double-booking guard is a',
    '  PARTIAL UNIQUE INDEX, so only a real Postgres can prove it holds.',
    '',
    '  To run them:   docker compose up -d && npx vitest run',
    '='.repeat(78),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Clean slate
 * ------------------------------------------------------------------ */

/**
 * Clean slate between tests: drops every event the tests created (which
 * cascades to `Reservation` and `ReservationSeat`) and re-activates any test
 * seat a test blocked.
 *
 * Deliberately **not** `TRUNCATE`: geometry must survive, and so must a
 * developer's seeded demo events — a test run should not empty the dev
 * database it happens to point at.
 */
export async function resetTestData(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Event" WHERE "id" LIKE 'itest-%'`;
  await prisma.seat.updateMany({
    where: { subsectorId: TEST_SUBSECTOR_ID, active: false },
    data: { active: true },
  });
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TestEventOptions {
  /** Reference instant the sales window is built around. Default `new Date()`. */
  now?: Date;
  status?: 'DRAFT' | 'ON_SALE' | 'CLOSED';
  title?: string;
  /** `salesOpen = now + this`. Default −1 day (already open). */
  salesOpenOffsetMs?: number;
  /** `salesClose = now + this`. Default +30 days (still open). */
  salesCloseOffsetMs?: number;
  kickoffOffsetMs?: number;
}

export interface TestEvent {
  id: string;
  title: string;
  kickoffAt: Date;
  salesOpen: Date;
  salesClose: Date;
}

/**
 * Creates an event.
 *
 * The id is prefixed `itest-` so `resetTestData()` can find it, and the sales
 * window defaults wide enough that a test may advance its injected clock by
 * hours without tripping `SalesClosedError`.
 */
export async function createTestEvent(options: TestEventOptions = {}): Promise<TestEvent> {
  const now = options.now ?? new Date();

  const event: TestEvent = {
    id: `itest-evt-${randomUUID()}`,
    title: options.title ?? 'ЦСКА – Левски (test)',
    kickoffAt: new Date(now.getTime() + (options.kickoffOffsetMs ?? 7 * DAY_MS)),
    salesOpen: new Date(now.getTime() + (options.salesOpenOffsetMs ?? -DAY_MS)),
    salesClose: new Date(now.getTime() + (options.salesCloseOffsetMs ?? 30 * DAY_MS)),
  };

  await prisma.event.create({
    data: {
      id: event.id,
      title: event.title,
      kickoffAt: event.kickoffAt,
      salesOpen: event.salesOpen,
      salesClose: event.salesClose,
      status: options.status ?? 'ON_SALE',
    },
  });

  return event;
}

/* ------------------------------------------------------------------ *
 * Inspection — what the DB actually holds
 * ------------------------------------------------------------------ */

export interface ReservationSnapshot {
  id: string;
  code: string;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
  expiresAt: Date | null;
  sessionId: string;
  name: string | null;
  /** The click-to-book free-text caption; NULL for every legacy row. */
  note: string | null;
  email: string | null;
  phone: string | null;
  seats: Array<{ seatId: string; active: boolean }>;
}

/** The raw row, bypassing the lazy-expiry presentation logic in the service. */
export async function readReservation(code: string): Promise<ReservationSnapshot | null> {
  const row = await prisma.reservation.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      status: true,
      expiresAt: true,
      sessionId: true,
      name: true,
      note: true,
      email: true,
      phone: true,
      seats: {
        select: { seatId: true, active: true },
        orderBy: { seatId: 'asc' },
      },
    },
  });
  return row;
}

/** Seat ids physically blocked for an event — exactly what the index sees. */
export async function activeSeatIds(eventId: string): Promise<string[]> {
  const rows = await prisma.reservationSeat.findMany({
    where: { eventId, active: true },
    select: { seatId: true },
    orderBy: { seatId: 'asc' },
  });
  return rows.map((row) => row.seatId);
}

/**
 * Any seat carrying more than one `active` row for the event — i.e. a
 * double-booking. Must always be empty; if it is not, the guard failed.
 */
export async function doubleBookedSeatIds(eventId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ seatId: string; n: number }>>`
    SELECT "seatId", COUNT(*)::int AS n
    FROM "ReservationSeat"
    WHERE "eventId" = ${eventId} AND "active"
    GROUP BY "seatId"
    HAVING COUNT(*) > 1
  `;
  return rows.map((row) => row.seatId);
}

/** Which reservation currently holds a seat, if any. */
export async function holderOfSeat(eventId: string, seatId: string): Promise<string | null> {
  const row = await prisma.reservationSeat.findFirst({
    where: { eventId, seatId, active: true },
    select: { reservation: { select: { code: true } } },
  });
  return row?.reservation.code ?? null;
}

export async function countReservations(eventId: string): Promise<number> {
  return prisma.reservation.count({ where: { eventId } });
}

/* ------------------------------------------------------------------ *
 * Clock surgery — how tests avoid sleeping for 7 minutes
 * ------------------------------------------------------------------ */

/**
 * Rewrites a hold's `expiresAt` into the past, leaving `status = PENDING` and
 * `active = true`.
 *
 * This is the "dead hold that still occupies the unique index" state that layer
 * (3) of §5 exists for. Every service function takes an injectable `now`, so
 * this is only needed when a test must make a hold stale *relative to the same
 * clock* another call will use.
 */
export async function forceExpiresAt(code: string, expiresAt: Date): Promise<void> {
  await prisma.reservation.update({ where: { code }, data: { expiresAt } });
}

/**
 * Sets a reservation's status **without** touching `ReservationSeat.active`.
 *
 * Emulates the window between a status change and the sweeper's cleanup: a
 * CANCELLED or EXPIRED reservation whose seat rows are still `active`. Reads
 * must treat those seats as free (`lib/availability.ts`), which is exactly what
 * this makes testable — the service functions would never leave that state
 * behind on their own.
 */
export async function setStatusWithoutReleasingSeats(
  code: string,
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED',
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Reservation" SET "status" = ${status}::"ReservationStatus" WHERE "code" = ${code}
  `;
}

/** Blocks/unblocks a geometry seat (`Seat.active`), i.e. the BLOCKED status. */
export async function setSeatActive(seatId: string, active: boolean): Promise<void> {
  await prisma.seat.update({ where: { id: seatId }, data: { active } });
}

/* ------------------------------------------------------------------ *
 * Raw insert — proving the index enforces, not just that the app avoids it
 * ------------------------------------------------------------------ */

/**
 * Inserts a `ReservationSeat` row straight through Prisma's raw layer,
 * bypassing every application check.
 *
 * The race suite uses it to prove the partial unique index *itself* rejects a
 * second active row (SQLSTATE 23505). Without this, a green race test could
 * also mean "the application happened not to try".
 */
export async function insertActiveReservationSeatRaw(args: {
  reservationId: string;
  eventId: string;
  seatId: string;
  active?: boolean;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "ReservationSeat" ("id", "reservationId", "eventId", "seatId", "active")
    VALUES (${`itest-rs-${randomUUID()}`}, ${args.reservationId}, ${args.eventId},
            ${args.seatId}, ${args.active ?? true})
  `;
}

/** True when the error is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  const text = String(
    (typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message: unknown }).message
      : error) ?? '',
  );
  return (
    text.includes('23505') ||
    text.toLowerCase().includes('unique constraint') ||
    text.toLowerCase().includes('duplicate key value')
  );
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const MINUTE = MINUTE_MS;

/** Distinct session ids, so "mine" flags and rate-limit buckets never collide. */
export function testSessionId(label = 'sid'): string {
  return `itest-${label}-${randomUUID()}`;
}

export { prisma };
