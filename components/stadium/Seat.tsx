/**
 * Seat — one seat in the SVG seat map.
 *
 * Every prop is a primitive on purpose: `SeatMap` re-derives its render model
 * on each 7 s status poll, and `memo`'s shallow compare then skips every seat
 * whose status did not actually change. Passing the `SeatDTO` object straight
 * through would defeat that (JSON parsing hands back fresh objects each poll).
 *
 * Click handling is normally **delegated** by `SeatMap` (one listener for ~1200
 * nodes) via the `data-seat-id` attribute; `onActivate` exists so a single seat
 * can also be used standalone.
 *
 * State is never conveyed by colour alone: wheelchair / companion / VIP seats
 * carry a glyph, and the accessible name spells the state out.
 */

'use client';

import { memo } from 'react';

// Type-only in the other direction (`SeatVisualState`), so this pair of imports
// is erased at runtime and never forms a cycle.
import { noteAriaFragment, seatHasHolder, visibleText } from '@/components/stadium/seatHolder';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type { SeatDTO, SeatType } from '@/lib/types';

/**
 * What the user sees. `SeatStatus` from the API plus the two client-side
 * distinctions: locally SELECTED, and HELD/RESERVED-by-me (`mine`).
 */
export type SeatVisualState = 'FREE' | 'SELECTED' | 'MINE' | 'HELD' | 'RESERVED' | 'BLOCKED';

/** Map an API seat + local selection onto a visual state. */
export function seatVisualState(
  seat: Pick<SeatDTO, 'status' | 'mine'>,
  isSelected: boolean,
): SeatVisualState {
  if (seat.status === 'BLOCKED') return 'BLOCKED';
  // Server truth first: once the hold exists these seats are really ours.
  if (seat.mine && (seat.status === 'HELD' || seat.status === 'RESERVED')) return 'MINE';
  if (isSelected) return 'SELECTED';
  if (seat.status === 'HELD') return 'HELD';
  if (seat.status === 'RESERVED') return 'RESERVED';
  return 'FREE';
}

/** Can the user still act on this seat? */
export function isSeatSelectable(state: SeatVisualState): boolean {
  return state === 'FREE' || state === 'SELECTED' || state === 'MINE';
}

const FILL_CLASS: Record<SeatVisualState, string> = {
  FREE: 'fill-seat-free',
  SELECTED: 'fill-seat-selected',
  MINE: 'fill-seat-mine',
  HELD: 'fill-seat-held',
  RESERVED: 'fill-seat-reserved',
  BLOCKED: 'fill-seat-blocked',
};

/** Glyph ink, chosen per fill so the pictogram stays legible in both themes. */
const GLYPH_CLASS: Record<SeatVisualState, string> = {
  FREE: 'text-white',
  SELECTED: 'text-white',
  MINE: 'text-white',
  HELD: 'text-black/65 dark:text-white/75',
  RESERVED: 'text-white/85',
  BLOCKED: 'text-black/35 dark:text-white/35',
};

/* ------------------------------------------------------------------ *
 * Glyphs — drawn in a 24×24 box and scaled into the seat.
 * Hand-rolled rather than pulled from an icon set so they stay a single
 * <path>/<circle> group with no nested <svg> viewport per seat.
 * ------------------------------------------------------------------ */

function SeatGlyph({ type, size }: { type: SeatType; size: number }) {
  if (type === 'STANDARD') return null;

  const scale = (size * 0.78) / 24;
  const transform = `scale(${scale}) translate(-12 -12)`;

  if (type === 'WHEELCHAIR') {
    return (
      <g
        transform={transform}
        className="pointer-events-none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <circle cx="9" cy="4" r="2.4" fill="currentColor" stroke="none" />
        <path d="M9 7.4v5.1h6" strokeWidth="2.4" />
        <path d="M15 12.5l2.7 5.6" strokeWidth="2.2" />
        <circle cx="10.2" cy="15.6" r="6" strokeWidth="1.9" />
        <circle cx="10.2" cy="15.6" r="1.1" fill="currentColor" stroke="none" />
      </g>
    );
  }

  if (type === 'COMPANION') {
    return (
      <g transform={transform} className="pointer-events-none" fill="currentColor">
        <rect x="10.6" y="4" width="2.8" height="16" rx="1.4" />
        <rect x="4" y="10.6" width="16" height="2.8" rx="1.4" />
      </g>
    );
  }

  // VIP
  return (
    <path
      transform={transform}
      className="pointer-events-none"
      fill="currentColor"
      d="M12 2.6l2.9 6 6.5.9-4.8 4.6 1.2 6.5L12 17.5 6.2 20.6l1.2-6.5L2.6 9.5l6.5-.9z"
    />
  );
}

/* ------------------------------------------------------------------ *
 * Seat
 * ------------------------------------------------------------------ */

