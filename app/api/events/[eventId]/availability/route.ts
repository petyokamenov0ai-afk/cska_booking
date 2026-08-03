/**
 * `GET /api/events/:eventId/availability` — free/total seats per subsector.
 *
 * Drives the stadium overview colouring, so every visitor on the event page
 * polls it. One indexed aggregate inside `lib/availability`, plus the 10 s shared
 * cache window the contract mandates:
 *
 *   200 `{ eventId, subsectors: SubsectorAvailabilityDTO[], updatedAt }`
 *       `Cache-Control: public, max-age=10`
 *
 * Lazy expiry (`PENDING AND expiresAt < now()` counts as free) lives in the
 * service, not here.
 */

import { NextResponse } from 'next/server';

import { jsonOk, notFoundError, toApiErrorResponse, validationError } from '@/lib/apiError';
import { eventExists, getSubsectorAvailability } from '@/lib/availability';
import type { AvailabilityResponse, SubsectorAvailabilityDTO } from '@/lib/types';
import { eventParamsSchema } from '@/lib/zodSchemas';

export const runtime = 'nodejs';
// The 10 s freshness window is a response header, not Next's route cache: the
// origin must recount on every miss, or a new hold would stay invisible for a
// whole revalidation period.
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  try {
    const parsed = eventParamsSchema.safeParse(await params);
    if (!parsed.success) {
      return validationError(parsed.error, 'Invalid event id.');
    }
    const { eventId } = parsed.data;

    // `getSubsectorAvailability` returns `[]` for an unknown event, which is
    // indistinguishable from a stadium with no subsectors — hence the probe.
    if (!(await eventExists(eventId))) {
      return notFoundError('Event not found.');
    }

    const subsectors: SubsectorAvailabilityDTO[] = await getSubsectorAvailability(eventId);

    const body: AvailabilityResponse = {
      eventId,
      subsectors,
      updatedAt: new Date().toISOString(),
    };

    return jsonOk(body, { cache: 'availability' });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
