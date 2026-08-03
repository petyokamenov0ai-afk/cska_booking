/**
 * SeatTooltip — `Ред 4 · Място 12`, plus who the seat is for.
 *
 * An HTML overlay rather than SVG text, so it never scales or rotates with the
 * map's viewBox and always renders at a readable size. `SeatMap` converts the
 * hovered seat's subsector-local coordinates to container pixels and passes
 * them in; positioning is purely presentational here.
 *
 * Two nested elements, and the split matters: the **positioner** carries the
 * container-pixel offset as a transform and *transitions* it, so while the
 * bubble stays mounted (see `key` on the caller) moving along a row makes it
 * glide on the compositor instead of teleporting. The **bubble** inside carries
 * alignment, the entrance fade and the looks.
 *
 * `aria-hidden`: the same information is already in each seat's accessible name
 * — including the holder, which `Seat` appends — so announcing it twice would
 * only add noise.
 */

'use client';

import { useEffect, useState } from 'react';
import { User } from 'lucide-react';

import { holderLabel, noteLabel, seatHasHolder } from '@/components/stadium/seatHolder';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type { SeatType } from '@/lib/types';
import type { SeatVisualState } from '@/components/stadium/Seat';

/** Gap between the seat edge and the bubble, in container px. */
const GAP = 8;

/**
 * Bubble max width in container px. `EDGE_MARGIN` is DERIVED from it, so
 * widening the bubble can never forget to move the horizontal flip threshold and
 * clip it at the container edge. The value is unchanged from the `max-w-[15rem]`
 * this replaces — the note is clamped rather than given more room, so a seat
 * *without* one keeps today's placement byte for byte.
 */
const TOOLTIP_MAX_W = 240;

/** Half the bubble's max width plus a margin — the horizontal flip threshold. */
const EDGE_MARGIN = TOOLTIP_MAX_W / 2 + 12;

/**
 * Room a two-line bubble needs above the seat. Deterministic rather than
 * measured: a measure-then-flip would thrash layout on every pointer move, and
 * the bubble's height is bounded by `line-clamp-2`.
 */
const TOOLTIP_SAFE_HEIGHT = 68;

/** What a three-line note adds: `mt-0.5` plus 3 × 16.2 px at `text-[12px]`/1.35.
 *  Asked for only when there IS a note, which is exactly the case that would
 *  otherwise be clipped by the map root's `overflow-hidden` in row 1 of a
 *  `pitchSide: 'top'` block. */
const TOOLTIP_NOTE_HEIGHT = 52;

const ACCENT: Record<SeatVisualState, string> = {
  FREE: 'border-l-seat-free',
  SELECTED: 'border-l-seat-selected',
  MINE: 'border-l-seat-mine',
  HELD: 'border-l-seat-held',
  RESERVED: 'border-l-seat-reserved',
  // `--seat-blocked` is near-white and would be invisible against the bubble.
  BLOCKED: 'border-l-muted-foreground/40',
};

export interface SeatTooltipProps {
  row: number;
  number: number;
  /** The seat's real subsector, shown only on merged grouped-corner maps where
   *  `row`/`number` repeat across members. */
  block?: string | null;
  /**
   * Pixel offset inside the map container. `y` is the seat **centre** — the
   * bubble owns the anchor gap, because only it knows which side it will sit on.
   */
  x: number;
  y: number;
  state?: SeatVisualState;
  type?: SeatType;
  /** Who the seat is for; `null` on a booking that carries no name. */
  holder?: string | null;
  /** Free text attached to the same reservation, rendered as a caption under
   *  the holder line. `null` on a booking that carries none. */
  note?: string | null;
  locale?: Locale;
  /** Container width in px, used to keep the bubble from clipping at the edges. */
  containerWidth?: number;
  /**
   * Half the seat's rendered height in container px — the anchor gap, and with
   * `y` it is all that is needed to decide whether the bubble fits above.
   */
  seatHalfPx?: number;
  className?: string;
}

