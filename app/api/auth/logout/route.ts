/**
 * `POST /api/auth/logout` — clears the `admin` cookie. POST, not GET, so a
 * prefetched link can never log anyone out.
 */

import { NextResponse } from 'next/server';

import { authCookieOptions, AUTH_COOKIE } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, '', { ...authCookieOptions(), maxAge: 0 });
  return response;
}
