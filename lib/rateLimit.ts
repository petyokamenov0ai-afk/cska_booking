/**
 * Fixed-window rate limiter — IMPLEMENTATION_PLAN §5 "Limits".
 *
 * ## Scope and its limits
 *
 * State lives in a plain `Map` **inside one Node process**. That is deliberate
 * for v1 (zero infrastructure, zero latency) and it is honestly weak:
 *
 * - Serverless / multi-instance deploys give every instance its own budget, so
 *   the effective limit is `limit × instances`.
 * - A cold start resets every window.
 * - It cannot be used from the Edge runtime.
 *
 * **Production replacement:** swap the `buckets` Map for Redis (`INCR` + `EXPIRE`
 * on the same key, or a sliding-window script) or Upstash Ratelimit. The exported
 * signatures below are the whole surface — keeping them means route handlers do
 * not change when that happens.
 *
 * ## Memory safety
 *
 * A naive Map keyed by IP leaks: every distinct caller adds an entry that is
 * never removed. Two guards prevent that:
 *
 * 1. Every call sweeps expired windows at most once per `PRUNE_INTERVAL_MS`
 *    (O(size), amortised to roughly nothing).
 * 2. If the Map somehow still exceeds `MAX_TRACKED_KEYS` after a sweep — a flood
 *    of unique keys inside one window — it is cleared outright. Losing counters
 *    is strictly better than losing the process, and the flood itself is the
 *    thing the caller should be shedding upstream.
 */

interface Bucket {
  count: number;
  /** Epoch ms at which this window ends. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const PRUNE_INTERVAL_MS = 60_000;
const MAX_TRACKED_KEYS = 50_000;

let nextPruneAt = 0;

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  nextPruneAt = now + PRUNE_INTERVAL_MS;
}

export interface RateLimitResult {
  /** False when the caller is over budget for the current window. */
  allowed: boolean;
  /** Budget left after this call (0 once over). */
  remaining: number;
  /** Seconds until the window resets — use for the `Retry-After` header. */
  retryAfterSeconds: number;
  /** Epoch ms at which the window resets. */
  resetAt: number;
  limit: number;
}

/**
 * Consumes one unit and reports the full state, so a 429 can carry
 * `Retry-After` (required by `docs/API_CONTRACT.md`).
 *
 * Over-budget calls still increment the counter, but the window end is fixed at
 * first use — hammering an endpoint therefore never extends the ban, which is
 * the defining property of a fixed window.
 *
 * @param key      caller identity, e.g. `reserve:ip:1.2.3.4` or `reserve:sid:<uuid>`
 * @param limit    allowed calls per window; `<= 0` denies everything
 * @param windowMs window length in milliseconds
 * @param now      injectable clock (epoch ms) for tests
 */
export function consumeWithInfo(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  if (now >= nextPruneAt || buckets.size > MAX_TRACKED_KEYS) prune(now);
  if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();

  if (limit <= 0) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
      resetAt: now + windowMs,
      limit,
    };
  }

  let bucket = buckets.get(key);
  if (bucket === undefined || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const allowed = bucket.count <= limit;

  return {
    allowed,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    resetAt: bucket.resetAt,
    limit,
  };
}

/**
 * In-memory fixed-window limiter. Returns false when the caller is over budget.
 * (`docs/API_CONTRACT.md § lib/rateLimit.ts`.)
 */
export function consume(key: string, limit: number, windowMs: number): boolean {
  return consumeWithInfo(key, limit, windowMs).allowed;
}

/**
 * Current state without consuming. Useful for `X-RateLimit-*` headers on
 * success responses.
 */
export function peek(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key);
  const active = bucket !== undefined && bucket.resetAt > now;
  const count = active && bucket !== undefined ? bucket.count : 0;
  const resetAt = active && bucket !== undefined ? bucket.resetAt : now + windowMs;
  const allowed = limit > 0 && count < limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    resetAt,
    limit,
  };
}

/** Clears one key, or the whole table. For tests and admin tooling. */
export function resetRateLimit(key?: string): void {
  if (key === undefined) {
    buckets.clear();
    nextPruneAt = 0;
    return;
  }
  buckets.delete(key);
}

/** Number of tracked keys. Diagnostics/tests only. */
export function rateLimitSize(): number {
  return buckets.size;
}

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

export interface RateLimitBudget {
  limit: number;
  windowMs: number;
}

/**
 * The budgets for the reservation endpoints. **This is the single source of
 * truth** — route handlers import from here rather than declaring their own
 * constants, so the numbers cannot drift apart from the ones documented here.
 *
 * Every write endpoint applies **both** an IP and a session budget: the IP one
 * stops a script, the session one stops a single tab from spamming. The IP
 * budget is deliberately the looser of the two, because a whole office, school
 * or mobile carrier can sit behind one address and must still be able to buy
 * tickets; the session budget is what actually bounds one visitor.
 */
export const BUDGETS = {
  /** Creating holds — the seat-hoarding vector. */
  createReservationPerIp: { limit: 30, windowMs: 60_000 },
  createReservationPerSession: { limit: 10, windowMs: 60_000 },
  /** Confirm / cancel — cheap, but still bounded. */
  mutateReservationPerIp: { limit: 60, windowMs: 60_000 },
  mutateReservationPerSession: { limit: 20, windowMs: 60_000 },
  /** Public lookups by code — bound guessing attempts on the 6-char code. */
  lookupReservationPerIp: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitBudget>;

/**
 * Best-effort client IP from the proxy headers Vercel / nginx set.
 * `Request` has no socket address, so a missing header means we fall back to a
 * single shared bucket — which is intentionally conservative.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}
