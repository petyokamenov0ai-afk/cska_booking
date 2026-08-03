/**
 * Shared types — the frozen wire/module contract.
 *
 * The first block is verbatim `docs/API_CONTRACT.md § Shared types`.
 * The second block is the geometry file shape from `docs/DATA_CONTRACT.md`.
 * The third block is response envelopes derived from the endpoint table in
 * `docs/API_CONTRACT.md § Endpoints` (no new fields — just names for the
 * objects the route handlers return, so clients and servers agree).
 *
 * Nothing here imports Prisma: these types describe JSON crossing a boundary,
 * not database rows.
 */

/* ------------------------------------------------------------------ *
 * API contract — shared types
 * ------------------------------------------------------------------ */

export type SeatType = 'STANDARD' | 'WHEELCHAIR' | 'COMPANION' | 'VIP';
export type SeatStatus = 'FREE' | 'HELD' | 'RESERVED' | 'BLOCKED';
export type EventStatus = 'DRAFT' | 'ON_SALE' | 'CLOSED';
export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

export interface SeatDTO {
  id: string;
  row: number;
  number: number;
  x: number;
  y: number;
  angle: number;
  type: SeatType;
  white: boolean;
  status: SeatStatus;
  mine: boolean; // held by this browser session
  /**
   * Who the seat is for. `null` when it is free or blocked, and also when it is
   * booked by one of the many reservations that carry no name — so the fallback
   * is the common case, not an edge.
   *
   * Required-and-nullable rather than optional on purpose: `JSON.stringify`
   * drops `undefined`, so absent-vs-null is exactly the distinction that would
   * rot across the wire. "Does this seat carry a reservation" is answered by
   * `status`, never by this field.
   *
   * Visible to every visitor, not just the holder — see the no-auth note in
   * `lib/booking.ts`. Pinned by tests/availability.test.ts so it reads as
   * deliberate.
   */
  holder: string | null;
  /**
   * Free text the booker attached to this one seat, or `null`. Gated exactly
   * like `holder`: never present on a FREE or BLOCKED seat, and never on a hold
   * the lazy-expiry rules read as lapsed — so a freed-but-unswept reservation
   * cannot leak the previous occupant's note.
   *
   * Required-and-nullable for the same reason as `holder`: `JSON.stringify`
   * drops `undefined`, and absent-vs-null is exactly the distinction that rots
   * across the wire.
   *
   * Bounded at 120 characters by `seatNoteSchema`. A longer value can only come
   * from a hand-written INSERT; it is clamped at render, never truncated here.
   * Public to every visitor, like the name, and — also like the name — never
   * carried by `SubsectorAvailabilityDTO`, whose response is cached and shared.
   */
  note: string | null;
  /**
   * The subsector this seat physically belongs to, present ONLY on the merged
   * grouped-corner responses (`lib/subsectorGroup.ts`), where seats from two or
   * three independently-numbered blocks share one canvas and `row`/`number`
   * pairs repeat. Optional rather than nullable: the single-subsector response
   * — the overwhelmingly common one — is byte-identical to what it was before
   * groups merged, and "which subsector" is already in that response's header.
   */
  block?: string;
}

export interface SubsectorAvailabilityDTO {
  code: string; // Cyrillic, e.g. "А1"
  latin: string;
  free: number;
  total: number;
}

export interface ReservationDTO {
  code: string; // e.g. "K7KQ2M"
  eventId: string;
  status: ReservationStatus;
  expiresAt: string | null; // ISO
  createdAt: string; // ISO
  name: string | null;
  email: string | null;
  phone: string | null;
  event: { id: string; title: string; kickoffAt: string };
  seats: Array<{
    seatId: string;
    subsectorCode: string;
    subsectorLatin: string;
    row: number;
    number: number;
  }>;
}

/** Every non-2xx response body. */
export interface ApiError {
  error: string; // machine code, e.g. "SEATS_TAKEN"
  message: string; // human, English
  conflictSeats?: string[]; // seat ids, for 409 SEATS_TAKEN
  details?: unknown; // zod flatten() output for 400
}

/** The machine codes from `docs/API_CONTRACT.md § Error codes`. */
export type ApiErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'SEATS_TAKEN'
  | 'INVALID_STATE'
  | 'EXPIRED'
  | 'SALES_CLOSED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

/* ------------------------------------------------------------------ *
 * Geometry — data/stadium.json (docs/DATA_CONTRACT.md)
 * ------------------------------------------------------------------ */

/** Overview-space coordinates (one shared space for the whole bowl). */
export interface Point {
  x: number;
  y: number;
}

/** A seat as produced by the PDF pipeline. Subsector-local coordinates. */
export interface SeatGeometry {
  row: number; // integer, as printed on the drawing
  number: number; // integer, as printed on the drawing
  x: number; // subsector-local, seat centre
  y: number;
  angle: number; // degrees, seat rotation (0 = upright)
  type: SeatType;
  white: boolean; // true = light "ЦСКА"-letter seat (В stand); cosmetic only
}

