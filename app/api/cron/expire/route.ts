/**
 * `POST /api/cron/expire` — the hold sweeper.
 *
 *   header `x-cron-secret: $CRON_SECRET`
 *   200 `{ expired: number }`
 *   401 when the header is missing or wrong
 *
 * Layer 2 of the two-layer expiry in `IMPLEMENTATION_PLAN.md §5`. Lazy expiry
 * already hides lapsed holds from availability queries, but those rows still
 * carry `active = true` and therefore still occupy slots in the
 * `reservation_seat_active_uq` partial unique index — this sweep flips them to
 * EXPIRED and frees the slots. Run it every minute.
 *
 * POST only, deliberately: there is no `GET` export, so Next answers 405 and the
 * secret can never end up in a browser address bar, a `Referer` header or a proxy
 * access log.
 */

import { NextResponse } from 'next/server';

import { isCronAuthorized, jsonOk, toApiErrorResponse } from '@/lib/apiError';
import { expireStaleReservations } from '@/lib/reservations';
import type { ApiError, CronExpireResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `expireStaleReservations` sweeps at most `limit` reservations per call so that
 * a long outage cannot produce one enormous transaction. Pass the batch size
 * explicitly and keep going while a batch comes back full — a normal minute
 * finishes in one iteration.
 */
const BATCH_SIZE = 5_000;
/** Hard stop, so a pathological backlog cannot hold the request open forever. */
const MAX_BATCHES = 10;

/**
 * 401, hand-built: `UNAUTHORIZED` is not an `ApiErrorCode` (the contract's table
 * has no auth row, because nothing else in v1 is authenticated), so `apiError()`
 * cannot express it. `ApiError.error` is a plain string, so the body still matches
 * the documented envelope.
 *
 * The message deliberately does not say whether the secret was missing, wrong or
 * unconfigured.
 */
function unauthorized(): NextResponse {
  const body: ApiError = {
    error: 'UNAUTHORIZED',
    message: 'Invalid or missing cron secret.',
  };
  return NextResponse.json(body, {
    status: 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // `isCronAuthorized` does the constant-time compare and fails closed when
    // CRON_SECRET is unset. Log that case separately: it means the sweeper is
    // effectively dead and dead holds will accumulate in the unique index.
    if (!process.env.CRON_SECRET) {
      console.error('[cron/expire] CRON_SECRET is not configured — rejecting all calls');
      return unauthorized();
    }
    if (!isCronAuthorized(request)) {
      return unauthorized();
    }

    let expired = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const swept = await expireStaleReservations(new Date(), BATCH_SIZE);
      expired += swept;
      if (swept < BATCH_SIZE) {
        break;
      }
    }

    const body: CronExpireResponse = { expired };
    return jsonOk(body, { cache: 'no-store' });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
