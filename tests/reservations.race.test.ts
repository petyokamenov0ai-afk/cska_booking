/**
 * Race tests — IMPLEMENTATION_PLAN.md §10:
 *
 *   "integration test firing N parallel reservation attempts for the same seat
 *    against a real Postgres — asserts exactly one succeeds (proves the index +
 *    retry path)."
 *
 * Three things are proven here, and they are not the same thing:
 *
 * 1. **The application never double-books** under concurrency (`createHold`).
 * 2. **The storage layer cannot be made to double-book** even with the
 *    application bypassed — a raw second `active` row is rejected by
 *    `reservation_seat_active_uq` with SQLSTATE 23505. A green test on (1) alone
 *    could just mean "nothing tried".
 * 3. **Losers lose cleanly**: every rejection is `SeatsTakenError` naming exactly
 *    the seats that were taken, and a loser leaves nothing behind — no orphan
 *    PENDING reservation, and none of its *other* seats stuck.
 *
 * (3) is also the regression test for the deadlock class `lib/reservations.ts`
 * documents: `createMany` locks one index entry per seat in array order, so two
 * overlapping baskets inserting shared seats in opposite orders deadlock and
 * Postgres kills one — a 500 for a user whose seats were free. `createHold`
 * sorts the batch by seat id to make a lock cycle impossible, and the assertion
 * "every rejection is SeatsTakenError" is what would catch a regression: a
 * deadlock arrives as a bare transaction error, not as SeatsTakenError.
 */

// `./helpers/db` first: it loads `.env`, which Vitest does not do and
// `@prisma/client` never does.
import {
  activeSeatIds,
  countReservations,
  createTestEvent,
  doubleBookedSeatIds,
  guardIndexDefinition,
  holderOfSeat,
  insertActiveReservationSeatRaw,
  isUniqueViolation,
  prisma,
  readReservation,
  resetTestData,
  setupTestDatabase,
  skipBanner,
  teardownTestDatabase,
  testSeatIds,
  testSessionId,
  type TestEvent,
} from './helpers/db';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelReservation,
  createHold,
  SeatsTakenError,
} from '@/lib/reservations';
import type { ReservationDTO } from '@/lib/types';

const db = await setupTestDatabase();
if (!db.ok) console.error(skipBanner(db, 'reservations.race'));
if (db.guardWasMissing) {
  console.error(
    '\nWARNING: reservation_seat_active_uq was missing and has been re-created.\n' +
      'Something dropped the double-booking guard — most likely `prisma migrate dev`.\n' +
      'Use `npm run db:deploy` (migrate deploy) instead; see prisma/schema.prisma.\n',
  );
}

/** Same seat, N attempts at once. §10 asks for N = 20. */
const N = 20;

interface Outcome {
  fulfilled: ReservationDTO[];
  rejected: unknown[];
}

function split(results: Array<PromiseSettledResult<ReservationDTO>>): Outcome {
  const fulfilled: ReservationDTO[] = [];
  const rejected: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value);
    else rejected.push(result.reason);
  }
  return { fulfilled, rejected };
}

/** Turns unexpected rejections into a message a human can act on. */
function describeErrors(errors: unknown[]): string {
  return errors
    .map((error) =>
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    )
    .join('\n  ');
}

// One teardown for the whole file: `$disconnect()` per suite would drop the pool
// while the next suite is still using it.
afterAll(async () => {
  if (db.ok) await resetTestData();
  await teardownTestDatabase();
});

