/**
 * Availability tests — `lib/availability.ts` against a real Postgres.
 *
 * The predicate both functions implement (and must implement *identically*, or
 * the overview map and the seat map disagree):
 *
 *   blocked ⇔ CONFIRMED ∨ (PENDING ∧ (expiresAt IS NULL ∨ expiresAt > now))
 *
 * So the interesting cases are the ones that are *not* blocked despite carrying
 * an `active` ReservationSeat row: a lapsed PENDING hold, and a CANCELLED or
 * EXPIRED reservation the sweeper has not cleaned yet. The service functions
 * never leave those last two states behind, so the harness forges them with a
 * raw status update (`setStatusWithoutReleasingSeats`).
 *
 * BLOCKED seats (`Seat.active = false`) are the other axis: they are *not*
 * capacity, so they must drop out of `total` in the aggregate while still
 * appearing in the seat list with status `BLOCKED`.
 *
 * These tests double as the regression test for the timezone bug the aggregate
 * SQL was written to avoid: `Reservation.expiresAt` is `timestamp WITHOUT time
 * zone` holding UTC, so comparing it against a `timestamptz` shifts the cutoff
 * by the *session's* UTC offset and every live hold reads as free. A machine on
 * anything but UTC (this one runs Europe/Sofia) fails the mixed-state test
 * immediately if that regresses.
 */

// `./helpers/db` first: it loads `.env` (Vitest does not, and @prisma/client
// never does).
import {
  createTestEvent,
  forceExpiresAt,
  holderOfSeat,
  prisma,
  resetTestData,
  setSeatActive,
  setStatusWithoutReleasingSeats,
  setupTestDatabase,
  skipBanner,
  teardownTestDatabase,
  testSeatId,
  testSeatIds,
  testSessionId,
  TEST_ROWS,
  TEST_SEATS_PER_ROW,
  TEST_SEAT_TOTAL,
  TEST_SUBSECTOR_CODE,
  TEST_SUBSECTOR_CODE_LATIN_LOOKALIKE,
  TEST_SUBSECTOR_HEIGHT,
  TEST_SUBSECTOR_LATIN,
  TEST_SUBSECTOR_VIEWBOX,
  TEST_SUBSECTOR_WIDTH,
  type TestEvent,
} from './helpers/db';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  eventExists,
  getSubsectorAvailability,
  getSubsectorSeats,
  listEvents,
} from '@/lib/availability';
import { bookSeat } from '@/lib/booking';
import {
  cancelReservation,
  confirmReservation,
  createHold,
  HOLD_TTL_MS,
} from '@/lib/reservations';
import type { SeatDTO, SubsectorAvailabilityDTO } from '@/lib/types';

const db = await setupTestDatabase();
if (!db.ok) console.error(skipBanner(db, 'availability'));

const T0 = new Date('2026-08-15T12:00:00.000Z');
const T_MID = new Date(T0.getTime() + 60_000);
const T_LATE = new Date(T0.getTime() + HOLD_TTL_MS + 1_000);

afterAll(async () => {
  if (db.ok) await resetTestData();
  await teardownTestDatabase();
});

function testSubsector(rows: SubsectorAvailabilityDTO[]): SubsectorAvailabilityDTO {
  const row = rows.find((entry) => entry.code === TEST_SUBSECTOR_CODE);
  if (row === undefined) {
    throw new Error(
      `availability did not include ${TEST_SUBSECTOR_CODE}; got [${rows
        .map((entry) => entry.code)
        .join(', ')}]`,
    );
  }
  return row;
}

function seatById(seats: SeatDTO[], id: string): SeatDTO {
  const seat = seats.find((entry) => entry.id === id);
  if (seat === undefined) throw new Error(`seat ${id} missing from the payload`);
  return seat;
}

