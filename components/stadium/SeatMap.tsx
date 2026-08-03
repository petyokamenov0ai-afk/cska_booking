/**
 * SeatMap — level 3 of the drill-down: one subsector's seats (≈400–1,200 nodes).
 *
 * Plain SVG, no canvas, no virtualisation — at this size it is comfortably fast
 * as long as a status poll does not force React to re-render every node. Two
 * things make that hold:
 *
 *   1. `useStableSeats` — a poll hands back a brand-new array of brand-new
 *      objects every 7 s. We fingerprint it (id + status + mine + holder + note)
 *      and keep the previous array when nothing meaningful moved, so the seat
 *      layer memo does not invalidate.
 *   2. Seats receive **primitives only** and are `memo`ised, so when one seat's
 *      status flips only that seat re-renders.
 *
 * There is no pan and no zoom: the whole subsector is always in view, sized to
 * fill whatever box the caller gives the map (the SVG letterboxes itself via
 * `preserveAspectRatio`), so a tap is always a selection. Hit-testing is
 * delegated through one listener on the root using `data-seat-id`, instead of
 * 1,200 handlers.
 *
 * Keyboard: roving tabindex — one seat is in the tab order, arrows move between
 * seats (row-aware), Enter/Space toggles.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Seat, { isSeatSelectable, seatVisualState } from '@/components/stadium/Seat';
import SeatTooltip from '@/components/stadium/SeatTooltip';
import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type { SeatDTO, SubsectorMeta } from '@/lib/types';

/* ------------------------------------------------------------------ *
 * viewBox maths
 * ------------------------------------------------------------------ */

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Vec {
  x: number;
  y: number;
}

function parseViewBox(value: string, fallbackW: number, fallbackH: number): ViewBox {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  return { x: 0, y: 0, w: fallbackW > 0 ? fallbackW : 1000, h: fallbackH > 0 ? fallbackH : 1000 };
}

function viewBoxString(view: ViewBox): string {
  return `${view.x} ${view.y} ${view.w} ${view.h}`;
}

/** Uniform scale of a `preserveAspectRatio="xMidYMid meet"` viewport. */
function fitScale(rect: { width: number; height: number }, view: ViewBox): number {
  if (view.w <= 0 || view.h <= 0) return 1;
  return Math.min(rect.width / view.w, rect.height / view.h);
}

function letterbox(rect: { width: number; height: number }, view: ViewBox): Vec {
  const scale = fitScale(rect, view);
  return { x: (rect.width - view.w * scale) / 2, y: (rect.height - view.h * scale) / 2 };
}

/** Subsector-local units → pixels inside the map container. */
function svgToContainer(
  size: { width: number; height: number },
  view: ViewBox,
  point: Vec,
): Vec {
  const scale = fitScale(size, view);
  const off = letterbox(size, view);
  return { x: off.x + (point.x - view.x) * scale, y: off.y + (point.y - view.y) * scale };
}

/* ------------------------------------------------------------------ *
 * Seat-array stabilisation
 * ------------------------------------------------------------------ */

function seatFingerprint(seats: readonly SeatDTO[]): string {
  let out = '';
  for (const seat of seats) {
    // The holder is part of what a seat *renders* (its accessible name and its
    // tooltip), so it belongs in the print. Without it, a seat released and
    // re-booked by someone else between two polls keeps the same status and
    // `mine`, `useStableSeats` keeps the old array, the seat-layer memo never
    // invalidates — and the map serves the previous holder's name for ever.
    // Length-prefixed so a name containing `|` cannot forge a record boundary.
    const holder = seat.holder === null ? '-' : `${seat.holder.length}~${seat.holder}`;
    // The note renders too (bubble caption and accessible name), so it is here
    // for exactly the same reason and length-prefixed for exactly the same one.
    // Omitting it means a seat whose note was edited between two polls keeps the
    // old array, the seat-layer memo never invalidates, and the map serves the
    // stale note for ever.
    const note = seat.note === null ? '-' : `${seat.note.length}~${seat.note}`;
    out += `${seat.id}:${seat.status}${seat.mine ? 'm' : ''}:${holder}:${note}|`;
  }
  return out;
}

/**
 * Returns a reference that only changes when something a seat *renders* changed.
 * The fingerprint is computed only when the incoming array identity changes
 * (i.e. once per poll) — never on the hover/selection re-renders in between.
 */
