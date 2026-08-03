/**
 * `GET /api/events/:eventId/subsectors/:code/seats` — one subsector's seats with
 * live per-seat status.
 *
 *   200 `{ eventId, subsector: { code, latin, viewBox, width, height,
 *          rowCount, seatCount }, seats: SeatDTO[] }`
 *       `Cache-Control: no-store`
 *
 * `:code` is a **Cyrillic** subsector code (`А1` = U+0410 + `1`), percent-encoded
 * by the client, so it is decoded here and then validated by
 * `subsectorSeatsParamsSchema` — which rejects Latin lookalikes outright, because
 * the app must never route on `latin`.
 *
 * Never cached: the client polls this every ~7 s and the `mine` flag is
 * per-session, so a shared cache entry would leak one visitor's holds to another.
 */

import { NextResponse } from 'next/server';

import { jsonOk, notFoundError, toApiErrorResponse, validationError } from '@/lib/apiError';
import { getSubsectorSeats } from '@/lib/availability';
import { getSessionIdOrAnonymous } from '@/lib/session';
import type { SubsectorSeatsResponse } from '@/lib/types';
import { subsectorSeatsParamsSchema } from '@/lib/zodSchemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Percent-decodes a path segment.
 *
 * Next normally hands dynamic segments over already decoded, so for our alphabet
 * (`[АБВГ]` + digits, which contains no `%`) this is a no-op — but it is kept
 * because decoding behaviour has varied across Next versions and a
 * still-encoded `%D0%901` must not be rejected as "not a Cyrillic code". Do not
 * remove it as dead code.
 *
 * Malformed escapes (`%zz`) make `decodeURIComponent` throw `URIError`; that is a
 * client mistake, so it becomes a 400 rather than a 500.
 */
function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string; code: string }> },
): Promise<NextResponse> {
  try {
    const { eventId, code } = await params;

    const decoded = decodePathSegment(code);
    if (decoded === null) {
      return validationError(undefined, 'Malformed subsector code.');
    }

    const parsed = subsectorSeatsParamsSchema.safeParse({ eventId, code: decoded });
    if (!parsed.success) {
      return validationError(parsed.error, 'Invalid subsector code.');
    }

    // Read path: never mint a cookie here. A prefetched or retried GET could
    // otherwise hand the browser a brand-new session and orphan its real holds.
    // No cookie yet simply means every seat comes back `mine: false`.
    const sessionId = await getSessionIdOrAnonymous();

    const result = await getSubsectorSeats(parsed.data.eventId, parsed.data.code, sessionId);
    if (result === null) {
      return notFoundError('Event or subsector not found.');
    }

    const body: SubsectorSeatsResponse = {
      eventId: parsed.data.eventId,
      subsector: result.subsector,
      seats: result.seats,
    };

    return jsonOk(body, { cache: 'no-store' });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
