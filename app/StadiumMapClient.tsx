'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useTransition } from 'react';

import SectorZoom from '@/components/stadium/SectorZoom';
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
 * Levels 1–2 of the drill-down, on the home page. `SectorZoom` owns the SVG and
 * the zoom animation; this component owns three things it cannot:
 *
 *   1. the focused sector ⇄ `?sector=<cyrillic>` binding, so a zoomed stand is
 *      shareable and the browser back button steps back out of it;
 *   2. polling the availability endpoint that colours the map;
 *   3. navigation to level 3, with the Cyrillic code percent-encoded.
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
  initialSector: string | null;
  locale: Locale;
}

/** `GET …/availability` is `max-age=10`; poll a little slower than the cache. */
const AVAILABILITY_POLL_MS = 20_000;

export default function StadiumMapClient({
  eventId,
  overview,
  sectors,
  availability,
  initialSector,
  locale,
}: StadiumMapClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isNavigating, startTransition] = useTransition();

  // The URL is the single source of truth for the focused sector.
  const sectorParam = searchParams.get('sector') ?? initialSector;
  const sector = useMemo(
    () => (sectorParam ? (sectors.find((entry) => entry.code === sectorParam) ?? null) : null),
    [sectorParam, sectors],
  );

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

  const setSector = useCallback(
    (code: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      // `URLSearchParams` percent-encodes the Cyrillic code for us.
      if (code) next.set('sector', code);
      else next.delete('sector');
      const query = next.toString();
      startTransition(() => {
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const openSubsector = useCallback(
    (code: string) => {
      startTransition(() => {
        router.push(`/subsectors/${encodeURIComponent(code)}`);
      });
    },
    [router],
  );

  return (
    // No heading or breadcrumb of its own: `SectorZoom` already renders the
    // trail, the hint and a "back to overview" control inside the map frame, so
    // anything here is the same thing said twice. The section carries the name
    // the heading used to, so it is still announced as the stadium map.
    <section
      aria-busy={isNavigating || undefined}
      aria-label={t(locale, 'map.overviewTitle')}
      className={cn('flex min-h-0 flex-1 flex-col gap-4', isNavigating && 'opacity-90')}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
        <SectorZoom
          overview={overview}
          sectors={sectors}
          availability={data.subsectors}
          sector={sector?.code ?? null}
          onSectorChange={setSector}
          onSelectSubsector={openSubsector}
          locale={locale}
        />
      </div>
    </section>
  );
}
