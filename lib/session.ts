/**
 * Anonymous guest identity — IMPLEMENTATION_PLAN §5 "Guest identity".
 *
 * One httpOnly cookie holding a random id. It is *not* authentication: it only
 * decides which held seats render as "yours" and lets the same browser resume or
 * cancel its own pending hold. The durable public handle is the reservation
 * `code`.
 *
 * ## Why there are two functions
 *
 * Next.js only allows cookies to be **written** while a response is being
 * produced by a route handler or a server action. A Server Component renders
 * during streaming, after headers are gone, so `cookieStore.set()` throws there.
 * A single "read or create" helper would therefore blow up in exactly the place
 * it gets used most (page components). Hence:
 *
 * | function            | reads | writes | safe in                               |
 * |---------------------|-------|--------|---------------------------------------|
 * | `getSessionId()`    | yes   | no     | anywhere server-side, incl. RSC pages |
 * | `ensureSessionId()` | yes   | yes    | route handlers & server actions only  |
 *
 * Practical rule:
 * - **Pages / Server Components** → `getSessionId()`. `null` simply means "this
 *   visitor has no holds yet", which renders identically to "no holds".
 * - **`app/api/**` route handlers and server actions** → `ensureSessionId()`,
 *   which mints and sets the cookie so the very first `POST /reservations` from
 *   a fresh browser already has a stable owner.
 *
 * `docs/API_CONTRACT.md` lists a single `getSessionId(): Promise<string>`. That
 * signature cannot be honoured without either writing cookies from RSC (throws)
 * or silently returning throw-away ids (breaks "my holds"), so the read-only
 * variant returns `string | null` and `ensureSessionId()` covers the writing
 * case. Callers that need a guaranteed id in a *read* context should use
 * `getSessionIdOrAnonymous()`.
 */

import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';

/** Cookie name. Short on purpose — it travels on every request. */
export const SESSION_COOKIE = 'sid';

/** 180 days, per IMPLEMENTATION_PLAN §5. */
export const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * A sentinel used by `getSessionIdOrAnonymous()`. It can never equal a real
 * session id (real ids are UUIDs), so it never marks anyone's seats as "mine".
 */
export const ANONYMOUS_SESSION_ID = 'anonymous';

/** Fresh, unguessable session id. */
export function newSessionId(): string {
  return randomUUID();
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  };
}

/**
 * Reads the `sid` cookie. Never writes, so it is safe in Server Components,
 * `generateMetadata`, middleware-adjacent code and route handlers alike.
 *
 * @returns the session id, or `null` when this browser has never been given one.
 */
export async function getSessionId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

/**
 * Reads the `sid` cookie, creating and setting it when absent.
 *
 * **Only valid inside route handlers (`app/api/**`) and server actions.**
 * Calling it while rendering a Server Component throws
 * `Cookies can only be modified in a Server Action or Route Handler`.
 */
export async function ensureSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(SESSION_COOKIE)?.value;
  if (existing && existing.length > 0) return existing;

  const created = newSessionId();
  store.set(SESSION_COOKIE, created, cookieOptions());
  return created;
}

/**
 * Read-only variant that always yields a string, for code paths that need to
 * pass *something* as `sessionId` (e.g. `getSubsectorSeats`) while rendering.
 * Returns `ANONYMOUS_SESSION_ID` when there is no cookie, which matches no
 * reservation, so every seat comes back with `mine: false`.
 */
export async function getSessionIdOrAnonymous(): Promise<string> {
  return (await getSessionId()) ?? ANONYMOUS_SESSION_ID;
}

/**
 * Drops the cookie. Route handlers / server actions only. Not used by v1 flows;
 * here so "forget me" does not have to reinvent the cookie options.
 */
export async function clearSessionId(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
}
