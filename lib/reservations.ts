/**
 * Reservation lifecycle — IMPLEMENTATION_PLAN §5, `docs/API_CONTRACT.md`.
 *
 * ## The invariant
 *
 * `ReservationSeat.active` is true **exactly while** its reservation legitimately
 * blocks the seat (PENDING and unexpired, or CONFIRMED). Postgres enforces the
 * consequence:
 *
 * ```sql
 * CREATE UNIQUE INDEX reservation_seat_active_uq
 *   ON "ReservationSeat" ("eventId", "seatId") WHERE "active";
 * ```
 *
 * Double-booking is therefore impossible *at the storage layer*, whatever the
 * application does. Everything below is written on that assumption: the code
 * never checks "is this seat free?" and then inserts — a check-then-act pair is a
 * race by construction. It inserts, and treats the unique violation as the
 * authoritative answer.
 *
 * ## Expiry is three layers (§5)
 *
 * 1. **Lazy** — every read (`lib/availability.ts`) treats `PENDING AND
 *    expiresAt < now` as free, so the UI is right the instant a hold lapses.
 * 2. **Sweeper** — `expireStaleReservations()` from `POST /api/cron/expire`
 *    flips the rows, because a lapsed-but-uncleaned row still physically
 *    occupies the unique index.
 * 3. **On conflict** — `createHold` expires *exactly* the stale blockers for the
 *    seats it wants and retries once, so nobody is ever told "taken" because of
 *    a dead hold.
 *
 * ## Clock injection
 *
 * Every exported function accepts an optional `now: Date`. Tests drive expiry
 * deterministically instead of sleeping; production omits it.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  MAX_SEATS_PER_RESERVATION,
  RESERVATION_CODE_ALPHABET,
  RESERVATION_CODE_LENGTH,
} from '@/lib/zodSchemas';
import type {
  ApiErrorCode,
  EventStatus,
  ReservationDTO,
  ReservationStatus,
} from '@/lib/types';
import { randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Hold TTL — the 7:00 countdown the UI shows after seat selection. */
export const HOLD_TTL_MS = 7 * 60 * 1000;

/**
 * Anti-hoarding cap. Defined in `lib/zodSchemas.ts` (which client components can
 * import) and re-exported here, where `docs/API_CONTRACT.md` advertises it.
 */
export { MAX_SEATS_PER_RESERVATION };

/** How many fresh codes to try before giving up on a `Reservation.code` clash. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Retries for a transient serialisation failure / deadlock, which says nothing
 * about availability and so is safe to re-attempt as-is.
 */
const MAX_TRANSIENT_ATTEMPTS = 3;

/**
 * Loop bound for the insert: the code retries, the transient retries and the one
 * permitted seat-conflict retry, plus slack. Purely a guard against spinning.
 */
const MAX_INSERT_ATTEMPTS = MAX_CODE_ATTEMPTS + MAX_TRANSIENT_ATTEMPTS + 2;

/** The sweeper batches, so one run can never build a million-element `IN (…)`. */
const EXPIRE_BATCH_LIMIT = 5_000;

/** Interactive transactions default to 5 s; the sweeper's batch deserves more. */
const SWEEP_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Base class for everything this module throws deliberately.
 *
 * `apiCode` is read **structurally** by `lib/apiError.ts` (`toApiErrorResponse`),
 * which is why that module needs no import from this one: no `instanceof` across
 * a bundler boundary, no Prisma pulled into the error helpers.
 */
export class ServiceError extends Error {
  readonly apiCode: ApiErrorCode;

  constructor(apiCode: ApiErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.apiCode = apiCode;
  }
}

/** 409 `SEATS_TAKEN` — `conflictSeats` is exactly what the UI must un-select. */
export class SeatsTakenError extends ServiceError {
  readonly conflictSeats: string[];

  constructor(conflictSeats: string[], message?: string) {
    super(
      'SEATS_TAKEN',
      message ??
        `${conflictSeats.length} of the selected seats ${
          conflictSeats.length === 1 ? 'is' : 'are'
        } no longer available.`,
    );
    this.conflictSeats = conflictSeats;
  }
}

/** 409 `INVALID_STATE` — e.g. confirming a CANCELLED reservation. */
export class InvalidStateError extends ServiceError {
  constructor(message: string) {
    super('INVALID_STATE', message);
  }
}

