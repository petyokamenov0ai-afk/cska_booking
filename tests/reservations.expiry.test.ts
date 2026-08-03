/**
 * Expiry tests — IMPLEMENTATION_PLAN.md §5 + §10 ("unit tests for lazy-expiry
 * filtering and the on-conflict stale-blocker path (clock injected)").
 *
 * **No test sleeps.** Every service function takes an injectable `now`, so a
 * 7-minute TTL is exercised by moving the clock, not the wall. Where a hold has
 * to look stale *to the same clock* another call will use, `forceExpiresAt()`
 * rewrites `expiresAt` directly — that is the "dead hold still occupying the
 * unique index" state layer (3) exists for.
 *
 * The three layers of §5, one describe block each:
 *
 *   1. **Lazy** — reads treat `PENDING AND expiresAt < now` as free, and write
 *      nothing while doing so.
 *   2. **Sweeper** — `expireStaleReservations` flips `status` and `active`,
 *      batches, and is idempotent.
 *   3. **On conflict** — a second user must *succeed* on a seat whose blocker is
 *      dead (retry-once), and must *fail* when the blocker is alive.
 *
 * Plus the pure classifiers, which run without Postgres.
 */

// `./helpers/db` first: it loads `.env` (Vitest does not, and @prisma/client
// never does).
import {
  activeSeatIds,
  createTestEvent,
  doubleBookedSeatIds,
  forceExpiresAt,
  holderOfSeat,
  readReservation,
  resetTestData,
  setupTestDatabase,
  skipBanner,
  teardownTestDatabase,
  testSeatIds,
  testSessionId,
  TEST_SUBSECTOR_CODE,
  type TestEvent,
} from './helpers/db';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getSubsectorAvailability, getSubsectorSeats } from '@/lib/availability';
import {
  cancelReservation,
  classifyUniqueViolation,
  confirmReservation,
  createHold,
  expireStaleReservations,
  generateReservationCode,
  getReservation,
  HOLD_TTL_MS,
  InvalidStateError,
  isRetryableTransactionError,
  releaseStaleBlockers,
  ReservationExpiredError,
  SeatsTakenError,
} from '@/lib/reservations';
import { RESERVATION_CODE_ALPHABET, RESERVATION_CODE_LENGTH } from '@/lib/zodSchemas';

const db = await setupTestDatabase();
if (!db.ok) console.error(skipBanner(db, 'reservations.expiry'));

/** A fixed instant, so every assertion in this file is reproducible. */
const T0 = new Date('2026-08-15T12:00:00.000Z');
/** One second after the hold TTL has run out. */
const T_LATE = new Date(T0.getTime() + HOLD_TTL_MS + 1_000);
/** Inside the TTL. */
const T_MID = new Date(T0.getTime() + 60_000);

afterAll(async () => {
  if (db.ok) await resetTestData();
  await teardownTestDatabase();
});

/* ------------------------------------------------------------------ *
 * Layer 1 — lazy expiry
 * ------------------------------------------------------------------ */

