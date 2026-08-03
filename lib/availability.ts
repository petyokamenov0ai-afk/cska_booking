/**
 * Availability reads — `docs/API_CONTRACT.md § lib/availability.ts`.
 *
 * ## Lazy expiry, in one place
 *
 * A seat is blocked when it carries an `active` ReservationSeat row for the event
 * **and** that reservation still legitimately holds it:
 *
 * ```
 * blocked  ⇔  reservation.status = CONFIRMED
 *          ∨  (reservation.status = PENDING ∧ (expiresAt IS NULL ∨ expiresAt > now))
 * ```
 *
 * Anything else — a PENDING hold past its TTL, or a CANCELLED/EXPIRED row the
 * sweeper has not cleaned yet — reads as **free**. That is IMPLEMENTATION_PLAN §5
 * layer (1), and both functions here implement exactly the same predicate so the
 * overview map and the seat map can never disagree.
 *
 * ## Query shape
 *
 * `getSubsectorAvailability` is **one** grouped SQL statement over
 * `ReservationSeat ⋈ Reservation ⋈ Seat ⋈ Subsector`, not 22 counts. Prisma's
 * `groupBy` cannot join, and the numbers we need (seats per subsector, blockers
 * per subsector) only exist across a join, so this is raw SQL — parameterised via
 * `Prisma.sql`, never string-interpolated.
 *
 * `getSubsectorSeats` is scoped to a single subsector (≈400–1,200 rows) and stays
 * in the type-safe query builder.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSubsectorGeometry } from '@/lib/stadium';
import type {
  EventListItemDTO,
  EventStatus,
  SeatDTO,
  SeatStatus,
  SeatType,
  SubsectorAvailabilityDTO,
  SubsectorMeta,
} from '@/lib/types';

/* ------------------------------------------------------------------ *
 * getSubsectorAvailability
 * ------------------------------------------------------------------ */

interface AvailabilityRow {
  code: string;
  latin: string;
  order: number;
  total: number;
  blocked: number;
}

/**
 * Free/total per subsector for one event — drives the overview and sector
 * colouring. Cached ~10 s at the route level.
 *
 * `total` counts **active** seats only: a killed seat is not capacity, so
 * including it would make a fully-sold subsector look 99 % sold forever.
 *
 * All 22 subsectors are returned — the overview map draws every shape.
 *
 * Returns `[]` for an unknown event id; use `eventExists()` when the caller has
 * to distinguish that from "no subsectors".
 */
export async function getSubsectorAvailability(
  eventId: string,
  now: Date = new Date(),
): Promise<SubsectorAvailabilityDTO[]> {
  // This is the only response in the app served `Cache-Control: public,
  // max-age=10`, i.e. the only one a shared cache may hand to a different
  // visitor. It must stay counts-only — never add a holder name or a seat note
  // here. Both belong to `getSubsectorSeats`, which is always `no-store`. Pinned
  // by tests/availability.test.ts.
  // Prisma maps `DateTime` to `timestamp(3) WITHOUT time zone`, holding the UTC
  // wall clock. Comparing that column against a `timestamptz` makes Postgres
  // reinterpret it in the *session* time zone, which silently shifts the cutoff
  // by the server's UTC offset — every live hold reads as expired on a machine
  // running Europe/Sofia. So the bound is built as a plain `timestamp` in UTC:
  // the ISO string parses to an absolute instant (`Z` offset), and `AT TIME ZONE
  // 'UTC'` projects it back to the same representation the column uses. No
  // session setting can affect the result.
  const cutoff = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

  // COUNT(DISTINCT se.id) rather than COUNT(*): the partial unique index means
  // the ReservationSeat join cannot fan out today, but DISTINCT makes the counts
  // correct even if that ever changes.
  const rows = await prisma.$queryRaw<AvailabilityRow[]>(Prisma.sql`
    SELECT
      sub."code"  AS "code",
      sub."latin" AS "latin",
      sub."order" AS "order",
      COUNT(DISTINCT se."id")::int AS "total",
      COUNT(DISTINCT CASE
        WHEN r."status" = 'CONFIRMED'
          OR (r."status" = 'PENDING'
              AND (r."expiresAt" IS NULL OR r."expiresAt" > ${cutoff}))
        THEN se."id"
      END)::int AS "blocked"
    FROM "Subsector" sub
    LEFT JOIN "Seat" se
      ON se."subsectorId" = sub."id"
     AND se."active"
    LEFT JOIN "ReservationSeat" rs
      ON rs."seatId" = se."id"
     AND rs."eventId" = ${eventId}
     AND rs."active"
    LEFT JOIN "Reservation" r
      ON r."id" = rs."reservationId"
    GROUP BY sub."id", sub."code", sub."latin", sub."order"
    ORDER BY sub."order" ASC
  `);

  return rows.map((row) => ({
    code: row.code,
    latin: row.latin,
    free: Math.max(0, row.total - row.blocked),
    total: row.total,
  }));
}