describe.skipIf(!db.ok)('createHold concurrency', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent();
  });

  it(`lets exactly one of ${N} simultaneous holds win the same seat`, async () => {
    const [seatId] = testSeatIds(1);

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, index) =>
        createHold({
          eventId: event.id,
          seatIds: [seatId],
          sessionId: testSessionId(`racer-${index}`),
        }),
      ),
    );
    const { fulfilled, rejected } = split(results);

    // Exactly one winner.
    expect(
      fulfilled.length,
      `expected 1 winner, got ${fulfilled.length}. Rejections:\n  ${describeErrors(rejected)}`,
    ).toBe(1);
    expect(rejected.length).toBe(N - 1);

    // Every loser lost for the right reason, with the right payload. A deadlock
    // or a pool timeout would show up here as a non-SeatsTakenError.
    const wrongError = rejected.filter((error) => !(error instanceof SeatsTakenError));
    expect(
      wrongError.length,
      `all ${N - 1} losers must fail with SeatsTakenError; got:\n  ${describeErrors(wrongError)}`,
    ).toBe(0);
    for (const error of rejected) {
      const seatsTaken = error as SeatsTakenError;
      expect(seatsTaken.apiCode).toBe('SEATS_TAKEN');
      expect(seatsTaken.conflictSeats).toEqual([seatId]);
    }

    // The database agrees: one hold, one active row, no duplicates.
    const winner = fulfilled[0];
    expect(winner.status).toBe('PENDING');
    expect(winner.seats.map((seat) => seat.seatId)).toEqual([seatId]);
    expect(await activeSeatIds(event.id)).toEqual([seatId]);
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
    expect(await holderOfSeat(event.id, seatId)).toBe(winner.code);

    // Losers rolled back completely — 19 aborted transactions left no rows.
    expect(await countReservations(event.id)).toBe(1);
  });

  it('never double-holds a seat when baskets overlap, and rolls losers back whole', async () => {
    // Six seats, twelve baskets of three, sliding window: every seat is wanted
    // by several baskets and no basket is disjoint from all others.
    const pool = testSeatIds(6);
    const baskets: string[][] = Array.from({ length: 12 }, (_, index) => {
      const start = index % 4;
      return pool.slice(start, start + 3);
    });

    const results = await Promise.allSettled(
      baskets.map((seatIds, index) =>
        createHold({
          eventId: event.id,
          seatIds,
          sessionId: testSessionId(`basket-${index}`),
        }),
      ),
    );
    const { fulfilled, rejected } = split(results);

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const wrongError = rejected.filter((error) => !(error instanceof SeatsTakenError));
    expect(
      wrongError.length,
      `overlapping baskets must fail with SeatsTakenError only (a deadlock would ` +
        `appear here). Got:\n  ${describeErrors(wrongError)}`,
    ).toBe(0);

    // No seat is held twice — the invariant the partial index exists to enforce.
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);

    // Winners' seat sets are pairwise disjoint.
    const seen = new Set<string>();
    for (const reservation of fulfilled) {
      for (const seat of reservation.seats) {
        expect(seen.has(seat.seatId), `seat ${seat.seatId} won twice`).toBe(false);
        seen.add(seat.seatId);
      }
    }

    // The active rows in the DB are *exactly* the winners' seats: no loser left a
    // partially-inserted basket behind, and no winner lost a seat afterwards.
    expect(await activeSeatIds(event.id)).toEqual([...seen].sort());
    expect(await countReservations(event.id)).toBe(fulfilled.length);

    // Each loser named a non-empty subset of what it asked for, all of which are
    // genuinely held by somebody else.
    for (const error of rejected) {
      const seatsTaken = error as SeatsTakenError;
      expect(seatsTaken.conflictSeats.length).toBeGreaterThan(0);
      for (const seatId of seatsTaken.conflictSeats) {
        expect(pool).toContain(seatId);
        expect(seen.has(seatId)).toBe(true);
      }
    }
  });

  it('reports only the lost seats when baskets partially overlap', async () => {
    const [s1, s2, s3, s4, s5] = testSeatIds(5);

    const first = await createHold({
      eventId: event.id,
      seatIds: [s1, s2, s3],
      sessionId: testSessionId('first'),
    });

    // Wants s3 (taken) plus s4, s5 (free).
    const rejection = await createHold({
      eventId: event.id,
      seatIds: [s3, s4, s5],
      sessionId: testSessionId('second'),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SeatsTakenError);
    expect((rejection as SeatsTakenError).conflictSeats).toEqual([s3]);

    // s4 and s5 must be free again: the failed insert was one transaction.
    expect(await activeSeatIds(event.id)).toEqual([s1, s2, s3].sort());
    expect(await countReservations(event.id)).toBe(1);
    expect(await holderOfSeat(event.id, s3)).toBe(first.code);
    expect(await holderOfSeat(event.id, s4)).toBeNull();
  });

  it('frees the seat for the next caller once the winner cancels', async () => {
    const [seatId] = testSeatIds(1);

    const winner = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('winner'),
    });
    await expect(
      createHold({
        eventId: event.id,
        seatIds: [seatId],
        sessionId: testSessionId('blocked'),
      }),
    ).rejects.toBeInstanceOf(SeatsTakenError);

    await cancelReservation(winner.code);
    expect(await activeSeatIds(event.id)).toEqual([]);

    const next = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('next'),
    });
    expect(next.status).toBe('PENDING');
    expect(await holderOfSeat(event.id, seatId)).toBe(next.code);
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
  });

  it('holds the same seat independently for two different events', async () => {
    const [seatId] = testSeatIds(1);
    const other = await createTestEvent({ title: 'ЦСКА – Ботев (test)' });

    const a = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('event-a'),
    });
    const b = await createHold({
      eventId: other.id,
      seatIds: [seatId],
      sessionId: testSessionId('event-b'),
    });

    // The guard is on (eventId, seatId): one seat, two matches, no conflict.
    expect(a.code).not.toBe(b.code);
    expect(await activeSeatIds(event.id)).toEqual([seatId]);
    expect(await activeSeatIds(other.id)).toEqual([seatId]);
  });
});

