/**
 * The naming dialog: the note field, validation, every dismissal path, and
 * standing regression tests for D1 (a reopen swallowed by a stale `close`
 * event) and D2 (the page scrolling behind the modal).
 *
 * Everything here is browser-only by nature. The pure half — `visibleText`,
 * `noteLabel`, `noteAriaFragment`, the schemas — is covered in vitest; what
 * cannot be proved there is that the platform behaves the way the component
 * assumes it does, which is exactly what D1 and D2 turned out to be about.
 *
 * D3 (one tap must answer) needs a touch device and therefore a file-scope
 * `test.use({ ...devices[…] })`, so it lives in `seat-touch.spec.ts`.
 */

import { expect, test, type Page } from '@playwright/test';

const SUBSECTOR = 'А1';

/**
 * Built with `String.fromCodePoint`, never pasted: a literal zero-width
 * character in a source file is invisible to review and one "tidy up" away from
 * deleting the very thing the test exists to catch.
 */
const ZWSP = String.fromCodePoint(0x200b);
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);

// The page header is `sticky`; at the config's default height a seat can end up
// under it and become unclickable. See e2e/README.md.
test.use({ viewport: { width: 1280, height: 1100 } });

const dialog = (p: Page) => p.getByTestId('seat-name-dialog');
const nameBox = (p: Page) => p.getByTestId('seat-name-input');
const noteBox = (p: Page) => p.getByTestId('seat-note-input');
const submit = (p: Page) => p.getByTestId('seat-name-submit');
/** `Затвори` is `common.close`, shared with EVERY visible toast — a measured
 *  3-element strict-mode violation. Always scope it to the dialog. */
const closeX = (p: Page) => dialog(p).getByRole('button', { name: 'Затвори' });
const firstFree = (p: Page) => p.locator('[data-seat-id][data-seat-state="FREE"]').first();

/** Every seat this file books, released after each test whatever happened. */
const booked = new Set<string>();

test.afterEach(async ({ page }) => {
  for (const id of booked) {
    // Same cookie jar, so this releases as the session that booked. Idempotent.
    await page.request.delete(`/api/seats/${encodeURIComponent(id)}`);
  }
  booked.clear();
});

async function openSubsector(page: Page): Promise<void> {
  await page.goto(`/subsectors/${encodeURIComponent(SUBSECTOR)}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Подсектор ${SUBSECTOR} / A1` }),
  ).toBeVisible();
  // Seats are server-rendered, so `toBeVisible` proves nothing about
  // interactivity. `useSeats` refetches the instant it mounts; that response is
  // the precise "this map is hydrated" signal.
  await page.waitForResponse(
    (response) => response.url().includes('/seats') && response.status() === 200,
  );
}

async function openDialogOnFreeSeat(page: Page): Promise<string> {
  const seat = firstFree(page);
  const seatId = await seat.getAttribute('data-seat-id');
  expect(seatId).toBeTruthy();
  await seat.click();
  await expect(dialog(page)).toBeVisible();
  return seatId as string;
}

async function bookViaDialog(page: Page, name: string, note?: string): Promise<void> {
  await expect(dialog(page)).toBeVisible();
  await nameBox(page).fill(name);
  if (note !== undefined) await noteBox(page).fill(note);
  await submit(page).click();
  await expect(dialog(page)).toBeHidden();
}

