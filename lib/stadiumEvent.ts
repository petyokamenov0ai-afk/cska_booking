/**
 * The stadium has no match days.
 *
 * Booking is per *seat*, not per event: the administrator creates and deletes
 * seats when they are needed, and a seat is simply free or taken. But the
 * storage-layer double-booking guard is
 *
 *     CREATE UNIQUE INDEX reservation_seat_active_uq
 *       ON "ReservationSeat" ("eventId", "seatId") WHERE "active";
 *
 * which is what makes two people clicking the same seat physically impossible.
 * Keeping that index — and therefore the `eventId` column it is built on — is
 * worth far more than deleting a table, so one hidden singleton `Event` row
 * stands in for "the stadium". It never appears in the UI.
 *
 * That also means the match-day model can come back later (or be dropped for
 * real) without a destructive migration in the meantime.
 */

import { prisma } from '@/lib/db';

/** Fixed id, so the row is idempotent to create and easy to find by hand. */
export const STADIUM_EVENT_ID = 'stadium';

/** Sales are always open: there is no match to open or close them around. */
const ALWAYS_OPEN_FROM = new Date('2000-01-01T00:00:00.000Z');
const ALWAYS_OPEN_UNTIL = new Date('2100-01-01T00:00:00.000Z');

let cachedId: string | null = null;

/**
 * The singleton stadium "event" id, creating the row on first use so a fresh
 * database works without a special seed step.
 */
export async function getStadiumEventId(): Promise<string> {
  if (cachedId !== null) return cachedId;
  const row = await prisma.event.upsert({
    where: { id: STADIUM_EVENT_ID },
    // Never rewrite the row on read — an admin may have adjusted it.
    update: {},
    create: {
      id: STADIUM_EVENT_ID,
      title: 'Стадион „Българска армия“',
      kickoffAt: ALWAYS_OPEN_UNTIL,
      salesOpen: ALWAYS_OPEN_FROM,
      salesClose: ALWAYS_OPEN_UNTIL,
      status: 'ON_SALE',
    },
    select: { id: true },
  });
  cachedId = row.id;
  return cachedId;
}

/** Test helper — forget the memoised id. */
export function resetStadiumEventCache(): void {
  cachedId = null;
}
