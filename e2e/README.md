# End-to-end tests (Playwright)

Three specs. The basket / hold / confirm journey the previous version of this
table described was deleted with the match-day model — `drilldown.spec.ts` and
`concurrency.spec.ts` no longer exist, and booking is now one click plus a
naming dialog.

| Spec | What it proves |
|---|---|
| `booking.spec.ts` | The drill-down and the round trip: home (level 1) → **sector А** (level 2, no route change) → **subsector А1** (level 3) → click a free seat → **the naming dialog** → booked as `MINE`, with the holder in the seat's *accessible name* → click your own seat → released, **with no dialog**. Plus a second browser context: another session sees the seat as `RESERVED`, non-selectable, and — deliberately — carrying the holder's name. |
| `seatName.spec.ts` | The dialog itself: the note field (optional, bounded at 120, Enter submits, invisible-only input is not a note), name validation, **every** dismissal path booking nothing and leaving no residue, double submit, the seat being lost mid-typing, and standing regression tests for **D1** (a reopen swallowed by a stale `close` event, 30 laps) and **D2** (the page scrolling behind the modal). |
| `seat-touch.spec.ts` | **D3** on an emulated Pixel 7: one tap on an occupied seat names the holder, and the fat-finger guard is still in place for a free one. |

---

## Running them

They need a server **and** a seeded database. Nothing is mocked.

```bash
# 1. database
docker compose up -d            # or any Postgres matching DATABASE_URL
npm run db:deploy               # prisma migrate deploy  (NOT migrate dev — see prisma/README notes)
npm run db:seed                 # 22+ subsectors, ~16k seats, 1 ON_SALE + 1 DRAFT event

# 2. browser binary (once per machine)
npx playwright install chromium

# 3. the suite — `playwright.config.ts` starts `npm run dev` for you
npm run test:e2e

# …or point it at a server you already have (faster, and what CI should do):
npm run build && npm start &
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
```

Useful variants:

```bash
npx playwright test e2e/seatName.spec.ts         # one file
npx playwright test --headed --project=chromium  # watch it click
npx playwright test e2e/seatName.spec.ts -g D1 --repeat-each=3   # D1 is a RACE test:
                                                 # one green run is not evidence
npx playwright show-report                       # after a CI-style run
```

### What the suite writes to your database

Every spec books real seats. Each records the seat id and releases it
(`DELETE /api/seats/:id`) in an `afterEach` — or `afterAll` for the one seat
`seat-touch.spec.ts` books from a foreign session — so the suite is re-runnable
indefinitely against the same seed. A hook rather than an in-test `finally` is
deliberate: a test timeout tears the fixtures down before a `finally` would run.
`page.request.delete` shares the page context's cookie jar, so it releases as the
session that booked; DELETE is idempotent, so releasing twice is harmless.

The ledger to check before and after a run — it must come back to where it
started:

```sql
SELECT count(*) FROM "ReservationSeat" WHERE active;   -- 115 on the dev seed
SELECT count(*) FROM "Reservation" r
  JOIN "ReservationSeat" rs ON rs."reservationId" = r.id
 WHERE rs.active AND r.name IS NOT NULL;               -- 0
```

**Never point the suite at production.**

---

## Locator policy

In priority order, and enforced by review rather than tooling:

1. **Accessible role + accessible name** — `getByRole('button', { name: 'Продължи' })`,
   `getByRole('heading', { level: 1, name: … })`, `getByLabel('Имейл (задължително)')`.
   Half of these assertions double as an a11y test: if the name changes or
   disappears, a screen-reader user lost something too.
2. **The semantic data-attributes the seat map already exposes.** These are part
   of the component contract, not styling, and the specs depend on them:
   `data-seat-id`, `data-seat-state` (`FREE|SELECTED|MINE|HELD|RESERVED|BLOCKED`),
   `data-seat-selectable`, `data-sector`, `data-subsector`. **Please do not rename
   or drop them.**
3. **`getByTestId('x').or(<accessible fallback>)`** for the handful of nodes with
   no good role: the fallback works against the app as it ships today, and the
   moment the `data-testid` below is added *to the same element* the union
   resolves through it instead. Nothing to change here when they land.

Never a CSS class, never `nth-child`, never a Tailwind utility.

### The `data-testid`s that ship, and why each one earns its place

Rule 3 is a *last* resort, so every id below carries the reason role+name was not
enough. The rows for `app/reservations/[code]/*`, `components/EventCard.tsx` and
`BasketBar.tsx` are gone with the files and the flow they described.