test.describe('seat naming dialog', () => {
  test('books with a name and a note, and shows both', async ({ page }) => {
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);

    await bookViaDialog(page, 'Иван Тест', 'до пътеката');
    booked.add(seatId);

    const seat = page.locator(`[data-seat-id="${seatId}"]`);
    await expect(seat).toHaveAttribute('data-seat-state', 'MINE', { timeout: 15_000 });
    // The note is appended after the holder, and only for seats that carry one.
    await expect(seat).toHaveAttribute('aria-label', /, за Иван Тест, бележка: до пътеката$/);

    await expect(page.getByTestId('toast')).toContainText(
      /^Резервирано за Иван Тест: ред \d+, място \d+\.$/,
    );

    // The hover bubble carries both — it is the whole point of the feature, and
    // it is `aria-hidden`, so no accessible-name assertion can stand in for it.
    await seat.hover();
    const bubble = page.getByTestId('seat-tooltip');
    await expect(bubble).toContainText('За: Иван Тест');
    await expect(bubble).toContainText('до пътеката');
  });

  test('the note is optional — booking without one adds no fragment', async ({ page }) => {
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);

    await bookViaDialog(page, 'Иван Тест');
    booked.add(seatId);

    const seat = page.locator(`[data-seat-id="${seatId}"]`);
    await expect(seat).toHaveAttribute('data-seat-state', 'MINE', { timeout: 15_000 });
    // Ends at the holder: no "бележка:" at all, not an empty one.
    await expect(seat).toHaveAttribute('aria-label', /, за Иван Тест$/);
  });

  test('the 120-character bound is enforced by the control itself', async ({ page }) => {
    await openSubsector(page);
    await openDialogOnFreeSeat(page);

    // Pins `maxLength` against `SEAT_NOTE_MAX` drifting apart from the schema:
    // if the attribute is ever dropped, a 200-character paste reaches a server
    // that rejects it and the dialog has no error state to show for it.
    await noteBox(page).fill('я'.repeat(200));
    expect((await noteBox(page).inputValue()).length).toBe(120);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  });

  test('Enter inside the note submits, and inserts no newline', async ({ page }) => {
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);

    await nameBox(page).fill('Иван Тест');
    await noteBox(page).click();
    await page.keyboard.type('плаща в брой');
    // The contract the hint line advertises: "До 120 знака. Enter записва."
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    booked.add(seatId);

    const seat = page.locator(`[data-seat-id="${seatId}"]`);
    await expect(seat).toHaveAttribute('data-seat-state', 'MINE', { timeout: 15_000 });
    await expect(seat).toHaveAttribute('aria-label', /, бележка: плаща в брой$/);
  });

  test('a note of only zero-width characters is not a note', async ({ page }) => {
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);

    await nameBox(page).fill('Иван Тест');
    // ZWSP + ZWNJ + ZWJ. Dropped to `undefined` rather than rejected: an
    // optional field that would render nothing simply is not there, and an error
    // here would be a puzzle with no fix the user can see.
    await noteBox(page).fill(ZWSP + ZWNJ + ZWJ);
    await submit(page).click();
    await expect(dialog(page)).toBeHidden();
    booked.add(seatId);

    const seat = page.locator(`[data-seat-id="${seatId}"]`);
    await expect(seat).toHaveAttribute('data-seat-state', 'MINE', { timeout: 15_000 });
    await expect(seat).toHaveAttribute('aria-label', /, за Иван Тест$/);
  });

  test('a too-short name is refused, books nothing, and does not wedge the form', async ({
    page,
  }) => {
    await openSubsector(page);

    let posts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/seats\//.test(request.url())) posts += 1;
    });

    const seatId = await openDialogOnFreeSeat(page);

    await nameBox(page).fill('Я');
    await submit(page).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('Въведи име — поне 2 знака.');
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator(`[data-seat-id="${seatId}"]`)).not.toHaveAttribute(
      'data-seat-state',
      'MINE',
    );
    expect(posts).toBe(0);

    // The error clears on the next keystroke and the form still submits.
    await nameBox(page).fill('Иван Тест');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await submit(page).click();
    await expect(dialog(page)).toBeHidden();
    booked.add(seatId);
    expect(posts).toBe(1);

    await expect(page.locator(`[data-seat-id="${seatId}"]`)).toHaveAttribute(
      'data-seat-state',
      'MINE',
      { timeout: 15_000 },
    );
  });

  test('D4 — a name of only zero-width characters is refused', async ({ page }) => {
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);

    // On the old code this booked: `.min(2)` counts code units, so two ZWSPs
    // were a legal name, and the map rendered a bold "За: " with nothing after
    // it plus an aria-label ending ", за ".
    await nameBox(page).fill(ZWSP + ZWSP);
    await submit(page).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('Въведи име — поне 2 знака.');
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(`[data-seat-id="${seatId}"]`)).toHaveAttribute(
      'data-seat-state',
      'FREE',
    );
  });

  test('every dismissal path books nothing and leaves no residue', async ({ page }) => {
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);
    const seat = page.locator(`[data-seat-id="${seatId}"]`);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();

    for (const how of ['escape', 'cancel', 'close', 'backdrop'] as const) {
      await seat.click();
      await expect(dialog(page), how).toBeVisible();
      // Type into both fields first: a dismissal that discards nothing proves
      // less than one that discards something.
      await nameBox(page).fill('Ще бъде отказано');
      await noteBox(page).fill('и това също');

      if (how === 'escape') await page.keyboard.press('Escape');
      else if (how === 'cancel') await dialog(page).getByRole('button', { name: 'Отказ' }).click();
      else if (how === 'close') await closeX(page).click();
      // Bottom-left of the viewport: the dialog is centred and `p-0`, so this is
      // unambiguously the backdrop.
      else await page.mouse.click(20, 1050);

      await expect(dialog(page), how).toBeHidden();
      await expect(seat, how).toHaveAttribute('data-seat-state', 'FREE');
      // Every dismissal path is `setPromptSeatId(null)` and NOTHING else, which
      // is what makes cancellation structurally incapable of stranding the seat
      // SELECTED or in the `pending` re-entry guard. Re-opening is the assertion
      // that proves it: if a cancel had left residue, this click would be a no-op.
      await seat.click();
      await expect(dialog(page), how).toBeVisible();
      // The note is not remembered across seats, and neither is a cancelled one.
      await expect(noteBox(page), how).toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(dialog(page), how).toBeHidden();
    }

    await page.reload();
    await expect(page.locator(`[data-seat-id="${seatId}"]`)).toHaveAttribute(
      'data-seat-state',
      'FREE',
    );
  });

  test('D1 — reopening immediately after dismissing is not swallowed', async ({ page }) => {
    await openSubsector(page);

    // `close` is delivered from a QUEUED TASK, not synchronously from `close()`
    // (measured: p50 2.4 ms, max 7 ms). A reopen inside that window used to be
    // cancelled by the stale event — 36/40 laps on the old code.
    //
    // Keyboard only and NO waits: the race window closes under 16 ms, and
    // `page.mouse.click` is far too slow to reach it (0/10 laps by mouse vs
    // 36/40 by keyboard). This is why the regression test cannot use clicks.
    //
    // The target must be the ROVING seat. `SeatMap`'s keydown activates
    // `activeSeatId ?? nav.firstId`, and `activeSeatId` is set only by the arrow
    // keys or a previous activation — so focusing an arbitrary seat and pressing
    // Enter activates the FIRST seat in the map, not the focused one.
    const roving = page.locator('[data-seat-id][tabindex="0"]');
    await expect(roving).toHaveCount(1);
    // If the roving seat is not free, Enter would toast "taken" instead of
    // opening the dialog and this test would fail for the wrong reason.
    await expect(roving).toHaveAttribute('data-seat-state', 'FREE');

    for (let lap = 0; lap < 30; lap += 1) {
      await roving.focus();
      await page.keyboard.press('Enter');
      await expect(dialog(page), `lap ${lap} open`).toBeVisible();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter'); // no delay, on purpose
      await expect(dialog(page), `lap ${lap} reopen`).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog(page), `lap ${lap} closed`).toBeHidden();
    }

    // 30 laps of Enter and not one of them booked anything.
    await expect(page.locator('[data-seat-state="MINE"]')).toHaveCount(0);
  });

  test('D2 — the page never scrolls, dialog open or not', async ({ page }) => {
    // The shell is pinned to the viewport (`h-dvh`): a short window shrinks
    // the map instead of overflowing the page, so the WINDOW can never scroll
    // — which is the whole reason the old body-pinning assertions are gone.
    // What remains to pin: the fit itself, and that wheeling over the map with
    // the dialog open (the document is inert, so the map's own wheel guard is
    // off) still moves nothing.
    await page.setViewportSize({ width: 1280, height: 600 });
    await openSubsector(page);

    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(await overflow()).toBeLessThanOrEqual(0);

    await openDialogOnFreeSeat(page);
    const anchorTop = () =>
      page.evaluate(() =>
        Math.round((document.querySelector('h1') as HTMLElement).getBoundingClientRect().top),
      );
    const settled = await anchorTop();

    // Over the map — the old worst offender, measured at 382 px of background
    // scroll before the shell was viewport-pinned.
    await page.mouse.move(640, 300);
    await page.mouse.wheel(0, 400);
    expect(await anchorTop()).toBe(settled);
    expect(await overflow()).toBeLessThanOrEqual(0);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  });

  test('a double submit books exactly once', async ({ page }) => {
    await openSubsector(page);

    let posts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/seats\//.test(request.url())) posts += 1;
    });

    const seatId = await openDialogOnFreeSeat(page);
    await nameBox(page).fill('Иван Тест');

    // Two clicks in ONE task, which is the case the guard exists for: it reads
    // `pendingRef`, not the `pending` state, so it holds inside a single React
    // batch where the state has not been committed yet. Two awaited
    // `locator.click()`s would be milliseconds apart and would not test that.
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="seat-name-submit"]',
      );
      button?.click();
      button?.click();
    });
    await expect(dialog(page)).toBeHidden();
    booked.add(seatId);

    await expect(page.locator(`[data-seat-id="${seatId}"]`)).toHaveAttribute(
      'data-seat-state',
      'MINE',
      { timeout: 15_000 },
    );
    await expect(page.locator('[data-seat-state="MINE"]')).toHaveCount(1);
    await expect(page.getByTestId('toast')).toHaveCount(1);
    // The assertion that actually pins the guard. Before the confirm latch this
    // was 2: the seat came back RESERVED-but-not-mine, because the two writes
    // minted two different `sid` cookies and the loser's is the one that stuck —
    // a seat booked by you that you cannot release.
    expect(posts).toBe(1);
  });

  test('the seat is lost while the dialog is open', async ({ page, playwright, baseURL }) => {
    test.slow();
    await openSubsector(page);
    const seatId = await openDialogOnFreeSeat(page);
    await noteBox(page).fill('ще бъде изхвърлено');

    // A different context means a different `sid` cookie, so this is genuinely
    // somebody else taking the seat out from under the open dialog. Staff
    // login comes from the shared storage state.
    const intruder = await playwright.request.newContext({
      baseURL,
      storageState: 'e2e/.auth/state.json',
    });
    try {
      const response = await intruder.post(`/api/seats/${encodeURIComponent(seatId)}`, {
        data: { name: 'Друг Човек', note: 'бележка на натрапника' },
      });
      expect(response.ok()).toBeTruthy();

      // Closing beats letting someone finish typing into a seat already lost.
      await expect(dialog(page)).toBeHidden({ timeout: 15_000 });
      const toast = page.getByTestId('toast');
      await expect(toast).toContainText(/^Ред \d+, място \d+ е заето от Друг Човек\.$/);
      // The refusal does not carry the intruder's note — `seatUnavailableMessage`
      // answers "why can I not have this seat", not "what did they write".
      await expect(toast).not.toContainText('натрапника');
    } finally {
      await intruder.delete(`/api/seats/${encodeURIComponent(seatId)}`);
      await intruder.dispose();
    }
  });
});
