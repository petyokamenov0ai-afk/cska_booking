/**
 * Click-to-book: one seat, one click, no basket and no form.
 *
 * A booking is a `Reservation` with exactly one seat, created straight into
 * `CONFIRMED` — there is no hold and no 7-minute TTL. The only thing collected
 * is `name`: who the seat is for, so the map can be read at a glance. No e-mail,
 * no phone. Releasing is the same click again.
 *
 * What is deliberately kept from the match-day model:
 *
 *   * the partial unique index (`reservation_seat_active_uq`) as the *only*
 *     arbiter of who got the seat, so two simultaneous clicks cannot both win;
 *   * `sessionId`, so the UI can still show a visitor which seats are theirs.
 *
 * What is deliberately dropped: the hold state machine, expiry, the sweeper and
 * reservation codes are unused on this path. `lib/reservations.ts` still
 * implements them (and is still tested) so the flow can come back without being
 * rewritten, but nothing here calls into it.
 *
 * ## No authentication
 *
 * `releaseSeat` intentionally lets **anyone** free **any** seat — that is what
 * "click to book, drop the booking if needed" means for a stadium run by an
 * administrator. There is no ownership check. If this is ever exposed beyond a
 * trusted network it needs auth first; see docs/API_CONTRACT.md.
 *
 * The same applies to `name` and `note`: both are served to **every** visitor of
 * the seat map, not only to the session that booked the seat — that is the point
 * of labelling one. Anyone adding auth here must decide about them at the same
 * time, and the note is the likelier of the two to carry something a booker
 * assumed was private.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  NotFoundError,
  SeatsTakenError,
  ServiceError,
  classifyUniqueViolation,
  generateReservationCode,
  isRetryableTransactionError,
} from '@/lib/reservations';
import { getStadiumEventId } from '@/lib/stadiumEvent';
import { normaliseSeatText, rendersSomething } from '@/lib/zodSchemas';

/** Bounded retries for a code collision or a serialisation failure. */
const MAX_ATTEMPTS = 5;

export interface BookedSeat {
  seatId: string;
  row: number;
  number: number;
  subsectorCode: string;
}

/**
 * A seat the administrator has deactivated is not capacity, so it cannot be
 * booked. Reported as `INVALID_STATE` (409) rather than a new error code, to
 * keep the surface in docs/API_CONTRACT.md unchanged.
 */
export class SeatUnavailableError extends ServiceError {
  constructor(public readonly seatId: string) {
    super('INVALID_STATE', `Seat ${seatId} is not bookable.`);
  }
}

interface SeatRow {
  id: string;
  row: number;
  number: number;
  active: boolean;
  subsector: { code: string };
}

async function loadSeat(seatId: string): Promise<SeatRow> {
  const seat = await prisma.seat.findUnique({
    where: { id: seatId },
    select: {
      id: true,
      row: true,
      number: true,
      active: true,
      subsector: { select: { code: true } },
    },
  });
  if (seat === null) throw new NotFoundError(`Unknown seat ${seatId}.`);
  if (!seat.active) throw new SeatUnavailableError(seatId);
  return seat;
}

/**
 * Normalise, then refuse anything that would put no ink on the map: a stored
 * caption is either absent or something a reader can actually see. Shared by
 * `name` and `note` so neither can acquire a laxer rule than the other.
 */
function visibleOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const tidy = normaliseSeatText(value);
  return tidy !== '' && rendersSomething(tidy) ? tidy : null;
}

/**
 * Books one seat immediately.
 *
 * @throws SeatsTakenError when someone else already holds it — including when
 *   the loser of a genuine race hits the unique index.
 */
