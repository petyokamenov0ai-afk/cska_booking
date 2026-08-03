/**
 * Click-to-book concurrency — `lib/booking.ts`.
 *
 * The hold state machine is gone from this flow, so the partial unique index
 * `reservation_seat_active_uq` is now the *only* thing standing between two
 * simultaneous clicks and a double-booked seat. These tests exercise exactly
 * that, against a real Postgres.
 *
 * Needs a database; skips loudly without one, like the other integration suites.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { SeatUnavailableError, bookSeat, releaseSeat } from '@/lib/booking';
import { prisma } from '@/lib/db';
import { NotFoundError, SeatsTakenError } from '@/lib/reservations';
import {
  type DatabaseStatus,
  type TestEvent,
  activeSeatIds,
  createTestEvent,
  doubleBookedSeatIds,
  holderOfSeat,
  readReservation,
  resetTestData,
  setupTestDatabase,
  skipBanner,
  teardownTestDatabase,
  testSeatIds,
  testSessionId,
} from './helpers/db';

// Top-level await, like the other integration suites: the skip decision has to
// be made at collection time, before `it.runIf` is evaluated.
const db: DatabaseStatus = await setupTestDatabase();
if (!db.ok) console.error(skipBanner(db, 'booking'));

afterAll(async () => {
  await teardownTestDatabase();
});

const ready = (): boolean => db.ok;

describe('bookSeat / releaseSeat', () => {
  let event: TestEvent;

  beforeEach(async () => {
    if (!ready()) return;
    await resetTestData();
    event = await createTestEvent();
  });

  it.runIf(ready())('books a free seat straight into CONFIRMED, with no expiry', async () => {
    const [seatId] = testSeatIds(1);
    const booked = await bookSeat({ seatId, sessionId: testSessionId('a'), eventId: event.id });
    expect(booked.seatId).toBe(seatId);

    const rows = await prisma.reservationSeat.findMany({
      where: { eventId: event.id, seatId },
      select: { active: true, reservation: { select: { status: true, expiresAt: true } } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    expect(rows[0].reservation.status).toBe('CONFIRMED');
    // No TTL on this path — a booking must never expire on its own.
    expect(rows[0].reservation.expiresAt).toBeNull();
  });

  it.runIf(ready())(
    'lets exactly one of 20 simultaneous clicks win the same seat',
    async () => {
      const [seatId] = testSeatIds(1);
      const attempts = Array.from({ length: 20 }, (_, i) =>
        bookSeat({ seatId, sessionId: testSessionId(`racer-${i}`), eventId: event.id }),
      );
      const settled = await Promise.allSettled(attempts);

      const won = settled.filter((r) => r.status === 'fulfilled');
      const lost = settled.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(19);
      // Every loser must be told it lost the seat, not handed a 500.
      for (const rejection of lost) {
        expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(SeatsTakenError);
      }

      // And the storage layer agrees: one active row, nothing double-booked.
      expect(await activeSeatIds(event.id)).toEqual([seatId]);
      expect(await doubleBookedSeatIds(event.id)).toEqual([]);
    },
  );

  it.runIf(ready())('reports a seat already booked by someone else as taken', async () => {
    const [seatId] = testSeatIds(1);
    await bookSeat({ seatId, sessionId: testSessionId('first'), eventId: event.id });
    await expect(
      bookSeat({ seatId, sessionId: testSessionId('second'), eventId: event.id }),
    ).rejects.toBeInstanceOf(SeatsTakenError);
  });

  it.runIf(ready())('frees a seat and lets anyone book it again', async () => {
    const [seatId] = testSeatIds(1);
    await bookSeat({ seatId, sessionId: testSessionId('owner'), eventId: event.id });

    expect(await releaseSeat({ seatId, eventId: event.id })).toBe(true);
    expect(await activeSeatIds(event.id)).toEqual([]);

    // Deliberately a *different* session: release is unauthenticated by design.
    const rebooked = await bookSeat({
      seatId,
      sessionId: testSessionId('someone-else'),
      eventId: event.id,
    });
    expect(rebooked.seatId).toBe(seatId);
    expect(await activeSeatIds(event.id)).toEqual([seatId]);
  });

  it.runIf(ready())('is idempotent when releasing a seat nobody holds', async () => {
    const [seatId] = testSeatIds(1);
    expect(await releaseSeat({ seatId, eventId: event.id })).toBe(false);
    expect(await releaseSeat({ seatId, eventId: event.id })).toBe(false);
  });

  it.runIf(ready())('survives 20 simultaneous releases of one booking', async () => {
    const [seatId] = testSeatIds(1);
    await bookSeat({ seatId, sessionId: testSessionId('owner'), eventId: event.id });

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => releaseSeat({ seatId, eventId: event.id })),
    );
    // None may throw, and the seat ends up free exactly once.
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      settled.filter((r) => r.status === 'fulfilled' && r.value === true).length,
    ).toBe(1);
    expect(await activeSeatIds(event.id)).toEqual([]);
  });

  it.runIf(ready())('refuses a deactivated seat', async () => {
    const [seatId] = testSeatIds(1);
    await prisma.seat.update({ where: { id: seatId }, data: { active: false } });
    await expect(
      bookSeat({ seatId, sessionId: testSessionId('a'), eventId: event.id }),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
  });

  it.runIf(ready())('rejects an unknown seat id', async () => {
    await expect(
      bookSeat({ seatId: 'itest-seat-does-not-exist', sessionId: testSessionId('a'), eventId: event.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * `bookSeat` does not return the reservation, so the route to the stored row
   * is: which reservation holds the seat → read it raw.
   */
  async function nameOnSeat(eventId: string, seatId: string): Promise<string | null> {
    const code = await holderOfSeat(eventId, seatId);
    if (code === null) throw new Error(`no active reservation holds ${seatId}`);
    const reservation = await readReservation(code);
    if (reservation === null) throw new Error(`reservation ${code} vanished`);
    return reservation.name;
  }

  it.runIf(ready())('stores the normalised holder name on the reservation', async () => {
    const [seatId] = testSeatIds(1);
    // Padded and with an interior newline: the storage layer normalises too, so
    // a caller that never went through the route still cannot write a name that
    // breaks the one-line tooltip.
    await bookSeat({
      seatId,
      sessionId: testSessionId('a'),
      name: '  Иван\nПетров  ',
      eventId: event.id,
    });
    expect(await nameOnSeat(event.id, seatId)).toBe('Иван Петров');
  });

  it.runIf(ready())('stores null rather than an empty string for a blank name', async () => {
    // "" and null would render identically today, but only one of them is a
    // state the rest of the code has to know about.
    const [seatId] = testSeatIds(1);
    await bookSeat({ seatId, sessionId: testSessionId('a'), name: '   ', eventId: event.id });
    expect(await nameOnSeat(event.id, seatId)).toBeNull();
  });

  it.runIf(ready())('leaves the name null when a booking is made without one', async () => {
    // Every booking made before the name existed looks exactly like this, so
    // "reservation with no name" has to stay a supported state, not a bug.
    const [seatId] = testSeatIds(1);
    await bookSeat({ seatId, sessionId: testSessionId('a'), eventId: event.id });
    expect(await nameOnSeat(event.id, seatId)).toBeNull();
  });

  it.runIf(ready())(
    'keeps exactly the winner\'s name when 20 clicks race for one seat',
    async () => {
      const [seatId] = testSeatIds(1);
      const names = Array.from({ length: 20 }, (_, i) => `Състезател ${i}`);
      const settled = await Promise.allSettled(
        names.map((name, i) =>
          bookSeat({ seatId, sessionId: testSessionId(`racer-${i}`), name, eventId: event.id }),
        ),
      );
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      // The name is written in the same transaction as the seat claim, so the
      // survivor must carry one racer's name whole — never null, never a blend
      // of two attempts.
      expect(await activeSeatIds(event.id)).toEqual([seatId]);
      expect(await doubleBookedSeatIds(event.id)).toEqual([]);
      expect(names).toContain(await nameOnSeat(event.id, seatId));
    },
  );

  it.runIf(ready())('does not carry a name across release and re-book', async () => {
    const [seatId] = testSeatIds(1);
    await bookSeat({ seatId, sessionId: testSessionId('owner'), name: 'Иван', eventId: event.id });
    const firstCode = await holderOfSeat(event.id, seatId);

    expect(await releaseSeat({ seatId, eventId: event.id })).toBe(true);
    await bookSeat({ seatId, sessionId: testSessionId('next'), name: 'Мария', eventId: event.id });

    expect(await nameOnSeat(event.id, seatId)).toBe('Мария');
    // The cancelled row keeps its own name: `releaseSeat` flips
    // ReservationSeat.active in the same transaction, so no read can ever reach
    // it again, and the audit trail stays honest about who had the seat.
    const cancelled = await readReservation(firstCode!);
    expect(cancelled!.status).toBe('CANCELLED');
    expect(cancelled!.name).toBe('Иван');
  });

  /** Same route to the raw row as `nameOnSeat`, one column over. */
  async function noteOnSeat(eventId: string, seatId: string): Promise<string | null> {
    const code = await holderOfSeat(eventId, seatId);
    if (code === null) throw new Error(`no active reservation holds ${seatId}`);
    const reservation = await readReservation(code);
    if (reservation === null) throw new Error(`reservation ${code} vanished`);
    return reservation.note;
  }

  it.runIf(ready())('stores the normalised note beside the name', async () => {
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('a'),
      name: 'Иван Петров',
      note: '  плаща в брой,\nвход Б  ',
      eventId: event.id,
    });
    expect(await nameOnSeat(event.id, seatId)).toBe('Иван Петров');
    // Newline to space, never a deletion: "вход Б\nдо" must not become "вход Бдо".
    expect(await noteOnSeat(event.id, seatId)).toBe('плаща в брой, вход Б');
  });

  it.runIf(ready())('leaves the note null when a booking is made without one', async () => {
    // The common case, and the state of every row written before the column
    // existed — so it has to be supported, not merely tolerated.
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('a'),
      name: 'Иван Петров',
      eventId: event.id,
    });
    expect(await noteOnSeat(event.id, seatId)).toBeNull();
  });

  it.runIf(ready())('stores null for a note that would render nothing', async () => {
    // Two zero-width spaces are two characters that survive `trim()`, so without
    // the ink check this reaches the column and the bubble grows a blank line.
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('a'),
      name: 'Иван Петров',
      note: String.fromCodePoint(0x200b, 0x200b),
      eventId: event.id,
    });
    expect(await noteOnSeat(event.id, seatId)).toBeNull();
  });

  it.runIf(ready())('stores null for a name that would render nothing', async () => {
    // The same hole on the required field. The route rejects it outright; this
    // is the second half of the guarantee, for a caller that never went through
    // the route — the column must not be able to hold an invisible label.
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('a'),
      name: String.fromCodePoint(0x200b, 0x200b),
      eventId: event.id,
    });
    expect(await nameOnSeat(event.id, seatId)).toBeNull();
  });

  it.runIf(ready())('accepts a note with no name, and a name with no note', async () => {
    // The two columns are independent. Nothing in this flow writes a note today
    // without a name, but nothing in the storage layer should require one either.
    const [withNoteOnly, withNameOnly] = testSeatIds(2);
    await bookSeat({
      seatId: withNoteOnly,
      sessionId: testSessionId('a'),
      note: 'до пътеката',
      eventId: event.id,
    });
    await bookSeat({
      seatId: withNameOnly,
      sessionId: testSessionId('a'),
      name: 'Иван Петров',
      eventId: event.id,
    });

    expect(await nameOnSeat(event.id, withNoteOnly)).toBeNull();
    expect(await noteOnSeat(event.id, withNoteOnly)).toBe('до пътеката');
    expect(await nameOnSeat(event.id, withNameOnly)).toBe('Иван Петров');
    expect(await noteOnSeat(event.id, withNameOnly)).toBeNull();
  });

  it.runIf(ready())('does not carry a note across release and re-book', async () => {
    const [seatId] = testSeatIds(1);
    await bookSeat({
      seatId,
      sessionId: testSessionId('owner'),
      name: 'Иван',
      note: 'плаща в брой',
      eventId: event.id,
    });
    expect(await releaseSeat({ seatId, eventId: event.id })).toBe(true);
    await bookSeat({
      seatId,
      sessionId: testSessionId('next'),
      name: 'Мария',
      eventId: event.id,
    });

    // A caption belongs to a booking, not to a seat. If it survived the release
    // the map would annotate the new occupant with the old one's business.
    expect(await nameOnSeat(event.id, seatId)).toBe('Мария');
    expect(await noteOnSeat(event.id, seatId)).toBeNull();
  });

  it.runIf(ready())('never double-books when many seats are clicked at once', async () => {
    const seatIds = testSeatIds(12);
    // Two racers per seat, all interleaved.
    const attempts = seatIds.flatMap((seatId, i) => [
      bookSeat({ seatId, sessionId: testSessionId(`x-${i}`), eventId: event.id }),
      bookSeat({ seatId, sessionId: testSessionId(`y-${i}`), eventId: event.id }),
    ]);
    await Promise.allSettled(attempts);

    expect(await doubleBookedSeatIds(event.id)).toEqual([]);
    expect((await activeSeatIds(event.id)).sort()).toEqual([...seatIds].sort());
  });
});
