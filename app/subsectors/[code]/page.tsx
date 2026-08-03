/**
 * Level 3 — one subsector's seats, with click-to-book.
 *
 * No event in the path: there are no match days, so the route is just the
 * subsector's (Cyrillic, percent-encoded) code.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import Breadcrumbs, { type Crumb } from '@/components/Breadcrumbs';
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

/** `А1` -> `А`; the sector letter is the code's first character. */
function sectorCodeOf(subsectorCode: string): string {
  return subsectorCode.slice(0, 1);
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
  const sectorCode = sectorCodeOf(subsector.code);

  const crumbs: Crumb[] = [
    { label: t(locale, 'brand.stadium'), href: '/' },
    {
      label: `${t(locale, 'sector.label', { code: sectorCode })} · ${t(locale, `sector.${sectorCode}.name`)}`,
      href: `/?sector=${encodeURIComponent(sectorCode)}`,
    },
    { label: t(locale, 'subsector.label', { code: subsector.code }) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs items={crumbs} />

      <header className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">
          {t(locale, 'subsector.label', {
            code: formatDualCode(subsector.code, subsector.latin),
          })}
        </h1>
        <p className="tabular text-sm text-muted-foreground">
          {subsector.rowCount} × {t(locale, 'common.row')} · {subsector.seatCount}{' '}
          {t(locale, 'common.seats')}
        </p>
      </header>

      <SeatMapClient
        eventId={eventId}
        subsector={subsector}
        initialSeats={seats}
        locale={locale}
      />
    </div>
  );
}
