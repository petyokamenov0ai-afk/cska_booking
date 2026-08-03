/**
 * Level 3 — one subsector's seats, with click-to-book.
 *
 * No event in the path: there are no match days, so the route is just the
 * subsector's (Cyrillic, percent-encoded) code.
 *
 * A code that belongs to a grouped corner (Б6/Б6-2; Б10-2/Б11/Б11-2) gets the
 * whole corner as ONE merged map — `getSubsectorSeats` unrolls the members
 * side by side (see `lib/subsectorGroup.ts`), so this page renders exactly one
 * `SeatMapClient` whatever the code names.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getSubsectorSeats } from '@/lib/availability';
import { formatDualCode } from '@/lib/format';
import { DEFAULT_LOCALE, t } from '@/lib/i18n';
import { getSessionIdOrAnonymous } from '@/lib/session';
import { getStadiumEventId } from '@/lib/stadiumEvent';
import type { SeatDTO, SubsectorMeta } from '@/lib/types';

import SeatMapClient from './SeatMapClient';

// Seat statuses are per-session and never cacheable.
export const dynamic = 'force-dynamic';

const locale = DEFAULT_LOCALE;

interface RouteParams {
  /** URL-encoded Cyrillic subsector code, e.g. `%D0%901` for `А1`. */
  code: string;
}

/** A malformed percent-escape must 404, not throw. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { code } = await params;
  return { title: t(locale, 'subsector.label', { code: safeDecode(code) }) };
}

export default async function SubsectorPage({ params }: { params: Promise<RouteParams> }) {
  const { code } = await params;
  const subsectorCode = safeDecode(code);

  const eventId = await getStadiumEventId();
  // A Server Component cannot mint the cookie, so a first-time visitor reads as
  // anonymous here: every seat comes back `mine: false`, and the first POST
  // (a route handler) sets the real `sid`.
  const sessionId = await getSessionIdOrAnonymous();
  const data = await getSubsectorSeats(eventId, subsectorCode, sessionId);
  if (!data) notFound();

  const subsector: SubsectorMeta = data.subsector;
  const seats: SeatDTO[] = data.seats;

  // No breadcrumbs and no visible header: every pixel of height goes to the
  // map, so the whole subsector fits on screen. The h1 stays for screen
  // readers (the page title alone is not part of the document outline).
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">
        {t(locale, 'subsector.label', {
          code: formatDualCode(subsector.code, subsector.latin),
        })}
      </h1>

      <SeatMapClient
        eventId={eventId}
        subsector={subsector}
        initialSeats={seats}
        locale={locale}
      />
    </div>
  );
}