| File | Element | `data-testid` | Why role + name is not enough |
|---|---|---|---|
| `app/subsectors/[code]/SeatNameDialog.tsx` | the `<dialog>` | `seat-name-dialog` | It has no accessible name of its own — `aria-labelledby` points at the `<h2>` — and its ✕ button's name `Затвори` is `common.close`, **shared with every visible toast**: a measured 3-element strict-mode violation. This id is what makes every other dialog locator unambiguous, by scoping. |
| `app/subsectors/[code]/SeatNameDialog.tsx` | the name `<input>` | `seat-name-input` | `Име` is a prefix of `Имейл` elsewhere in the app; the id survives the label gaining a suffix. |
| `app/subsectors/[code]/SeatNameDialog.tsx` | the note `<textarea>` | `seat-note-input` | Its accessible name is `Допълнителна информация (по избор)` — the only label on the page with a parenthetical modifier, exactly the kind of copy an i18n review rewrites. A prefix-anchored `getByLabel` would then silently match nothing. |
| `app/subsectors/[code]/SeatNameDialog.tsx` | the submit `<Button>` | `seat-name-submit` | `Резервирай` is copy that will change before the element does, and the success toast `Резервирано за …` already shares its stem. |
| `components/stadium/SeatTooltip.tsx` | the positioner `<div>` | `seat-tooltip` | The bubble is `aria-hidden="true"` **by design** (the same text is already in each seat's accessible name), so it has no role and no accessible name at all. There is no policy-legal alternative, and it is the only way to assert that the note actually reaches a sighted mouse user. |
| `components/ui/Toast.tsx` | the toast card | `toast` | `getByText(<message>)` couples every assertion to a full copy string. |

If any of these change the element they sit on, grep the specs for the id.

---

## Things that bit us, so they don't bite you

Every item here was found by actually running the suite, not by reading the code.

- **A held seat is `aria-disabled="true"`, and Playwright honours that.**
  `elementState('enabled')` resolves through `aria-disabled`, so a plain
  `locator.click()` on a held seat waits for it to become enabled — forever. The
  spec asserts `expect(seat).toBeDisabled()` (a real ARIA assertion) and then
  clicks with `{ force: true }`, because the point is that *the app* refuses the
  pick, not that the harness refuses to deliver it.
- **`use.actionTimeout` is now `15_000`** in `playwright.config.ts` (it used to be
  0, i.e. wait forever, which turned the bug above into a whole-test timeout
  reported against the wrong line). Specs no longer need to pass `{ timeout }` on
  every action — only where they are waiting for the 7 s poll.
- **Two `next dev` servers corrupt `.next/static` exactly like the documented
  dev/start pair below.** A second dev server takes the next free port and
  silently rewrites `.next` under the first, which then 404s its own JS chunks.
  The symptom is that the page renders but *every click does nothing*, and it
  misreports as a locator failure — half an hour, twice. `pkill -f 'next dev'`
  and start exactly one server before any run. The same applies after a Prisma
  migration: a server started before `prisma generate` is holding a client that
  does not know the new column, and every write through it 500s.
- **`seat.focus()` does not decide which seat `Enter` activates.** `SeatMap`'s
  keydown handler activates `activeSeatId ?? nav.firstId`, and `activeSeatId` is
  set only by the arrow keys or a previous activation — so Tab-then-Enter always
  activates the *first* seat in the map, not the focused one. Target the roving
  seat (`[data-seat-id][tabindex="0"]`) or drive with `ArrowRight` first.
- **The D1 race window closes in under 16 ms, so its regression test must be
  keyboard-only.** `Enter → Escape → Enter` with no waits reproduced the dropped
  reopen 36/40 times on the old code; the identical loop driven by
  `page.mouse.click` reproduced it **0/10**, because Playwright's click (move,
  down, up) is itself slow enough to drain the task queue that delivers the
  stale `close` event. A mouse-driven version of that test would be green
  against the bug. It is also a race test, so run it `--repeat-each=3`.
- **`zoomIn()` was never needed for mouse clicks** and has been deleted. The
  fat-finger guard keys on `pointerType !== 'mouse'`, so a mouse books at any
  zoom; the old helper also matched `/увелич|zoom in/i` against a button really
  labelled `Приближи`, i.e. neither locale. Zoom only matters in
  `seat-touch.spec.ts`, where the guard actually applies.
- **Clicks need hydration; the seat HTML does not.** Seats are server-rendered,
  so `toBeVisible()` proves nothing about interactivity. `useSeats` runs with
  `staleTime: 0` and therefore refetches the instant it mounts — the specs wait
  for that `GET …/subsectors/:code/seats` as a precise "this map is hydrated"
  signal. On the overview map there is no such signal (its query starts from
  `initialData`), so the sector click is wrapped in a `toPass()` retry; the
  target chosen for it (a subsector shape in a not-yet-focused stand) is
  *idempotent*, so a retry can never over-shoot into level 3.
