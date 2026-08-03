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
 * tap IS the interaction: on an occupied seat it must say whose it is (toast +
 * peek bubble), and on a free seat it must open the naming dialog directly.
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
  intruder = await playwright.request.newContext({ baseURL });
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

    // ONE tap. Not two.
    //
    // `{ force: true }`: an occupied seat is `aria-disabled="true"`, and
    // Playwright's actionability check resolves through it — a plain `tap()`
    // waits for the seat to become "enabled", for ever. The point of this test is
    // that *the app* answers the tap, not that the harness can deliver one; see
    // the same note in e2e/README.md.
    await seat.tap({ force: true });

    const toast = page.getByTestId('toast');
    await expect(toast).toContainText(new RegExp(`е заето от ${HOLDER}\\.$`));
    // The refusal stays one short sentence — the note is not in it. Now that it
    // fires on the first tap, that restraint matters more, not less.
    await expect(toast).not.toContainText('пътеката');

    // …and the note is not lost to the touch user: the press-to-peek bubble
    // carries it, on that same first tap.
    const bubble = page.getByTestId('seat-tooltip');
    await expect(bubble).toContainText(`За: ${HOLDER}`);
    await expect(bubble).toContainText(NOTE);
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