/** Cheap existence probe, so routes can answer 404 vs "empty". */
export async function eventExists(eventId: string): Promise<boolean> {
  const row = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true },
  });
  return row !== null;
}

/* ------------------------------------------------------------------ *
 * getSubsectorSeats
 * ------------------------------------------------------------------ */

interface SubsectorRow {
  id: string;
  code: string;
  latin: string;
  viewBox: string;
  width: number;
  height: number;
}

interface SeatRow {
  id: string;
  row: number;
  number: number;
  x: number;
  y: number;
  angle: number;
  type: SeatType;
  white: boolean;
  active: boolean;
}

interface HoldRow {
  seatId: string;
  reservation: {
    status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
    sessionId: string;
    expiresAt: Date | null;
    name: string | null;
    note: string | null;
  };
}

export interface SubsectorSeatsResult {
  subsector: SubsectorMeta;
  seats: SeatDTO[];
}

/**
 * Every seat of one subsector with its live status for this event, plus the
 * `mine` flag for the calling browser session.
 *
 * Geometry (`x`, `y`, `angle`, `white`, `viewBox`, `width`, `height`) comes from
 * the **database** rows, not from `data/stadium.json`: the DB is what the seed
 * wrote, so ids and coordinates cannot drift apart between the two sources.
 *
 * `rowCount` / `seatCount` in the header are derived from the seats actually
 * returned rather than from `Subsector`'s denormalised columns, so the header can
 * never describe a different payload than the one attached to it.
 *
 * @param sessionId the `sid` cookie value. `null` is accepted so a Server
 *   Component can pass `await getSessionId()` straight through: no session
 *   matches no reservation, so every seat comes back `mine: false`.
 * @returns `null` when the event or the subsector code is unknown.
 */