function useStableSeats(seats: readonly SeatDTO[]): readonly SeatDTO[] {
  const cache = useRef<{ source: readonly SeatDTO[]; print: string; value: readonly SeatDTO[] }>({
    source: seats,
    print: seatFingerprint(seats),
    value: seats,
  });

  if (cache.current.source !== seats) {
    const print = seatFingerprint(seats);
    cache.current = {
      source: seats,
      print,
      value: print === cache.current.print ? cache.current.value : seats,
    };
  }
  return cache.current.value;
}

function selectionKey(input: ReadonlySet<string> | readonly string[] | undefined): string {
  if (!input) return '';
  const ids = input instanceof Set ? [...input] : [...input];
  return ids.sort().join('|');
}

/** Content-stable `Set` of selected ids, whatever shape the caller passes. */
function useStableSelection(
  input: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  const key = selectionKey(input);
  const cache = useRef<{ key: string; value: ReadonlySet<string> }>({
    key,
    value: new Set(key === '' ? [] : key.split('|')),
  });
  if (cache.current.key !== key) {
    cache.current = { key, value: new Set(key === '' ? [] : key.split('|')) };
  }
  return cache.current.value;
}

/* ------------------------------------------------------------------ *
 * Geometry derived from the seat data
 * ------------------------------------------------------------------ */

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Seat glyph size, inferred from the data rather than hard-coded: the drawing's
 * units are abstract and the real pipeline output may not share the fixture's
 * scale.
 */
function estimateSeatSize(seats: readonly SeatDTO[], fallback: number): number {
  if (seats.length < 2) return fallback;

  // Orientation-free: measure the gap to each seat's nearest neighbour in 2-D
  // rather than along x. Rows run horizontally on А/В but VERTICALLY on Б/Г, so
  // an x-based in-row spacing collapses to ~0 there and every seat would render
  // sub-pixel. Nearest-neighbour distance is the seat pitch on any orientation.
  //
  // O(n log n) via a coarse grid: n is ~1,000 here, and the grid keeps a full
  // pairwise scan off the render path.
  const bucket = Math.max(estimateSpan(seats) / 60, 1e-6);
  const grid = new Map<string, SeatDTO[]>();
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  for (const seat of seats) {
    const k = key(Math.floor(seat.x / bucket), Math.floor(seat.y / bucket));
    const cell = grid.get(k);
    if (cell) cell.push(seat);
    else grid.set(k, [seat]);
  }

  const nearest: number[] = [];
  for (const seat of seats) {
    const cx = Math.floor(seat.x / bucket);
    const cy = Math.floor(seat.y / bucket);
    let best = Number.POSITIVE_INFINITY;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (other === seat) continue;
          const d = Math.hypot(other.x - seat.x, other.y - seat.y);
          if (d > 0.01 && d < best) best = d;
        }
      }
    }
    if (Number.isFinite(best)) nearest.push(best);
  }

  // 0.8 of the pitch leaves a visible gap between adjacent seats.
  const size = nearest.length > 0 ? median(nearest) * 0.8 : fallback;
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

