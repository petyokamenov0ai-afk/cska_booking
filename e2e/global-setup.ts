/**
 * Signs in once as the seeded staff user and saves the `admin` cookie as
 * Playwright storage state. Every spec context — including the manual
 * `browser.newContext()` / `request.newContext()` calls, which must pass
 * `storageState: AUTH_STATE` themselves — starts authenticated, while each
 * still gets its own fresh `sid` booking identity.
 */

import { request, type FullConfig } from '@playwright/test';

export const AUTH_STATE = 'e2e/.auth/state.json';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
  const ctx = await request.newContext({ baseURL });
  const response = await ctx.post('/api/auth/login', {
    data: {
      username: process.env.ADMIN_USERNAME ?? 'meto',
      password: process.env.ADMIN_PASSWORD ?? 'R3brenie_',
    },
  });
  if (!response.ok()) {
    throw new Error(
      `e2e login failed (${response.status()}). Is the admin user seeded? Run \`npm run db:seed\`.`,
    );
  }
  await ctx.storageState({ path: AUTH_STATE });
  await ctx.dispose();
}
