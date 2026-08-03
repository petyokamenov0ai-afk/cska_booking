# CSKA Stadium Seat Booking — Implementation Plan

**Stack:** Next.js (App Router, TypeScript) · PostgreSQL + Prisma · SVG seat maps
**Booking model:** per match/event · v1 = guest reservations (no auth, no payments — roadmapped)
**Source of truth for the layout:** `22142-AR-SEATS NUMBERING-R01.pdf` (Bulgarian Army Stadium seat-numbering drawing, A0, vector)

---

## 1. What the drawing contains (analysis results)

The PDF is a CAD-exported vector plan of the whole bowl. Findings that drive the design:

- **Hierarchy on the drawing:** 4 stands, labeled with Cyrillic/Latin pairs, containing 22 uniquely numbered subsectors:
  - **А (A) — South:** А1–А5
  - **Б (B) — East:** Б6–Б11
  - **В (V) — North:** В12–В16 (contains the "ЦСКА" letters drawn in light-colored seats)
  - **Г (G) — West:** Г17–Г22
  In the app we use the user-facing terms **Sector** (А/Б/В/Г) → **Subsector** (А1…Г22), matching the drawing's own labels.
- **Numbering scheme:** every seat carries a *row number* + *seat number*; seat numbers restart each row, rows are numbered within a subsector (verified on 600 DPI zoom of А1/А2).
- **Scale:** roughly **12,000 seat glyphs** detected by color analysis at 200 DPI; expect **~13–15k total** once light "ЦСКА"-letter seats and special positions are included. Exact counts fall out of Phase 1.
- **Special positions:** wheelchair spaces along the front promenade with companion platforms next to them; camera platforms and the players' tunnel create gaps (non-seats); corner subsectors are curved (rows follow arcs, not straight lines).
- **Extraction constraint (verified):** seat numbers are **drawn as raw vector paths, not text** — `pdftotext` returns only the 22 subsector labels and grid axes; the page is a single ~147 MB flat content stream with no reusable XObjects. So seat data must be extracted via **high-DPI rendering + image detection**, not text/structure parsing. Color-blob detection was validated and works well (seats are saturated red on a white/grey background).
- Page is stored rotated 90° (A0 portrait, rendered landscape) — the pipeline must normalize orientation.

---

## 2. Architecture overview

```
┌────────────────────────────── Next.js (App Router) ──────────────────────────────┐
│  UI (React, SVG maps)                    Route handlers (/app/api/…)             │
│  /events/[id]            overview   ───▶ GET  availability (per subsector)      │
│  /events/[id]/[sector]   stand view ───▶ GET  subsector seats + statuses        │
│  /events/[id]/[sector]/[sub] seats  ───▶ POST reservations (hold w/ TTL)        │
│  basket + contact form              ───▶ PATCH confirm / DELETE cancel          │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ Prisma
        ┌───────▼────────┐        ┌──────────────────────────────┐
        │  PostgreSQL     │        │  Static geometry assets      │
        │  seats, events, │        │  stadium.json + overview SVG │
        │  reservations   │        │  (produced by the pipeline)  │
        └────────────────┘        └──────────────────────────────┘
```

Two kinds of data are deliberately separated:

1. **Geometry** (seat x/y, subsector outlines, viewBoxes) — static, produced once by the PDF pipeline, stored in the DB and mirrored as JSON for fast map rendering. Changes only if the stadium changes.
2. **Availability** (who holds/reserved which seat for which event) — dynamic, always read from Postgres.

---

## 3. Phase 1 — Seat-data pipeline (PDF → database)

The riskiest, most valuable phase; everything else is standard web work. Scripts live in `scripts/pipeline/`, runnable end-to-end with one command, idempotent.

**Step 1 — Render.** `pdftoppm` crops per subsector at 400–600 DPI (full page at 600 DPI is ~28k×20k px — render per-subsector windows instead; a small manifest maps each subsector code to its crop rectangle, hand-measured once from a 150 DPI overview).

**Step 2 — Detect seats (OpenCV, Python).** HSV mask for the two red seat tones → contours → per-seat centroid + bbox. Seat glyphs are ~150 px blobs at 200 DPI, cleanly separable. Special handling: light "ЦСКА"-letter seats on В12–В16 (template match / relaxed threshold within known letter regions), wheelchair symbols (distinct glyph → `type=WHEELCHAIR`), companion platforms (`type=COMPANION`), camera platforms & voids excluded.

**Step 3 — Cluster rows.** Straight stands: group by y with tolerance. Corner subsectors (А1, А5, Б6, Б11, В16, Г17, Г22…): fit per-row arcs — cluster by nearest-neighbor chains along the seat pitch, not global y. Output: ordered rows, ordered seats within row.

