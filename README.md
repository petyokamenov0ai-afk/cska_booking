# CSKA — Stadium seat booking

Per-match seat reservation for the **Bulgarian Army Stadium** (Стадион „Българска армия“).
Next.js 15 (App Router, TypeScript) · PostgreSQL + Prisma · SVG seat maps · guest
reservations with a 7-minute hold (no auth, no payments in v1).

Seat geometry is extracted from the A0 seat-numbering drawing (`SEATS_CSKA.pdf`)
by the pipeline in `scripts/pipeline/`, mirrored to `data/stadium.json`, and
seeded into Postgres.

---

## Requirements

- Node.js ≥ 20.9 (developed on 23.x)
- Docker (for the local Postgres)
- Python 3 + OpenCV only if you re-run the PDF pipeline (`.venv-pipeline/`)

## Run it

```bash
# 1. Postgres (postgres:16, db cska_booking, user/pass cska/cska, port 5432)
docker compose up -d

# 2. Environment — .env is already there for local dev; otherwise:
cp .env.example .env

# 3. Schema + generated Prisma client
npm run db:migrate          # or: npm run db:push for a throwaway DB

# 4. Seed geometry + a demo event
#    Uses data/stadium.json, falling back to data/stadium.sample.json.
npm run db:seed

# 5. Dev server → http://localhost:3000
npm run dev
```

If `data/stadium.json` does not exist yet (the PDF pipeline has not been run),
generate the synthetic fixture first — it satisfies `docs/DATA_CONTRACT.md`
exactly, so everything downstream works:

```bash
npm run pipeline:sample     # writes data/stadium.sample.json
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server on :3000 |
| `npm run build` / `npm start` | Production build / serve |
| `npm run lint` | ESLint (flat config, `next/core-web-vitals` + `next/typescript`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (unit + integration, `tests/**/*.test.ts`) |
| `npm run test:e2e` | Playwright (`e2e/**/*.spec.ts`, boots `npm run dev` itself) |
| `npm run db:push` | Push schema without a migration |
| `npm run db:migrate` | Create/apply a dev migration |
| `npm run db:seed` | `tsx prisma/seed.ts` — idempotent; never deletes reservations |
| `npm run pipeline:sample` | Regenerate `data/stadium.sample.json` |

Seeding after re-running the PDF pipeline: it samples each subsector's corner
seats and re-diffs automatically when their coordinates have moved, so a geometry
change lands without a flag. `npm run db:seed -- --refresh-geometry` forces a full
re-diff of all 16k seats, and `-- --dry-run` reports what would change.

Playwright browsers are not installed by `npm install` — run
`npx playwright install chromium` once before `npm run test:e2e`.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (matches `docker-compose.yml`) |
| `CRON_SECRET` | Shared secret for `POST /api/cron/expire` (`x-cron-secret` header) |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | `bg` (default) or `en` |

## Architecture in one screen

```
app/
  (public)/                     pages: events list, event overview + sector zoom,
                                subsector seat map, reservation confirmation
  api/                          route handlers (Node runtime — Prisma)
components/stadium/             OverviewMap, SectorZoom, SeatMap, Seat, Legend, BasketBar
lib/
  db.ts          singleton PrismaClient
  types.ts       the wire contract (DTOs) + stadium.json geometry types
  i18n.ts        t(locale, key, vars) — bg + en dictionaries
  stadium.ts     loads data/stadium.json (cached)
  availability.ts / reservations.ts / session.ts / rateLimit.ts / zodSchemas.ts
prisma/          schema.prisma, migrations/, seed.ts
data/            stadium.json, stadium.sample.json, stadium-overview.svg
scripts/pipeline/  PDF → seats (render, detect, cluster rows, number, QA, emit)
```

Two kinds of data, deliberately separated:

1. **Geometry** — seat x/y, subsector outlines, viewBoxes. Static, produced once
   by the pipeline, seeded into Postgres and mirrored as JSON for fast rendering.
2. **Availability** — who holds/reserved which seat for which event. Always read
   from Postgres, never cached beyond ~10 s.

**Reservations** are a single state machine (`PENDING → CONFIRMED | CANCELLED |
EXPIRED`); a hold *is* a `PENDING` reservation with `expiresAt`. Double booking
is impossible at the storage layer thanks to a partial unique index on
`ReservationSeat("eventId", "seatId") WHERE "active"`. Expiry is two-layer:
lazy (queries treat expired holds as free) plus a sweeper at
`POST /api/cron/expire`.

**UI** is a three-level drill-down: stadium overview → sector (SVG `viewBox`
zoom, `?sector=<cyrillic>`) → subsector seat map. Server state via TanStack
Query (seats poll every 7 s), basket in a Zustand store.

### Conventions that bite if ignored

- **Sector/subsector codes are Cyrillic**: `А1` is `U+0410`, *not* Latin `A1`.
  Always route on `code`, `encodeURIComponent` on the way out,
  `decodeURIComponent` on the way in. `latin` is display-only.
- **No money anywhere**: booking is free. Nothing carries a price, and every
  subsector of an `ON_SALE` event is sellable.
- **Times** are ISO 8601 UTC strings on the wire; `Date` stays server-side.

## The contracts (read these before changing anything shared)

- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — the spec: phases, data
  model, concurrency design, risks.
- [`docs/DATA_CONTRACT.md`](./docs/DATA_CONTRACT.md) — the exact shape of
  `data/stadium.json`, both coordinate spaces, and the pipeline invariants.
- [`docs/API_CONTRACT.md`](./docs/API_CONTRACT.md) — frozen DTOs, endpoint
  table, error codes and service-module signatures.
