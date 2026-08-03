# API & module contract

Frozen interfaces so the DB layer, route handlers and UI can be built
independently. Anything crossing a module boundary is defined here.
Implementation detail inside a module is free.

Runtime: Next.js App Router, route handlers under `app/api/**/route.ts`,
Node runtime (not edge — Prisma). All inputs validated with `zod`.

## Shared types — `lib/types.ts`

```ts
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
  mine: boolean;        // held by this browser session
  holder: string | null;// who the seat is for; null when free, blocked, or
                        // booked without a name. Public to every visitor.
  note: string | null;  // free text about this one seat; null when free,
                        // blocked, or booked without one. Gated exactly like
                        // `holder`, and public to every visitor too.
}

export interface SubsectorAvailabilityDTO {
  code: string;         // Cyrillic, e.g. "А1"
  latin: string;
  free: number;
  total: number;
}

export interface ReservationDTO {
  code: string;                 // e.g. "K7KQ2M"
  eventId: string;
  status: ReservationStatus;
  expiresAt: string | null;     // ISO
  createdAt: string;            // ISO
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
  error: string;                // machine code, e.g. "SEATS_TAKEN"
  message: string;              // human, English
  conflictSeats?: string[];     // seat ids, for 409 SEATS_TAKEN
  details?: unknown;            // zod flatten() output for 400
}
```

## Endpoints

| Method & path | Request | 2xx response |
|---|---|---|
| `GET /api/events` | – | `{ events: Array<{ id, title, kickoffAt, salesOpen, salesClose, status }> }` |
| `GET /api/events/:eventId/availability` | – | `{ eventId, subsectors: SubsectorAvailabilityDTO[], updatedAt }` — `Cache-Control: public, max-age=10` |
| `GET /api/events/:eventId/subsectors/:code/seats` | `code` is URL-encoded Cyrillic | `{ eventId, subsector: { code, latin, viewBox, width, height, rowCount, seatCount }, seats: SeatDTO[] }` — `Cache-Control: no-store` |
| `POST /api/seats/:seatId` | `{ name: string, note?: string }` — `name` 2..120 after normalisation, `note` 1..120 | `201 { seat: { seatId, row, number, subsectorCode } }` — `Cache-Control: no-store` |
| `DELETE /api/seats/:seatId` | – (no body) | `{ seatId, released: boolean }` — idempotent, `Cache-Control: no-store` |
| `POST /api/cron/expire` | header `x-cron-secret: $CRON_SECRET` | `{ expired: number }` |

The two seat routes are the click-to-book flow: one seat per request, booked
straight into `CONFIRMED`, released by `DELETE`. Both are **unauthenticated by
design** (`lib/booking.ts`) — anyone on the network may free anyone's seat, and
both captions are served to every visitor.

`name` and `note` share one normalisation, applied before validation: C0/C1
controls and the bidi overrides/isolates become **spaces** (never deletions, so
`"Иван\nПетров"` cannot become `"ИванПетров"`), runs of whitespace collapse, ends
are trimmed. `\p{Cf}` is deliberately kept so ZWJ survives and family emoji stay
intact; a value that would nevertheless render *nothing* (only zero-width
characters, combining marks, Hangul fillers …) is refused for `name` and treated
as absent for `note`.

A body that is absent, not JSON, or whose `name` fails that rule is `400
VALIDATION` — never a silent booking and never a 500. `note` is optional:
missing, blank and renders-as-nothing all store `NULL`, and only a value longer
than 120 characters after normalisation is a `400`.

Both fields are served to every visitor as `SeatDTO.holder` / `SeatDTO.note`,
and neither ever appears in the cached availability aggregate.

The reservation routes below are the match-day (hold → confirm) flow. They are
**not implemented** in the click-to-book build; `lib/reservations.ts` still
provides the service layer, so they can return without being redesigned.

| Method & path | Request | 2xx response |
|---|---|---|
| `POST /api/events/:eventId/reservations` | `{ seatIds: string[] }` (1..10) | `201 { reservation: ReservationDTO }` |
| `GET /api/reservations/:code` | – | `{ reservation: ReservationDTO }` |
| `PATCH /api/reservations/:code` | `{ name: string, email: string, phone?: string }` | `{ reservation: ReservationDTO }` |
| `DELETE /api/reservations/:code` | – | `{ reservation: ReservationDTO }` (status `CANCELLED`) |

