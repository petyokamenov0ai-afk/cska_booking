-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SeatType" AS ENUM ('STANDARD', 'WHEELCHAIR', 'COMPANION', 'VIP');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'ON_SALE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Sector" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "latin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameBg" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subsector" (
    "id" TEXT NOT NULL,
    "sectorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "latin" TEXT NOT NULL,
    "viewBox" TEXT NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "svgPath" TEXT NOT NULL,
    "centroidX" DOUBLE PRECISION NOT NULL,
    "centroidY" DOUBLE PRECISION NOT NULL,
    "seatCount" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "Subsector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "subsectorId" TEXT NOT NULL,
    "row" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "angle" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "type" "SeatType" NOT NULL DEFAULT 'STANDARD',
    "white" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kickoffAt" TIMESTAMP(3) NOT NULL,
    "salesOpen" TIMESTAMP(3) NOT NULL,
    "salesClose" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubsectorPrice" (
    "eventId" TEXT NOT NULL,
    "subsectorId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,

    CONSTRAINT "SubsectorPrice_pkey" PRIMARY KEY ("eventId","subsectorId")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "totalCents" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationSeat" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReservationSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sector_code_key" ON "Sector"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subsector_code_key" ON "Subsector"("code");

-- CreateIndex
CREATE INDEX "Subsector_sectorId_idx" ON "Subsector"("sectorId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_subsectorId_row_number_key" ON "Seat"("subsectorId", "row", "number");

-- CreateIndex
CREATE INDEX "Event_status_idx" ON "Event"("status");

-- CreateIndex
CREATE INDEX "SubsectorPrice_subsectorId_idx" ON "SubsectorPrice"("subsectorId");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_code_key" ON "Reservation"("code");

-- CreateIndex
CREATE INDEX "Reservation_status_expiresAt_idx" ON "Reservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Reservation_sessionId_idx" ON "Reservation"("sessionId");

-- CreateIndex
CREATE INDEX "Reservation_eventId_idx" ON "Reservation"("eventId");

-- CreateIndex
CREATE INDEX "ReservationSeat_eventId_seatId_idx" ON "ReservationSeat"("eventId", "seatId");

-- CreateIndex
CREATE INDEX "ReservationSeat_seatId_idx" ON "ReservationSeat"("seatId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationSeat_reservationId_seatId_key" ON "ReservationSeat"("reservationId", "seatId");

-- AddForeignKey
ALTER TABLE "Subsector" ADD CONSTRAINT "Subsector_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_subsectorId_fkey" FOREIGN KEY ("subsectorId") REFERENCES "Subsector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubsectorPrice" ADD CONSTRAINT "SubsectorPrice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubsectorPrice" ADD CONSTRAINT "SubsectorPrice_subsectorId_fkey" FOREIGN KEY ("subsectorId") REFERENCES "Subsector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationSeat" ADD CONSTRAINT "ReservationSeat_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationSeat" ADD CONSTRAINT "ReservationSeat_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationSeat" ADD CONSTRAINT "ReservationSeat_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The double-booking guard (IMPLEMENTATION_PLAN.md §4).
--
-- Prisma cannot express a partial unique index, so it is created here by hand.
-- `active` is true exactly while the owning reservation is PENDING (unexpired)
-- or CONFIRMED, and is flipped to false in the same transaction that
-- cancels/expires the reservation. Postgres then makes double-booking
-- IMPOSSIBLE at the storage layer, regardless of application bugs or races —
-- `createHold` relies on the resulting unique violation (23505) as its gate.
--
-- NOTE: this index is invisible to `prisma migrate diff`. Any future migration
-- that drops or rebuilds "ReservationSeat" must recreate it.
-- ---------------------------------------------------------------------------

-- CreateIndex (partial unique — hand-written, not generated)
CREATE UNIQUE INDEX "reservation_seat_active_uq"
  ON "ReservationSeat" ("eventId", "seatId")
  WHERE "active";
