/**
 * SectorZoom — levels 1 → 2 of the drill-down, in one place and with **no route
 * change** (IMPLEMENTATION_PLAN.md § 7).
 *
 * Owns the animated `viewBox`: picking a stand eases the SVG from the whole
 * bowl to that stand's bounding box over ~450 ms (`requestAnimationFrame` +
 * ease-in-out-cubic), and jumps instantly when the visitor prefers reduced
 * motion. The zoomed stand shows its 5–6 subsectors enlarged with free-seat
 * count, both inside the shapes and as a tappable list underneath.
 *
 * Controlled or uncontrolled: pass `sector` (plus `onSectorChange`) to keep it
 * in sync with `?sector=<cyrillic>` in the URL, or leave it off and let the
 * component manage the zoom itself.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

import OverviewMap, {
  availabilityLevel,
  sectorBBox,
  sectorSwatch,
  type BBox,
} from '@/components/stadium/OverviewMap';
import Button from '@/components/ui/Button';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type {
  SectorGeometry,
  StadiumOverviewGeometry,
  SubsectorAvailabilityDTO,
} from '@/lib/types';

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const SECTOR_ZOOM_DURATION_MS = 450;

/** Extra room around a stand so it does not touch the edge of the frame. */
const ZOOM_PADDING = 0.08;

/**
 * The frame reshapes itself to the stand being viewed, within these bounds.
 *
 * This matters more than it looks. А and В are wide and shallow (~7:1), Б and Г
 * are tall and narrow (~1:5); forcing either into the bowl's 1.375 landscape
 * frame *zooms out* — the padded box ends up larger than the whole stadium.
 * Letting the panel go to ~2.6 for the end stands and ~0.85 for the side stands
 * buys a real 1.5–1.8× magnification while keeping the whole stand on screen.
 */
const ASPECT_MIN = 0.85;
const ASPECT_MAX = 2.6;

function parseViewBox(value: string, width: number, height: number): ViewBox {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  return { x: 0, y: 0, w: width, h: height };
}

/** Grow a box about its centre to a target aspect ratio. Never shrinks it. */
function toAspect(box: BBox, aspect: number): ViewBox {
  let w = Math.max(box.width, 1);
  let h = Math.max(box.height, 1);
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  return { x: box.x + box.width / 2 - w / 2, y: box.y + box.height / 2 - h / 2, w, h };
}

/** Slide a view back inside `bounds` where it fits; centre it where it does not. */
function clampInside(view: ViewBox, bounds: ViewBox): ViewBox {
  const x =
    view.w <= bounds.w
      ? Math.min(Math.max(view.x, bounds.x), bounds.x + bounds.w - view.w)
      : bounds.x + (bounds.w - view.w) / 2;
  const y =
    view.h <= bounds.h
      ? Math.min(Math.max(view.y, bounds.y), bounds.y + bounds.h - view.h)
      : bounds.y + (bounds.h - view.h) / 2;
  return { x, y, w: view.w, h: view.h };
}

/** Padded stand box → the frame we actually show, aspect-clamped and nudged inside the bowl. */
function frameFor(box: BBox, bounds: ViewBox): ViewBox {
  const raw = box.width / Math.max(box.height, 1);
  const aspect = Math.min(Math.max(raw, ASPECT_MIN), ASPECT_MAX);
  return clampInside(toAspect(box, aspect), bounds);
}

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function sameView(a: ViewBox, b: ViewBox): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.w - b.w) < 0.01 &&
    Math.abs(a.h - b.h) < 0.01
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface SectorZoomProps {
  overview: StadiumOverviewGeometry;
  sectors: readonly SectorGeometry[];
  availability?: readonly SubsectorAvailabilityDTO[];
  /** Controlled focused sector (Cyrillic code). Omit for uncontrolled. */
  sector?: string | null;
  onSectorChange?: (sectorCode: string | null) => void;
  /** Level 3 navigation: the page turns this into a route push. */
  onSelectSubsector?: (subsectorCode: string) => void;
  selectedSubsector?: string | null;
  locale?: Locale;
  durationMs?: number;
  /** Back-to-overview control. Default true — it is how you leave level 2. */
  showBackButton?: boolean;
  className?: string;
}