/** Per-row summary, for row labels and QA assertions. */
export interface RowGeometry {
  row: number;
  count: number;
  firstSeat: number;
  lastSeat: number;
}

/**
 * Which side of a block the pitch lies on — the side row 1 faces. Subsector-local
 * coordinates are the drawing's own orientation, so this varies by stand:
 * А (South) -> top, Б (East) -> left, В (North) -> bottom, Г (West) -> right.
 * Rows run horizontally for top/bottom and vertically for left/right.
 */
export type PitchSide = 'top' | 'bottom' | 'left' | 'right';

export interface SubsectorGeometry {
  code: string; // Cyrillic, unique across the stadium, e.g. "А1"
  latin: string; // "A1" — display / ASCII fallback only, never routed on
  order: number; // 1..22, drawing order
  viewBox: string; // subsector-local space, e.g. "0 0 1000 640"
  width: number;
  height: number;
  pitchSide: PitchSide;
  svgPath: string; // outline, OVERVIEW space, closed path
  centroid: Point; // overview space, for labels
  /**
   * Presentation only. Cyrillic code of the overview **block** this subsector is
   * DRAWN as part of. Present iff the block covers more than one subsector,
   * absent for the 20 drawn 1:1. The value is always the `code` of one of the
   * block's own members, in the same sector, and every member carries the same
   * value AND a byte-identical `svgPath` + exactly-equal `centroid`.
   *
   * The overview draws one shape per distinct `overviewGroup ?? code` — 22 shapes
   * over 25 subsectors, because the printed ticket map draws two corners whole
   * where we hold 2 and 3 blocks (Б6 ← Б6, Б6-2 · Б11 ← Б10-2, Б11, Б11-2).
   *
   * Never a routing, booking or seat-map key: `/subsectors/Б11-2` and its level-3
   * seat map are unaffected, `stats.subsectorCount` stays 25, and the level-2 card
   * list still lists all of them. A consumer that ignores this field draws the
   * correct polygon two or three times over — identical pixels, no gap.
   */
  overviewGroup?: string;
  seatCount: number;
  rowCount: number;
  rows: RowGeometry[];
  seats: SeatGeometry[];
}

export interface SectorGeometry {
  code: string; // Cyrillic: "А" | "Б" | "В" | "Г"
  latin: string; // "A" | "B" | "V" | "G"
  name: string; // English, e.g. "South"
  nameBg: string; // Bulgarian, e.g. "Юг"
  order: number; // 1..4, А Б В Г
  subsectors: SubsectorGeometry[];
}

export interface StadiumOverviewGeometry {
  width: number;
  height: number;
  viewBox: string;
  pitch: string; // SVG path of the pitch, overview space
}

export interface StadiumStats {
  seatTotal: number;
  subsectorCount: number;
}

/** The whole of `data/stadium.json`. */
export interface StadiumFile {
  generatedAt: string; // ISO
  source: string; // e.g. "SEATS_CSKA.pdf"
  overview: StadiumOverviewGeometry;
  stats: StadiumStats;
  sectors: SectorGeometry[];
}

/* ------------------------------------------------------------------ *
 * Response envelopes (endpoint table)
 * ------------------------------------------------------------------ */

/** `GET /api/events` row. */
export interface EventListItemDTO {
  id: string;
  title: string;
  kickoffAt: string; // ISO
  salesOpen: string; // ISO
  salesClose: string; // ISO
  status: EventStatus;
}

export interface EventsResponse {
  events: EventListItemDTO[];
}

export interface AvailabilityResponse {
  eventId: string;
  subsectors: SubsectorAvailabilityDTO[];
  updatedAt: string; // ISO
}

/** The subsector header returned alongside a seat list. */
export interface SubsectorMeta {
  code: string;
  latin: string;
  viewBox: string;
  width: number;
  height: number;
  rowCount: number;
  seatCount: number;
  /**
   * Which side the pitch is on. Not a database column — it is a property of the
   * geometry, so it is read from `data/stadium.json` via `lib/stadium.ts` and
   * falls back to `'top'` if the file has no entry for this subsector.
   */
  pitchSide: PitchSide;
}

export interface SubsectorSeatsResponse {
  eventId: string;
  subsector: SubsectorMeta;
  seats: SeatDTO[];
}

/** `POST /api/events/:eventId/reservations`, `GET|PATCH|DELETE /api/reservations/:code`. */
export interface ReservationResponse {
  reservation: ReservationDTO;
}

export interface CronExpireResponse {
  expired: number;
}

/* ------------------------------------------------------------------ *
 * Request bodies
 * ------------------------------------------------------------------ */

export interface CreateReservationBody {
  seatIds: string[]; // 1..10
}

/** `POST /api/seats/:seatId` */
export interface BookSeatBody {
  name: string; // 2..120 after normalisation
  note?: string; // 1..120 after normalisation; absent === no note
}

export interface ConfirmReservationBody {
  name: string;
  email: string;
  phone?: string;
}