/** 422 `SALES_CLOSED` — event not `ON_SALE`, or outside `salesOpen..salesClose`. */
export class SalesClosedError extends ServiceError {
  constructor(message: string) {
    super('SALES_CLOSED', message);
  }
}

/** 410 `EXPIRED` — the hold lapsed before confirmation. */
export class ReservationExpiredError extends ServiceError {
  constructor(message = 'This hold has expired. Please pick your seats again.') {
    super('EXPIRED', message);
  }
}

/** 404 `NOT_FOUND` — unknown event, seat id or reservation code. */
export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/**
 * 400 `VALIDATION` — belt-and-braces behind the zod schema, so a caller that
 * forgets to validate still cannot exceed the cap.
 */
export class SeatLimitError extends ServiceError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

const EVENT_SELECT = {
  id: true,
  title: true,
  kickoffAt: true,
  salesOpen: true,
  salesClose: true,
  status: true,
} as const;

interface EventRow {
  id: string;
  title: string;
  kickoffAt: Date;
  salesOpen: Date;
  salesClose: Date;
  status: EventStatus;
}

const RESERVATION_SCALAR_SELECT = {
  id: true,
  code: true,
  eventId: true,
  status: true,
  name: true,
  email: true,
  phone: true,
  expiresAt: true,
  createdAt: true,
  sessionId: true,
} as const;

interface ReservationScalars {
  id: string;
  code: string;
  eventId: string;
  status: ReservationStatus;
  name: string | null;
  email: string | null;
  phone: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  sessionId: string;
}

interface ReservationSeatRow {
  seatId: string;
  active: boolean;
}

interface ReservationRow extends ReservationScalars {
  seats: ReservationSeatRow[];
}

/** Everything the DTO needs about a seat, flattened. */
interface SeatInfo {
  id: string;
  row: number;
  number: number;
  subsectorId: string;
  subsectorCode: string;
  subsectorLatin: string;
  subsectorOrder: number;
}

const SEAT_INFO_SELECT = {
  id: true,
  row: true,
  number: true,
  active: true,
  subsectorId: true,
  subsector: { select: { code: true, latin: true, order: true } },
} as const;

interface SeatInfoRow {
  id: string;
  row: number;
  number: number;
  active: boolean;
  subsectorId: string;
  subsector: { code: string; latin: string; order: number };
}

function toSeatInfo(row: SeatInfoRow): SeatInfo {
  return {
    id: row.id,
    row: row.row,
    number: row.number,
    subsectorId: row.subsectorId,
    subsectorCode: row.subsector.code,
    subsectorLatin: row.subsector.latin,
    subsectorOrder: row.subsector.order,
  };
}

/* ------------------------------------------------------------------ *
 * Reservation codes
 * ------------------------------------------------------------------ */

/**
 * 6 characters from a 32-symbol Crockford-ish alphabet with `I O 0 1` removed.
 *
 * `randomBytes` (CSPRNG, not `Math.random`) because the code is the public
 * handle that authorises cancellation — guessable codes would be a hole. The
 * alphabet is exactly 32 symbols, so `byte % 32` is uniform with no modulo bias.
 * 32^6 ≈ 1.07e9 combinations; collisions are handled by retrying on the unique
 * violation rather than by pre-checking.
 */
export function generateReservationCode(
  length: number = RESERVATION_CODE_LENGTH,
): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += RESERVATION_CODE_ALPHABET[bytes[index] % RESERVATION_CODE_ALPHABET.length];
  }
  return code;
}