describe.skipIf(!db.ok)('getSubsectorAvailability', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent({ now: T0 });
  });

  it('counts every active seat as free when nothing is reserved', async () => {
    const row = testSubsector(await getSubsectorAvailability(event.id, T0));
    expect(row.total).toBe(TEST_SEAT_TOTAL);
    expect(row.free).toBe(TEST_SEAT_TOTAL);
    expect(row.latin).toBe(TEST_SUBSECTOR_LATIN);
  });

  it('counts a mix of PENDING / CONFIRMED / CANCELLED / EXPIRED / stale / BLOCKED correctly', async () => {
    const seats = testSeatIds(11);
    const [
      confirmed1,
      confirmed2,
      live1,
      live2,
      stale1,
      stale2,
      cancelledUnswept,
      expiredUnswept,
      cancelledSwept,
      blocked1,
      blocked2,
    ] = seats;

    // CONFIRMED — blocks for ever.
    const confirmedHold = await createHold({
      eventId: event.id,
      seatIds: [confirmed1, confirmed2],
      sessionId: testSessionId('confirmed'),
      now: T0,
    });
    await confirmReservation({
      code: confirmedHold.code,
      name: 'Иван Петров',
      email: 'ivan@example.com',
      now: T_MID,
    });

    // PENDING, still live at the clock we will read with.
    await createHold({
      eventId: event.id,
      seatIds: [live1, live2],
      sessionId: testSessionId('live'),
      now: T_LATE,
    });

    // PENDING but lapsed — active rows still present, must read as FREE.
    await createHold({
      eventId: event.id,
      seatIds: [stale1, stale2],
      sessionId: testSessionId('stale'),
      now: T0,
    });

    // CANCELLED / EXPIRED whose seat rows the sweeper has not released yet.
    const cancelledHold = await createHold({
      eventId: event.id,
      seatIds: [cancelledUnswept],
      sessionId: testSessionId('cancelled-unswept'),
      now: T_LATE,
    });
    await setStatusWithoutReleasingSeats(cancelledHold.code, 'CANCELLED');
    const expiredHold = await createHold({
      eventId: event.id,
      seatIds: [expiredUnswept],
      sessionId: testSessionId('expired-unswept'),
      now: T_LATE,
    });
    await setStatusWithoutReleasingSeats(expiredHold.code, 'EXPIRED');

    // CANCELLED the normal way — seats already released.
    const sweptHold = await createHold({
      eventId: event.id,
      seatIds: [cancelledSwept],
      sessionId: testSessionId('cancelled'),
      now: T_LATE,
    });
    await cancelReservation(sweptHold.code, T_LATE);

    // BLOCKED — not capacity at all.
    await setSeatActive(blocked1, false);
    await setSeatActive(blocked2, false);

    const row = testSubsector(await getSubsectorAvailability(event.id, T_LATE));

    // Blocked seats leave `total`; only CONFIRMED (2) and live PENDING (2) are
    // subtracted from `free`. Everything else is free again.
    expect(row.total).toBe(TEST_SEAT_TOTAL - 2);
    expect(row.free).toBe(TEST_SEAT_TOTAL - 2 - 4);

    // Cross-check against the seat list — the two functions must never disagree.
    const detail = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_LATE);
    expect(detail).not.toBeNull();
    const list = detail!.seats;
    expect(list.filter((seat) => seat.status === 'BLOCKED')).toHaveLength(2);
    expect(list.filter((seat) => seat.status === 'RESERVED')).toHaveLength(2);
    expect(list.filter((seat) => seat.status === 'HELD')).toHaveLength(2);
    expect(list.filter((seat) => seat.status === 'FREE')).toHaveLength(row.free);
    expect(
      list.filter((seat) => seat.status !== 'BLOCKED' && seat.status !== 'FREE'),
    ).toHaveLength(row.total - row.free);

    // And the specific seats, so a compensating error cannot hide.
    expect(seatById(list, confirmed1).status).toBe('RESERVED');
    expect(seatById(list, live1).status).toBe('HELD');
    expect(seatById(list, stale1).status).toBe('FREE');
    expect(seatById(list, cancelledUnswept).status).toBe('FREE');
    expect(seatById(list, expiredUnswept).status).toBe('FREE');
    expect(seatById(list, cancelledSwept).status).toBe('FREE');
    expect(seatById(list, blocked1).status).toBe('BLOCKED');
  });

  it('never lets free go negative or exceed total', async () => {
    await createHold({
      eventId: event.id,
      seatIds: testSeatIds(10),
      sessionId: testSessionId('holder'),
      now: T0,
    });
    for (const now of [T0, T_MID, T_LATE]) {
      const row = testSubsector(await getSubsectorAvailability(event.id, now));
      expect(row.free).toBeGreaterThanOrEqual(0);
      expect(row.free).toBeLessThanOrEqual(row.total);
    }
  });

  it('returns rows ordered by subsector order, one per subsector', async () => {
    const rows = await getSubsectorAvailability(event.id, T0);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
    const subsectors = await prisma.subsector.findMany({
      select: { code: true },
      orderBy: { order: 'asc' },
    });
    expect(rows.map((row) => row.code)).toEqual(subsectors.map((row) => row.code));
  });

  it('does not attribute another event\'s holds to this one', async () => {
    const other = await createTestEvent({ now: T0 });
    await createHold({
      eventId: other.id,
      seatIds: testSeatIds(3),
      sessionId: testSessionId('other-event'),
      now: T0,
    });

    expect(testSubsector(await getSubsectorAvailability(event.id, T0)).free).toBe(
      TEST_SEAT_TOTAL,
    );
    expect(testSubsector(await getSubsectorAvailability(other.id, T0)).free).toBe(
      TEST_SEAT_TOTAL - 3,
    );
  });

  it('reports every seat free for an unknown event id', async () => {
    // NOTE: the doc comment on getSubsectorAvailability says "[] for an unknown
    // event", but the query is driven by `Subsector` with LEFT JOINs on eventId,
    // so it returns every subsector fully free instead. That is the safer of the
    // two behaviours (an unknown event cannot look sold out) and the route layer
    // answers 404 via `eventExists()` before ever calling this — pinned here so
    // the difference is deliberate rather than forgotten.
    const rows = await getSubsectorAvailability('itest-does-not-exist', T0);
    expect(rows.length).toBeGreaterThan(0);
    const row = testSubsector(rows);
    expect(row.free).toBe(row.total);
    expect(await eventExists('itest-does-not-exist')).toBe(false);
    expect(await eventExists(event.id)).toBe(true);
  });
});

