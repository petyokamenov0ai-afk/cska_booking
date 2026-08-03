# Unit + integration tests

`npx vitest run` (or `npm test`). Playwright owns the browser journey in `e2e/`
and is deliberately excluded from `vitest.config.ts`.

```
tests/
  helpers/db.ts                  harness: .env, connect, migrate, fixtures, clean slate
  reservations.race.test.ts      §10 race test — N=20 parallel holds on one seat
  reservations.expiry.test.ts    §5 three expiry layers, clock injected
  availability.test.ts           lib/availability.ts against a real Postgres
  stadium.contract.test.ts       docs/DATA_CONTRACT.md over data/stadium*.json (no DB)
```

## Running them

| Command | What runs |
|---|---|
| `docker compose up -d && npx vitest run` | everything |
| `npx vitest run` with no Postgres | `stadium.contract` + the pure unit tests; the rest **skip** with a loud banner and exit 0 |
| `npx vitest run tests/reservations.race.test.ts` | one file |
| `DATABASE_URL=… npx vitest run` | point at any Postgres you like |

**`DATABASE_URL` is read from `.env`** by `helpers/db.ts`. Vitest does not load
`.env`, and `@prisma/client` (unlike the Prisma CLI) never does, so without that
the integration suites would silently skip even with the database up. Anything
already in the environment wins, so CI can override.

The harness applies `prisma migrate deploy` if the schema is missing, so a fresh
`docker compose up -d` needs no other setup. It also re-creates
`reservation_seat_active_uq` if it has gone missing and shouts about it — see
below.

Postgres 14.19 and 16.10 both run the suite green.

## Why these are integration tests

The double-booking guard is a **partial unique index**:

```sql
CREATE UNIQUE INDEX reservation_seat_active_uq
  ON "ReservationSeat" ("eventId", "seatId") WHERE "active";
```

A mock cannot enforce it, so a mocked race test proves only that the mock is a
mock. Everything about concurrency here talks to a real server. That is also why
absence of Postgres is a **skip, not a pass**: a green run that quietly did not
test the guard is worse than a red one.

## What the suites assert

**`reservations.race`** — 20 simultaneous `createHold()` calls for the *same*
seat: exactly one wins, the other 19 get `SeatsTakenError` with
`conflictSeats = [thatSeat]`, and the database ends with one hold, one active row
and no duplicates. Then 12 overlapping baskets of 3 seats over a pool of 6: no
seat is ever held twice, winners' seat sets are pairwise disjoint, and the active
rows are *exactly* the winners' seats — i.e. losers rolled back whole rather than
leaving their non-conflicting seats stuck. Partial overlap reports only the lost
seat. Two events can hold the same seat independently (the guard is on
`(eventId, seatId)`).

The suite also proves the index itself, not just the application: a raw
`INSERT` of a second active row is rejected with SQLSTATE 23505, while any number
of *inactive* rows for the same seat is fine (released holds must not block the
seat for ever, and the audit trail has to survive).

> **Deadlock regression.** "Every loser fails with `SeatsTakenError`" is load
> bearing. `createMany` locks one index entry per seat in array order, so two
> overlapping baskets inserting shared seats in opposite orders form a lock cycle
> and Postgres kills one — a 500 for a user whose seats were free.
> `lib/reservations.ts` sorts the batch by seat id to make that impossible. A
> deadlock does *not* arrive as `SeatsTakenError`, so it fails these assertions.

**`reservations.expiry`** — the three layers of IMPLEMENTATION_PLAN §5:

1. *Lazy* — a lapsed hold reads `FREE` in both `getSubsectorSeats` and
   `getSubsectorAvailability`, and `getReservation` reports `EXPIRED`, while the
   row stays `PENDING`/`active` (reads must not write). The TTL boundary is
   pinned: 1 ms before expiry is `HELD`, at expiry it is `FREE`.
2. *Sweeper* — `expireStaleReservations` flips `status` and `active`, leaves live
   holds / `CONFIRMED` / `CANCELLED` alone, is idempotent, and honours `limit`
   (which is why `app/api/cron/expire` must loop until a batch comes back
   short — asserted here as 2, 2, 1).
3. *On conflict* — a second user **succeeds** on a seat whose blocker is dead
   (retry-once), never steals a live hold, and a basket mixing a dead and a live
   blocker reports only the live seat. Eight users racing for one dead-blocked
   seat still produce exactly one winner.

Plus confirm/cancel across the boundary, and the pure classifiers
(`classifyUniqueViolation`, `isRetryableTransactionError`,
`generateReservationCode`) which need no database.

**No test sleeps.** Every service function takes an injectable `now`; where a
hold must look stale *to the same clock* another call uses,
`forceExpiresAt()` rewrites `expiresAt`. Two tests deliberately use the
un-injected production clock so that path is covered too.

**`availability`** — one subsector carrying, simultaneously, seats that are
`CONFIRMED`, live `PENDING`, lapsed `PENDING`, `CANCELLED`-but-unswept,
`EXPIRED`-but-unswept, cleanly cancelled and `BLOCKED` (`Seat.active = false`).
`total` counts active seats only; `free` subtracts only the genuinely blocking
ones; and the seat list is cross-checked against the aggregate, because the
overview map and the seat map must never disagree. Also `mine` per session,
price propagation, header fields derived from the payload, unknown ids, and
`listEvents`.

