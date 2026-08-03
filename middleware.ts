/**
 * The staff-login gate. Every page and API route requires the signed `admin`
 * cookie (lib/auth.ts), with exactly these doors left open:
 *
 *   * `/login` and `POST /api/auth/login` — how you get the cookie;
 *   * `/api/cron/*`                       — machine calls, guarded by their own
 *                                           shared secret (x-cron-secret);
 *   * Next's static assets and the favicon.
 *
 * Pages redirect to /login; API calls get a 401 in the flat ApiError shape the
 * client's `apiFetch` already understands. Verification is stateless HMAC, so
 * this runs fine on the Edge runtime with no database in reach.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { AUTH_COOKIE, verifyAuthToken } from '@/lib/auth';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  const user = token === undefined ? null : await verifyAuthToken(token);
  if (user !== null) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: 'Sign in required.' },
      { status: 401 },
    );
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: [
    // Everything except the open doors listed above.
    '/((?!login|api/auth/login|api/cron|_next/static|_next/image|favicon\\.ico).*)',
  ],
};