describe.skipIf(!db.ok)('getSubsectorSeats', () => {
  let event: TestEvent;

  beforeEach(async () => {
    await resetTestData();
    event = await createTestEvent({ now: T0 });
  });

  it('returns the whole subsector with geometry, price and a truthful header', async () => {
    const result = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T0);
    expect(result).not.toBeNull();
    const { subsector, seats } = result!;

    expect(subsector.code).toBe(TEST_SUBSECTOR_CODE);
    expect(subsector.latin).toBe(TEST_SUBSECTOR_LATIN);
    expect(subsector.viewBox).toBe(TEST_SUBSECTOR_VIEWBOX);
    expect(subsector.width).toBe(TEST_SUBSECTOR_WIDTH);
    expect(subsector.height).toBe(TEST_SUBSECTOR_HEIGHT);
    // The header describes the payload attached to it, not a stale column.
    expect(subsector.seatCount).toBe(seats.length);
    expect(subsector.rowCount).toBe(new Set(seats.map((seat) => seat.row)).size);
    expect(subsector.seatCount).toBe(TEST_SEAT_TOTAL);
    expect(subsector.rowCount).toBe(TEST_ROWS);

    // Ordered by (row, number), which is what the SVG renderer relies on.
    expect(seats[0].row).toBe(1);
    expect(seats[0].number).toBe(1);
    expect(seats[TEST_SEATS_PER_ROW].row).toBe(2);
    expect(seats.every((seat) => seat.status === 'FREE' && !seat.mine)).toBe(true);

    // Geometry survives the round trip through the database.
    const first = seatById(seats, testSeatId(1, 1));
    expect(first.x).toBe(30);
    expect(first.y).toBe(TEST_SUBSECTOR_HEIGHT - 40);
    expect(first.angle).toBe(0);
    expect(first.type).toBe('STANDARD');
    expect(first.white).toBe(false);
  });

  it('flags `mine` only for the session that holds the seat', async () => {
    const [seatId] = testSeatIds(1);
    const mySession = testSessionId('mine');
    await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: mySession,
      now: T0,
    });

    const asHolder = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, mySession, T_MID);
    expect(seatById(asHolder!.seats, seatId).mine).toBe(true);

    const asStranger = await getSubsectorSeats(
      event.id,
      TEST_SUBSECTOR_CODE,
      testSessionId('stranger'),
      T_MID,
    );
    expect(seatById(asStranger!.seats, seatId).status).toBe('HELD');
    expect(seatById(asStranger!.seats, seatId).mine).toBe(false);

    // A Server Component with no cookie yet passes null — nothing is "mine".
    const anonymous = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID);
    expect(seatById(anonymous!.seats, seatId).mine).toBe(false);
  });

  it('keeps `mine` true for a CONFIRMED reservation of the same session', async () => {
    const [seatId] = testSeatIds(1);
    const mySession = testSessionId('mine');
    const hold = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: mySession,
      now: T0,
    });
    await confirmReservation({
      code: hold.code,
      name: 'Иван Петров',
      email: 'ivan@example.com',
      now: T_MID,
    });

    const result = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, mySession, T_LATE);
    const seat = seatById(result!.seats, seatId);
    expect(seat.status).toBe('RESERVED');
    expect(seat.mine).toBe(true);
  });

  it('exposes the holder name to every session, not just the holder', async () => {
    // Deliberate, and pinned here so nobody "fixes" it later: the point of
    // naming a seat is that whoever is looking at the map can read it. There is
    // no auth on this tool — see the header of lib/booking.ts.
    const [seatId] = testSeatIds(1);
    const mySession = testSessionId('mine');
    await bookSeat({ seatId, sessionId: mySession, name: 'Иван Петров', eventId: event.id });

    const asHolder = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, mySession, T_MID);
    expect(seatById(asHolder!.seats, seatId).holder).toBe('Иван Петров');
    expect(seatById(asHolder!.seats, seatId).mine).toBe(true);

    const asStranger = await getSubsectorSeats(
      event.id,
      TEST_SUBSECTOR_CODE,
      testSessionId('stranger'),
      T_MID,
    );
    expect(seatById(asStranger!.seats, seatId).holder).toBe('Иван Петров');
    expect(seatById(asStranger!.seats, seatId).mine).toBe(false);

    const anonymous = await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID);
    expect(seatById(anonymous!.seats, seatId).holder).toBe('Иван Петров');
  });

  it('reports holder null for free, blocked, held and nameless seats', async () => {
    const [free, blocked, held, nameless] = testSeatIds(4);

    // A booked, *named* seat that an administrator then kills: BLOCKED wins, and
    // it must take the name with it — exactly as it already forces `mine` false.
    await bookSeat({
      seatId: blocked,
      sessionId: testSessionId('blocked'),
      name: 'Георги Аспарухов',
      eventId: event.id,
    });
    await setSeatActive(blocked, false);

    // The hold path writes no name at all; it must read as absent, not empty.
    await createHold({
      eventId: event.id,
      seatIds: [held],
      sessionId: testSessionId('held'),
      now: T_MID,
    });
    await bookSeat({ seatId: nameless, sessionId: testSessionId('anon'), eventId: event.id });

    const seats = (await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID))!.seats;
    expect(seatById(seats, free).status).toBe('FREE');
    expect(seatById(seats, free).holder).toBeNull();
    expect(seatById(seats, blocked).status).toBe('BLOCKED');
    expect(seatById(seats, blocked).holder).toBeNull();
    expect(seatById(seats, held).status).toBe('HELD');
    expect(seatById(seats, held).holder).toBeNull();
    expect(seatById(seats, nameless).status).toBe('RESERVED');
    expect(seatById(seats, nameless).holder).toBeNull();
  });

  it('reports holder null for a cancelled reservation whose active row was not swept', async () => {
    // Lazy expiry says this seat is FREE. If the name outlived the status, a
    // seat anyone can book would still be labelled with the previous holder.
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('gone'),
      name: 'Иван Петров',
      eventId: event.id,
    });
    const code = await holderOfSeat(event.id, seatId);
    await setStatusWithoutReleasingSeats(code!, 'CANCELLED');

    const seat = seatById(
      (await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID))!.seats,
      seatId,
    );
    expect(seat.status).toBe('FREE');
    expect(seat.holder).toBeNull();
  });

  it('exposes the seat note beside the holder, to every session', async () => {
    // The note is public for exactly the reason the name is: it annotates a seat
    // on a map that everyone in the room is reading. Pinned so the decision has
    // to be *un*made deliberately.
    const [seatId] = testSeatIds(1);
    const mySession = testSessionId('mine');
    await bookSeat({
      seatId,
      sessionId: mySession,
      name: 'Иван Петров',
      note: 'плаща в брой, 2 деца',
      eventId: event.id,
    });

    for (const session of [mySession, testSessionId('stranger'), null]) {
      const seats = (await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, session, T_MID))!.seats;
      const seat = seatById(seats, seatId);
      expect(seat.holder, String(session)).toBe('Иван Петров');
      expect(seat.note, String(session)).toBe('плаща в брой, 2 деца');
    }
  });

  it('reports note null for free, blocked, held and note-less seats', async () => {
    const [free, blocked, held, noteless] = testSeatIds(4);

    // A booked seat carrying a note that an administrator then kills: BLOCKED
    // wins and must take the note with it. "A note on a switched-off seat" is
    // the same fallacy as "booked by someone anonymous".
    await bookSeat({
      seatId: blocked,
      sessionId: testSessionId('blocked'),
      name: 'Георги Аспарухов',
      note: 'вход от сектор Б',
      eventId: event.id,
    });
    await setSeatActive(blocked, false);

    // The hold path writes no note at all; it must read as absent, not empty.
    await createHold({
      eventId: event.id,
      seatIds: [held],
      sessionId: testSessionId('held'),
      now: T_MID,
    });
    await bookSeat({
      seatId: noteless,
      sessionId: testSessionId('anon'),
      name: 'Иван Петров',
      eventId: event.id,
    });

    const seats = (await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID))!.seats;
    expect(seatById(seats, free).note).toBeNull();
    expect(seatById(seats, blocked).status).toBe('BLOCKED');
    expect(seatById(seats, blocked).note).toBeNull();
    expect(seatById(seats, held).status).toBe('HELD');
    expect(seatById(seats, held).note).toBeNull();
    expect(seatById(seats, noteless).status).toBe('RESERVED');
    expect(seatById(seats, noteless).holder).toBe('Иван Петров');
    expect(seatById(seats, noteless).note).toBeNull();
  });

  it('reports note null for a cancelled reservation whose active row was not swept', async () => {
    // Same gate as the holder, on the same computed status. A note that outlived
    // its booking would annotate a seat anyone can now take with the previous
    // occupant's private arrangements.
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('a'),
      name: 'Иван Петров',
      note: 'плаща в брой',
      eventId: event.id,
    });
    const code = await holderOfSeat(event.id, seatId);
    await setStatusWithoutReleasingSeats(code!, 'CANCELLED');

    const seat = seatById(
      (await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID))!.seats,
      seatId,
    );
    expect(seat.status).toBe('FREE');
    expect(seat.holder).toBeNull();
    expect(seat.note).toBeNull();
  });

  it('reports note null for a hold that has lapsed but not been swept', async () => {
    // The third way a row can still be `active` while the seat reads FREE. The
    // note has to lapse with it, on the same line of code that drops the name.
    const [seatId] = testSeatIds(1);
    const hold = await createHold({
      eventId: event.id,
      seatIds: [seatId],
      sessionId: testSessionId('lapsing'),
      now: T0,
    });
    await prisma.reservation.update({
      where: { code: hold.code },
      data: { name: 'Иван Петров', note: 'плаща в брой' },
    });
    await forceExpiresAt(hold.code, new Date(T_MID.getTime() - 1));

    const seat = seatById(
      (await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE, null, T_MID))!.seats,
      seatId,
    );
    expect(seat.status).toBe('FREE');
    expect(seat.holder).toBeNull();
    expect(seat.note).toBeNull();
  });

  it('keeps names and notes out of the subsector availability aggregate', async () => {
    // `GET /api/events/:id/availability` is the only response in the app served
    // `Cache-Control: public, max-age=10` — the only one a shared cache may hand
    // to a different visitor. It must stay counts-only.
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('named'),
      name: 'Иван Петров',
      note: 'плаща в брой',
      eventId: event.id,
    });

    const row = testSubsector(await getSubsectorAvailability(event.id, T_MID));
    expect(Object.keys(row).sort()).toEqual(['code', 'free', 'latin', 'total']);
    expect(JSON.stringify(row)).not.toContain('Иван');
    expect(JSON.stringify(row)).not.toContain('брой');
  });

  it('returns null for an unknown event, unknown code, or a Latin look-alike', async () => {
    expect(await getSubsectorSeats('itest-nope', TEST_SUBSECTOR_CODE, null, T0)).toBeNull();
    expect(await getSubsectorSeats(event.id, 'Ъ99', null, T0)).toBeNull();
    // Cyrillic ТСТ1 (U+0422 U+0421 U+0422) is not Latin TCT1 — codes are never
    // matched loosely, and routes must never be built on `latin`.
    expect(TEST_SUBSECTOR_CODE).not.toBe(TEST_SUBSECTOR_CODE_LATIN_LOOKALIKE);
    expect(
      await getSubsectorSeats(event.id, TEST_SUBSECTOR_CODE_LATIN_LOOKALIKE, null, T0),
    ).toBeNull();
    expect(await getSubsectorSeats(event.id, TEST_SUBSECTOR_LATIN, null, T0)).toBeNull();
  });
});

