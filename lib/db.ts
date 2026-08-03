import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Singleton PrismaClient.
 *
 * Next.js dev mode hot-reloads modules on every edit; without the globalThis
 * cache each reload would open a fresh connection pool and eventually exhaust
 * Postgres' connection limit.
 *
 * ## Why logging goes through an event handler
 *
 * `log: ['error']` makes Prisma print straight to stderr, which cannot be
 * filtered. That matters here because of one specific, *expected* error: the
 * `reservation_seat_active_uq` partial unique index is the double-booking gate
 * (IMPLEMENTATION_PLAN §4), so **every visitor who loses a race for a seat
 * produces a P2002**. Under a ticket rush that is one stack trace per losing
 * user — ordinary traffic being reported as a fault, drowning real errors in
 * the log and in whatever alerts read it.
 *
 * `createHold` already handles P2002 (expire stale blockers, retry once, then
 * 409 `SEATS_TAKEN` with the losing seat ids), so by the time it surfaces it is
 * a *handled* condition. Emitting the log as an event lets us drop exactly that
 * case and keep everything else.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * True for the one error class that is expected traffic rather than a fault:
 * a unique violation on the `(eventId, seatId)` pair.
 *
 * Matched on the **message text**, because the log payload carries no error
 * code — `Prisma.LogEvent` is `{ timestamp, message, target }`, and the message
 * Prisma renders does *not* include `P2002` (verified against a live race). Two
 * spellings occur:
 *
 *   through the client:  Unique constraint failed on the fields: (`eventId`,`seatId`)
 *   through $executeRaw: Raw query failed. Code: `23505`. … Key ("eventId", "seatId")=(…)
 *
 * Deliberately narrow: it requires **both** column names, so a collision on
 * `Reservation.code` or any other unique key still gets logged.
 */
function isExpectedRaceLoss(message: string): boolean {
  const isUniqueViolation =
    message.includes('Unique constraint failed') || message.includes('23505');
  if (!isUniqueViolation) return false;

  // Strip the quoting Prisma/Postgres apply so one test covers both spellings.
  const bare = message.replace(/[`"]/g, '');
  return bare.includes('eventId') && bare.includes('seatId');
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
          ]
        : [{ emit: 'event', level: 'error' }],
  });

  client.$on('error', (event: Prisma.LogEvent) => {
    if (isExpectedRaceLoss(event.message)) return;
    console.error('[prisma]', event.message);
  });

  if (process.env.NODE_ENV === 'development') {
    client.$on('warn', (event: Prisma.LogEvent) => {
      console.warn('[prisma]', event.message);
    });
  }

  return client;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
