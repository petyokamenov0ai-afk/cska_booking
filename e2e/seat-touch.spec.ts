/**
 * D3 — on a phone, one tap must answer "whose seat is this?".
 *
 * A separate file purely because of the `test.use()` below: `devices['Pixel 7']`
 * has to be applied at file scope, and it carries `hasTouch`, `isMobile` and a
 * 412×915 viewport that would break every desktop assertion in the other specs.
 * `devices` comes from `@playwright/test` itself, so this needs no second
 * Playwright project, no config change and no new dependency.
 *
 * The map has no zoom any more — the whole subsector is always in view — so a
 * tap IS the interaction: on an occupied seat it must open the release dialog
 * (which says whose it is, and can cancel ANY booking — this is an admin
 * tool), and on a free seat it must open the naming dialog directly.
 */

import { devices, expect, test, type APIRequestContext } from '@playwright/test';

test.use({ ...devices['Pixel 7'] });

const SUBSECTOR = 'А1';
const HOLDER = 'Иван Тъч';
const NOTE = 'до пътеката, вход Б';

/** Booked from a foreign session, so the map under test sees it as RESERVED
 *  rather than MINE — "someone else's seat" is the whole subject here. */
let intruder: APIRequestContext;
let seatId: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  // Staff-authenticated (storage state) but with its own `sid`, so its booking
  // reads as someone else's to the page under test.
  intruder = await playwright.request.newContext({
    baseURL,
    storageState: 'e2e/.auth/state.json',
  });
});

// `afterAll`, not an in-test `finally`: a test timeout tears the fixtures down
// before a `finally` would run, and the seat would stay booked indefinitely.
test.afterAll(async () => {
  if (seatId) await intruder.delete(`/api/seats/${encodeURIComponent(seatId)}`);
  await intruder.dispose();
});

async function openSubsector(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/subsectors/${encodeURIComponent(SUBSECTOR)}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Подсектор ${SUBSECTOR} / A1` }),
  ).toBeVisible();
  await page.waitForResponse(
    (response) => response.url().includes('/seats') && response.status() === 200,
  );
}

test.describe('touch', () => {
  test('one tap on an occupied seat says whose it is', async ({ page }) => {
    await openSubsector(page);

    // Take a seat as somebody else, then wait for this page's poll to see it.
    const free = page.locator('[data-seat-id][data-seat-state="FREE"]').first();
    seatId = (await free.getAttribute('data-seat-id')) as string;
    expect(seatId).toBeTruthy();
    const response = await intruder.post(`/api/seats/${encodeURIComponent(seatId)}`, {
      data: { name: HOLDER, note: NOTE },
    });
    expect(response.ok()).toBeTruthy();

    const seat = page.locator(`[data-seat-id="${seatId}"]`);
    await expect(seat).toHaveAttribute('data-seat-state', 'RESERVED', { timeout: 20_000 });

    // ONE tap. Not two. No `force`: an occupied seat is actionable now — an
    // administrator can cancel any booking — so Playwright's actionability
    // check passes on its own.
    await seat.tap();

    // The release dialog answers the tap: whose seat it is, note included.
    const dialog = page.getByTestId('seat-release-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`За: ${HOLDER}`);
    await expect(dialog).toContainText(NOTE);

    // Dismissing cancels nothing — only the destructive button releases.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(seat).toHaveAttribute('data-seat-state', 'RESERVED');
  });

  test('one tap on a free seat opens the naming dialog — no zoom step between', async ({
    page,
  }) => {
    await openSubsector(page);

    const svg = page.getByRole('group', { name: /^Подсектор А1/ });
    const before = await svg.getAttribute('viewBox');

    await page.locator('[data-seat-id][data-seat-state="FREE"]').first().tap();

    // The fat-finger guard went with the zoom: the first tap is the selection.
    await expect(page.getByTestId('seat-name-dialog')).toBeVisible();
    // …and nothing zoomed to make that possible — the viewBox is static now.
    await expect(svg).toHaveAttribute('viewBox', before as string);

    // Dismissing the dialog books nothing: the POST only exists on confirm.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('seat-name-dialog')).toBeHidden();
    await expect(page.locator('[data-seat-state="MINE"]')).toHaveCount(0);
  });
});
