/**
 * `POST /api/auth/login` — the one open API door.
 *
 *   body `{ username, password }`
 *   200 `{ user }` + the signed `admin` cookie (see lib/auth.ts)
 *   401 on a wrong pair — one generic message for "no such user" and "wrong
 *       password" alike, so the endpoint cannot be used to enumerate users
 *   429 after 10 attempts per IP per minute
 */

import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { rateLimitedError, validationError } from '@/lib/apiError';
import { authCookieOptions, mintAuthToken, AUTH_COOKIE } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { clientIp, consume } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

/** Hand-built 401: `UNAUTHORIZED` is not an `ApiErrorCode` — nothing else in
 *  the API is authenticated, so the contract's table has no auth row. */
function invalidCredentials(): NextResponse {
  return NextResponse.json(
    { error: 'UNAUTHORIZED', message: 'Invalid username or password.' },
    { status: 401 },
  );
}

export async function POST(request: Request): Promise<Response> {
  // Tight budget: a login form is typed by a human, ten a minute is plenty.
  if (!consume(`login:ip:${clientIp(request)}`, 10, 60_000)) {
    return rateLimitedError(60);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return validationError(undefined, 'Malformed request body.');
  }
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return validationError(parsed.error, 'Invalid login payload.');
  }

  const user = await prisma.adminUser.findUnique({
    where: { username: parsed.data.username },
    select: { username: true, passwordHash: true },
  });
  // bcrypt.compare against a constant hash even when the user is unknown, so
  // "no such user" and "wrong password" take the same time.
  const hash =
    user?.passwordHash ??
    '$2b$10$C6UzMDM.H6dfI/f/IKcEeO7ZUv5eXe6ZQpxbcCogYPGmI8Nnhjq1y';
  const ok = await bcrypt.compare(parsed.data.password, hash);
  if (!ok || user === null) return invalidCredentials();

  const response = NextResponse.json({ user: user.username });
  response.cookies.set(AUTH_COOKIE, await mintAuthToken(user.username), authCookieOptions());
  return response;
}