describe.skipIf(!db.ok)('lazy expiry (reads)', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent({ now: T0 });
  });

  it('shows a lapsed hold as FREE without writing anything', async () => {
    const [seatId] = testSeatIds(1);
    const sessionId = testSessionId('holder');
    const hold = await createHold({ eventId: event.id, seatIds: [seatId], sessionId, now: T0 });

    // Inside the TTL: HELD, and mine for the holder.
    const live = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, sessionId, T_MID);
    const liveSeat = live?.seats.find((seat) => seat.id === seatId);
    expect(liveSeat?.status).toBe('HELD');
    expect(liveSeat?.mine).toBe(true);

    // One second past it: FREE, and `mine` goes with it — nothing is held.
    const lapsed = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, sessionId, T_LATE);
    const lapsedSeat = lapsed?.seats.find((seat) => seat.id === seatId);
    expect(lapsedSeat?.status).toBe('FREE');
    expect(lapsedSeat?.mine).toBe(false);

    // The read must not have swept anything: status and active are untouched.
    const row = await readReservation(hold.code);
    expect(row?.status).toBe('PENDING');
    expect(row?.seats.every((seat) => seat.active)).toBe(true);
  });

  it('counts a lapsed hold as free in the availability aggregate', async () => {
    const seatIds = testSeatIds(3);
    await createHold({
      eventId: event.id,
      seatIds,
      sessionId: testSessionId('holder'),
      now: T0,
    });

    const during = await availabilityFor(event.id, T_MID);
    const after = await availabilityFor(event.id, T_LATE);

    expect(during.total).toBe(after.total);
    expect(during.free).toBe(during.total - seatIds.length);
    expect(after.free).toBe(after.total);
  });

  it('reports a lapsed hold as EXPIRED through getReservation, without writing', async () => {
    const [seatId] = testSeatIds(1);
    const hold = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('holder'),
      now: T0,
    });
    expect(hold.status).toBe('PENDING');
    expect(hold.expiresAt).toBe(new Date(T0.getTime() + HOLD_TTL_MS).toISOString());

    const stillLive = await getReservation(hold.code, undefined, T_MID);
    expect(stillLive?.status).toBe('PENDING');

    const lapsed = await getReservation(hold.code, undefined, T_LATE);
    expect(lapsed?.status).toBe('EXPIRED');
    // Lazy expiry is presentation only — the row is still PENDING/active.
    const row = await readReservation(hold.code);
    expect(row?.status).toBe('PENDING');
    expect(row?.seats.every((seat) => seat.active)).toBe(true);
  });

  it('treats the TTL boundary as still held', async () => {
    const [seatId] = testSeatIds(1);
    await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('holder'),
      now: T0,
    });
    const expiresAt = new Date(T0.getTime() + HOLD_TTL_MS);

    const oneMsBefore = await getSubsectorSeats(
      event.id,
      TEST_SUBSECTOR_CODE,
      null,
      new Date(expiresAt.getTime() - 1),
    );
    expect(oneMsBefore?.seats.find((seat) => seat.id === seatId)?.status).toBe('HELD');

    const atExpiry = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, expiresAt);
    expect(atExpiry?.seats.find((seat) => seat.id === seatId)?.status).toBe('FREE');
  });
});

/* ------------------------------------------------------------------ *
 * Layer 2 — the sweeper
 * ------------------------------------------------------------------ */