export default function SeatTooltip({
  row,
  number,
  block = null,
  x,
  y,
  state,
  type = 'STANDARD',
  holder,
  note,
  locale = DEFAULT_LOCALE,
  containerWidth,
  seatHalfPx = 0,
  className,
}: SeatTooltipProps) {
  const main =
    (block ? `${block} · ` : '') + t(locale, 'map.seatTooltip', { row, number });
  // Both gated on the SAME `seatHasHolder` call, so a note can never appear
  // where a holder line cannot. Re-checked here even though `lib/availability`
  // already nulls both, so a standalone `<SeatTooltip>` handed a stale note
  // still cannot annotate a free seat.
  const info = state && seatHasHolder(state) ? holderLabel(locale, holder) : null;
  const noteText = state && seatHasHolder(state) ? noteLabel(note) : null;

  // Entrance only — the same rAF flag idiom the toasts use. Within one hover
  // session the element stays mounted, so this runs once and the bubble then
  // glides rather than re-fading at each seat.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Flip the bubble towards the middle when the seat sits near an edge.
  const nearRight = containerWidth !== undefined && x > containerWidth - EDGE_MARGIN;
  const nearLeft = x < EDGE_MARGIN;
  const alignX = nearRight ? '-translate-x-[100%]' : nearLeft ? 'translate-x-0' : '-translate-x-1/2';

  // Row 1 of a `pitchSide: 'top'` block sits hard against the container's top
  // edge, and the map root is `overflow-hidden` — without this flip the bubble
  // is simply clipped away for the whole first row.
  const safeHeight = TOOLTIP_SAFE_HEIGHT + (noteText !== null ? TOOLTIP_NOTE_HEIGHT : 0);
  const below = y - seatHalfPx - GAP < safeHeight;
  const anchorY = below ? y + seatHalfPx + GAP : y - seatHalfPx - GAP;

  return (
    <div
      aria-hidden="true"
      // The bubble is `aria-hidden` by design, so it has no role and no
      // accessible name to locate it by — a test id is the only policy-legal
      // handle, and e2e/README.md carries the justification.
      data-testid="seat-tooltip"
      className="pointer-events-none absolute left-0 top-0 z-20 transition-[transform] duration-150 ease-out motion-reduce:transition-none"
      style={{ transform: `translate3d(${x}px, ${anchorY}px, 0)` }}
    >
      <div
        // The width lives in `TOOLTIP_MAX_W` rather than a Tailwind class so the
        // flip threshold above is derived from it and cannot fall out of step.
        style={{ maxWidth: TOOLTIP_MAX_W }}
        className={cn(
          alignX,
          below ? 'origin-top translate-y-0' : 'origin-bottom -translate-y-full',
          'rounded-md border border-border border-l-[3px] bg-surface-raised px-2 py-1.5 shadow-lg',
          state ? ACCENT[state] : 'border-l-border',
          'transition-[opacity,scale] duration-150 ease-out motion-reduce:transition-none',
          entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
          className,
        )}
      >
        {/* `whitespace-nowrap` belongs to this line alone — the holder line below
            has to be allowed to wrap, or a 120-character name blows the bubble
            off the map. */}
        <div className="whitespace-nowrap text-xs font-medium text-foreground tabular">
          {main}
          {state && state !== 'FREE' ? (
            <span className="ml-1 text-muted-foreground">· {t(locale, `seat.state.${state}`)}</span>
          ) : null}
          {type !== 'STANDARD' ? (
            <span className="ml-1 text-muted-foreground">· {t(locale, `seat.type.${type}`)}</span>
          ) : null}
        </div>

        {info ? (
          <div className="mt-0.5 flex items-start gap-1.5 text-[13px]">
            <User className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/* The note is a CAPTION of the holder line and shares its icon
                column — no second icon, no second import. `min-w-0` so an
                unbroken token shrinks instead of forcing the bubble past its max
                width. The clamps live on the two blocks inside, never on this
                flex row: `line-clamp` sets `display: -webkit-box`, which would
                override `flex` and drop the icon onto its own line. */}
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'line-clamp-2 break-words',
                  // A real name is what the user came to read, so it outweighs
                  // line one; the "no name" placeholder recedes instead.
                  info.named
                    ? 'font-semibold text-foreground'
                    : 'font-normal text-muted-foreground',
                )}
              >
                {info.text}
              </div>
              {noteText ? (
                // No "Бележка:" prefix: a label would eat a third of the three
                // lines the note has, and position plus weight already say what
                // this line is.
                <div className="mt-0.5 line-clamp-3 break-words text-[12px] font-normal leading-[1.35] text-muted-foreground">
                  {noteText}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