export async function getSubsectorSeats(
  eventId: string,
  subsectorCode: string,
  sessionId: string | null,
  now: Date = new Date(),
): Promise<SubsectorSeatsResult | null> {
  const eventPromise: Promise<{ id: string } | null> = prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true },
  });
  const subsectorPromise: Promise<SubsectorRow | null> = prisma.subsector.findUnique({
    where: { code: subsectorCode },
    select: {
      id: true,
      code: true,
      latin: true,
      viewBox: true,
      width: true,
      height: true,
    },
  });

  const [event, subsector] = await Promise.all([eventPromise, subsectorPromise]);
  if (event === null || subsector === null) return null;

  const seatsPromise: Promise<SeatRow[]> = prisma.seat.findMany({
    where: { subsectorId: subsector.id },
    select: {
      id: true,
      row: true,
      number: true,
      x: true,
      y: true,
      angle: true,
      type: true,
      white: true,
      active: true,
    },
    orderBy: [{ row: 'asc' }, { number: 'asc' }],
  });

  // Joined through the `seat` relation instead of `seatId: { in: [...1200 ids] }`,
  // so the statement stays small and uses ReservationSeat(eventId, seatId).
  const holdsPromise: Promise<HoldRow[]> = prisma.reservationSeat.findMany({
    where: {
      eventId,
      active: true,
      seat: { subsectorId: subsector.id },
    },
    select: {
      seatId: true,
      reservation: {
        // `name` and `note` ride along on a statement already being issued — a
        // relation select Prisma resolves once for the whole result set, so these
        // are two extra columns, not an extra round trip and not an N+1.
        select: {
          status: true,
          sessionId: true,
          expiresAt: true,
          name: true,
          note: true,
        },
      },
    },
  });

  const [seatRows, holds] = await Promise.all([seatsPromise, holdsPromise]);

  const holdBySeatId = new Map(holds.map((hold) => [hold.seatId, hold.reservation]));

  const rowNumbers = new Set<number>();
  const seats: SeatDTO[] = seatRows.map((seat) => {
    rowNumbers.add(seat.row);

    let status: SeatStatus = 'FREE';
    let mine = false;
    let holder: string | null = null;
    let note: string | null = null;

    if (!seat.active) {
      // An administrator-killed seat is not "booked by someone", so it never
      // carries a holder or a note — even if a stale reservation row still
      // points at it.
      status = 'BLOCKED';
    } else {
      const hold = holdBySeatId.get(seat.id);
      if (hold !== undefined) {
        if (hold.status === 'CONFIRMED') {
          status = 'RESERVED';
        } else if (
          hold.status === 'PENDING' &&
          (hold.expiresAt === null || hold.expiresAt.getTime() > now.getTime())
        ) {
          status = 'HELD';
        }
        // else: stale PENDING, or CANCELLED/EXPIRED with a not-yet-swept
        // active row — lazy expiry says FREE.
        mine = status !== 'FREE' && hold.sessionId === sessionId;
        // Gated on the *computed* status, exactly like `mine`: the query filters
        // on `active` alone, so a CANCELLED/EXPIRED reservation the sweeper has
        // not cleared still arrives here and reads FREE. Its name must not
        // survive that, or a freed seat keeps showing the previous holder.
        // One computed-status gate for both captions: a note is a fact about a
        // booking, so it must not outlive the booking by even one read.
        holder = status !== 'FREE' ? hold.name : null;
        note = status !== 'FREE' ? hold.note : null;
      }
    }

    return {
      id: seat.id,
      row: seat.row,
      number: seat.number,
      x: seat.x,
      y: seat.y,
      angle: seat.angle,
      type: seat.type,
      white: seat.white,
      status,
      mine,
      holder,
      note,
    };
  });

  const meta: SubsectorMeta = {
    code: subsector.code,
    latin: subsector.latin,
    viewBox: subsector.viewBox,
    width: subsector.width,
    height: subsector.height,
    rowCount: rowNumbers.size,
    seatCount: seats.length,
    // Orientation lives in the geometry file, not the database — see the note on
    // SubsectorMeta.pitchSide.
    pitchSide: getSubsectorGeometry(subsector.code)?.pitchSide ?? 'top',
  };

  return { subsector: meta, seats };
}

/* ------------------------------------------------------------------ *
 * listEvents
 * ------------------------------------------------------------------ */

interface EventRow {
  id: string;
  title: string;
  kickoffAt: Date;
  salesOpen: Date;
  salesClose: Date;
  status: EventStatus;
}

export interface ListEventsOptions {
  /** When false, DRAFT and CLOSED events are included too. Default true. */
  onSaleOnly?: boolean;
}

/** `GET /api/events`, kick-off order. */
export async function listEvents(
  options: ListEventsOptions = {},
): Promise<EventListItemDTO[]> {
  const onSaleOnly = options.onSaleOnly ?? true;

  const events: EventRow[] = await prisma.event.findMany({
    where: onSaleOnly ? { status: 'ON_SALE' } : {},
    select: {
      id: true,
      title: true,
      kickoffAt: true,
      salesOpen: true,
      salesClose: true,
      status: true,
    },
    orderBy: { kickoffAt: 'asc' },
  });

  return events.map((event) => ({
    id: event.id,
    title: event.title,
    kickoffAt: event.kickoffAt.toISOString(),
    salesOpen: event.salesOpen.toISOString(),
    salesClose: event.salesClose.toISOString(),
    status: event.status,
  }));
}