**Step 4 — Assign numbers.** Apply the drawing's scheme (seat numbers restart per row; rows numbered within subsector). Direction (left→right vs right→left, row 1 at front vs back) is confirmed per stand against 600 DPI zooms before bulk assignment — this is a config flag per subsector, not a guess.

**Step 5 — QA overlay.** A throwaway local HTML page renders detected seats (with row/seat labels) on top of the rasterized drawing at adjustable opacity. Every subsector gets eyeballed; misdetections are fixed via a `patches.json` (add/remove/move/renumber) that the pipeline applies last. Assertions: no duplicate (subsector,row,seat), no orphan seats, per-subsector counts within expected range.

**Step 6 — Emit.** `stadium.json` + Prisma seed:

```jsonc
{
  "sectors": [{
    "code": "А", "latin": "A", "name": "South",
    "subsectors": [{
      "code": "А1", "latin": "A1", "viewBox": "0 0 1000 640",
      "outline": "M 12 630 L …",            // auto: padded hull of its seats
      "seats": [
        { "row": 1, "number": 1, "x": 14.2, "y": 612.8, "type": "STANDARD" }
      ]
    }]
  }]
}
```

**Overview map:** subsector outlines are auto-generated (padded concave hull of each subsector's seats, projected to one shared stadium coordinate space), assembled into a single `stadium-overview.svg` with `id`s matching subsector codes; pitch/roof decoration traced once by hand in Inkscape. Hulls beat hand-tracing 22 shapes and stay consistent with the seat data.

**Fallback:** if any subsector resists detection, it's small enough to hand-author in `patches.json` — the pipeline degrades gracefully to partial manual entry without changing anything downstream.

---

## 4. Data model (Prisma / Postgres)

```prisma
model Sector {        // А, Б, В, Г
  id         String      @id @default(cuid())
  code       String      @unique          // "А"
  latin      String                       // "A"
  name       String                       // "South"
  order      Int
  subsectors Subsector[]
}

model Subsector {     // А1 … Г22
  id       String  @id @default(cuid())
  sectorId String
  code     String  @unique               // "А1"
  latin    String                        // "A1"
  viewBox  String                        // local seat-map coordinates
  svgPath  String                        // outline in overview coordinates
  order    Int
  sector   Sector  @relation(fields: [sectorId], references: [id])
  seats    Seat[]
}

model Seat {
  id          String    @id @default(cuid())
  subsectorId String
  row         Int
  number      Int
  x           Float                     // subsector-local coords
  y           Float
  type        SeatType  @default(STANDARD)
  active      Boolean   @default(true)  // false = killed/blocked seat
  subsector   Subsector @relation(fields: [subsectorId], references: [id])
  @@unique([subsectorId, row, number])
}

model Event {
  id         String   @id @default(cuid())
  title      String                     // "CSKA – Levski"
  kickoffAt  DateTime
  salesOpen  DateTime
  salesClose DateTime
  status     EventStatus @default(DRAFT) // DRAFT | ON_SALE | CLOSED
  prices     SubsectorPrice[]
}

model SubsectorPrice {
  eventId     String
  subsectorId String
  priceCents  Int
  @@id([eventId, subsectorId])
}

model Reservation {
  id        String   @id @default(cuid())
  code      String   @unique            // human code, e.g. "K7KQ2M" — lookup/cancel key
  eventId   String
  status    ReservationStatus @default(PENDING) // PENDING|CONFIRMED|CANCELLED|EXPIRED
  name      String?
  email     String?
  phone     String?
  totalCents Int
  expiresAt DateTime?                   // set while PENDING (hold TTL)
  createdAt DateTime @default(now())
  sessionId String                      // anonymous cookie id — marks "my" holds
  seats     ReservationSeat[]
}

model ReservationSeat {
  id            String  @id @default(cuid())
  reservationId String
  eventId       String                  // denormalized for the uniqueness guard
  seatId        String
  priceCents    Int
  active        Boolean @default(true)  // maintained with reservation status
  reservation   Reservation @relation(fields: [reservationId], references: [id])
}

enum SeatType { STANDARD WHEELCHAIR COMPANION VIP }
enum EventStatus { DRAFT ON_SALE CLOSED }
enum ReservationStatus { PENDING CONFIRMED CANCELLED EXPIRED }
```

**The double-booking guard** — a partial unique index (raw SQL migration; Prisma can't express it, which is fine):

```sql
CREATE UNIQUE INDEX reservation_seat_active_uq
  ON "ReservationSeat" ("eventId", "seatId")
  WHERE "active";
```

`active` is true exactly while the owning reservation is PENDING (unexpired) or CONFIRMED, and is flipped false in the same transaction that cancels/expires the reservation. Postgres then makes double-booking *impossible at the storage layer*, regardless of application bugs or race conditions.

---

## 5. Reservation lifecycle & concurrency

```
select seats ──▶ POST /reservations          PENDING, expiresAt = now()+7min
                     │  (tx: insert reservation + seats; unique index is the gate)
                     ├─ unique violation ──▶ expire stale blockers, retry once,
                     │                        else 409 + list of lost seats
confirm form ──▶ PATCH /reservations/:code   name/email/phone → CONFIRMED, expiresAt=null
timeout      ──▶ sweeper / lazy expiry       PENDING past expiresAt → EXPIRED, seats active=false
cancel       ──▶ DELETE /reservations/:code  CANCELLED, seats active=false
```

Details that make this correct:

- **Hold = pending reservation.** No separate hold table; one state machine. UI shows a 7:00 countdown after seat selection.
- **Expiry is two-layer.** (1) *Lazy:* every availability/seat query treats `PENDING AND expiresAt < now()` as free. (2) *Sweeper:* a cron route (`/api/cron/expire`, every minute — Vercel Cron or node-cron) flips them to EXPIRED and clears `active`, because an expired-but-uncleaned row still physically blocks the unique index. (3) *On conflict:* the insert path, upon unique violation, first tries to expire exactly the stale blockers for the requested seats and retries once — so a user is never told "taken" because of a dead hold.
- **Limits:** max 10 seats per reservation; basic IP + session rate limiting on the reservation endpoints to prevent seat-hoarding.
- **Guest identity:** httpOnly cookie with a random `sessionId`; used to render "your held seats" and to let the same visitor resume/cancel their pending reservation. Reservation `code` is the durable public handle (confirmation page, lookup, cancellation).

---

## 6. API surface (route handlers)

| Method & path | Purpose |
|---|---|
| `GET /api/events` | List events on sale |
| `GET /api/events/:id/availability` | Free/total per subsector (drives overview & sector coloring). Cached ~10 s |
| `GET /api/events/:id/subsectors/:code/seats` | Seat list with status: `FREE · HELD · RESERVED · BLOCKED` (+ `mine` flag) |
| `POST /api/events/:id/reservations` | Body `{ seatIds[] }` → creates PENDING hold, returns `code`, `expiresAt`, prices |
| `PATCH /api/reservations/:code` | Add contact details → CONFIRMED |
| `DELETE /api/reservations/:code` | Cancel (also releases a pending hold when user empties basket) |
| `GET /api/reservations/:code` | Lookup for the confirmation/"my reservation" page |
| `POST /api/cron/expire` | Sweeper (secured by secret header) |

All inputs validated with `zod`; errors are structured (`409 { conflictSeats: [...] }` so the UI can un-select exactly the lost seats and show a toast).

---

## 7. Frontend — the three-level drill-down

This is the core UX requirement: ~14k seats can't render (or make sense) on one screen, so each level shows only what fits comfortably.

**Level 1 — Stadium overview** (`/events/[id]`)
`stadium-overview.svg` inlined as a React component: pitch in the middle, 22 subsector shapes grouped by sector. Each subsector is filled on an availability scale (e.g. green→amber→grey by % free, from the cached availability endpoint) with its code label (А1 / A1 — dual Cyrillic/Latin, as on the drawing). Clicking anywhere in a sector (or its edge label А/Б/В/Г) animates the SVG `viewBox` to zoom into that stand — no route change needed for the intermediate level.

**Level 2 — Sector (stand) view** (same page, zoomed state, `?sector=А` in the URL for shareability)
The zoomed stand shows its 5–6 subsectors large and tappable, each with free-seat count and price. Breadcrumb `Overview → Sector А`. Clicking a subsector navigates to level 3.

**Level 3 — Subsector seat map** (`/events/[id]/subsectors/[code]`)
Renders that subsector's seats (≈400–1,200 nodes — plain SVG is comfortably fast, no canvas/virtualization needed) from static geometry, with statuses merged in from the seats endpoint via TanStack Query (poll every ~7 s + refetch on focus/before confirm). Interactions:

- pan/pinch/wheel zoom (`react-zoom-pan-pinch` or hand-rolled viewBox math); on mobile, seat taps only register above a zoom threshold so fat-finger picks don't happen
- hover/tap tooltip: `Row 4 · Seat 12 · 20 лв`
- click toggles selection (optimistic); wheelchair seats rendered with the ♿ glyph, not color alone
- row numbers rendered at row ends (they're real data, so labels are exact)
- sticky basket bar: selected seats, total, countdown once held, **Continue** → contact form (name, email, phone) → confirmation screen with the reservation code (also emailed later, when email infra lands on the roadmap)

**Seat states:** `FREE` (red/brand color), `SELECTED` (highlight), `HELD` by others (grey, disabled), `RESERVED` (dark, disabled), `BLOCKED/inactive` (not rendered or ghosted). Legend fixed on screen. Availability changes arriving via polling reconcile with local selection; if a selected seat becomes taken, it's dropped with an explanatory toast.

**Stack details:** Tailwind (+ shadcn/ui for forms/dialogs), TanStack Query for server state, small Zustand store for the basket, `next/font` with a font that renders Cyrillic well. i18n (bg/en) is structured-in via a tiny dictionary from day one — the drawing itself is bilingual — full translation later.

---

## 8. Project structure

```
app/
  (public)/
    page.tsx                       // events list
    events/[eventId]/page.tsx      // overview + sector zoom (levels 1–2)
    events/[eventId]/subsectors/[code]/page.tsx // seat map (level 3)
    reservations/[code]/page.tsx   // confirmation / lookup
  api/                             // route handlers from §6
components/
  stadium/OverviewMap.tsx  SectorZoom.tsx  SeatMap.tsx  Seat.tsx  Legend.tsx  BasketBar.tsx
lib/
  db.ts  availability.ts  reservations.ts  session.ts  rateLimit.ts  zodSchemas.ts
prisma/
  schema.prisma  migrations/  seed.ts      // seeds from data/stadium.json
data/
  stadium.json  stadium-overview.svg  patches.json
scripts/pipeline/
  00_manifest.json  01_render.sh  02_detect.py  03_rows.py  04_number.py
  05_qa_overlay/  06_emit.ts
docker-compose.yml                 // postgres:16 for local dev
```

---

## 9. Phases & milestones

| Phase | Deliverable | Est. |
|---|---|---|
| **0. Scaffold** | create-next-app, Prisma + Dockerized Postgres, CI (lint, typecheck, test), deploy skeleton | 0.5 d |
| **1. Seat pipeline** | `stadium.json` + overview SVG + seeded DB, QA-verified counts per subsector | 2–4 d |
| **2. Map UI** | Levels 1–3 rendering real geometry with mock statuses; mobile pan/zoom | 2–3 d |
| **3. Reservations** | Holds with TTL, confirm/cancel/lookup, conflict handling, sweeper, rate limits | 2 d |
| **4. Polish** | Polling reconciliation, empty/error/sold-out states, legend & a11y pass, event list | 1–2 d |
| **5. Deploy** | Vercel (or Node host) + Neon/Supabase Postgres, cron, prod seed, load sanity check | 0.5–1 d |

**Post-v1 roadmap** (in likely order): email confirmations with QR codes → admin panel (events, prices, seat blocking, reservation search/export) → auth (reservations tied to accounts) → online payments (Stripe Checkout; state machine gains `PENDING_PAYMENT`, confirmed by webhook — the partial-index guard already supports this unchanged) → season tickets (long-lived reservations spanning events) → SSE/Realtime seat updates replacing polling.

---

## 10. Testing & verification

- **Pipeline QA (most important):** overlay eyeball pass per subsector + automated assertions — unique (subsector,row,seat), monotonic numbering within rows, per-subsector count ranges, zero seats outside outline hulls.
- **Race test:** integration test firing N parallel reservation attempts for the same seat against a real Postgres — asserts exactly one succeeds (proves the index + retry path).
- **Expiry tests:** unit tests for lazy-expiry filtering and the on-conflict stale-blocker path (clock injected).
- **E2E (Playwright):** drill-down journey overview → А → А1 → select 2 seats → hold countdown visible → confirm → code shown; second browser sees the seats as taken.
- **Load sanity:** k6/autocannon on availability + seats endpoints with realistic polling to size the cache TTLs.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Detection errors in odd areas (letters on В-stand, curved corners, wheelchair rows) | QA overlay + `patches.json` manual overrides; worst case a subsector is hand-entered without affecting anything downstream |
| Wrong numbering direction in some subsector | Per-subsector direction flags verified against 600 DPI zooms before seeding; spot-check rows against the drawing during QA |
| Dead holds blocking seats | Two-layer expiry + on-conflict stale-blocker cleanup (§5) |
| Seat-hoarding by one visitor | 10-seat cap, hold TTL, IP/session rate limits |
| Availability polling load at ~15k seats | Per-subsector aggregate endpoint is one indexed GROUP BY; 10 s cache; seats endpoint scoped to one subsector only |

---

*Prepared 2026-07-30 from the R01 seat-numbering drawing. First concrete step: Phase 0 scaffold + pipeline Step 1 render manifest — both can start immediately.*