describe.skipIf(!db.ok)('listEvents', () => {
  beforeEach(async () => {
    await resetTestData();
  });

  it('lists ON_SALE events only by default', async () => {
    const onSale = await createTestEvent({ now: T0 });
    const draft = await createTestEvent({ now: T0, status: 'DRAFT' });
    const closed = await createTestEvent({ now: T0, status: 'CLOSED' });

    const listed = await listEvents();
    const ids = listed.map((event) => event.id);
    expect(ids).toContain(onSale.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(closed.id);

    const row = listed.find((event) => event.id === onSale.id)!;
    expect(row.status).toBe('ON_SALE');
    expect(row.kickoffAt).toBe(onSale.kickoffAt.toISOString());
    expect(row.salesOpen).toBe(onSale.salesOpen.toISOString());
    expect(row.salesClose).toBe(onSale.salesClose.toISOString());
  });

  it('includes DRAFT and CLOSED events when asked', async () => {
    const draft = await createTestEvent({ now: T0, status: 'DRAFT' });
    const listed = await listEvents({ onSaleOnly: false });
    const row = listed.find((event) => event.id === draft.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('DRAFT');
  });

  it('orders by kickoff, soonest first', async () => {
    const later = await createTestEvent({ now: T0, kickoffOffsetMs: 20 * 24 * 3_600_000 });
    const sooner = await createTestEvent({ now: T0, kickoffOffsetMs: 2 * 24 * 3_600_000 });

    const listed = (await listEvents()).filter((event) => event.id.startsWith('itest-'));
    expect(listed.map((event) => event.id)).toEqual([sooner.id, later.id]);
  });
});
