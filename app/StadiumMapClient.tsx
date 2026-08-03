'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useTransition } from 'react';

import OverviewMap from '@/components/stadium/OverviewMap';
import { cn } from '@/lib/format';
import { t, type Locale } from '@/lib/i18n';
import { apiFetch } from '@/lib/useSeats';
import type {
  AvailabilityResponse,
  SectorGeometry,
  StadiumOverviewGeometry,
  SubsectorAvailabilityDTO,
} from '@/lib/types';

/**
 * The whole stadium, one level deep.
 *
 * The bowl fits the viewport, so the old sector-zoom step (and the subsector
 * card list that came with it) is gone: every block on the map is directly
 * clickable and goes straight to its seat map. This component owns the two
 * things the presentational map cannot:
 *
 *   1. polling the availability endpoint that colours the blocks;
 *   2. navigation to the seats, with the Cyrillic code percent-encoded.
 */
export interface StadiumMapClientProps {
  /**
   * The hidden stadium row's id. Passed down rather than imported:
   * `lib/stadiumEvent.ts` pulls in Prisma, and importing it from a client
   * component bundles the whole client into the browser.
   */
  eventId: string;
  overview: StadiumOverviewGeometry;
  /** Overview geometry with the per-seat payload stripped by the page. */
  sectors: SectorGeometry[];
  availability: SubsectorAvailabilityDTO[];
  locale: Locale;
}

/** `GET …/availability` is `max-age=10`; poll a little slower than the cache. */
const AVAILABILITY_POLL_MS = 20_000;

export default function StadiumMapClient({
  eventId,
  overview,
  sectors,
  availability,
  locale,
}: StadiumMapClientProps) {
  const router = useRouter();
  const [isNavigating, startTransition] = useTransition();

  const { data } = useQuery<AvailabilityResponse>({
    queryKey: ['availability', eventId],
    queryFn: ({ signal }) =>
      apiFetch<AvailabilityResponse>(
        `/api/events/${encodeURIComponent(eventId)}/availability`,
        { signal },
      ),
    // The server already rendered one; start from it instead of a blank map.
    initialData: {
      eventId,
      subsectors: availability,
      updatedAt: new Date(0).toISOString(),
    },
    refetchInterval: AVAILABILITY_POLL_MS,
    staleTime: 10_000,
  });

  const openSubsector = useCallback(
    (code: string) => {
      startTransition(() => {
        router.push(`/subsectors/${encodeURIComponent(code)}`);
      });
    },
    [router],
  );

  return (
    <section
      aria-busy={isNavigating || undefined}
      aria-label={t(locale, 'map.overviewTitle')}
      className={cn('flex min-h-0 flex-1 flex-col', isNavigating && 'opacity-90')}
    >
      <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border bg-surface">
        <OverviewMap
          overview={overview}
          sectors={sectors}
          availability={data.subsectors}
          // One click, one destination: no focus step, every block activates.
          alwaysSelectSubsector
          onSelectSubsector={openSubsector}
          detailLevel="all"
          locale={locale}
        />
      </div>
    </section>
  );
}
