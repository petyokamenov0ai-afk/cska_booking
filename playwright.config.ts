import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  // Logs in as the seeded staff user and saves the `admin` cookie; every
  // context below starts from that storage state.
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    /**
     * Bound every action. The default is 0 (wait forever), which turns a real
     * failure — e.g. clicking a seat that is `aria-disabled`, which Playwright
     * treats as "not enabled yet" — into a whole-test timeout reported against
     * the wrong line. See e2e/README.md.
     */
    actionTimeout: 15_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'bg-BG',
    timezoneId: 'Europe/Sofia',
    storageState: 'e2e/.auth/state.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