> **Timezone regression.** `Reservation.expiresAt` is `timestamp WITHOUT time
> zone` holding UTC. Comparing it against a `timestamptz` makes Postgres
> reinterpret it in the *session* time zone, and every live hold reads as free.
> The mixed-state test fails immediately if that regresses — on a machine whose
> Postgres session zone is not UTC. This one runs `Europe/Sofia`; CI on a UTC
> container would **not** catch it, so keep at least one non-UTC run.

**`stadium.contract`** — no database. Runs `scripts/pipeline/validate.ts` as a
subprocess (it ends in `process.exit(main())`, so it cannot be imported) *and*
re-derives every invariant independently, one `it` per rule. Both layers matter:
the exit code alone says nothing about *which* rule broke, and a test that only
calls the validator cannot catch a bug in the validator. It runs over
`data/stadium.sample.json` and over `data/stadium.json` **when that exists**.

`docs/DATA_CONTRACT.md` splits its invariants into **fatal** and **advisory**
(the drawing genuinely violates a few), and this suite follows that split:
fatal ones are hard assertions; advisory ones assert the *budget* the contract
documents and print the offenders as `ADVISORY …` warnings. Today:

```
ADVISORY data/stadium.json: no row 1 in 3 subsector(s):
         Б6-2 (lowest row 5), Б11 (lowest row 2), Б11-2 (lowest row 4)
```

Those are QA-overlay items (IMPLEMENTATION_PLAN §3 step 5 / §10), not broken
data: `(subsector, row, seat)` stays unique, so booking is unaffected. If a
pipeline change makes any of them *worse*, the budget is exceeded and the suite
goes red.

## Test data, and what the harness leaves behind

Tests own their geometry: a Cyrillic sector `ТСТ` / subsector `ТСТ1` with 60
seats (5 rows × 12) and deterministic ids (`itest-seat-r3-n07`). So they neither
depend on `npm run db:seed` having run nor break when
`data/stadium.sample.json` changes, and a failing race test is reproducible seat
for seat.

`resetTestData()` runs before each test and deletes only
`Event WHERE id LIKE 'itest-%'`, which cascades to `Reservation` and
`ReservationSeat`; it also re-activates any test seat a test blocked. It is deliberately **not** `TRUNCATE`: geometry has to survive between
tests, and so must a developer's seeded demo events — pointing the suite at your
dev database must not empty it.

The `ТСТ`/`ТСТ1` geometry itself is created once per run and reused across the
four files. `tests/helpers/globalTeardown.ts` (wired in as `globalSetup` in
`vitest.config.ts`) deletes every `itest-`-prefixed row after the run, so a
completed run leaves the database exactly as it found it.

Two things follow from that:

- **While the run is in progress**, `GET /api/events/:id/availability` on the
  same database lists one extra subsector — `ТСТ1`, fully free. The maps key
  on geometry from `data/stadium.json`, so
  nothing renders it, but a raw API response shows it. Don't demo off the same
  database you are testing against.
- **If a run is killed** (Ctrl-C, crashed worker), the teardown does not fire and
  the fixture survives. Remove it with
  `DELETE FROM "Event" WHERE id LIKE 'itest-%'; DELETE FROM "Seat" WHERE id LIKE
  'itest-%'; DELETE FROM "Subsector" WHERE id LIKE 'itest-%'; DELETE FROM
  "Sector" WHERE id LIKE 'itest-%';` — or just let the next run recreate and
  clean it.

`prisma/seed.ts` never touches it — it only visits subsectors named in the
geometry file.

## Known noise

- **`prisma:error` blocks in the output.** `lib/db.ts` logs at the `error`
  level, and every *deliberately* lost race logs a `P2002` stack. Expected here
  and expected in production during a ticket rush; filtering `P2002` in
  `lib/db.ts` would quieten both.
- The suites share one Postgres, so `vitest.config.ts` pins
  `poolOptions.threads.singleThread`. Do not remove that without giving each file
  its own schema.
- The harness appends `connection_limit=30&pool_timeout=20` to `DATABASE_URL`
  (unless you set them yourself). 20 concurrent interactive transactions need
  more connections than Prisma's default `cpus * 2 + 1` on a small machine, and
  the failure mode otherwise is a pool timeout dressed up as a transaction error.
- `tests/helpers/globalTeardown.ts` imports `dotenv`, which is **not** a declared
  dependency — it resolves today only because `c12` (a Prisma/Tailwind
  transitive) happens to ship it. Since it runs as `globalSetup`, a hoisting
  change breaks the *whole* run, not just the cleanup. Either add `dotenv` to
  `devDependencies` or reuse the loader already in `tests/helpers/db.ts`.

## If `reservation_seat_active_uq` goes missing

`prisma migrate dev` may offer to drop it — a partial index is invisible to
Prisma's datamodel, so its drift check sees an unknown object. **Do not accept
that migration**; use `npm run db:deploy` (`prisma migrate deploy`), which never
touches it. The harness re-creates it if it is absent and prints a warning
naming the likely cause; the race suite then still proves it enforces.