- **The page header is `sticky` and `BasketBar` is `position: fixed`.** A seat
  scrolled under either cannot be clicked ("does not receive pointer events").
  Both specs use a tall viewport (1280×1100) and pick seats from the **middle**
  of the map for that reason.
- **The hover tooltip follows the pointer.** It renders above the hovered seat,
  so it does not cover it — but if `SeatTooltip`'s offset ever changes, expect
  intercepted-pointer-event failures on seat clicks.
- **`prisma:error … Unique constraint failed on (eventId, seatId)` in the server
  log during the race test is the expected outcome**, not a failure: it is the
  partial unique index `reservation_seat_active_uq` doing its job. `lib/db.ts`
  logs every lost race at error level (already flagged by the services agent).
- **Rate limits are per process and, on localhost, per *shared* bucket.**
  `clientIp()` returns `'unknown'` without an `x-forwarded-for` header, so every
  local caller shares one bucket: `POST /reservations` is 30/min for the whole
  machine. This suite makes 3 holds per run; a tight re-run loop (>10 runs/min)
  will start seeing 429 `RATE_LIMITED` and the failure will look like "Continue
  did nothing". Restart the server, or wait out the window.
- **`refetchIntervalInBackground: false`** means the 7 s poll only runs while the
  page is visible. Headless pages are always `visible`, so two contexts both
  poll — but in `--headed` mode with real window focus, do not be surprised if
  the *unfocused* window is slower to notice. `POLL_GRACE_MS` is 25 s for that
  reason, and the test is marked `test.slow()`.
- **`browser.newContext(contextOptions)` does not give you the config's
  `baseURL`/viewport.** The `contextOptions` fixture is only `use.contextOptions`;
  the merge with `viewport`, `locale`, `baseURL` etc. happens inside Playwright's
  own `context` fixture. Browser B is therefore configured explicitly and
  navigates by an absolute URL derived from browser A's, and the `afterAll`
  cleanup builds absolute URLs too.
- **The subsector count is not 22.** `docs/DATA_CONTRACT.md` says 22, but the
  pipeline splits blocks (`Б6-2`, `Б10-2`, `Б11-2`) and currently emits 25. That
  invariant belongs to `scripts/pipeline/validate.ts`; the e2e only asserts the
  four stands (`А Б В Г`, which *is* fixed) and that `А1` exists.

---

## Verified

Executed, not just written. On 2026-07-30, with Chromium 1228
(`@playwright/test` 1.62):

1. **Against `next start`** (production build) on `:3311` with
   `PLAYWRIGHT_BASE_URL` pointed at it, backed by a throwaway PostgreSQL 16.10
   cluster (`prisma migrate deploy` + `prisma/seed.ts` → 25 subsectors, 16 033
   seats; the cluster was deleted afterwards).
   → **4/4 passing in ~11 s, twice in a row.**
2. **Against `npm run test:e2e`'s own path** — the config's `webServer`, i.e. a
   `next dev` server on `:3000` and the local dev database.
   → **4/4 passing in ~15 s.**

In both cases the database was left as found: every reservation the suite created
came back `CANCELLED`, and no `ReservationSeat` rows stayed `active`.

One caveat worth knowing, learned the hard way: **`next dev` and `next start`
share `.next/`.** Starting a dev server while a production server is running
replaces `.next/static`, the running server then 404s its own JS chunks, and the
pages stop hydrating — which surfaces here as `waitForResponse` timeouts and
clicks that "do nothing". If a whole run suddenly fails at the hydration waits,
check that nothing else rebuilt `.next` underneath you before suspecting the app.

---

## Possible follow-ups

- The helpers (the dialog locators, `openSubsector`, the release bookkeeping) are
  duplicated across the specs on purpose: no agent has owned `e2e/support/` yet.
  A shared `e2e/support/seat-map.ts` is the obvious refactor once someone does.
- Nothing covers hold **expiry** in the browser (the 7:00 countdown reaching
  zero, `router.refresh()`, the EXPIRED terminal state). It needs either a 7 min
  test or a clock/TTL seam; `lib/reservations.ts` already takes an injectable
  `now`, so an env-tunable `HOLD_TTL_MS` would make this a 20-second test.
- Nothing covers mobile: the fat-finger guard (`tapZoomThreshold`) means a tap
  below 1.6× zoom zooms instead of selecting, so a touch project needs its own
  seat-selection helper.