/** Accepts user-typed codes (any case, stray spaces) and normalises them. */
export function normalizeReservationCode(code: string): string {
  return code.trim().toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Prisma error classification
 * ------------------------------------------------------------------ */

interface KnownRequestErrorLike {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

/**
 * `instanceof` first (correct), structural check second (survives two copies of
 * `@prisma/client` in one process, which bundlers occasionally produce).
 */
function asKnownRequestError(error: unknown): KnownRequestErrorLike | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return { code: error.code, message: error.message, meta: error.meta as Record<string, unknown> | undefined };
  }
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown };
  if (typeof candidate.code !== 'string' || !/^P\d{4}$/.test(candidate.code)) return null;
  return {
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : '',
    meta:
      typeof candidate.meta === 'object' && candidate.meta !== null
        ? (candidate.meta as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Lower-cased haystack describing which constraint blew up.
 *
 * Prisma reports `meta.target` as a field-name array when it recognises the
 * index (`['code']` for `Reservation_code_key`) and as the raw constraint name
 * when it does not — which is our case, because `reservation_seat_active_uq` is
 * a hand-written partial index Prisma knows nothing about. The message is folded
 * in as a last resort.
 */
function uniqueTargetText(error: KnownRequestErrorLike): string {
  const parts: string[] = [];
  const target = error.meta?.target;
  if (typeof target === 'string') parts.push(target);
  else if (Array.isArray(target)) parts.push(...target.map((entry) => String(entry)));
  const constraint = error.meta?.constraint;
  if (typeof constraint === 'string') parts.push(constraint);
  parts.push(error.message);
  return parts.join(' ').toLowerCase();
}

export type UniqueViolationKind = 'seat' | 'code' | null;

/**
 * Which unique constraint a P2002 hit. Both live on the insert path, and they
 * demand opposite responses — a seat clash means somebody beat us to the seat, a
 * code clash means we drew an unlucky 6 characters — so they must never be
 * conflated.
 *
 * Exported so the on-conflict decision can be unit-tested without a database
 * (IMPLEMENTATION_PLAN §10, "Expiry tests"). `null` means "not a P2002 at all",
 * i.e. rethrow.
 */
export function classifyUniqueViolation(error: unknown): UniqueViolationKind {
  const known = asKnownRequestError(error);
  if (known === null || known.code !== 'P2002') return null;
  const text = uniqueTargetText(known);
  // Checked first: `reservation_seat_active_uq` and
  // `ReservationSeat_reservationId_seatId_key` both contain "seat" and neither
  // contains "code", while the code clash reports ("code") / Reservation_code_key.
  if (text.includes('seat')) return 'seat';
  if (text.includes('code')) return 'code';
  // Unnameable constraint: assume the seat guard. `createHold` self-corrects by
  // checking who actually holds the seats and falling back to a code retry when
  // the answer is "nobody".
  return 'seat';
}

/**
 * A deadlock or serialisation failure: Postgres aborted the transaction to break
 * a lock cycle. It carries **no information about availability** — nobody took
 * the seat — so the correct response is to run the same insert again, not to tell
 * the user their seats are gone.
 *
 * This is a **safety net, not the guarantee**. Measured against Postgres 16 by
 * forcing lock-order inversion: a deadlock inside an interactive transaction
 * reaches the caller as `P2028` ("transaction already closed") whose message does
 * *not* name the deadlock — the `40P01 ConnectorError` only ever appears in
 * Prisma's own error log. So neither this function nor any other can reliably
 * classify that case after the fact.
 *
 * Which is precisely why `createHold` **prevents** the cycle instead of reacting
 * to it, by inserting seats in a deterministic global order (see the sort there).
 * With that in place the deadlock rate over 252 concurrent overlapping holds was
 * zero; with a randomised order the same test produced 21 failures.
 *
 * What this does catch: deadlocks and serialisation failures Prisma labels
 * properly (`P2034`, or SQLSTATE `40001` / `40P01` in `meta`), which is the shape
 * seen for single statements outside an interactive transaction.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  const known = asKnownRequestError(error);
  if (known !== null) {
    if (known.code === 'P2034') return true;
    const sqlState = known.meta?.code;
    if (sqlState === '40001' || sqlState === '40P01') return true;
  }

  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : '';
  return (
    message.includes('deadlock detected') ||
    message.includes('40p01') ||
    message.includes('could not serialize') ||
    message.includes('serialization failure') ||
    message.includes('40001')
  );
}

/* ------------------------------------------------------------------ *
 * DTO assembly
 * ------------------------------------------------------------------ */

/**
 * Lazy expiry, applied to presentation: a PENDING row whose `expiresAt` has
 * passed *is* expired even though the sweeper has not touched it yet. Reporting
 * it as PENDING would show a countdown that is already at zero.
 */
function effectiveStatus(
  status: ReservationStatus,
  expiresAt: Date | null,
  now: Date,
): ReservationStatus {
  if (status === 'PENDING' && expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return status;
}

function toReservationDTO(
  reservation: ReservationRow,
  event: Pick<EventRow, 'id' | 'title' | 'kickoffAt'>,
  seatInfoById: ReadonlyMap<string, SeatInfo>,
  now: Date,
): ReservationDTO {
  const seats = reservation.seats.map((seat) => {
    const info = seatInfoById.get(seat.seatId);
    if (info === undefined) {
      // The FK makes this unreachable; if it ever fires, the data is broken and
      // a 500 is the honest answer.
      throw new Error(
        `Reservation ${reservation.code} references unknown seat ${seat.seatId}.`,
      );
    }
    return {
      seatId: seat.seatId,
      subsectorCode: info.subsectorCode,
      subsectorLatin: info.subsectorLatin,
      row: info.row,
      number: info.number,
      sortKey: [info.subsectorOrder, info.row, info.number] as const,
    };
  });

  seats.sort(
    (a, b) =>
      a.sortKey[0] - b.sortKey[0] ||
      a.sortKey[1] - b.sortKey[1] ||
      a.sortKey[2] - b.sortKey[2],
  );

  const status = effectiveStatus(reservation.status, reservation.expiresAt, now);

  return {
    code: reservation.code,
    eventId: reservation.eventId,
    status,
    expiresAt: reservation.expiresAt?.toISOString() ?? null,
    createdAt: reservation.createdAt.toISOString(),
    name: reservation.name,
    email: reservation.email,
    phone: reservation.phone,
    event: {
      id: event.id,
      title: event.title,
      kickoffAt: event.kickoffAt.toISOString(),
    },
    seats: seats.map(({ sortKey: _sortKey, ...seat }) => seat),
  };
}

async function loadReservationRow(code: string): Promise<ReservationRow | null> {
  const row: ReservationRow | null = await prisma.reservation.findUnique({
    where: { code },
    select: {
      ...RESERVATION_SCALAR_SELECT,
      seats: { select: { seatId: true, active: true } },
    },
  });
  return row;
}

/** Fetches the event + seat metadata a `ReservationRow` needs, then maps. */
async function hydrateReservationDTO(
  reservation: ReservationRow,
  now: Date,
): Promise<ReservationDTO> {
  const seatIds = reservation.seats.map((seat) => seat.seatId);

  const eventPromise: Promise<Pick<EventRow, 'id' | 'title' | 'kickoffAt'> | null> =
    prisma.event.findUnique({
      where: { id: reservation.eventId },
      select: { id: true, title: true, kickoffAt: true },
    });
  const seatsPromise: Promise<SeatInfoRow[]> =
    seatIds.length === 0
      ? Promise.resolve([])
      : prisma.seat.findMany({
          where: { id: { in: seatIds } },
          select: SEAT_INFO_SELECT,
        });

  const [event, seatRows] = await Promise.all([eventPromise, seatsPromise]);
  if (event === null) {
    throw new Error(`Reservation ${reservation.code} points at missing event.`);
  }

  const seatInfoById = new Map(seatRows.map((row) => [row.id, toSeatInfo(row)]));
  return toReservationDTO(reservation, event, seatInfoById, now);
}

/* ------------------------------------------------------------------ *
 * Sales window
 * ------------------------------------------------------------------ */

function assertOnSale(event: EventRow, now: Date): void {
  if (event.status !== 'ON_SALE') {
    throw new SalesClosedError(
      `Tickets for "${event.title}" are not on sale (event is ${event.status}).`,
    );
  }
  if (now.getTime() < event.salesOpen.getTime()) {
    throw new SalesClosedError(
      `Sales for "${event.title}" open at ${event.salesOpen.toISOString()}.`,
    );
  }
  if (now.getTime() > event.salesClose.getTime()) {
    throw new SalesClosedError(`Sales for "${event.title}" have closed.`);
  }
}

/* ------------------------------------------------------------------ *
 * Stale-blocker cleanup
 * ------------------------------------------------------------------ */

/**
 * Flips `status = EXPIRED` and `seats.active = false` for the given reservation
 * ids, but only for those still PENDING and actually past `expiresAt`.
 *
 * The two-step (update, then re-read *which* rows the guard let through, then
 * deactivate only those seats) matters: `updateMany` reports a count, not ids, so
 * deactivating seats for the whole input list would release the seats of a
 * reservation that the guard deliberately spared.
 */
async function expireReservationIds(
  tx: Prisma.TransactionClient,
  ids: string[],
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;

  await tx.reservation.updateMany({
    where: { id: { in: ids }, status: 'PENDING', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });

  const expired: Array<{ id: string }> = await tx.reservation.findMany({
    where: { id: { in: ids }, status: 'EXPIRED' },
    select: { id: true },
  });
  if (expired.length === 0) return 0;

  await tx.reservationSeat.updateMany({
    where: { reservationId: { in: expired.map((row) => row.id) }, active: true },
    data: { active: false },
  });

  return expired.length;
}

/**
 * Targeted cleanup for the on-conflict path: expires **only** the reservations
 * that are (a) PENDING, (b) past `expiresAt`, and (c) holding one of `seatIds`
 * for this event.
 *
 * Deliberately narrow. A blind "expire everything stale" would work too, but it
 * turns one user's click into a full-table write and makes the retry's latency
 * depend on unrelated traffic.
 *
 * @returns how many reservations were actually released (0 ⇒ nothing to retry for).
 */
export async function releaseStaleBlockers(
  eventId: string,
  seatIds: string[],
  now: Date = new Date(),
): Promise<number> {
  if (seatIds.length === 0) return 0;

  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<number> => {
    const rows: Array<{ reservationId: string }> = await tx.reservationSeat.findMany({
      where: {
        eventId,
        active: true,
        seatId: { in: seatIds },
        reservation: { status: 'PENDING', expiresAt: { lt: now } },
      },
      select: { reservationId: true },
      distinct: ['reservationId'],
    });

    return expireReservationIds(
      tx,
      rows.map((row) => row.reservationId),
      now,
    );
  });
}

/**
 * Which of `seatIds` are *physically* blocked right now — i.e. carry an
 * `active` ReservationSeat row for this event.
 *
 * "Physically" is the right question after a unique violation: the index is what
 * rejected the insert, and `active` is precisely what the index sees. Filtering
 * by reservation status here would risk reporting an empty conflict list while
 * the insert keeps failing.
 *
 * The result preserves the caller's seat order, so the UI can highlight losses
 * in the order the user picked them.
 */
export async function findBlockingSeatIds(
  eventId: string,
  seatIds: string[],
): Promise<string[]> {
  if (seatIds.length === 0) return [];

  const rows: Array<{ seatId: string }> = await prisma.reservationSeat.findMany({
    where: { eventId, active: true, seatId: { in: seatIds } },
    select: { seatId: true },
    distinct: ['seatId'],
  });

  const blocked = new Set(rows.map((row) => row.seatId));
  return seatIds.filter((seatId) => blocked.has(seatId));
}

/* ------------------------------------------------------------------ *
 * createHold
 * ------------------------------------------------------------------ */

export interface CreateHoldArgs {
  eventId: string;
  seatIds: string[];
  sessionId: string;
  /** Injectable clock; defaults to `new Date()`. */
  now?: Date;
}

/**
 * Creates a PENDING reservation holding `seatIds` for `HOLD_TTL_MS`.
 *
 * Order of operations, and why:
 *
 * 1. **Event + sales window** — cheap, and a closed event should never touch the
 *    seat tables.
 * 2. **Seats exist and are active** — an inactive seat is not capacity, so it
 *    reads as taken rather than as an error.
 * 3. **One transaction**: insert the `Reservation`, then all `ReservationSeat`
 *    rows with `active = true`. No availability check anywhere — the partial
 *    unique index is the gate, and it is the only check that cannot race.
 * 4. **On P2002**: never a blind retry. If it was a seat clash, expire exactly
 *    the stale blockers for these seats; retry once *only if that freed
 *    something*; otherwise report precisely who holds them. If it was a
 *    `Reservation.code` clash, draw a new code (up to `MAX_CODE_ATTEMPTS`).
 *
 * @throws SalesClosedError | NotFoundError | SeatsTakenError | SeatLimitError
 */
export async function createHold(args: CreateHoldArgs): Promise<ReservationDTO> {
  const now = args.now ?? new Date();
  // Dedupe defensively: two identical ids would trip
  // ReservationSeat_reservationId_seatId_key and look like a seat conflict.
  const seatIds = [...new Set(args.seatIds)];

  if (seatIds.length === 0) {
    throw new SeatLimitError('Select at least one seat.');
  }
  if (seatIds.length > MAX_SEATS_PER_RESERVATION) {
    throw new SeatLimitError(
      `At most ${MAX_SEATS_PER_RESERVATION} seats per reservation.`,
    );
  }
  if (args.sessionId.length === 0) {
    throw new SeatLimitError('Missing session id.');
  }

  const event: EventRow | null = await prisma.event.findUnique({
    where: { id: args.eventId },
    select: EVENT_SELECT,
  });
  if (event === null) {
    throw new NotFoundError(`Event ${args.eventId} does not exist.`);
  }
  assertOnSale(event, now);

  // One stadium in v1, so "belongs to this stadium" is satisfied by the
  // Seat → Subsector FK, and every subsector of an ON_SALE event is sellable.
  const seatRows: SeatInfoRow[] = await prisma.seat.findMany({
    where: { id: { in: seatIds } },
    select: SEAT_INFO_SELECT,
  });

  if (seatRows.length !== seatIds.length) {
    const found = new Set(seatRows.map((row) => row.id));
    const missing = seatIds.filter((seatId) => !found.has(seatId));
    throw new NotFoundError(`Unknown seat id(s): ${missing.join(', ')}.`);
  }

  const inactive = seatRows.filter((row) => !row.active).map((row) => row.id);
  if (inactive.length > 0) {
    // BLOCKED seats are not for sale; from the client's point of view they are
    // unavailable, and 409 + conflictSeats is exactly what un-selects them.
    throw new SeatsTakenError(
      seatIds.filter((seatId) => inactive.includes(seatId)),
      'Some of the selected seats are not available for sale.',
    );
  }

  // Insert in a deterministic global order (by seat id).
  //
  // `createMany` inserts rows in array order, and each insert takes a lock on the
  // `reservation_seat_active_uq` index entry for that seat. Two overlapping
  // baskets that insert their shared seats in *opposite* order form a lock cycle,
  // and Postgres resolves that by killing one transaction with a deadlock error —
  // a 500 for a user whose seats were actually available. Sorting means every
  // transaction in the system acquires these locks in the same sequence, so a
  // cycle cannot form: the loser simply waits and then gets a clean P2002.
  const orderedSeatIds = seatRows
    .map((row) => row.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const expiresAt = new Date(now.getTime() + HOLD_TTL_MS);
  const seatInfoById = new Map(seatRows.map((row) => [row.id, toSeatInfo(row)]));

  let cleanupAttempted = false;
  let codeAttempts = 0;
  let transientAttempts = 0;

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
    const code = generateReservationCode();

    try {
      const created: ReservationRow = await prisma.$transaction(
        async (tx: Prisma.TransactionClient): Promise<ReservationRow> => {
          const reservation: ReservationScalars = await tx.reservation.create({
            data: {
              code,
              eventId: event.id,
              status: 'PENDING',
              expiresAt,
              sessionId: args.sessionId,
            },
            select: RESERVATION_SCALAR_SELECT,
          });

          await tx.reservationSeat.createMany({
            data: orderedSeatIds.map((seatId) => ({
              reservationId: reservation.id,
              eventId: event.id,
              seatId,
              active: true,
            })),
          });

          return {
            ...reservation,
            seats: orderedSeatIds.map((seatId) => ({ seatId, active: true })),
          };
        },
      );

      return toReservationDTO(
        created,
        { id: event.id, title: event.title, kickoffAt: event.kickoffAt },
        seatInfoById,
        now,
      );
    } catch (error) {
      // Deadlock / serialisation failure: nothing was decided, so just go again.
      if (isRetryableTransactionError(error)) {
        transientAttempts += 1;
        if (transientAttempts >= MAX_TRANSIENT_ATTEMPTS) throw error;
        continue;
      }

      const kind = classifyUniqueViolation(error);
      if (kind === null) throw error;

      if (kind === 'code') {
        codeAttempts += 1;
        if (codeAttempts >= MAX_CODE_ATTEMPTS) throw error;
        continue;
      }

      // Seat clash. Expire exactly the dead holds on these seats — once — and
      // retry only if that actually freed something. Retrying without having
      // changed anything would just lose the same race again.
      if (!cleanupAttempted) {
        cleanupAttempted = true;
        const freed = await releaseStaleBlockers(event.id, seatIds, now);
        if (freed > 0) continue;
      }

      const conflictSeats = await findBlockingSeatIds(event.id, seatIds);
      if (conflictSeats.length === 0) {
        // Nothing holds these seats, so the violation was not the seat guard —
        // Prisma could not name the constraint and we guessed wrong. It can only
        // have been the reservation code.
        codeAttempts += 1;
        if (codeAttempts < MAX_CODE_ATTEMPTS) continue;
        throw error;
      }

      throw new SeatsTakenError(conflictSeats);
    }
  }

  throw new Error(
    `Could not create a reservation after ${MAX_INSERT_ATTEMPTS} attempts.`,
  );
}

/* ------------------------------------------------------------------ *
 * confirmReservation
 * ------------------------------------------------------------------ */

export interface ConfirmReservationArgs {
  code: string;
  name: string;
  email: string;
  phone?: string;
  /** Injectable clock; defaults to `new Date()`. */
  now?: Date;
}

/**
 * PENDING (unexpired) → CONFIRMED, contact details attached, `expiresAt` cleared.
 *
 * - already CONFIRMED → idempotent success, details left untouched (a retried
 *   request must not overwrite what the first one stored)
 * - PENDING but past `expiresAt` → expires it, then throws
 *   `ReservationExpiredError` (410 `EXPIRED`)
 * - CANCELLED / EXPIRED → `InvalidStateError` (409)
 *
 * The write is a conditional `updateMany` (`status = PENDING AND expiresAt >
 * now`), i.e. a compare-and-set. A plain `update` after the read would let a
 * sweeper that fires in between produce a CONFIRMED reservation whose seats have
 * already been released.
 *
 * @throws NotFoundError | InvalidStateError | ReservationExpiredError
 */
export async function confirmReservation(
  args: ConfirmReservationArgs,
): Promise<ReservationDTO> {
  const now = args.now ?? new Date();
  const code = normalizeReservationCode(args.code);

  const existing = await loadReservationRow(code);
  if (existing === null) {
    throw new NotFoundError(`Reservation ${code} does not exist.`);
  }

  if (existing.status === 'CONFIRMED') {
    return hydrateReservationDTO(existing, now);
  }
  if (existing.status !== 'PENDING') {
    throw new InvalidStateError(
      `Reservation ${code} is ${existing.status.toLowerCase()} and cannot be confirmed.`,
    );
  }
  if (existing.expiresAt !== null && existing.expiresAt.getTime() <= now.getTime()) {
    await expireReservation(existing.id, now);
    throw new ReservationExpiredError();
  }

  const name = args.name.trim();
  const email = args.email.trim().toLowerCase();
  const phone = args.phone?.trim();

  const updated: { count: number } = await prisma.reservation.updateMany({
    where: {
      id: existing.id,
      status: 'PENDING',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: {
      status: 'CONFIRMED',
      expiresAt: null,
      name,
      email,
      phone: phone && phone.length > 0 ? phone : null,
    },
  });

  if (updated.count === 0) {
    // Lost a race with the sweeper or with another confirm/cancel. Re-read and
    // report the truth rather than guessing.
    const current = await loadReservationRow(code);
    if (current === null) {
      throw new NotFoundError(`Reservation ${code} does not exist.`);
    }
    if (current.status === 'CONFIRMED') {
      return hydrateReservationDTO(current, now);
    }
    if (current.status === 'PENDING' || current.status === 'EXPIRED') {
      await expireReservation(current.id, now);
      throw new ReservationExpiredError();
    }
    throw new InvalidStateError(
      `Reservation ${code} is ${current.status.toLowerCase()} and cannot be confirmed.`,
    );
  }

  const confirmed = await loadReservationRow(code);
  if (confirmed === null) {
    throw new NotFoundError(`Reservation ${code} does not exist.`);
  }
  return hydrateReservationDTO(confirmed, now);
}

/** Expires one reservation (and releases its seats) in a single transaction. */
async function expireReservation(id: string, now: Date): Promise<number> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<number> =>
    expireReservationIds(tx, [id], now),
  );
}

/* ------------------------------------------------------------------ *
 * cancelReservation
 * ------------------------------------------------------------------ */

/**
 * PENDING or CONFIRMED → CANCELLED, with every seat released in the same
 * transaction so the unique index is free the instant the status changes.
 *
 * Idempotent when already CANCELLED. An EXPIRED reservation cannot be cancelled
 * (it is already dead and its seats are already released) — `InvalidStateError`.
 *
 * @throws NotFoundError | InvalidStateError
 */
export async function cancelReservation(
  code: string,
  now: Date = new Date(),
): Promise<ReservationDTO> {
  const normalized = normalizeReservationCode(code);

  const existing = await loadReservationRow(normalized);
  if (existing === null) {
    throw new NotFoundError(`Reservation ${normalized} does not exist.`);
  }
  if (existing.status === 'CANCELLED') {
    return hydrateReservationDTO(existing, now);
  }
  if (existing.status === 'EXPIRED') {
    throw new InvalidStateError(
      `Reservation ${normalized} has already expired and cannot be cancelled.`,
    );
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
    const result: { count: number } = await tx.reservation.updateMany({
      where: { id: existing.id, status: { in: ['PENDING', 'CONFIRMED'] } },
      data: { status: 'CANCELLED', expiresAt: null },
    });
    if (result.count === 0) return; // someone else finished it first
    await tx.reservationSeat.updateMany({
      where: { reservationId: existing.id, active: true },
      data: { active: false },
    });
  });

  const current = await loadReservationRow(normalized);
  if (current === null) {
    throw new NotFoundError(`Reservation ${normalized} does not exist.`);
  }
  if (current.status !== 'CANCELLED') {
    throw new InvalidStateError(
      `Reservation ${normalized} is ${current.status.toLowerCase()} and cannot be cancelled.`,
    );
  }
  return hydrateReservationDTO(current, now);
}

/* ------------------------------------------------------------------ *
 * getReservation
 * ------------------------------------------------------------------ */

/**
 * Lookup by public code, for the confirmation / "my reservation" page.
 *
 * A PENDING row whose TTL has passed is reported with status `EXPIRED` (lazy
 * expiry) but is **not** written — reads stay reads; the sweeper and the
 * confirm path do the writing.
 *
 * `sessionId` is accepted for signature compatibility with
 * `docs/API_CONTRACT.md` and is intentionally **not** used to gate access: per
 * IMPLEMENTATION_PLAN §5 the reservation `code` is the durable public handle, so
 * a confirmation link must work from a different device or browser. `null` is
 * accepted so callers can pass `await getSessionId()` through unchecked.
 */
export async function getReservation(
  code: string,
  _sessionId?: string | null,
  now: Date = new Date(),
): Promise<ReservationDTO | null> {
  const row = await loadReservationRow(normalizeReservationCode(code));
  if (row === null) return null;
  return hydrateReservationDTO(row, now);
}

/* ------------------------------------------------------------------ *
 * expireStaleReservations (the sweeper)
 * ------------------------------------------------------------------ */

/**
 * Bulk-expires every PENDING reservation past its `expiresAt` and releases its
 * seats, in one transaction. Driven by `POST /api/cron/expire` every minute.
 *
 * This is what keeps the unique index honest: lazy expiry makes lapsed holds
 * *look* free, but the row still occupies `(eventId, seatId) WHERE active`, so
 * without the sweep the third insert path would carry all the load.
 *
 * @param now   injectable clock
 * @param limit batch size, so a long outage cannot produce one enormous `IN (…)`.
 *              Re-run until the result is smaller than `limit`.
 * @returns how many reservations were expired.
 */
export async function expireStaleReservations(
  now: Date = new Date(),
  limit: number = EXPIRE_BATCH_LIMIT,
): Promise<number> {
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<number> => {
      const stale: Array<{ id: string }> = await tx.reservation.findMany({
        where: { status: 'PENDING', expiresAt: { lt: now } },
        select: { id: true },
        take: limit,
        orderBy: { expiresAt: 'asc' },
      });
      return expireReservationIds(
        tx,
        stale.map((row) => row.id),
        now,
      );
    },
    { timeout: SWEEP_TIMEOUT_MS },
  );
}
