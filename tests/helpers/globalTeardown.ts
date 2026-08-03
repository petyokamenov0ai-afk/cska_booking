/**
 * Vitest global teardown — removes the integration-test geometry fixture.
 *
 * `tests/helpers/db.ts` creates a persistent sector/subsector (`ТСТ` / `ТСТ1`
 * with 60 `itest-` seats) once and reuses it across test files, which keeps
 * setup cheap. The catch is that it shares a database with the app, so without
 * this teardown the fixture survives the run and shows up as a real 60-seat
 * subsector in `GET /api/events/:id/availability` — fake inventory in
 * application data.
 *
 * Deleting only `itest-`-prefixed rows means a seeded stadium is untouched.
 */
import { PrismaClient } from '@prisma/client';

import { loadDotEnv } from './env';

/** Vitest calls `setup` before the run and `teardown` after it. */
export async function setup(): Promise<void> {
  /* nothing to do — tests/helpers/db.ts builds the fixture lazily */
}

export async function teardown(): Promise<void> {
  // Shares the loader with `tests/helpers/db.ts` so both agree on which file
  // wins. `dotenv` is deliberately not used here — see tests/helpers/env.ts.
  loadDotEnv(['.env.test', '.env.local', '.env']);
  if (!process.env.DATABASE_URL) return;

  const prisma = new PrismaClient();
  try {
    // Order matters: events cascade to reservations, then geometry.
    await prisma.$executeRaw`DELETE FROM "Event" WHERE "id" LIKE 'itest-%'`;
    await prisma.$executeRaw`DELETE FROM "Seat" WHERE "id" LIKE 'itest-%'`;
    await prisma.$executeRaw`DELETE FROM "Subsector" WHERE "id" LIKE 'itest-%'`;
    await prisma.$executeRaw`DELETE FROM "Sector" WHERE "id" LIKE 'itest-%'`;
  } catch {
    // A missing/unreachable database is the normal "tests were skipped" case.
  } finally {
    await prisma.$disconnect();
  }
}