describe.skipIf(!db.ok)('expireStaleReservations (the sweeper)', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent({ now: T0 });
  });

  it('flips status to EXPIRED and releases the seats', async () => {
    const seatIds = testSeatIds(2);
    const hold = await createHold({
      eventId: event.id,
      seatIds,
      sessionId: testSessionId('holder'),
      now: T0,
    });

    const swept = await expireStaleReservations(T_LATE);
    expect(swept).toBe(1);

    const row = await readReservation(hold.code);
    expect(row?.status).toBe('EXPIRED');
    expect(row?.seats.every((seat) => !seat.active)).toBe(true);
    // `expiresAt` is deliberately preserved on EXPIRED (audit trail), and is in
    // the past by construction.
    expect(row?.expiresAt).not.toBeNull();
    expect(row!.expiresAt!.getTime()).toBeLessThan(T_LATE.getTime());

    expect(await activeSeatIds(event.id)).toEqual([]);
  });

  it('leaves live holds, CONFIRMED and CANCELLED reservations alone', async () => {
    const [s1, s2, s3, s4] = testSeatIds(4);

    const stale = await createHold({
      eventId: event.id,
      seatIds: [s1],
      sessionId: testSessionId('stale'),
      now: T0,
    });
    // Created against the later clock, so it is still live when the sweep runs.
    const live = await createHold({
      eventId: event.id,
      seatIds: [s2],
      sessionId: testSessionId('live'),
      now: T_LATE,
    });
    const confirmed = await createHold({
      eventId: event.id,
      seatIds: [s3],
      sessionId: testSessionId('confirmed'),
      now: T0,
    });
    await confirmReservation({
      code: confirmed.code,
      name: 'Иван Петров',
      email: 'ivan@example.com',
      now: T_MID,
    });
    const cancelled = await createHold({
      eventId: event.id,
      seatIds: [s4],
      sessionId: testSessionId('cancelled'),
      now: T0,
    });
    await cancelReservation(cancelled.code, T_MID);

    expect(await expireStaleReservations(T_LATE)).toBe(1);

    expect((await readReservation(stale.code))?.status).toBe('EXPIRED');
    expect((await readReservation(live.code))?.status).toBe('PENDING');
    expect((await readReservation(confirmed.code))?.status).toBe('CONFIRMED');
    expect((await readReservation(cancelled.code))?.status).toBe('CANCELLED');

    // A CONFIRMED reservation keeps its seat; the live hold keeps its seat.
    expect(await activeSeatIds(event.id)).toEqual([s2, s3].sort());
  });

  it('is idempotent', async () => {
    await createHold({
      eventId: event.id,
      seatIds: testSeatIds(1),
      sessionId: testSessionId('holder'),
      now: T0,
    });

    expect(await expireStaleReservations(T_LATE)).toBe(1);
    expect(await expireStaleReservations(T_LATE)).toBe(0);
    expect(await expireStaleReservations(T_LATE)).toBe(0);
  });

  it('batches, so the cron route must loop until the count is short', async () => {
    // The contract in lib/reservations.ts: "Re-run until the result is smaller
    // than `limit`". app/api/cron/expire relies on it.
    for (let index = 0; index < 5; index += 1) {
      await createHold({
        eventId: event.id,
        seatIds: testSeatIds(1, index),
        sessionId: testSessionId(`holder-${index}`),
        now: T0,
      });
    }

    expect(await expireStaleReservations(T_LATE, 2)).toBe(2);
    expect(await expireStaleReservations(T_LATE, 2)).toBe(2);
    const last = await expireStaleReservations(T_LATE, 2);
    expect(last).toBe(1);
    expect(last).toBeLessThan(2); // the loop's exit condition
    expect(await expireStaleReservations(T_LATE, 2)).toBe(0);

    expect(await activeSeatIds(event.id)).toEqual([]);
  });

  it('makes swept seats immediately holdable again', async () => {
    const [seatId] = testSeatIds(1);
    await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('first'),
      now: T0,
    });
    await expireStaleReservations(T_LATE);

    const next = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('second'),
      now: T_LATE,
    });
    expect(next.status).toBe('PENDING');
    expect(await holderOfSeat(event.id, seatId)).toBe(next.code);
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Layer 3 — the on-conflict stale-blocker path
 * ------------------------------------------------------------------ */