export default function SectorZoom({
  overview,
  sectors,
  availability,
  sector,
  onSectorChange,
  onSelectSubsector,
  selectedSubsector = null,
  locale = DEFAULT_LOCALE,
  durationMs = SECTOR_ZOOM_DURATION_MS,
  showBackButton = true,
  className,
}: SectorZoomProps) {
  const isControlled = sector !== undefined;
  const [internalSector, setInternalSector] = useState<string | null>(null);
  const focused = isControlled ? (sector ?? null) : internalSector;

  const setFocused = useCallback(
    (code: string | null) => {
      if (!isControlled) setInternalSector(code);
      onSectorChange?.(code);
    },
    [isControlled, onSectorChange],
  );

  const fullView = useMemo(
    () => parseViewBox(overview.viewBox, overview.width, overview.height),
    [overview.viewBox, overview.width, overview.height],
  );
  /** Target viewBox per sector code, computed once from the geometry. */
  const sectorViews = useMemo(() => {
    const map = new Map<string, ViewBox>();
    for (const entry of sectors) {
      const box = sectorBBox(entry);
      if (!box) continue;
      const padded: BBox = {
        x: box.x - box.width * ZOOM_PADDING,
        y: box.y - box.height * ZOOM_PADDING,
        width: box.width * (1 + ZOOM_PADDING * 2),
        height: box.height * (1 + ZOOM_PADDING * 2),
      };
      map.set(entry.code, frameFor(padded, fullView));
    }
    return map;
  }, [sectors, fullView]);

  const targetView = (focused !== null ? sectorViews.get(focused) : undefined) ?? fullView;

  const [view, setView] = useState<ViewBox>(targetView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const frameRef = useRef<number | null>(null);
  const lastTarget = useRef<string | null>(null);

  // Cancel on unmount only. Deliberately *not* the animating effect's cleanup:
  // if a parent re-render hands us a fresh `sectors` array mid-flight, that
  // cleanup would kill the animation halfway.
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const from = viewRef.current;
    const to = targetView;
    const targetKey = `${to.x},${to.y},${to.w},${to.h}`;
    // Compare by value: prop identity churn must not restart an easing run.
    if (lastTarget.current === targetKey) return;
    lastTarget.current = targetKey;
    if (sameView(from, to)) return;

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);

    if (durationMs <= 0 || prefersReducedMotion()) {
      setView(to);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = easeInOutCubic(progress);
      setView({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        w: from.w + (to.w - from.w) * eased,
        h: from.h + (to.h - from.h) * eased,
      });
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(step);
  }, [targetView, durationMs]);

  const focusedSector = useMemo(
    () => sectors.find((entry) => entry.code === focused) ?? null,
    [sectors, focused],
  );

  const availabilityByCode = useMemo(() => {
    const map = new Map<string, SubsectorAvailabilityDTO>();
    for (const entry of availability ?? []) map.set(entry.code, entry);
    return map;
  }, [availability]);

  const sectorName = focusedSector
    ? locale === 'bg'
      ? focusedSector.nameBg
      : focusedSector.name
    : '';

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3', className)}>
      {/* Breadcrumb / hint row */}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {focusedSector ? (
            <span className="tabular">
              <span>{t(locale, 'nav.overview')}</span>
              <span className="mx-1.5 text-border">→</span>
              <span className="font-semibold text-foreground">
                {t(locale, 'sector.label', {
                  code: `${focusedSector.code} / ${focusedSector.latin}`,
                })}
                {sectorName ? ` · ${sectorName}` : ''}
              </span>
            </span>
          ) : (
            t(locale, 'map.overviewHint')
          )}
        </p>
        {showBackButton && focusedSector ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<ChevronLeft className="size-4" aria-hidden="true" />}
            onClick={() => setFocused(null)}
          >
            {t(locale, 'nav.backToOverview')}
          </Button>
        ) : null}
      </div>

      <div
        // No border here: the map is normally already inside a framed panel.
        // `flex-1 min-h-0` rather than an aspect-ratio box: the frame takes
        // whatever height the viewport leaves (so the whole page fits on
        // screen, like the seat maps) and `meet` letterboxes the animated view
        // inside it.
        className="relative min-h-0 w-full flex-1 overflow-hidden rounded-xl bg-surface"
      >
        <OverviewMap
          overview={overview}
          sectors={sectors}
          availability={availability}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          focusedSector={focused}
          selectedSubsector={selectedSubsector}
          onSelectSector={setFocused}
          onSelectSubsector={(code) => onSelectSubsector?.(code)}
          detailLevel="focused"
          locale={locale}
          ariaLabel={
            focusedSector
              ? t(locale, 'sector.label', { code: focusedSector.code })
              : t(locale, 'map.overviewTitle')
          }
        />
      </div>

      {/* Level 2 list: the same subsectors, reachable without hitting an SVG shape. */}
      {focusedSector ? (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">{t(locale, 'map.sectorHint')}</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {focusedSector.subsectors.map((sub) => {
              const entry = availabilityByCode.get(sub.code);
              const level = availabilityLevel(entry?.free, entry?.total);
              const soldOut = level === 'none';
              return (
                <li key={sub.code}>
                  <button
                    type="button"
                    disabled={soldOut}
                    aria-current={selectedSubsector === sub.code ? 'true' : undefined}
                    onClick={() => onSelectSubsector?.(sub.code)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors',
                      'motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      soldOut
                        ? 'cursor-not-allowed border-border bg-muted text-muted-foreground'
                        : 'border-border bg-surface hover:bg-muted',
                      selectedSubsector === sub.code && 'border-primary ring-1 ring-primary',
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      {/* Ties the card back to the block's colour on the map. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-3 shrink-0 rounded-[3px] ring-1 ring-black/10',
                          soldOut ? 'bg-stand-sold' : sectorSwatch(focusedSector.code),
                        )}
                      />
                      <span className="text-base font-semibold text-foreground">{sub.code}</span>
                      {/* Shown on every member of a grouped shape, the caption
                          one included. It is what makes this list *explain* the
                          map — three cards under one wedge — instead of looking
                          like it contradicts it. */}
                      {sub.overviewGroup ? (
                        <span className="text-[11px] text-muted-foreground">
                          {t(locale, 'subsector.partOf', { code: sub.overviewGroup })}
                        </span>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground">{sub.latin}</span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular">
                      {entry
                        ? soldOut
                          ? t(locale, 'subsector.soldOut')
                          : t(locale, 'subsector.seatsFree', {
                              free: entry.free,
                              total: entry.total,
                            })
                        : t(locale, 'common.loading')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