describe.skipIf(!db.ok)('reservation_seat_active_uq (the storage-layer guard)', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent();
  });

  it('exists as a partial unique index on (eventId, seatId) WHERE active', async () => {
    const indexdef = await guardIndexDefinition();
    expect(
      indexdef,
      'reservation_seat_active_uq is missing. `prisma migrate dev` drops it because ' +
        'a partial index is invisible to Prisma\'s datamodel — use `npm run db:deploy`.',
    ).not.toBeNull();

    const sql = (indexdef ?? '').replace(/\s+/g, ' ');
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/ON [\w."]*"ReservationSeat"/i);
    expect(sql).toMatch(/\("eventId", "seatId"\)/);
    expect(sql).toMatch(/WHERE "?active"?/i);
  });

  it('rejects a second active row for the same (event, seat) even with the app bypassed', async () => {
    const [seatId] = testSeatIds(1);
    const held = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('holder'),
    });

    // A second reservation that tries to claim the same seat by raw insert.
    const intruder = await prisma.reservation.create({
      data: {
        id: 'itest-intruder',
        code: 'ITEST1',
        eventId: event.id,
        status: 'PENDING',
        sessionId: testSessionId('intruder'),
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });

    const failure = await insertActiveReservationSeatRaw({
      reservationId: intruder.id,
      eventId: event.id,
      seatId,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure, 'the partial unique index did not reject a duplicate active row').not.toBeNull();
    expect(isUniqueViolation(failure)).toBe(true);
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
    expect(await holderOfSeat(event.id, seatId)).toBe(held.code);
  });

  it('permits any number of inactive rows for the same (event, seat)', async () => {
    // The index is partial: released holds must not block the seat forever, and
    // the audit trail (who held what, when) must survive.
    const [seatId] = testSeatIds(1);

    for (let index = 0; index < 3; index += 1) {
      const hold = await createHold({
        eventId: event.id,
        seatIds: [seatId],
        sessionId: testSessionId(`serial-${index}`),
      });
      await cancelReservation(hold.code);
      const snapshot = await readReservation(hold.code);
      expect(snapshot?.status).toBe('CANCELLED');
      expect(snapshot?.seats.every((seat) => !seat.active)).toBe(true);
    }

    const rows = await prisma.reservationSeat.count({ where: { eventId: event.id, seatId } });
    expect(rows).toBe(3);
    expect(await activeSeatIds(event.id)).toEqual([]);
  });
});