describe.skipIf(!db.ok)('on-conflict stale-blocker path (retry once)', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent({ now: T0 });
  });

  it('SUCCEEDS for a second user when the blocking hold is dead', async () => {
    // This is the case §5 layer (3) exists for: the sweeper has not run, so the
    // dead hold still physically occupies (eventId, seatId) WHERE active. The
    // second user must NOT get a 409.
    const [seatId] = testSeatIds(1);
    const first = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('first'),
      now: T0,
    });
    expect(await holderOfSeat(event.id, seatId)).toBe(first.code);

    const second = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('second'),
      now: T_LATE,
    });

    expect(second.status).toBe('PENDING');
    expect(second.seats.map((seat) => seat.seatId)).toEqual([seatId]);

    // The dead hold was expired as part of the retry, not merely ignored.
    const firstRow = await readReservation(first.code);
    expect(firstRow?.status).toBe('EXPIRED');
    expect(firstRow?.seats.every((seat) => !seat.active)).toBe(true);

    expect(await activeSeatIds(event.id)).toEqual([seatId]);
    expect(await holderOfSeat(event.id, seatId)).toBe(second.code);
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
  });

  it('never steals a live hold', async () => {
    const [seatId] = testSeatIds(1);
    const first = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('first'),
      now: T0,
    });

    const rejection = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('second'),
      now: T_MID,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SeatsTakenError);
    expect((rejection as SeatsTakenError).conflictSeats).toEqual([seatId]);
    expect((await readReservation(first.code))?.status).toBe('PENDING');
    expect(await holderOfSeat(event.id, seatId)).toBe(first.code);
  });

  it('reports only the live blocker when a basket mixes dead and live holds', async () => {
    const [dead, alive] = testSeatIds(2);

    const deadHold = await createHold({
      eventId: event.id,
      seatIds: [dead],
      sessionId: testSessionId('dead'),
      now: T0,
    });
    const liveHold = await createHold({
      eventId: event.id,
      seatIds: [alive],
      sessionId: testSessionId('alive'),
      now: T_LATE,
    });

    const rejection = await createHold({
      eventId: event.id,
      seatIds: [dead, alive],
      sessionId: testSessionId('third'),
      now: T_LATE,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(SeatsTakenError);
    expect((rejection as SeatsTakenError).conflictSeats).toEqual([alive]);

    // Side effect of the cleanup: the dead hold is expired and its seat is free,
    // even though the request that triggered it failed.
    expect((await readReservation(deadHold.code))?.status).toBe('EXPIRED');
    expect(await activeSeatIds(event.id)).toEqual([alive]);
    expect(await holderOfSeat(event.id, alive)).toBe(liveHold.code);
    expect(await holderOfSeat(event.id, dead)).toBeNull();
  });

  it('lets several users race for a seat whose blocker is dead: exactly one wins', async () => {
    const [seatId] = testSeatIds(1);
    await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('dead'),
      now: T0,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        createHold({
          eventId: event.id,
          seatIds: [seatId],
          sessionId: testSessionId(`racer-${index}`),
          now: T_LATE,
        }),
      ),
    );
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');

    expect(winners.length).toBe(1);
    for (const loser of losers) {
      expect(
        (loser as PromiseRejectedResult).reason,
        'the cleanup racing with itself must still produce a clean SEATS_TAKEN',
      ).toBeInstanceOf(SeatsTakenError);
    }
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
    expect(await activeSeatIds(event.id)).toEqual([seatId]);
  });

  describe('releaseStaleBlockers', () => {
    it('expires only the stale holders of the given seats', async () => {
      const [stale, live, untouched] = testSeatIds(3);

      const staleHold = await createHold({
        eventId: event.id,
        seatIds: [stale],
        sessionId: testSessionId('stale'),
        now: T0,
      });
      const liveHold = await createHold({
        eventId: event.id,
        seatIds: [live],
        sessionId: testSessionId('live'),
        now: T_LATE,
      });
      // Also stale, but not among the seats we ask about.
      const otherStale = await createHold({
        eventId: event.id,
        seatIds: [untouched],
        sessionId: testSessionId('other'),
        now: T0,
      });

      const freed = await releaseStaleBlockers(event.id, [stale, live], T_LATE);
      expect(freed).toBe(1);

      expect((await readReservation(staleHold.code))?.status).toBe('EXPIRED');
      expect((await readReservation(liveHold.code))?.status).toBe('PENDING');
      expect((await readReservation(otherStale.code))?.status).toBe('PENDING');
      expect(await activeSeatIds(event.id)).toEqual([live, untouched].sort());
    });

    it('returns 0 when nothing is stale (so createHold must not retry)', async () => {
      const [seatId] = testSeatIds(1);
      await createHold({
        eventId: event.id,
        seatIds: [seatId],
        sessionId: testSessionId('live'),
        now: T0,
      });
      expect(await releaseStaleBlockers(event.id, [seatId], T_MID)).toBe(0);
      expect(await releaseStaleBlockers(event.id, [], T_LATE)).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Confirm / cancel around the TTL
 * ------------------------------------------------------------------ */

describe.skipIf(!db.ok)('confirm and cancel across the TTL boundary', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent({ now: T0 });
  });

  it('confirms inside the TTL, clears expiresAt and keeps the seats', async () => {
    const seatIds = testSeatIds(2);
    const hold = await createHold({
      eventId: event.id,
      seatIds,
      sessionId: testSessionId('holder'),
      now: T0,
    });

    const confirmed = await confirmReservation({
      code: hold.code,
      name: '  Иван Петров  ',
      email: '  IVAN@Example.COM ',
      phone: ' +359888123456 ',
      now: T_MID,
    });

    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.expiresAt).toBeNull();
    expect(confirmed.name).toBe('Иван Петров');
    expect(confirmed.email).toBe('ivan@example.com');
    expect(confirmed.phone).toBe('+359888123456');

    const row = await readReservation(hold.code);
    expect(row?.seats.every((seat) => seat.active)).toBe(true);
    // A CONFIRMED reservation is immune to the sweeper for ever.
    expect(await expireStaleReservations(new Date(T0.getTime() + 365 * 24 * 3_600_000))).toBe(0);
    expect(await activeSeatIds(event.id)).toEqual([...seatIds].sort());
  });

  it('is idempotent once CONFIRMED and never overwrites the stored details', async () => {
    const hold = await createHold({
      eventId: event.id,
      seatIds: testSeatIds(1),
      sessionId: testSessionId('holder'),
      now: T0,
    });
    await confirmReservation({
      code: hold.code,
      name: 'Иван Петров',
      email: 'ivan@example.com',
      now: T_MID,
    });

    const again = await confirmReservation({
      code: hold.code,
      name: 'Someone Else',
      email: 'someone@example.com',
      now: T_MID,
    });
    expect(again.status).toBe('CONFIRMED');
    expect(again.name).toBe('Иван Петров');
    expect(again.email).toBe('ivan@example.com');
  });

  it('rejects a confirm after the TTL with EXPIRED and releases the seats', async () => {
    const [seatId] = testSeatIds(1);
    const hold = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('holder'),
      now: T0,
    });

    await expect(
      confirmReservation({
        code: hold.code,
        name: 'Иван Петров',
        email: 'ivan@example.com',
        now: T_LATE,
      }),
    ).rejects.toBeInstanceOf(ReservationExpiredError);

    // The failed confirm expired the hold itself — the seat is free at once,
    // without waiting for the sweeper.
    const row = await readReservation(hold.code);
    expect(row?.status).toBe('EXPIRED');
    expect(row?.seats.every((seat) => !seat.active)).toBe(true);
    expect(await activeSeatIds(event.id)).toEqual([]);

    const next = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('next'),
      now: T_LATE,
    });
    expect(next.status).toBe('PENDING');
  });

  it('refuses to confirm an EXPIRED or CANCELLED reservation', async () => {
    const expired = await createHold({
      eventId: event.id,
      seatIds: testSeatIds(1, 0),
      sessionId: testSessionId('expired'),
      now: T0,
    });
    await expireStaleReservations(T_LATE);
    await expect(
      confirmReservation({
        code: expired.code,
        name: 'Иван',
        email: 'ivan@example.com',
        now: T_LATE,
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);

    const cancelled = await createHold({
      eventId: event.id,
      seatIds: testSeatIds(1, 1),
      sessionId: testSessionId('cancelled'),
      now: T_LATE,
    });
    await cancelReservation(cancelled.code, T_LATE);
    await expect(
      confirmReservation({
        code: cancelled.code,
        name: 'Иван',
        email: 'ivan@example.com',
        now: T_LATE,
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('cancels a live hold, is idempotent, and refuses an EXPIRED one', async () => {
    const [s1, s2] = testSeatIds(2);

    const hold = await createHold({
      eventId: event.id,
      seatIds: [s1],
      sessionId: testSessionId('holder'),
      now: T0,
    });
    const cancelled = await cancelReservation(hold.code, T_MID);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.expiresAt).toBeNull();
    expect(await activeSeatIds(event.id)).toEqual([]);
    expect((await cancelReservation(hold.code, T_MID)).status).toBe('CANCELLED');

    const lapsed = await createHold({
      eventId: event.id,
      seatIds: [s2],
      sessionId: testSessionId('lapsed'),
      now: T0,
    });
    await expireStaleReservations(T_LATE);
    await expect(cancelReservation(lapsed.code, T_LATE)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The production clock — every test above injects `now`, so these two make
 * sure the un-injected path (what actually runs in prod) behaves the same.
 * `forceExpiresAt` rewrites `expiresAt` into the past instead of sleeping.
 * ------------------------------------------------------------------ */

describe.skipIf(!db.ok)('default (un-injected) clock', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent();
  });

  it('sweeps a hold whose expiresAt is already in the past', async () => {
    const hold = await createHold({
      eventId: event.id,
      seatIds: testSeatIds(1),
      sessionId: testSessionId('holder'),
    });
    await forceExpiresAt(hold.code, new Date(Date.now() - 60_000));

    expect(await expireStaleReservations()).toBe(1);
    const row = await readReservation(hold.code);
    expect(row?.status).toBe('EXPIRED');
    expect(row?.seats.every((seat) => !seat.active)).toBe(true);
  });

  it('grants the seat to a second user over a dead blocker', async () => {
    const [seatId] = testSeatIds(1);
    const first = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('first'),
    });
    await forceExpiresAt(first.code, new Date(Date.now() - 1_000));

    const second = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('second'),
    });
    expect(second.status).toBe('PENDING');
    expect(await holderOfSeat(event.id, seatId)).toBe(second.code);
    expect((await readReservation(first.code))?.status).toBe('EXPIRED');
    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Pure unit tests — no database needed
 * ------------------------------------------------------------------ */

describe('reservation codes', () => {
  it('draws 6 characters from the Crockford-ish alphabet, never I O 0 1', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) {
      const code = generateReservationCode();
      expect(code).toHaveLength(RESERVATION_CODE_LENGTH);
      expect(code).toMatch(new RegExp(`^[${RESERVATION_CODE_ALPHABET}]{6}$`));
      expect(code).not.toMatch(/[IO01]/);
      seen.add(code);
    }
    // 32^6 ≈ 1.07e9, so 5 000 draws colliding would mean the generator is broken.
    expect(seen.size).toBe(5_000);
  });
});

describe('classifyUniqueViolation', () => {
  it('separates a seat clash from a reservation-code clash', () => {
    // Prisma names the constraint when it recognises the index …
    expect(classifyUniqueViolation({ code: 'P2002', meta: { target: ['code'] } })).toBe('code');
    expect(
      classifyUniqueViolation({ code: 'P2002', meta: { target: 'Reservation_code_key' } }),
    ).toBe('code');
    // … and reports the raw name for the hand-written partial index.
    expect(
      classifyUniqueViolation({
        code: 'P2002',
        meta: { target: 'reservation_seat_active_uq' },
      }),
    ).toBe('seat');
    expect(
      classifyUniqueViolation({
        code: 'P2002',
        meta: { target: ['reservationId', 'seatId'] },
      }),
    ).toBe('seat');
  });

  it('assumes the seat guard when the constraint cannot be named', () => {
    // createHold self-corrects: if nothing actually holds the seats it falls back
    // to a fresh reservation code.
    expect(classifyUniqueViolation({ code: 'P2002', message: 'Unique constraint failed' })).toBe(
      'seat',
    );
  });

  it('returns null for anything that is not a unique violation', () => {
    expect(classifyUniqueViolation({ code: 'P2003', meta: {} })).toBeNull();
    expect(classifyUniqueViolation(new Error('boom'))).toBeNull();
    expect(classifyUniqueViolation(null)).toBeNull();
    expect(classifyUniqueViolation('P2002')).toBeNull();
  });
});

describe('isRetryableTransactionError', () => {
  it('recognises the labelled deadlock / serialisation failures', () => {
    expect(isRetryableTransactionError({ code: 'P2034', message: 'write conflict' })).toBe(true);
    expect(isRetryableTransactionError({ code: 'P2010', meta: { code: '40P01' } })).toBe(true);
    expect(isRetryableTransactionError({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
    expect(isRetryableTransactionError(new Error('deadlock detected'))).toBe(true);
    expect(isRetryableTransactionError(new Error('could not serialize access'))).toBe(true);
  });

  it('does not treat a seat conflict as retryable', () => {
    expect(
      isRetryableTransactionError({
        code: 'P2002',
        meta: { target: 'reservation_seat_active_uq' },
        message: 'Unique constraint failed',
      }),
    ).toBe(false);
    expect(isRetryableTransactionError(new Error('nope'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

async function availabilityFor(
  eventId: string,
  now: Date,
): Promise<{ free: number; total: number }> {
  const rows = await getSubsectorAvailability(eventId, now);
  const row = rows.find((entry) => entry.code === TEST_SUBSECTOR_CODE);
  if (row === undefined) {
    throw new Error(`availability did not include ${TEST_SUBSECTOR_CODE}`);
  }
  return { free: row.free, total: row.total };
}
