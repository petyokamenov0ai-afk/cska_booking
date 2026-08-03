/**
 * Home = the stadium.
 *
 * There are no match days: the administrator creates and deletes seats when they
 * are needed, so there is nothing to pick before choosing a sector. This page is
 * levels 1–2 of the drill-down (whole bowl, then one stand); clicking a subsector
 * goes to /subsectors/[code].
 */

import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoadingBlock } from '@/components/ui/Spinner';
import { getSubsectorAvailability } from '@/lib/availability';
import { DEFAULT_LOCALE, t } from '@/lib/i18n';
import { getStadiumOverview, listSectors } from '@/lib/stadium';
import { getStadiumEventId } from '@/lib/stadiumEvent';
import type { SectorGeometry } from '@/lib/types';

import StadiumMapClient from './StadiumMapClient';

// Availability is live, and `?sector=` is read on the client.
export const dynamic = 'force-dynamic';

const locale = DEFAULT_LOCALE;

interface RouteSearchParams {
  sector?: string | string[];
}

export const metadata: Metadata = {
  title: t(locale, 'brand.stadium'),
};

/** Geometry only — availability arrives separately and merges in the client. */
function overviewSectors(): SectorGeometry[] {
  return listSectors();
}

function MapSkeleton() {
  return (
    <div className="min-h-0 w-full flex-1 rounded-xl border border-border bg-surface">
      <LoadingBlock locale={locale} className="h-full" />
    </div>
  );
}

async function StadiumMapSection({ initialSector }: { initialSector: string | null }) {
  let eventId: string;
  let availability;
  try {
    eventId = await getStadiumEventId();
    availability = await getSubsectorAvailability(eventId);
  } catch (cause) {
    // A missing / unmigrated database must not blank the whole page.
    console.error('[stadium] failed to load availability', cause);
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-6 py-10 text-center">
        <p className="font-medium text-destructive">{t(locale, 'error.INTERNAL')}</p>
      </div>
    );
  }

  return (
    <StadiumMapClient
      eventId={eventId}
      overview={getStadiumOverview()}
      sectors={overviewSectors()}
      availability={availability}
      initialSector={initialSector}
      locale={locale}
    />
  );
}

export default async function StadiumPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  const raw = Array.isArray(query.sector) ? query.sector[0] : query.sector;
  const initialSector = raw && raw.length > 0 ? raw : null;

  // `flex-1 min-h-0` all the way down, like the seat page: the bowl — and the
  // zoomed stand with its subsector list — fits the viewport with no scrolling.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<MapSkeleton />}>
        <StadiumMapSection initialSector={initialSector} />
      </Suspense>
    </div>
  );
}
