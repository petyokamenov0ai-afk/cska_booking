/**
 * Legend — what the colours mean, kept on screen.
 *
 * Two scales, because the app has two: the six seat states on the level-3 map,
 * and the overview's stand colours. Both pull their swatch classes from the same
 * place the maps do (`OverviewMap` for the stands, the seat tokens for seats), so
 * a palette change cannot leave the legend lying.
 *
 * The overview colours the blocks by **stand**, not by availability, so that is
 * what the swatches show. Availability is on that map as darkness instead, and
 * the two rows underneath say so — using the very same shade the map applies.
 *
 * The wheelchair row is deliberately included: it is the reminder that seat type
 * is communicated by a glyph, not by colour.
 */

'use client';

import type { ReactNode } from 'react';
import { Accessibility } from 'lucide-react';

import {
  SCARCITY_SHADE,
  SECTOR_CODES,
  SECTOR_SWATCH,
} from '@/components/stadium/OverviewMap';
import type { SeatVisualState } from '@/components/stadium/Seat';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';

const SEAT_STATES: readonly SeatVisualState[] = [
  'FREE',
  'SELECTED',
  'MINE',
  'HELD',
  'RESERVED',
  'BLOCKED',
] as const;

const SEAT_SWATCH: Record<SeatVisualState, string> = {
  FREE: 'bg-seat-free',
  SELECTED: 'bg-seat-selected',
  MINE: 'bg-seat-mine',
  HELD: 'bg-seat-held',
  RESERVED: 'bg-seat-reserved',
  BLOCKED: 'bg-seat-blocked',
};

export interface LegendProps {
  /** `'seats'` for the seat map, `'stands'` for the overview. */
  variant?: 'seats' | 'stands' | 'both';
  /**
   * Pin the legend to the viewport (bottom-left, clear of the basket bar)
   * instead of flowing in the layout.
   */
  floating?: boolean;
  locale?: Locale;
  className?: string;
  /** Hide the "Legend" heading. */
  hideTitle?: boolean;
}

function Swatch({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-3.5 shrink-0 rounded-[3px] ring-1 ring-black/10', className)}
    />
  );
}

/**
 * A stand swatch under the map's own scarcity shade, so "running out" is shown
 * by the exact darkening the blocks get rather than by a colour invented here.
 */
function ShadedSwatch({ className, shade }: { className: string; shade: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative size-3.5 shrink-0 overflow-hidden rounded-[3px] ring-1 ring-black/10',
        className,
      )}
    >
      <span
        className="absolute inset-0"
        style={{ backgroundColor: `rgb(0 0 0 / ${shade})` }}
      />
    </span>
  );
}

function Row({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2">
      {swatch}
      <span className="text-xs text-muted-foreground">{label}</span>
    </li>
  );
}

export default function Legend({
  variant = 'seats',
  floating = false,
  locale = DEFAULT_LOCALE,
  className,
  hideTitle = false,
}: LegendProps) {
  const showSeats = variant === 'seats' || variant === 'both';
  const showStands = variant === 'stands' || variant === 'both';

  return (
    <aside
      aria-label={t(locale, 'map.legend.title')}
      className={cn(
        'rounded-xl border border-border bg-surface-raised/95 p-3 shadow-sm backdrop-blur-sm',
        floating && 'fixed bottom-24 left-3 z-30 max-w-[13rem] sm:bottom-28 sm:left-4',
        className,
      )}
    >
      {!hideTitle ? (
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground">
          {t(locale, 'map.legend.title')}
        </h2>
      ) : null}

      {showSeats ? (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {SEAT_STATES.map((state) => (
            <Row
              key={state}
              swatch={<Swatch className={SEAT_SWATCH[state]} />}
              label={t(locale, `seat.state.${state}`)}
            />
          ))}
          <Row
            swatch={
              <Accessibility
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            }
            label={t(locale, 'seat.type.WHEELCHAIR')}
          />
        </ul>
      ) : null}

      {showSeats && showStands ? <hr className="my-2.5 border-border" /> : null}

      {showStands ? (
        <>
          <h3 className="mb-1.5 text-xs font-semibold text-foreground">
            {t(locale, 'map.legend.stands')}
          </h3>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {SECTOR_CODES.map((code) => (
              <Row
                key={code}
                swatch={<Swatch className={SECTOR_SWATCH[code]} />}
                label={`${t(locale, 'sector.label', { code })} · ${t(locale, `sector.${code}.name`)}`}
              />
            ))}
          </ul>

          <h3 className="mb-1.5 mt-2.5 text-xs font-semibold text-foreground">
            {t(locale, 'map.availability.title')}
          </h3>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {(['high', 'medium', 'low'] as const).map((level) => {
              const shade = SCARCITY_SHADE[level];
              return (
                <Row
                  key={level}
                  swatch={
                    shade === undefined ? (
                      <Swatch className={SECTOR_SWATCH['В']} />
                    ) : (
                      <ShadedSwatch className={SECTOR_SWATCH['В']} shade={shade} />
                    )
                  }
                  label={t(locale, `map.availability.${level}`)}
                />
              );
            })}
            <Row
              swatch={<Swatch className="bg-stand-sold" />}
              label={t(locale, 'map.availability.none')}
            />
          </ul>
        </>
      ) : null}
    </aside>
  );
}
