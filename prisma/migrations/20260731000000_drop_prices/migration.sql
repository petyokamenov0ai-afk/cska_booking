-- Drop money from the model.
--
-- Booking is free, so nothing stores a price any more. `SubsectorPrice` also
-- doubled as the "this subsector is on sale for this event" flag; that signal
-- goes away with it, and every subsector of an ON_SALE event is now sellable.
--
-- The partial unique index `reservation_seat_active_uq` is untouched: it is on
-- ("eventId", "seatId") and no column it references is dropped here.

-- DropForeignKey
ALTER TABLE "SubsectorPrice" DROP CONSTRAINT "SubsectorPrice_eventId_fkey";

-- DropForeignKey
ALTER TABLE "SubsectorPrice" DROP CONSTRAINT "SubsectorPrice_subsectorId_fkey";

-- DropTable
DROP TABLE "SubsectorPrice";

-- AlterTable
ALTER TABLE "Reservation" DROP COLUMN "totalCents";

-- AlterTable
ALTER TABLE "ReservationSeat" DROP COLUMN "priceCents";
