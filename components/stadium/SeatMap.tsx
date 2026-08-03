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
 * Pan / zoom is hand-rolled viewBox maths (wheel-to-cursor, drag pan, two-finger
 * pinch) — deliberately no dependency. Hit-testing is delegated through one
 * listener on the root using `data-seat-id`, instead of 1,200 handlers.
 *
 * Fat-finger guard: on touch/pen, a tap only *selects* a seat once the map is
 * zoomed past `tapZoomThreshold`; below it the tap zooms in on that spot
 * instead. Mouse clicks always select. The guard covers mutation only — a tap on
 * an occupied seat still says whose it is on the first tap (see `finishPointer`).
 *
 * Keyboard: roving tabindex — one seat is in the tab order, arrows move between
 * seats (row-aware), Enter/Space toggles, `+`/`-`/`0` drive the zoom.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

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

/** Client (page) pixels → subsector-local units. */
function clientToSvg(
  rect: { left: number; top: number; width: number; height: number },
  view: ViewBox,
  clientX: number,
  clientY: number,
): Vec {
  const scale = fitScale(rect, view);
  const off = letterbox(rect, view);
  return {
    x: view.x + (clientX - rect.left - off.x) / scale,
    y: view.y + (clientY - rect.top - off.y) / scale,
  };
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

/** Keep the view inside the base box; centre it when it is larger. */
function clampView(view: ViewBox, base: ViewBox): ViewBox {
  const x =
    view.w >= base.w
      ? base.x + (base.w - view.w) / 2
      : Math.min(Math.max(view.x, base.x), base.x + base.w - view.w);
  const y =
    view.h >= base.h
      ? base.y + (base.h - view.h) / 2
      : Math.min(Math.max(view.y, base.y), base.y + base.h - view.h);
  return { x, y, w: view.w, h: view.h };
}

/** Zoom to `targetZoom` (1 = whole subsector) keeping `focus` under the cursor. */
function zoomToward(
  base: ViewBox,
  view: ViewBox,
  targetZoom: number,
  focus: Vec,
  maxZoom: number,
): ViewBox {
  const zoom = Math.min(Math.max(targetZoom, 1), maxZoom);
  const w = base.w / zoom;
  const h = base.h / zoom;
  const next: ViewBox = {
    x: focus.x - (focus.x - view.x) * (w / view.w),
    y: focus.y - (focus.y - view.y) * (h / view.h),
    w,
    h,
  };
  return clampView(next, base);
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
 * (i.e. once per poll) — never on the pan/zoom re-renders in between.
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

interface RowLabel {
  row: number;
  /** Position along the row's own axis centre (y for horizontal rows, x for vertical). */
  across: number;
  /** The two ends of the row, along the direction the seats run. */
  start: number;
  end: number;
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
  /** Fires when a seat was tapped but the fat-finger guard swallowed it. */
  onTapBlocked?: () => void;
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
  showControls?: boolean;
  /** Zoom below which touch taps zoom instead of selecting. Default 1.6. */
  tapZoomThreshold?: number;
  maxZoom?: number;
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
  onTapBlocked,
  onSeatUnavailable,
  locale = DEFAULT_LOCALE,
  className,
  seatSize,
  showRowLabels = true,
  showPitchHint = true,
  pitchSide = 'top',
  showControls = true,
  tapZoomThreshold = 1.6,
  maxZoom = 8,
  isRefreshing = false,
}: SeatMapProps) {
  const stableSeats = useStableSeats(seats);
  const selected = useStableSelection(selectedSeatIds);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  /* --- geometry ------------------------------------------------------ */

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
    // labels straight off the top and bottom edges.
    const gutter = size * (showRowLabels ? 2.6 : 1.2);
    const alongX = rowsAreHorizontal(pitchSide);
    const padX = alongX ? gutter : size * 1.2;
    const padY = alongX ? size * 1.2 : gutter;
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
  ]);

  const base = geometry.base;
  const size = geometry.size;
  const baseKey = viewBoxString(base);

  /* --- view state ---------------------------------------------------- */

  const [viewOverride, setViewOverride] = useState<ViewBox | null>(null);
  const [baseSnapshot, setBaseSnapshot] = useState(baseKey);
  // Derive-during-render reset: a new subsector (or a rescaled base) starts
  // from the full view instead of keeping a stale, out-of-range viewBox.
  if (baseSnapshot !== baseKey) {
    setBaseSnapshot(baseKey);
    setViewOverride(null);
  }
  const view = viewOverride ?? base;
  const zoom = base.w / view.w;

  const viewRef = useRef(view);
  viewRef.current = view;
  const baseRef = useRef(base);
  baseRef.current = base;

  const applyView = useCallback((next: ViewBox) => {
    setViewOverride(clampView(next, baseRef.current));
  }, []);

  const zoomBy = useCallback(
    (factor: number, focus?: Vec) => {
      const current = viewRef.current;
      const centre = focus ?? { x: current.x + current.w / 2, y: current.y + current.h / 2 };
      setViewOverride(
        zoomToward(baseRef.current, current, (baseRef.current.w / current.w) * factor, centre, maxZoom),
      );
    },
    [maxZoom],
  );

  const resetView = useCallback(() => setViewOverride(null), []);

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
    const grouped = new Map<number, SeatDTO[]>();
    for (const seat of stableSeats) {
      const list = grouped.get(seat.row);
      if (list) list.push(seat);
      else grouped.set(seat.row, [seat]);
    }
    const rows = [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, list]) => ({ row, seats: [...list].sort((a, b) => a.number - b.number) }));

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

  interface Gesture {
    pointers: Map<number, Vec>;
    mode: 'none' | 'pan' | 'pinch';
    multiTouch: boolean;
    downTarget: EventTarget | null;
    pointerType: string;
    downClient: Vec;
    downTime: number;
    moved: boolean;
    rect: { left: number; top: number; width: number; height: number };
    startView: ViewBox;
    startScale: number;
    pinchStartDist: number;
    pinchStartSvg: Vec;
  }

  const emptyRect = { left: 0, top: 0, width: 0, height: 0 };
  const gesture = useRef<Gesture>({
    pointers: new Map(),
    mode: 'none',
    multiTouch: false,
    downTarget: null,
    pointerType: 'mouse',
    downClient: { x: 0, y: 0 },
    downTime: 0,
    moved: false,
    rect: emptyRect,
    startView: base,
    startScale: 1,
    pinchStartDist: 0,
    pinchStartSvg: { x: 0, y: 0 },
  });

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const g = gesture.current;
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (g.pointers.size === 1) {
      // Press-to-peek: a phone cannot hover, so the press itself opens the
      // bubble. It is anchored above the seat, never under the finger.
      if (event.pointerType !== 'mouse') {
        const seatId = seatIdFromTarget(event.target);
        if (seatId !== null) commitHover(seatId);
      }
      const rect = svg.getBoundingClientRect();
      g.mode = 'pan';
      g.multiTouch = false;
      g.downTarget = event.target;
      g.pointerType = event.pointerType;
      g.downClient = { x: event.clientX, y: event.clientY };
      g.downTime = event.timeStamp;
      g.moved = false;
      g.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      g.startView = viewRef.current;
      g.startScale = fitScale(rect, viewRef.current);
      return;
    }

    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.mode = 'pinch';
      g.multiTouch = true;
      g.startView = viewRef.current;
      g.pinchStartDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      g.pinchStartSvg = clientToSvg(
        g.rect,
        g.startView,
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
      );
    }
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (g.mode === 'pinch' && g.pointers.size >= 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const factor = dist / g.pinchStartDist;
      const startZoom = baseRef.current.w / g.startView.w;
      const targetZoom = Math.min(Math.max(startZoom * factor, 1), maxZoom);
      const w = baseRef.current.w / targetZoom;
      const h = baseRef.current.h / targetZoom;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const probe: ViewBox = { x: 0, y: 0, w, h };
      const scale = fitScale(g.rect, probe);
      const off = letterbox(g.rect, probe);
      applyView({
        x: g.pinchStartSvg.x - (midX - g.rect.left - off.x) / scale,
        y: g.pinchStartSvg.y - (midY - g.rect.top - off.y) / scale,
        w,
        h,
      });
      // A pinch is navigation, not reading — the peek goes with it.
      if (!g.moved) commitHover(null);
      g.moved = true;
      return;
    }

    if (g.mode !== 'pan') return;
    const dx = event.clientX - g.downClient.x;
    const dy = event.clientY - g.downClient.y;
    if (!g.moved && Math.hypot(dx, dy) < TAP_MAX_PX) return;
    // Past the tap slop this is a drag, not a read: drop the peek so the bubble
    // does not ride along over seats the finger is only passing.
    if (!g.moved && g.pointerType !== 'mouse') commitHover(null);
    g.moved = true;
    applyView({
      x: g.startView.x - dx / g.startScale,
      y: g.startView.y - dy / g.startScale,
      w: g.startView.w,
      h: g.startView.h,
    });
  };

  const finishPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    const wasTracking = g.pointers.delete(event.pointerId);
    if (!wasTracking) return;

    if (g.pointers.size >= 1) {
      // Second finger lifted: fall back to panning with what is left.
      const remaining = [...g.pointers.values()][0];
      g.mode = 'pan';
      g.downClient = remaining;
      g.startView = viewRef.current;
      g.startScale = fitScale(g.rect, viewRef.current);
      g.moved = true;
      return;
    }

    // Let a touch peek linger past the lift so it can actually be read, then
    // fade by itself. Without this the bubble stayed up until the next touch —
    // a real bug in the previous version, where nothing cleared it at all.
    if (g.pointerType !== 'mouse') scheduleHover(null, TOUCH_PEEK_MS);

    const isTap =
      !g.moved && !g.multiTouch && event.timeStamp - g.downTime < TAP_MAX_MS && g.mode === 'pan';
    g.mode = 'none';
    if (!isTap) return;

    const seatId = seatIdFromTarget(g.downTarget);
    const coarse = g.pointerType !== 'mouse';

    if (coarse && zoom < tapZoomThreshold) {
      // Fat-finger guard: at landing zoom a seat glyph is ~4.6 px wide, so zoom
      // into the tapped spot rather than guessing which seat was meant.
      const focus = clientToSvg(g.rect, g.startView, event.clientX, event.clientY);
      zoomBy(Math.max(tapZoomThreshold / Math.max(zoom, 0.001), 1.9), focus);

      // D3. …but the guard exists to stop a fat finger MUTATING the wrong seat.
      // Reading whose seat it is mutates nothing, and the app has already
      // committed to a seat — `handlePointerDown` opened the peek bubble on it.
      // Staying silent about the seat we just picked is the inconsistency, and it
      // is why the toast `seatHolder.ts` calls the primary TOUCH affordance
      // needed two taps while the bubble that is `aria-hidden` answered on the
      // first. This branch can reach `onSeatUnavailable` only, never
      // `onSeatToggle`, so an ambiguous tap can announce the wrong seat but can
      // never book one. `onSeatToggle` gates it for the same reason `activate`
      // does: a read-only map has nothing to refuse.
      const tapped = seatId === null ? undefined : seatById.get(seatId);
      if (
        onSeatToggle &&
        tapped !== undefined &&
        !isSeatSelectable(seatVisualState(tapped, selected.has(tapped.id)))
      ) {
        setActiveSeatId(tapped.id);
        onSeatUnavailable?.(tapped);
        return;
      }
      // A FREE seat still opens nothing on tap 1 — `isSeatSelectable('FREE')` is
      // true, so it falls through to here and the zoom above is the whole answer.
      if (seatId) onTapBlocked?.();
      return;
    }
    if (seatId) activate(seatId);
  };

  const handlePointerCancel = (event: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    g.pointers.delete(event.pointerId);
    if (g.pointers.size === 0) {
      g.mode = 'none';
      if (g.pointerType !== 'mouse') scheduleHover(null, TOUCH_PEEK_MS);
    }
  };

  // Non-passive wheel listener: React registers `onWheel` passively, so
  // `preventDefault()` there would be ignored and the page would scroll.
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const focus = clientToSvg(rect, viewRef.current, event.clientX, event.clientY);
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-step / 320);
      zoomBy(factor, focus);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const handleDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    zoomBy(1.8, clientToSvg(rect, viewRef.current, event.clientX, event.clientY));
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
      case '+':
      case '=':
        event.preventDefault();
        zoomBy(1.4);
        return;
      case '-':
      case '_':
        event.preventDefault();
        zoomBy(1 / 1.4);
        return;
      case '0':
        event.preventDefault();
        resetView();
        return;
      default:
    }
  };

  /* --- render layers ------------------------------------------------- */

  const rowLabels = useMemo<RowLabel[]>(() => {
    if (!showRowLabels) return [];
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
    return [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, entry]) => ({
        row,
        across: entry.across / entry.count,
        start: blockStart,
        end: blockEnd,
      }));
  }, [showRowLabels, stableSeats, pitchSide]);

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
  const canSelectByTap = zoom >= tapZoomThreshold;

  return (
    <div
      // Frameless on purpose: callers put the map inside their own panel.
      className={cn('relative overflow-hidden rounded-xl bg-surface', className)}
    >
      <div
        ref={containerRef}
        className="relative w-full"
        style={{ aspectRatio: `${base.w} / ${base.h}` }}
      >
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
          onDoubleClick={handleDoubleClick}
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
              {rowLabels.map((label) => {
                // Labels sit just past each end of the row, whichever axis the
                // row runs along, and are anchored so they grow *away* from the
                // seats. With a centred anchor a two-digit number is twice as
                // wide as a one-digit one and half of that width lands on top of
                // the last seat — which is exactly what rows 10+ looked like.
                const horizontal = rowsAreHorizontal(pitchSide);
                const pad = size * 0.7;
                const ends: Array<{ at: number; anchor: 'start' | 'end' }> = [
                  { at: label.start - pad, anchor: 'end' },
                  { at: label.end + pad, anchor: 'start' },
                ];
                return (
                  <g key={label.row}>
                    {ends.map(({ at, anchor }) => (
                      <text
                        key={anchor}
                        x={horizontal ? at : label.across}
                        y={horizontal ? label.across : at}
                        // On a vertical row the labels sit above and below it, so
                        // the growth direction is the baseline, not the anchor.
                        textAnchor={horizontal ? anchor : 'middle'}
                        dominantBaseline={
                          horizontal ? 'central' : anchor === 'end' ? 'auto' : 'hanging'
                        }
                        fontSize={labelSize}
                      >
                        {label.row}
                      </text>
                    ))}
                  </g>
                );
              })}
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

      {interactive && !canSelectByTap ? (
        <p className="pointer-events-none absolute left-3 top-3 rounded-md bg-surface-raised/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          {t(locale, 'map.seatMapHint')}
        </p>
      ) : null}

      {isRefreshing ? (
        <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-md bg-surface-raised/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
          <span className="sr-only">{t(locale, 'common.loading')}</span>
        </span>
      ) : null}

      {showControls ? (
        <div className="mt-2 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => zoomBy(1.4)}
            aria-label={t(locale, 'map.zoomIn')}
            className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-raised text-foreground shadow-sm transition-colors hover:bg-muted motion-reduce:transition-none"
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.4)}
            aria-label={t(locale, 'map.zoomOut')}
            className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-raised text-foreground shadow-sm transition-colors hover:bg-muted motion-reduce:transition-none"
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={resetView}
            aria-label={t(locale, 'map.zoomReset')}
            className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-raised text-foreground shadow-sm transition-colors hover:bg-muted motion-reduce:transition-none"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
