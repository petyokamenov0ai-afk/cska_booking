-- Free-text note captured alongside the seat holder's name (click-to-book).
--
-- Nullable TEXT with no default: PostgreSQL 11+ records this in the catalogue
-- only, so it does not rewrite the table and every existing row reads back as
-- NULL — which is the correct value for every one of them. No backfill.
--
-- No CHECK on the length. The 120-character bound is the request schema's, the
-- same posture `name` already takes: a bound in SQL turns a future copy change
-- into a migration, and turns an over-long value from a 400 into a 500.
--
-- The partial unique index `reservation_seat_active_uq` is untouched: this adds
-- a nullable column to "Reservation" and rebuilds nothing on "ReservationSeat".

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "note" TEXT;
