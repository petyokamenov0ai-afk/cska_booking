/**
 * Staff login — the signed session token behind the `admin` cookie.
 *
 * The whole app sits behind `middleware.ts`, which must run on the Edge
 * runtime; everything here is therefore Web Crypto and string maths — no
 * `node:crypto`, no Prisma, no imports that drag either in. Password HASHES
 * never appear here: bcrypt verification happens once, in the login route,
 * and afterwards the browser carries this stateless HMAC token:
 *
 *     base64url(username) . expiresAtMs . base64url(HMAC-SHA256(payload))
 *
 * Stateless on purpose: the middleware cannot reach the database, and a
 * one-table deployment has nothing to revoke against — rotating AUTH_SECRET
 * is the global logout.
 */

export const AUTH_COOKIE = 'admin';

/** 30 days. Long-lived on purpose — this is a staff tool, not a bank. */
export const AUTH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * HMAC key material. Set AUTH_SECRET in production; the fallback keeps a
 * fresh deployment working (this is a trusted-network staff tool) but makes
 * tokens forgeable by anyone who reads the repo, so it warns.
 */
function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (value && value.length > 0) return value;
  if (process.env.NODE_ENV === 'production') {
    console.warn('[auth] AUTH_SECRET is not set; using the built-in fallback secret');
  }
  return 'cska-booking-dev-secret';
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

/** Signed token asserting "this browser logged in as `username`". */
export async function mintAuthToken(username: string, now = Date.now()): Promise<string> {
  const expiresAt = now + AUTH_MAX_AGE_SECONDS * 1000;
  const payload = `${toBase64Url(encoder.encode(username))}.${expiresAt}`;
  const key = await hmacKey(['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

/**
 * The username the token asserts, or `null` for anything malformed, expired,
 * or not signed by us. `crypto.subtle.verify` does the constant-time compare.
 */
export async function verifyAuthToken(
  token: string,
  now = Date.now(),
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [user64, expiresRaw, sig64] = parts;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  const sig = fromBase64Url(sig64);
  const userBytes = fromBase64Url(user64);
  if (sig === null || userBytes === null) return null;

  const key = await hmacKey(['verify']);
  const payload = `${user64}.${expiresRaw}`;
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sig as BufferSource,
    encoder.encode(payload),
  );
  if (!valid) return null;

  return new TextDecoder().decode(userBytes);
}

/** Cookie attributes, shared by login (set) and logout (clear). */
export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: AUTH_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  };
}