### Error codes

| HTTP | `error` | When |
|---|---|---|
| 400 | `VALIDATION` | zod failure; `details` = `flatten()` |
| 404 | `NOT_FOUND` | unknown event / subsector / reservation code |
| 409 | `SEATS_TAKEN` | one or more seats already held/reserved; `conflictSeats` lists them |
| 409 | `INVALID_STATE` | e.g. confirming a CANCELLED/EXPIRED reservation |
| 410 | `EXPIRED` | hold expired before confirm |
| 422 | `SALES_CLOSED` | event not `ON_SALE`, or outside `salesOpen..salesClose` |
| 429 | `RATE_LIMITED` | rate limiter tripped; `Retry-After` header set |
| 500 | `INTERNAL` | unexpected |

## Service modules

### `lib/session.ts`
```ts
/** Reads the httpOnly `sid` cookie, creating one if absent. Server-only. */
export function getSessionId(): Promise<string>;
```

### `lib/availability.ts`
```ts
export function getSubsectorAvailability(eventId: string): Promise<SubsectorAvailabilityDTO[]>;
export function getSubsectorSeats(
  eventId: string, subsectorCode: string, sessionId: string,
): Promise<{ subsector: {...}; seats: SeatDTO[] } | null>;
```
Both treat `PENDING AND expiresAt < now()` as **free** (lazy expiry).

### `lib/reservations.ts`
```ts
export const HOLD_TTL_MS = 7 * 60 * 1000;
export const MAX_SEATS_PER_RESERVATION = 10;

export class SeatsTakenError extends Error { constructor(public conflictSeats: string[]) {...} }
export class InvalidStateError extends Error {}
export class SalesClosedError extends Error {}

export function createHold(args: {
  eventId: string; seatIds: string[]; sessionId: string;
}): Promise<ReservationDTO>;                    // throws SeatsTakenError / SalesClosedError

export function confirmReservation(args: {
  code: string; name: string; email: string; phone?: string;
}): Promise<ReservationDTO>;                    // throws InvalidStateError

export function cancelReservation(code: string): Promise<ReservationDTO>;
export function getReservation(code: string, sessionId?: string): Promise<ReservationDTO | null>;
export function expireStaleReservations(now?: Date): Promise<number>;
export function generateReservationCode(): string;  // 6 chars, Crockford-ish, no I/O/0/1
```

`createHold` must: verify sales window → insert reservation + seats in **one
transaction**, relying on the partial unique index as the gate → on unique
violation, expire exactly the stale blockers for those seats and **retry once**
→ if it still conflicts, throw `SeatsTakenError` with the losing seat ids.

### `lib/rateLimit.ts`
```ts
/** In-memory fixed-window limiter. Returns false when the caller is over budget. */
export function consume(key: string, limit: number, windowMs: number): boolean;
```

### `lib/stadium.ts`
```ts
/** Loads data/stadium.json, falling back to data/stadium.sample.json. Cached. */
export function loadStadium(): StadiumFile;              // shape per docs/DATA_CONTRACT.md
export function getSubsectorGeometry(code: string): SubsectorGeometry | null;
```

### `lib/i18n.ts`
```ts
export type Locale = 'bg' | 'en';
export const DEFAULT_LOCALE: Locale = 'bg';
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string;
```

## Routes (pages)

| Path | Level |
|---|---|
| `/` | events list |
| `/events/[eventId]` | overview + sector zoom (levels 1–2), `?sector=<cyrillic>` |
| `/events/[eventId]/subsectors/[code]` | seat map (level 3), `code` URL-encoded Cyrillic |
| `/reservations/[code]` | confirmation / lookup |

## Conventions

- Cyrillic subsector codes in URLs: always `encodeURIComponent` on the way out
  and `decodeURIComponent` on the way in. Never route on `latin`.
- No money anywhere: booking is free, so nothing carries a price and every
  subsector of an `ON_SALE` event is sellable.
- Times are ISO 8601 UTC strings on the wire; `Date` only inside the server.
- Client server-state via TanStack Query; basket selection in a Zustand store.
  Seats endpoint polls every 7 s and refetches on window focus.