/** Largest extent of the seat cloud, used to size the lookup grid. */
function estimateSpan(seats: readonly SeatDTO[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const seat of seats) {
    if (seat.x < minX) minX = seat.x;
    if (seat.x > maxX) maxX = seat.x;
    if (seat.y < minY) minY = seat.y;
    if (seat.y > maxY) maxY = seat.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

export type PitchSide = 'top' | 'bottom' | 'left' | 'right';

/** Reserves `band` units on `side` of the box, for the pitch strip. */
function growForBand(box: ViewBox, band: number, side: PitchSide): ViewBox {
  if (band <= 0) return box;
  switch (side) {
    case 'top':
      return { x: box.x, y: box.y - band, w: box.w, h: box.h + band };
    case 'bottom':
      return { x: box.x, y: box.y, w: box.w, h: box.h + band };
    case 'left':
      return { x: box.x - band, y: box.y, w: box.w + band, h: box.h };
    case 'right':
      return { x: box.x, y: box.y, w: box.w + band, h: box.h };
  }
}

/** The pitch strip's own rect inside a box already grown by `growForBand`. */
function bandRect(box: ViewBox, band: number, side: PitchSide): ViewBox {
  switch (side) {
    case 'top':
      return { x: box.x, y: box.y, w: box.w, h: band };
    case 'bottom':
      return { x: box.x, y: box.y + box.h - band, w: box.w, h: band };
    case 'left':
      return { x: box.x, y: box.y, w: band, h: box.h };
    case 'right':
      return { x: box.x + box.w - band, y: box.y, w: band, h: box.h };
  }
}

/** Rows run across the pitch direction: horizontal for top/bottom, vertical for left/right. */
function rowsAreHorizontal(side: PitchSide): boolean {
  return side === 'top' || side === 'bottom';
}

/**
 * Largest angular deviation (degrees) of the seat glyphs from their circular
 * mean. A straight stand sits within a few degrees of one direction; the curved
 * corner blocks (Г17, Г22, the Б corners) sweep 30–60°, and that sweep is what
 * bends the rows. Circular, not min/max of raw degrees: А's seats mix -179° and
 * +179°, which are 2° apart, not 358°.
 */
function maxAngleDeviationDeg(seats: readonly SeatDTO[]): number {
  if (seats.length === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (const seat of seats) {
    const rad = (seat.angle * Math.PI) / 180;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
  }
  const mean = Math.atan2(sy, sx);
  let max = 0;
  for (const seat of seats) {
    const rad = (seat.angle * Math.PI) / 180;
    let d = Math.abs(rad - mean) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > max) max = d;
  }
  return (max * 180) / Math.PI;
}

/** Above this the block is treated as curved and row labels follow each row. */
const CURVED_DEVIATION_DEG = 8;

/** One row number, fully positioned — the render step just prints these. */
interface PlacedRowLabel {
  key: string;
  row: number;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  baseline: 'auto' | 'central' | 'hanging';
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface SeatMapProps {
  /** Header from `GET …/seats`; only the geometry fields are used. */
  subsector: Pick<SubsectorMeta, 'code' | 'latin' | 'viewBox' | 'width' | 'height'>;
  seats: readonly SeatDTO[];
  /** Locally selected seat ids (from `lib/basketStore`). */
  selectedSeatIds?: ReadonlySet<string> | readonly string[];
  /** Fires for selectable seats only. */
  onSeatToggle?: (seat: SeatDTO) => void;
  /** Fires when a non-selectable seat was activated. */
  onSeatUnavailable?: (seat: SeatDTO) => void;
  locale?: Locale;
  className?: string;
  /** Override the inferred seat glyph width, in subsector units. */
  seatSize?: number;
  showRowLabels?: boolean;
  /** Draws the "pitch" band on the side the pitch actually is, for orientation. */
  showPitchHint?: boolean;
  /**
   * Which side of this block the pitch lies on, i.e. the side row 1 faces.
   * Comes from `pitchSide` in data/stadium.json: А->top, Б->left, В->bottom,
   * Г->right. Rows run horizontally for top/bottom and vertically for left/right,
   * so this also decides which axis the row labels sit on.
   */
  pitchSide?: PitchSide;
  /** Shows a subtle "updating" pip while a poll is in flight. */
  isRefreshing?: boolean;
}

/** Also the ceiling on a press-to-peek: hold longer and it stops being a tap. */
const TAP_MAX_MS = 500;
const TAP_MAX_PX = 8;

/* --- hover intent ---------------------------------------------------- *
 * Sweeping a mouse across 1,200 seats used to strobe the bubble through every
 * seat on the way to the one you wanted. These four numbers turn that into one
 * deliberate bubble that then follows you along a row.
 * --------------------------------------------------------------------- */

/** Rest this long on a seat before the first bubble appears. */
const HOVER_OPEN_DELAY_MS = 90;
/**
 * Once a bubble is up the next seat is instant — re-delaying inside a row makes
 * the map feel like it is resisting you. This is the grace window that keeps it
 * instant just after one closes.
 */
const HOVER_WARM_MS = 400;
/** Leaving a seat holds the bubble briefly, so the gap between two adjacent
 *  seats does not blink it away. */
const HOVER_CLOSE_DELAY_MS = 120;
/** Touch peek: a press shows the bubble, and it fades on its own after this.
 *  Raised from 2200 when the bubble gained a clamped note line: 2.2 s is not
 *  enough to read three extra rows before it fades. */
const TOUCH_PEEK_MS = 3200;

export default function SeatMap({
  subsector,
  seats,
  selectedSeatIds,
  onSeatToggle,
  onSeatUnavailable,
  locale = DEFAULT_LOCALE,
  className,
  seatSize,
  showRowLabels = true,
  showPitchHint = true,
  pitchSide = 'top',
  isRefreshing = false,
}: SeatMapProps) {
  const stableSeats = useStableSeats(seats);
  const selected = useStableSelection(selectedSeatIds);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  /* --- geometry ------------------------------------------------------ */

  /** Curved corner block? Decides how the row labels are laid out. A merged
   *  grouped corner (seats carrying `block`) always takes the curved path: its
   *  row numbers repeat across members, which the straight gutters — keyed on
   *  the row number alone — cannot represent. */
  const curved = useMemo(
    () =>
      maxAngleDeviationDeg(stableSeats) > CURVED_DEVIATION_DEG ||
      stableSeats.some((seat) => seat.block !== undefined),
    [stableSeats],
  );

  const geometry = useMemo(() => {
    const declared = parseViewBox(subsector.viewBox, subsector.width, subsector.height);
    const size = seatSize ?? estimateSeatSize(stableSeats, declared.w / 40);

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const seat of stableSeats) {
      if (seat.x < minX) minX = seat.x;
      if (seat.x > maxX) maxX = seat.x;
      if (seat.y < minY) minY = seat.y;
      if (seat.y > maxY) maxY = seat.y;
    }

    if (!Number.isFinite(minX)) {
      const band = showPitchHint ? size * 1.9 : 0;
      return { base: growForBand(declared, band, pitchSide), size, band };
    }

    // Room for the row labels sitting outside the outermost seats. Rows run
    // horizontally on А/В and vertically on Б/Г, so the gutter has to be on the
    // matching axis — reserving it sideways on a vertical-row stand clipped the
    // labels straight off the top and bottom edges. On a CURVED corner block the
    // rows bend through both axes, so the gutter is reserved on both.
    const gutter = size * (showRowLabels ? 2.6 : 1.2);
    const alongX = rowsAreHorizontal(pitchSide);
    const padX = curved || alongX ? gutter : size * 1.2;
    const padY = curved || !alongX ? gutter : size * 1.2;
    const left = Math.min(declared.x, minX - padX);
    const top = Math.min(declared.y, minY - padY);
    const right = Math.max(declared.x + declared.w, maxX + padX);
    const bottom = Math.max(declared.y + declared.h, maxY + padY);
    const band = showPitchHint ? size * 1.9 : 0;

    return {
      base: growForBand({ x: left, y: top, w: right - left, h: bottom - top }, band, pitchSide),
      size,
      band,
    };
  }, [
    subsector.viewBox,
    subsector.width,
    subsector.height,
    stableSeats,
    seatSize,
    showRowLabels,
    showPitchHint,
    pitchSide,
    curved,
  ]);

  const base = geometry.base;
  const size = geometry.size;
  // No pan and no zoom: the viewBox IS the base box, always. The map fills the
  // caller's container and `preserveAspectRatio` letterboxes the difference.
  const view = base;

  /* --- container size (for tooltip placement) ------------------------ */

  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rect = entry.contentRect;
      setBoxSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* --- seat lookup + keyboard navigation model ----------------------- */

  const seatById = useMemo(() => {
    const map = new Map<string, SeatDTO>();
    for (const seat of stableSeats) map.set(seat.id, seat);
    return map;
  }, [stableSeats]);

  const nav = useMemo(() => {
    // Keyed on block + row, not row alone: a merged grouped corner carries two
    // or three independently-numbered blocks on one canvas, so "row 5" exists
    // two or three times — as DIFFERENT physical rows. On a plain subsector
    // `block` is absent and this collapses to the row number.
    const grouped = new Map<string, { block: string; row: number; seats: SeatDTO[] }>();
    for (const seat of stableSeats) {
      const key = `${seat.block ?? ''}|${seat.row}`;
      const entry = grouped.get(key);
      if (entry) entry.seats.push(seat);
      else grouped.set(key, { block: seat.block ?? '', row: seat.row, seats: [seat] });
    }
    const rows = [...grouped.values()]
      .sort((a, b) =>
        a.block === b.block ? a.row - b.row : a.block < b.block ? -1 : 1,
      )
      .map((entry) => ({
        ...entry,
        seats: [...entry.seats].sort((a, b) => a.number - b.number),
      }));

    const index = new Map<string, { rowIndex: number; seatIndex: number }>();
    rows.forEach((entry, rowIndex) => {
      entry.seats.forEach((seat, seatIndex) => index.set(seat.id, { rowIndex, seatIndex }));
    });
    return { rows, index, firstId: rows[0]?.seats[0]?.id ?? null };
  }, [stableSeats]);

  const [activeSeatId, setActiveSeatId] = useState<string | null>(null);
  const activeId =
    activeSeatId !== null && nav.index.has(activeSeatId) ? activeSeatId : nav.firstId;

  // Only steal focus after an explicit keyboard move, never on mount/poll.
  const focusEpoch = useRef(0);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (focusTick === 0 || activeId === null) return;
    const escaped = activeId.replace(/["\\]/g, '\\$&');
    const node = svgRef.current?.querySelector<SVGGElement>(`[data-seat-id="${escaped}"]`);
    node?.focus();
  }, [focusTick, activeId]);

  const moveActive = useCallback(
    (dRow: number, dSeat: number, absolute?: 'start' | 'end') => {
      if (nav.rows.length === 0) return;
      const current = activeId !== null ? nav.index.get(activeId) : undefined;
      const rowIndex = Math.min(
        Math.max((current?.rowIndex ?? 0) + dRow, 0),
        nav.rows.length - 1,
      );
      const row = nav.rows[rowIndex];
      let seatIndex: number;
      if (absolute === 'start') seatIndex = 0;
      else if (absolute === 'end') seatIndex = row.seats.length - 1;
      else seatIndex = Math.min(Math.max((current?.seatIndex ?? 0) + dSeat, 0), row.seats.length - 1);
      const next = row.seats[seatIndex];
      if (!next) return;
      setActiveSeatId(next.id);
      focusEpoch.current += 1;
      setFocusTick(focusEpoch.current);
    },
    [activeId, nav],
  );

  /* --- activation ---------------------------------------------------- */

  /** No toggle handler = read-only map (sales closed, or a hold is in place). */
  const interactive = Boolean(onSeatToggle);

  const activate = useCallback(
    (seatId: string) => {
      const seat = seatById.get(seatId);
      if (!seat) return;
      setActiveSeatId(seat.id);
      if (!onSeatToggle) return;
      if (!isSeatSelectable(seatVisualState(seat, selected.has(seat.id)))) {
        onSeatUnavailable?.(seat);
        return;
      }
      onSeatToggle(seat);
    },
    [onSeatToggle, onSeatUnavailable, seatById, selected],
  );

  function seatIdFromTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const node = target.closest('[data-seat-id]');
    return node?.getAttribute('data-seat-id') ?? null;
  }

  /* --- hover tooltip ------------------------------------------------- */

  /**
   * `session` is the bubble's identity, not the seat's. Moving to a neighbour
   * keeps the session, so the tooltip element stays mounted and *glides*;
   * opening fresh mints a new one, so it fades in with nothing to slide from.
   */
  const [hover, setHover] = useState<{ id: string; session: number } | null>(null);
  // The ref is the authority — `setHover` only mirrors it. Timers fire outside
  // React's render cycle and must not read a stale closure.
  const hoverRef = useRef(hover);
  const hoverTimer = useRef<number | null>(null);
  const warmUntil = useRef(0);
  const sessionSeq = useRef(0);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const commitHover = useCallback(
    (id: string | null) => {
      clearHoverTimer();
      const prev = hoverRef.current;
      if (id === null) {
        if (prev !== null) warmUntil.current = Date.now() + HOVER_WARM_MS;
        hoverRef.current = null;
        setHover(null);
        return;
      }
      if (prev?.id === id) return;
      const next = { id, session: prev !== null ? prev.session : ++sessionSeq.current };
      hoverRef.current = next;
      setHover(next);
    },
    [clearHoverTimer],
  );

  const scheduleHover = useCallback(
    (id: string | null, delay: number) => {
      clearHoverTimer();
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null;
        commitHover(id);
      }, delay);
    },
    [clearHoverTimer, commitHover],
  );

  const handlePointerOver = (event: React.PointerEvent<SVGSVGElement>) => {
    // Touch drives the bubble from the press path instead; a `pointerover` from
    // a finger would otherwise leave it stuck until you touched something else.
    if (event.pointerType !== 'mouse') return;
    const seatId = seatIdFromTarget(event.target);
    if (seatId === hoverRef.current?.id) {
      clearHoverTimer();
      return;
    }
    if (seatId === null) {
      scheduleHover(null, HOVER_CLOSE_DELAY_MS);
      return;
    }
    const warm = hoverRef.current !== null || Date.now() < warmUntil.current;
    if (warm) commitHover(seatId);
    else scheduleHover(seatId, HOVER_OPEN_DELAY_MS);
  };

  /**
   * Mouse off the map entirely — no grace period, the pointer is gone.
   *
   * Guarded on `mouse` because a *touch* pointer stops existing when the finger
   * lifts, so the UA fires `pointerleave` at the end of every tap. Unguarded,
   * that fired immediately after `finishPointer` had scheduled the peek and
   * killed the bubble in the same frame — the press-to-peek read as broken.
   * The touch lifetime is owned by the press path alone.
   */
  const handlePointerLeave = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'mouse') return;
    commitHover(null);
  };

  // No timer may outlive the component: it would call setState on an unmounted
  // tree, and on a subsector switch it would resurrect a seat that is gone.
  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const hovered = hover !== null ? seatById.get(hover.id) : undefined;
  const tooltip =
    hovered && boxSize.width > 0
      ? svgToContainer(boxSize, view, { x: hovered.x, y: hovered.y })
      : null;
  // Half the seat glyph, in container px — the bubble's anchor gap. `Seat`
  // draws itself `size * 0.92` tall, and `fitScale` is the same conversion
  // `svgToContainer` just used.
  const seatHalfPx =
    boxSize.width > 0 ? ((size * 0.92) / 2) * fitScale(boxSize, view) : 0;

  /* --- pointer gestures --------------------------------------------- */

  /**
   * With pan and zoom gone, the only gesture left is the tap itself — but it
   * still has to be hand-tracked: a press that slides off a seat, outlives
   * `TAP_MAX_MS`, or was ever part of a two-finger gesture must not book one.
   */
  interface TapGesture {
    /** The pointer being tracked; anything else is ignored. */
    pointerId: number | null;
    /** A second finger landed at some point — whatever this was, not a tap. */
    multiTouch: boolean;
    downTarget: EventTarget | null;
    pointerType: string;
    downClient: Vec;
    downTime: number;
    moved: boolean;
  }

  const gesture = useRef<TapGesture>({
    pointerId: null,
    multiTouch: false,
    downTarget: null,
    pointerType: 'mouse',
    downClient: { x: 0, y: 0 },
    downTime: 0,
    moved: false,
  });

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (g.pointerId !== null) {
      // A second finger. Nothing multi-touch selects, and the peek goes too.
      g.multiTouch = true;
      commitHover(null);
      return;
    }
    // Press-to-peek: a phone cannot hover, so the press itself opens the
    // bubble. It is anchored above the seat, never under the finger.
    if (event.pointerType !== 'mouse') {
      const seatId = seatIdFromTarget(event.target);
      if (seatId !== null) commitHover(seatId);
    }
    g.pointerId = event.pointerId;
    g.multiTouch = false;
    g.downTarget = event.target;
    g.pointerType = event.pointerType;
    g.downClient = { x: event.clientX, y: event.clientY };
    g.downTime = event.timeStamp;
    g.moved = false;
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (g.pointerId !== event.pointerId || g.moved) return;
    const dx = event.clientX - g.downClient.x;
    const dy = event.clientY - g.downClient.y;
    if (Math.hypot(dx, dy) < TAP_MAX_PX) return;
    // Past the tap slop this is a scrub, not a read: drop the peek so the
    // bubble does not ride along over seats the finger is only passing.
    if (g.pointerType !== 'mouse') commitHover(null);
    g.moved = true;
  };

  const finishPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (g.pointerId !== event.pointerId) return;

    // Let a touch peek linger past the lift so it can actually be read, then
    // fade by itself. Without this the bubble stayed up until the next touch —
    // a real bug in the previous version, where nothing cleared it at all.
    if (g.pointerType !== 'mouse') scheduleHover(null, TOUCH_PEEK_MS);

    const isTap = !g.moved && !g.multiTouch && event.timeStamp - g.downTime < TAP_MAX_MS;
    const target = g.downTarget;
    g.pointerId = null;
    g.downTarget = null;
    if (!isTap) return;

    const seatId = seatIdFromTarget(target);
    if (seatId) activate(seatId);
  };

  const handlePointerCancel = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (g.pointerId !== event.pointerId) return;
    g.pointerId = null;
    g.downTarget = null;
    if (g.pointerType !== 'mouse') scheduleHover(null, TOUCH_PEEK_MS);
  };

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveActive(0, -1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveActive(0, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(1, 0);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveActive(-1, 0);
        return;
      case 'Home':
        event.preventDefault();
        moveActive(0, 0, 'start');
        return;
      case 'End':
        event.preventDefault();
        moveActive(0, 0, 'end');
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (activeId) activate(activeId);
        return;
      default:
    }
  };

  /* --- render layers ------------------------------------------------- */

  const rowLabels = useMemo<PlacedRowLabel[]>(() => {
    if (!showRowLabels) return [];

    if (curved) {
      // Curved corner block: the rows are arcs, so the shared straight gutters
      // below have no meaning — projecting an arc onto one axis is what strewed
      // the numbers across the middle of the corner maps. Instead each label
      // sits just past its own row's two END seats, pushed outward along the
      // row's local direction (the line to the neighbouring seat), which
      // follows the curve wherever it turns.
      const labels: PlacedRowLabel[] = [];
      const pad = size * 1.5;
      const place = (rowKey: string, row: number, end: SeatDTO, neighbour: SeatDTO, key: string) => {
        const dx = end.x - neighbour.x;
        const dy = end.y - neighbour.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return;
        labels.push({
          key: `${rowKey}:${key}`,
          row,
          x: end.x + (dx / len) * pad,
          y: end.y + (dy / len) * pad,
          anchor: 'middle',
          baseline: 'central',
        });
      };
      for (const entry of nav.rows) {
        const seats = entry.seats;
        if (seats.length < 2) continue; // a lone seat has no row direction
        const rowKey = `${entry.block}|${entry.row}`;
        place(rowKey, entry.row, seats[0], seats[1], 'start');
        place(rowKey, entry.row, seats[seats.length - 1], seats[seats.length - 2], 'end');
      }
      return labels;
    }

    // A row extends along the seat direction and is offset along the row
    // direction. Which of those is x and which is y depends on the stand: rows
    // are horizontal on А/В (pitch top/bottom) and vertical on Б/Г.
    const horizontal = rowsAreHorizontal(pitchSide);
    const acc = new Map<number, { across: number; count: number; min: number; max: number }>();
    for (const seat of stableSeats) {
      const across = horizontal ? seat.y : seat.x;
      const along = horizontal ? seat.x : seat.y;
      const entry = acc.get(seat.row);
      if (entry) {
        entry.across += across;
        entry.count += 1;
        entry.min = Math.min(entry.min, along);
        entry.max = Math.max(entry.max, along);
      } else {
        acc.set(seat.row, { across, count: 1, min: along, max: along });
      }
    }
    // Both labels of every row sit in the SAME two gutters, taken from the whole
    // block's extent — not at each row's own ends. Following the ends puts the
    // label of a short row in the middle of the map, on top of its neighbours'
    // seats, which is what the ragged columns of stray numbers were.
    let blockStart = Number.POSITIVE_INFINITY;
    let blockEnd = Number.NEGATIVE_INFINITY;
    for (const entry of acc.values()) {
      if (entry.min < blockStart) blockStart = entry.min;
      if (entry.max > blockEnd) blockEnd = entry.max;
    }
    const pad = size * 0.7;
    return [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([row, entry]) => {
        const across = entry.across / entry.count;
        // Labels sit just past each end of the row, whichever axis the row runs
        // along, anchored so they grow *away* from the seats: with a centred
        // anchor a two-digit number is twice as wide as a one-digit one and
        // half of that width lands on top of the last seat — which is exactly
        // what rows 10+ looked like.
        const ends: Array<{ at: number; side: 'start' | 'end' }> = [
          { at: blockStart - pad, side: 'start' },
          { at: blockEnd + pad, side: 'end' },
        ];
        return ends.map(({ at, side }): PlacedRowLabel => {
          if (horizontal) {
            return {
              key: `${row}:${side}`,
              row,
              x: at,
              y: across,
              anchor: side === 'start' ? 'end' : 'start',
              baseline: 'central',
            };
          }
          // On a vertical row the labels sit above and below it, so the growth
          // direction is the baseline, not the anchor.
          return {
            key: `${row}:${side}`,
            row,
            x: across,
            y: at,
            anchor: 'middle',
            baseline: side === 'start' ? 'auto' : 'hanging',
          };
        });
      });
  }, [showRowLabels, curved, nav, stableSeats, pitchSide, size]);

  const seatNodes = useMemo(
    () =>
      stableSeats.map((seat) => (
        <Seat
          key={seat.id}
          id={seat.id}
          row={seat.row}
          number={seat.number}
          x={seat.x}
          y={seat.y}
          angle={seat.angle}
          type={seat.type}
          white={seat.white}
          block={seat.block ?? null}
          state={seatVisualState(seat, selected.has(seat.id))}
          holder={seat.holder}
          note={seat.note}
          size={size}
          active={seat.id === activeId}
          interactive={interactive}
          locale={locale}
        />
      )),
    [stableSeats, selected, size, activeId, interactive, locale],
  );

  const labelSize = size * 0.9;

  return (
    <div
      // Frameless on purpose: callers put the map inside their own panel.
      // The map fills whatever box it is given — the caller owns the height
      // (e.g. `flex-1 min-h-0` to take the rest of the viewport) and the SVG
      // letterboxes the subsector into it.
      className={cn('relative overflow-hidden rounded-xl bg-surface', className)}
    >
      <div ref={containerRef} className="relative h-full w-full">
        <svg
          ref={svgRef}
          viewBox={viewBoxString(view)}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={t(locale, 'subsector.label', { code: `${subsector.code} / ${subsector.latin}` })}
          className="block size-full touch-none select-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={handlePointerCancel}
          onPointerOver={handlePointerOver}
          onPointerLeave={handlePointerLeave}
          onKeyDown={handleKeyDown}
        >
          <title>
            {t(locale, 'subsector.label', { code: `${subsector.code} / ${subsector.latin}` })}
          </title>

          {geometry.band > 0
            ? (() => {
                const strip = bandRect(base, geometry.band, pitchSide);
                const cx = strip.x + strip.w / 2;
                const cy = strip.y + strip.h / 2;
                // On a left/right strip the label has to turn with it; upright
                // text will not fit in a band two seats wide.
                const turn = pitchSide === 'left' ? -90 : pitchSide === 'right' ? 90 : 0;
                return (
                  <g aria-hidden="true">
                    <rect
                      x={strip.x}
                      y={strip.y}
                      width={strip.w}
                      height={strip.h}
                      rx={geometry.band * 0.25}
                      className="fill-pitch/15"
                    />
                    <text
                      x={cx}
                      y={cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={geometry.band * 0.5}
                      className="fill-pitch font-semibold"
                      style={{ letterSpacing: geometry.band * 0.06 }}
                      transform={turn ? `rotate(${turn} ${cx} ${cy})` : undefined}
                    >
                      {t(locale, 'map.pitch').toUpperCase()}
                    </text>
                  </g>
                );
              })()
            : null}

          {rowLabels.length > 0 ? (
            <g aria-hidden="true" className="fill-seat-label tabular">
              {rowLabels.map((label) => (
                <text
                  key={label.key}
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  dominantBaseline={label.baseline}
                  fontSize={labelSize}
                >
                  {label.row}
                </text>
              ))}
            </g>
          ) : null}

          <g>{seatNodes}</g>
        </svg>

        {tooltip && hovered && hover ? (
          // Keyed on the hover *session*, not the seat: within one session the
          // element stays mounted and slides between seats, which is the whole
          // point of scanning a row. A new session remounts it, so it fades in
          // at the new place instead of flying across the map.
          <SeatTooltip
            key={hover.session}
            row={hovered.row}
            number={hovered.number}
            block={hovered.block ?? null}
            x={tooltip.x}
            y={tooltip.y}
            state={seatVisualState(hovered, selected.has(hovered.id))}
            type={hovered.type}
            holder={hovered.holder}
            note={hovered.note}
            locale={locale}
            containerWidth={boxSize.width}
            seatHalfPx={seatHalfPx}
          />
        ) : null}
      </div>

      {isRefreshing ? (
        <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-md bg-surface-raised/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
          <span className="sr-only">{t(locale, 'common.loading')}</span>
        </span>
      ) : null}
    </div>
  );
}