export async function bookSeat(args: {
  seatId: string;
  sessionId: string;
  /**
   * Who the seat is for. Optional *here* even though the route requires it: the
   * column is nullable and every booking made before this feature existed has
   * none, so "a reservation without a name" has to stay a representable state
   * rather than something only a hand-written INSERT can produce.
   */
  name?: string;
  /**
   * Free text about this one seat. Optional for the same reason as `name` — the
   * column is nullable and no booking made before the field existed has one.
   */
  note?: string;
  /** Defaults to the singleton stadium row; injected by tests. */
  eventId?: string;
}): Promise<BookedSeat> {
  const eventId = args.eventId ?? (await getStadiumEventId());
  const seat = await loadSeat(args.seatId);
  // Normalised at the point of storage, not only at the point of parsing: this
  // is the one writer of these columns, and the values go straight onto the seat
  // map. An all-whitespace value collapses to nothing, which is `null` — a
  // reservation labelled with an empty string is a state nothing should have to
  // render. Length is the route's business; a caller here is trusted.
  //
  // `|| null` alone is not enough, which is why `rendersSomething` gates both:
  // a value of two zero-width spaces survives normalisation and is truthy, so it
  // would reach the column and paint a bold "За: " with nothing after it.
  const name = visibleOrNull(args.name);
  const note = visibleOrNull(args.note);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const reservation = await tx.reservation.create({
          data: {
            code: generateReservationCode(),
            eventId,
            status: 'CONFIRMED',
            expiresAt: null,
            sessionId: args.sessionId,
            // Loop-invariant: only the code is redrawn on a retry, and neither
            // `name` nor `note` carries a unique index, so neither can become a
            // new P2002 source or perturb how `classifyUniqueViolation` reads one.
            name,
            note,
          },
          select: { id: true },
        });
        // The insert below is the gate: the partial unique index rejects it if
        // the seat is already actively held, so the check and the claim are one
        // atomic step and no read-then-write race exists.
        await tx.reservationSeat.create({
          data: {
            reservationId: reservation.id,
            eventId,
            seatId: seat.id,
            active: true,
          },
        });
      });

      return {
        seatId: seat.id,
        row: seat.row,
        number: seat.number,
        subsectorCode: seat.subsector.code,
      };
    } catch (error) {
      if (isRetryableTransactionError(error)) continue;

      const kind = classifyUniqueViolation(error);
      if (kind === null) throw error;
      // A code collision is ours to fix — try again with a fresh code.
      if (kind === 'code') continue;
      throw new SeatsTakenError([seat.id]);
    }
  }
  // Only reachable if every attempt collided; treat as lost rather than 500.
  throw new SeatsTakenError([args.seatId]);
}

/**
 * Frees a seat. Idempotent: releasing an already-free seat succeeds.
 *
 * Cancels the whole owning reservation, which is safe precisely because this
 * flow only ever creates single-seat reservations.
 *
 * @returns whether anything was actually released.
 */
export async function releaseSeat(args: {
  seatId: string;
  /** Defaults to the singleton stadium row; injected by tests. */
  eventId?: string;
}): Promise<boolean> {
  const eventId = args.eventId ?? (await getStadiumEventId());
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const held = await tx.reservationSeat.findFirst({
      where: { eventId, seatId: args.seatId, active: true },
      select: { id: true, reservationId: true },
    });
    if (held === null) return false;

    // Clear `active` in the same transaction that cancels the reservation, so
    // the index never keeps blocking a seat whose booking is gone.
    //
    // `active: true` in the WHERE is what makes concurrency well defined: under
    // READ COMMITTED, N simultaneous releases all read the same active row, so an
    // unconditional update would have every one of them report success. Here only
    // the caller that actually flips the row gets `count === 1`; the rest observe
    // that someone else already did it and report `false`.
    //
    // Targeting `held.id` also means a release can never touch a *newer* booking:
    // if the seat was freed and re-booked in between, that is a different row.
    const flipped = await tx.reservationSeat.updateMany({
      where: { id: held.id, active: true },
      data: { active: false },
    });
    if (flipped.count === 0) return false;

    await tx.reservation.update({
      where: { id: held.reservationId },
      data: { status: 'CANCELLED', expiresAt: null },
    });
    return true;
  });
}
