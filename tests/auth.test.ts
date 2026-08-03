/**
 * lib/auth.ts — the stateless staff-session token the middleware trusts.
 * Everything the middleware decides hangs off `verifyAuthToken`, so each
 * rejection path is pinned individually.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AUTH_MAX_AGE_SECONDS, mintAuthToken, verifyAuthToken } from '@/lib/auth';

const ORIGINAL_SECRET = process.env.AUTH_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

describe('auth token', () => {
  it('round-trips the username, Cyrillic included', async () => {
    for (const name of ['meto', 'Методи Иванов']) {
      const token = await mintAuthToken(name);
      expect(await verifyAuthToken(token)).toBe(name);
    }
  });

  it('expires exactly at the deadline', async () => {
    const now = 1_700_000_000_000;
    const token = await mintAuthToken('meto', now);
    const lifetime = AUTH_MAX_AGE_SECONDS * 1000;
    expect(await verifyAuthToken(token, now + lifetime - 1)).toBe('meto');
    expect(await verifyAuthToken(token, now + lifetime)).toBeNull();
  });

  it('rejects tampering with any part', async () => {
    const token = await mintAuthToken('meto');
    const [user, exp, sig] = token.split('.');
    // Another username under the same signature.
    expect(await verifyAuthToken(`${btoa('root')}.${exp}.${sig}`)).toBeNull();
    // A pushed-out expiry under the same signature.
    expect(await verifyAuthToken(`${user}.${Number(exp) + 1}.${sig}`)).toBeNull();
    // A damaged signature.
    const flipped = sig.endsWith('A') ? `${sig.slice(0, -1)}B` : `${sig.slice(0, -1)}A`;
    expect(await verifyAuthToken(`${user}.${exp}.${flipped}`)).toBeNull();
    // Garbage shapes.
    expect(await verifyAuthToken('')).toBeNull();
    expect(await verifyAuthToken('a.b')).toBeNull();
    expect(await verifyAuthToken('не.е.токен')).toBeNull();
  });

  it('rejects tokens minted under a different secret', async () => {
    process.env.AUTH_SECRET = 'secret-one';
    const token = await mintAuthToken('meto');
    process.env.AUTH_SECRET = 'secret-two';
    expect(await verifyAuthToken(token)).toBeNull();
  });
});