export interface SeatProps {
  id: string;
  row: number;
  number: number;
  /** Subsector-local centre. */
  x: number;
  y: number;
  /** Degrees; non-zero only in the curved corner subsectors. */
  angle: number;
  type: SeatType;
  /** Light "ЦСКА"-letter seat (В stand). Cosmetic only — still bookable. */
  white: boolean;
  /** The seat's real subsector, on merged grouped-corner maps only — there
   *  `row`/`number` repeat across members, so the accessible name leads with
   *  which block this one is in. */
  block?: string | null;
  state: SeatVisualState;
  /**
   * Who the seat is for, when it carries a named reservation. Appended to the
   * accessible name — which is the *only* route to the holder for someone with
   * no pointer, since the hover tooltip is `aria-hidden` by design.
   */
  holder?: string | null;
  /**
   * The free-text note attached to the same reservation. Appended after the
   * holder for the same reason the holder is appended at all: `SeatTooltip` is
   * `aria-hidden` by design, so the accessible name is the only route to it for
   * someone with no pointer, and leaving it out would make the note a
   * sighted-mouse-only feature.
   */
  note?: string | null;
  /** Seat width in subsector units. */
  size: number;
  /**
   * Roving-tabindex owner: exactly one seat in the map has `active` and is
   * therefore reachable with Tab; the arrow keys move it.
   */
  active?: boolean;
  /**
   * False puts the seat in read-only mode (sales closed, hold already placed):
   * no pointer affordance, and it announces itself as disabled while still
   * reporting whether it is part of the selection.
   */
  interactive?: boolean;
  locale?: Locale;
  /** Standalone handler. `SeatMap` leaves this off and delegates instead. */
  onActivate?: (seatId: string) => void;
}

function SeatImpl({
  id,
  row,
  number,
  x,
  y,
  angle,
  type,
  white,
  block = null,
  state,
  holder,
  note,
  size,
  active = false,
  interactive = true,
  locale = DEFAULT_LOCALE,
  onActivate,
}: SeatProps) {
  const inSelection = state === 'SELECTED' || state === 'MINE';
  const selectable = interactive && isSeatSelectable(state);
  const height = size * 0.92;
  const halfW = size / 2;
  const halfH = height / 2;
  const radius = size * 0.28;

  const stateLabel = t(locale, `seat.state.${state}`);
  const typeLabel = type === 'STANDARD' ? '' : `, ${t(locale, `seat.type.${type}`)}`;
  // Only when a name is actually known. Appending "без име" to a nameless
  // booking adds nothing the state word ("Резервирано") did not already say,
  // and the ~1,200 free seats keep their short label — which matters on a page
  // that renders 1,200 of them. `seatHasHolder` is re-checked even though the
  // server already nulls `holder` for FREE/BLOCKED, so a standalone `<Seat>`
  // handed a stale holder still cannot claim a free seat belongs to someone.
  //
  // `visibleText`, not `trim()`: a holder of two zero-width spaces would
  // otherwise end the label with a bare ", за ".
  const holderName = visibleText(holder);
  const holderLabel =
    seatHasHolder(state) && holderName
      ? `, ${t(locale, 'seat.ariaHolder', { name: holderName })}`
      : '';
  // Emitted only for the seats that carry one, so the cost argument above still
  // holds across ~1,200 labels, and clipped at the schema's bound — an
  // accessible name is read aloud, and an unbounded one cannot be interrupted.
  const noteText = seatHasHolder(state) ? noteAriaFragment(note) : null;
  const noteLabelFragment =
    noteText === null ? '' : `, ${t(locale, 'seat.ariaNote', { note: noteText })}`;
  const label =
    (block ? `${block}, ` : '') +
    t(locale, 'seat.aria', { row, number, state: stateLabel }) +
    typeLabel +
    holderLabel +
    noteLabelFragment;

  const transform =
    angle === 0 ? `translate(${x} ${y})` : `translate(${x} ${y}) rotate(${angle})`;

  return (
    <g
      data-seat-id={id}
      data-seat-state={state}
      data-seat-selectable={selectable ? 'true' : 'false'}
      transform={transform}
      role="button"
      tabIndex={active ? 0 : -1}
      aria-label={label}
      aria-pressed={isSeatSelectable(state) ? inSelection : undefined}
      aria-disabled={selectable ? undefined : true}
      className={cn(
        'outline-none',
        GLYPH_CLASS[state],
        selectable ? 'cursor-pointer' : 'cursor-default',
      )}
      onClick={onActivate ? () => onActivate(id) : undefined}
      onKeyDown={
        onActivate
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate(id);
              }
            }
          : undefined
      }
    >
      {inSelection ? (
        <rect
          x={-halfW - 1.7}
          y={-halfH - 1.7}
          width={size + 3.4}
          height={height + 3.4}
          rx={radius + 1.2}
          fill="none"
          className="stroke-foreground"
          strokeWidth={1.3}
        />
      ) : null}

      <rect
        x={-halfW}
        y={-halfH}
        width={size}
        height={height}
        rx={radius}
        className={cn(
          // The light "ЦСКА" seats really are a paler red on the drawing; show
          // that, but only while the seat is free so status still wins.
          white && state === 'FREE' ? 'fill-cska-300 dark:fill-cska-500' : FILL_CLASS[state],
          selectable && state === 'FREE' && 'hover:fill-seat-free-hover',
          state === 'BLOCKED' && 'opacity-60',
        )}
        stroke="var(--seat-stroke)"
        strokeWidth={0.6}
      />

      <SeatGlyph type={type} size={size} />
    </g>
  );
}

/**
 * Shallow-compare memo. Safe because every prop is a primitive except
 * `onActivate`, which callers must keep stable (or omit, as `SeatMap` does).
 */
const Seat = memo(SeatImpl);

export default Seat;
