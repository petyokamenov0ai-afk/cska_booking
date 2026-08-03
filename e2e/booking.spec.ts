/**
 * End-to-end: the stadium drill-down and click-to-book.
 *
 * There are no match days, so the journey starts at `/` (the bowl) rather than
 * an event list, and booking is a click plus the naming dialog — no basket, no
 * hold countdown, no contact form.
 *
 * Needs a dev server and a seeded database:
 *   docker compose up -d && npm run db:seed && npm run test:e2e
 *
 * The dialog's own behaviour (validation, dismissal, the note field, D1/D2) lives
 * in `seatName.spec.ts`; this file only proves the journey still reaches it.
 */

import { expect, test, type Page } from '@playwright/test';

/** Cyrillic codes travel percent-encoded; keep the raw form for assertions. */
const SUBSECTOR = 'А1';

/** The seats this file books, released in `afterEach` whatever the outcome. */
const booked = new Set<string>();

test.afterEach(async ({ page }) => {
  for (const id of booked) {
    // `page.request` shares the context's cookie jar, so this releases as the
    // same session that booked. DELETE is idempotent — an already-released seat
    // answers 200 with `released: false`.
    await page.request.delete(`/api/seats/${encodeURIComponent(id)}`);
  }
  booked.clear();
});

async function openSubsector(page: Page): Promise<void> {
  await page.goto('/');
  // One level: the bowl fits the screen and every block is directly clickable,
  // so there is no sector-zoom step and no `?sector=` URL state any more.
  await page.getByRole('button', { name: new RegExp(`^Подсектор ${SUBSECTOR},`) }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(SUBSECTOR)));
  // Assert we landed, so a navigation failure reads as a navigation failure
  // instead of a seat-click timeout 15 s later.
  await expect(
    page.getByRole('heading', { level: 1, name: `Подсектор ${SUBSECTOR} / A1` }),
  ).toBeVisible();
}

/**
 * There is deliberately no `zoomIn()` helper any more.
 *
 * It clicked a button matching `/увелич|zoom in/i`, which matches neither
 * dictionary — the real label is `Приближи`. It was also never needed: the
 * fat-finger guard keys on `pointerType !== 'mouse'`, so a mouse click books at
 * any zoom. Three phantom clicks per test, protecting nothing. Touch is covered
 * in `seat-touch.spec.ts`, which is where the guard actually applies.
 */

const dialog = (page: Page) => page.getByTestId('seat-name-dialog');

/** Fill the naming dialog and submit. Every booking in the suite goes through
 *  it, because there is no longer any other way to book. */
async function bookViaDialog(page: Page, name: string): Promise<void> {
  await expect(dialog(page)).toBeVisible();
  await page.getByTestId('seat-name-input').fill(name);
  await page.getByTestId('seat-name-submit').click();
  await expect(dialog(page)).toBeHidden();
}

test.describe('stadium', () => {
  test('home page is the bowl, with no match to choose', async ({ page }) => {
    await page.goto('/');
    // A `region`, not a `heading`: the home page has zero headings of any level.
    // `map.overviewTitle` is an aria-label on the <section> (and on the SVG),
    // which `app/StadiumMapClient.tsx` explains. The <section> is asserted rather
    // than the SVG because it survives the map being restructured.
    await expect(
      page.getByRole('region', { name: /^(Избери сектор|Pick a sector)$/ }),
    ).toBeVisible();
    // The match-day model is gone: nothing should offer a fixture to pick.
    await expect(page.getByText('ЦСКА – Левски')).toHaveCount(0);
  });

  test('books a seat through the dialog and releases it on the next click', async ({ page }) => {
    await openSubsector(page);

    const seat = page.locator('[data-seat-id][data-seat-state="FREE"]').first();
    const seatId = await seat.getAttribute('data-seat-id');
    expect(seatId).toBeTruthy();

    // Clicking a free seat books NOTHING — it asks who it is for.
    await seat.click();
    await bookViaDialog(page, 'Иван Петров-E2E');
    booked.add(seatId as string);

    // Booked by this browser: the seat is now "mine", not merely unavailable.
    const mine = page.locator(`[data-seat-id="${seatId}"][data-seat-state="MINE"]`);
    await expect(mine).toBeVisible({ timeout: 15_000 });
    // The name reached the *accessible* name, not merely the database. This is
    // the only route to the holder for someone with no pointer — the hover
    // bubble is `aria-hidden` by design.
    await expect(mine).toHaveAttribute('aria-label', /, за Иван Петров-E2E$/);

    // Releasing is deliberate: clicking your own seat opens a confirm dialog
    // that shows who the seat is for — it must NOT fall into "name this seat"
    // (`mine` is tested before `FREE`), and it must not release by itself.
    await page.locator(`[data-seat-id="${seatId}"]`).click();
    await expect(dialog(page)).toBeHidden();
    const release = page.getByTestId('seat-release-dialog');
    await expect(release).toBeVisible();
    await expect(release).toContainText('Иван Петров-E2E');

    // Only the explicit destructive button releases.
    await release.getByTestId('seat-release-confirm').click();
    await expect(release).toBeHidden();
    await expect(page.locator(`[data-seat-id="${seatId}"][data-seat-state="FREE"]`)).toBeVisible({
      timeout: 15_000,
    });
    booked.delete(seatId as string);
  });

  test('a seat booked in one browser reads as taken in another', async ({ page, browser }) => {
    await openSubsector(page);

    const seat = page.locator('[data-seat-id][data-seat-state="FREE"]').first();
    const seatId = await seat.getAttribute('data-seat-id');
    await seat.click();
    await bookViaDialog(page, 'Иван Петров-E2E');
    booked.add(seatId as string);

    await expect(page.locator(`[data-seat-id="${seatId}"][data-seat-state="MINE"]`)).toBeVisible({
      timeout: 15_000,
    });

    // A second, independent session must see it as someone else's. Same staff
    // login (storage state), fresh `sid` — the booking identity is the cookie
    // that matters here.
    const other = await browser.newContext({ storageState: 'e2e/.auth/state.json' });
    const otherPage = await other.newPage();
    try {
      await openSubsector(otherPage);
      const mirrored = otherPage.locator(`[data-seat-id="${seatId}"]`);
      // RESERVED, not MINE: another session's booking is visible but not theirs.
      await expect(mirrored).toHaveAttribute('data-seat-state', 'RESERVED', {
        timeout: 20_000,
      });
      // …and still actionable: an administrator at ANY browser can open the
      // release dialog on it and cancel the booking.
      await expect(mirrored).toHaveAttribute('data-seat-selectable', 'true');
      // Names are PUBLIC to everyone who can see the map — this is an
      // administrator-run tool on a trusted network, and the decision is
      // deliberate enough to deserve a test rather than a comment.
      await expect(mirrored).toHaveAttribute('aria-label', /, за Иван Петров-E2E$/);
    } finally {
      await otherPage.close();
      await other.close();
    }

    // Leave the stadium as we found it (belt and braces — `afterEach` also
    // does). Releasing goes through the confirm dialog now.
    await page.locator(`[data-seat-id="${seatId}"]`).click();
    const release = page.getByTestId('seat-release-dialog');
    await expect(release).toBeVisible();
    await release.getByTestId('seat-release-confirm').click();
    await expect(page.locator(`[data-seat-id="${seatId}"][data-seat-state="FREE"]`)).toBeVisible({
      timeout: 15_000,
    });
  });
});
