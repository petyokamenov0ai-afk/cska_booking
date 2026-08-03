/**
 * OverviewMap — level 1 (and, zoomed, level 2) of the drill-down.
 *
 * Inline SVG in **overview space** (docs/DATA_CONTRACT.md § Coordinate spaces):
 * the pitch path plus one `<path>` per overview **block**, keyed on its
 * **Cyrillic** code, drawn to match the printed ticket map — one solid colour
 * per stand, white gaps between blocks, and the code set large and bold in
 * white.
 *
 * A block is not always a subsector: the map draws **22 shapes over 25
 * subsectors**, because the ticket map draws two corner wedges whole where we
 * hold two and three independently-numbered blocks (`overviewGroup` in
 * `lib/types.ts`). `overviewBlocks()` collapses them, so a grouped wedge is one
 * shape with one caption, one aggregated availability shade and one hit target
 * rather than three stacked identical paths whose topmost copy would silently
 * own every click. Level-2 navigation into a grouped wedge goes to the card list
 * below the map, which is the only honest destination — see `onSelectGroup`.
 *
 * ## What the fill means
 *
 * Colour is the **stand** (А/Б/В/Г), not availability — that is what makes the
 * bowl legible at a glance. Availability is still on the map, as darkness: a
 * nearly-gone block is dimmed towards black and a sold-out one is blacked out
 * entirely, the way an unavailable block reads on a ticket map. `Legend`
 * explains both scales.
 *
 * Purely presentational and fully controlled: it renders whatever `viewBox` it
 * is handed, which is how `SectorZoom` animates the bowl → stand transition
 * without a route change.
 *
 * The path-geometry helpers (`pathBBox`, `unionBBox`, `sectorBBox`), the stand
 * palette and the availability scale live here too, so the map, the zoom
 * container and the legend cannot drift apart.
 */

'use client';

import { useId, useMemo, useState } from 'react';

import { cn } from '@/lib/format';
import { DEFAULT_LOCALE, t, type Locale } from '@/lib/i18n';
import type {
  Point,
  SectorGeometry,
  StadiumOverviewGeometry,
  SubsectorAvailabilityDTO,
  SubsectorGeometry,
} from '@/lib/types';

/* ------------------------------------------------------------------ *
 * Availability scale
 * ------------------------------------------------------------------ */

export type AvailabilityLevel = 'high' | 'medium' | 'low' | 'none' | 'unknown';

/** % free → bucket. `unknown` when availability has not loaded yet. */
export function availabilityLevel(
  free: number | undefined,
  total: number | undefined,
): AvailabilityLevel {
  if (free === undefined || total === undefined || total <= 0) return 'unknown';
  if (free <= 0) return 'none';
  const ratio = free / total;
  if (ratio >= 0.4) return 'high';
  if (ratio >= 0.15) return 'medium';
  return 'low';
}

/* ------------------------------------------------------------------ *
 * Stand palette
 * ------------------------------------------------------------------ */

/** Ordered for the legend: А Б В Г, the drawing's own order. */
export const SECTOR_CODES: readonly string[] = ['А', 'Б', 'В', 'Г'] as const;

/**
 * One solid colour per stand, keyed on the **Cyrillic** sector code. An unknown
 * code falls back to the neutral stand grey rather than throwing, so a geometry
 * file that grows a fifth stand still renders.
 */
export const SECTOR_FILL: Record<string, string> = {
  'А': 'fill-stand-a', // South — gold
  'Б': 'fill-stand-b', // East  — bright red
  'В': 'fill-stand-v', // North — red
  'Г': 'fill-stand-g', // West  — dark red
};

/** HTML swatch equivalents, for the legend. */
export const SECTOR_SWATCH: Record<string, string> = {
  'А': 'bg-stand-a',
  'Б': 'bg-stand-b',
  'В': 'bg-stand-v',
  'Г': 'bg-stand-g',
};

export function sectorFill(sectorCode: string): string {
  return SECTOR_FILL[sectorCode] ?? 'fill-stand';
}

export function sectorSwatch(sectorCode: string): string {
  return SECTOR_SWATCH[sectorCode] ?? 'bg-stand';
}

/**
 * How far a block is darkened towards black to show it is running out. Sold-out
 * blocks do not use this — they are filled with `--stand-sold` outright, so they
 * read as one flat colour rather than as "very dark red".
 */
export const SCARCITY_SHADE: Partial<Record<AvailabilityLevel, number>> = {
  medium: 0.18,
  low: 0.42,
};

/* ------------------------------------------------------------------ *
 * Label fitting
 * ------------------------------------------------------------------ */

/**
 * Mean glyph advance as a fraction of the font size, for the bold sans the
 * labels render in. Only used to *shrink* a caption that would not fit, so an
 * approximation is enough — the alternative is measuring text, which needs the
 * DOM and would not work during SSR.
 */
const GLYPH_ADVANCE = 0.62;

/**
 * Largest font size at which `text` still fits inside the shape, capped at
 * `preferred`.
 *
 * The bowl is not made of equal blocks. Two classes exist: 18 rectangles and
 * trapezoids that fill their bounding box (0.94–1.00), and 4 corner wedges that
 * fill about 0.73 of theirs while spanning a box as wide as a main stand block.
 * A single font size either overflows the wedges or wastes most of the big
 * blocks, so the budget is the bounding box scaled by how much of it the shape
 * covers — a wedge is given the band it actually occupies to write in rather
 * than the box that band happens to span.
 *
 * Which blocks end up cramped is emergent from that arithmetic, never a list of
 * codes. Grouping is what bought the headroom: the corner the ticket map draws
 * as one 0.73-fill wedge used to be three narrow slices, two of which could not
 * fit their free-seat count at all.
 *
 * Returns `null` when even the floor would not fit, which is the caller's signal
 * to drop the caption rather than draw an unreadable one.
 */
export function fitLabelSize(
  text: string,
  metrics: PathMetrics | undefined,
  preferred: number,
  minimum = preferred * 0.3,
): number | null {
  if (text.length === 0) return null;
  if (metrics === undefined) return preferred;
  const { box, fill } = metrics;
  const usableWidth = box.width * Math.max(fill, 0.2);
  const usableHeight = box.height * Math.max(fill, 0.2);
  const byWidth = (usableWidth * 0.9) / (text.length * GLYPH_ADVANCE);
  const byHeight = usableHeight * 0.55;
  const size = Math.min(preferred, byWidth, byHeight);
  return size >= minimum ? size : null;
}

/* ------------------------------------------------------------------ *
 * Path geometry
 * ------------------------------------------------------------------ */

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PathMetrics {
  box: BBox;
  /** Fraction of the bounding box the shape covers, 0..1. */
  fill: number;
}

const PATH_TOKENS = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * Every point an SVG path visits, in order, computed without touching the DOM
 * (so it works during SSR and in tests, and is available before the element is
 * mounted).
 *
 * Bézier control points are emitted rather than solved for. For a bounding box
 * that yields a superset of the true box — perfectly fine for framing a zoom,
 * and it means smoothed hull outlines from the pipeline need no special case.
 * Elliptical arcs contribute their endpoints only.
 */
export function pathPoints(d: string): Point[] {
  const tokens = d.match(PATH_TOKENS);
  if (!tokens) return [];

  const points: Point[] = [];

  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let command = '';
  let i = 0;

  const include = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    points.push({ x, y });
  };

  const args = (count: number): number[] | null => {
    if (i + count > tokens.length) return null;
    const out: number[] = [];
    for (let k = 0; k < count; k += 1) {
      const value = Number(tokens[i + k]);
      if (!Number.isFinite(value)) return null;
      out.push(value);
    }
    i += count;
    return out;
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if (/[A-Za-z]/.test(token)) {
      command = token;
      i += 1;
      if (command === 'Z' || command === 'z') {
        cx = startX;
        cy = startY;
        include(cx, cy);
        continue;
      }
    } else if (command === '') {
      i += 1;
      continue;
    }

    const relative = command === command.toLowerCase();
    const baseX = relative ? cx : 0;
    const baseY = relative ? cy : 0;

    switch (command.toUpperCase()) {
      case 'M':
      case 'L': {
        const a = args(2);
        if (!a) return finish();
        cx = baseX + a[0];
        cy = baseY + a[1];
        include(cx, cy);
        if (command === 'M') {
          startX = cx;
          startY = cy;
          command = 'L';
        } else if (command === 'm') {
          startX = cx;
          startY = cy;
          command = 'l';
        }
        break;
      }
      case 'H': {
        const a = args(1);
        if (!a) return finish();
        cx = baseX + a[0];
        include(cx, cy);
        break;
      }
      case 'V': {
        const a = args(1);
        if (!a) return finish();
        cy = baseY + a[0];
        include(cx, cy);
        break;
      }
      case 'C': {
        const a = args(6);
        if (!a) return finish();
        include(baseX + a[0], baseY + a[1]);
        include(baseX + a[2], baseY + a[3]);
        cx = baseX + a[4];
        cy = baseY + a[5];
        include(cx, cy);
        break;
      }
      case 'S':
      case 'Q': {
        const a = args(4);
        if (!a) return finish();
        include(baseX + a[0], baseY + a[1]);
        cx = baseX + a[2];
        cy = baseY + a[3];
        include(cx, cy);
        break;
      }
      case 'T': {
        const a = args(2);
        if (!a) return finish();
        cx = baseX + a[0];
        cy = baseY + a[1];
        include(cx, cy);
        break;
      }
      case 'A': {
        const a = args(7);
        if (!a) return finish();
        cx = baseX + a[5];
        cy = baseY + a[6];
        include(cx, cy);
        break;
      }
      default:
        // Unknown command: bail out with whatever we collected.
        return finish();
    }
  }

  return finish();

  function finish(): Point[] {
    return points;
  }
}

/**
 * Bounding box plus how much of that box the shape actually covers (0..1,
 * shoelace area over box area).
 *
 * The coverage is what lets a caption be sized to the *shape* rather than to its
 * box. The bowl's corner slivers run diagonally, so their boxes are nearly as
 * wide as a main stand block's while the usable band inside is a third of that;
 * sizing on the box alone spills their captions straight over the neighbours.
 */
export function pathMetrics(d: string): PathMetrics | null {
  const points = pathPoints(d);
  if (points.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const box: BBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  // Shoelace over the implicitly closed ring. Control points sit outside the
  // true outline, so this slightly over-reports area on curved blocks — which
  // errs towards a larger caption, the safe direction for a rounded shape.
  let twiceArea = 0;
  for (let k = 0; k < points.length; k += 1) {
    const a = points[k];
    const b = points[(k + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  const boxArea = box.width * box.height;
  const fill = boxArea > 0 ? Math.min(1, Math.abs(twiceArea) / 2 / boxArea) : 1;

  return { box, fill };
}

export function pathBBox(d: string): BBox | null {
  return pathMetrics(d)?.box ?? null;
}

export function unionBBox(boxes: readonly (BBox | null)[]): BBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    if (!box) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Bounding box of every subsector in a sector, in overview space.
 *
 * Deliberately still a union over all 25, not over the 22 blocks: a union over
 * duplicated paths is idempotent, so grouping cannot move a level-2 frame.
 */
export function sectorBBox(sector: SectorGeometry): BBox | null {
  return unionBBox(sector.subsectors.map((sub) => pathBBox(sub.svgPath)));
}

/* ------------------------------------------------------------------ *
 * Blocks — the shapes the map actually draws
 * ------------------------------------------------------------------ */

/** Free / total for one subsector, or for a whole block once aggregated. */
export interface AvailabilityEntry {
  free: number;
  total: number;
}

export interface OverviewBlock {
  /** Block code when grouped, else the subsector's own code. Render key + caption. */
  code: string;
  sectorCode: string;
  svgPath: string;
  centroid: Point;
  /** In `order`. Length 1 for the 20 blocks drawn 1:1. */
  members: readonly SubsectorGeometry[];
  grouped: boolean;
}

/**
 * The shapes one stand actually draws — 22 stadium-wide, over 25 subsectors.
 *
 * Deduplication is not cosmetic. Б is ordered `Б6, Б6-2, Б7 … Б10-2, Б11,
 * Б11-2`, and the members of a group carry byte-identical paths, so rendering
 * one shape per subsector stacks three copies of the Б11 wedge and DOM order
 * decides the hit test: every click on that corner would silently land on
 * `Б11-2`, the last one painted.
 */
export function overviewBlocks(sector: SectorGeometry): OverviewBlock[] {
  const order: string[] = [];
  const buckets = new Map<string, SubsectorGeometry[]>();
  for (const sub of sector.subsectors) {
    const key = sub.overviewGroup ?? sub.code;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [sub]);
      order.push(key);
    } else {
      bucket.push(sub);
    }
  }
  return order.map((code) => {
    const members = buckets.get(code)!;
    // Take the shape from the member whose own code IS the block code, so a file
    // whose copies have drifted still draws the representative's polygon rather
    // than whichever member happened to come first in document order.
    const lead = members.find((sub) => sub.code === code) ?? members[0];
    return {
      code,
      sectorCode: sector.code,
      svgPath: lead.svgPath,
      centroid: lead.centroid,
      members,
      grouped: members.length > 1,
    };
  });
}

/**
 * Free / total summed over a block's members, or `undefined` if any is missing.
 *
 * All-or-nothing on purpose. A partial sum would print "301 свободни" on a
 * 924-seat corner and could paint a sold-out block as available; a missing
 * member instead makes the whole block read `unknown`, which is already a
 * rendered state. `total` sums DTO totals, which count only active seats, so a
 * deactivated seat is correctly not capacity — and a block is sold out only when
 * every member is.
 *
 * It lives here rather than in `lib/availability.ts` because that endpoint feeds
 * both this map *and* the 25-card list, which needs the per-subsector numbers;
 * aggregating there would destroy them and change a documented wire shape for a
 * purely visual merge.
 */
export function blockAvailability(
  block: OverviewBlock,
  byCode: ReadonlyMap<string, AvailabilityEntry>,
): AvailabilityEntry | undefined {
  let free = 0;
  let total = 0;
  for (const member of block.members) {
    const entry = byCode.get(member.code);
    if (entry === undefined) return undefined;
    free += entry.free;
    total += entry.total;
  }
  return { free, total };
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface OverviewMapProps {
  overview: StadiumOverviewGeometry;
  sectors: readonly SectorGeometry[];
  /** From `GET /api/events/:id/availability`. Absent → neutral "stand" fill. */
  availability?: readonly SubsectorAvailabilityDTO[];
  /**
   * `viewBox` to render. Defaults to `overview.viewBox`; `SectorZoom` passes an
   * animated value here.
   */
  viewBox?: string;
  /** Cyrillic sector code being zoomed into; others are dimmed. */
  focusedSector?: string | null;
  /** Cyrillic subsector code to outline as current. */
  selectedSubsector?: string | null;
  /** Fired when a subsector in a not-yet-focused sector is activated. */
  onSelectSector?: (sectorCode: string) => void;
  /** Fired when a subsector inside the focused sector is activated. */
  onSelectSubsector?: (subsectorCode: string, sectorCode: string) => void;
  /**
   * Fired instead of `onSelectSubsector` when the activated block covers more
   * than one subsector, because there is no single honest destination: no merged
   * seat map exists and none can be synthesised (each subsector's seats live in
   * their own local space, and `data/stadium.json` records no local→overview
   * transform). The host is expected to surface the members — `SectorZoom`
   * reveals and focuses their cards in the list under the map.
   *
   * Without a handler a grouped block is inert AND LOOKS IT: it leaves the tab
   * order and loses the pointer cursor, rather than silently routing to an
   * arbitrary member.
   */
  onSelectGroup?: (subsectorCodes: readonly string[], sectorCode: string) => void;
  /** Always go straight to the subsector, skipping the sector-zoom step. */
  alwaysSelectSubsector?: boolean;
  /** Show the free-seat count inside the shapes. Default `'focused'`. */
  detailLevel?: 'none' | 'focused' | 'all';
  showLabels?: boolean;
  interactive?: boolean;
  locale?: Locale;
  className?: string;
  ariaLabel?: string;
}

export default function OverviewMap({
  overview,
  sectors,
  availability,
  viewBox,
  focusedSector = null,
  selectedSubsector = null,
  onSelectSector,
  onSelectSubsector,
  onSelectGroup,
  alwaysSelectSubsector = false,
  detailLevel = 'focused',
  showLabels = true,
  interactive = true,
  locale = DEFAULT_LOCALE,
  className,
  ariaLabel,
}: OverviewMapProps) {
  const [focusRing, setFocusRing] = useState<string | null>(null);
  // Several maps can share a page (the zoom container renders one per level),
  // so the pitch clip path needs an id that is unique per instance.
  const uid = useId();

  const availabilityByCode = useMemo(() => {
    const map = new Map<string, AvailabilityEntry>();
    for (const entry of availability ?? []) {
      map.set(entry.code, { free: entry.free, total: entry.total });
    }
    return map;
  }, [availability]);

  const effectiveViewBox = viewBox ?? overview.viewBox;
  const viewNumbers = useMemo(() => {
    const parts = effectiveViewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }
    return { x: 0, y: 0, w: overview.width, h: overview.height };
  }, [effectiveViewBox, overview.width, overview.height]);

  // User-space label size that keeps a roughly constant on-screen size as the
  // viewBox shrinks during a sector zoom.
  const labelSize = viewNumbers.w / 48;

  const pitch = useMemo(() => pathBBox(overview.pitch), [overview.pitch]);

  const sectorLabels = useMemo(
    () =>
      sectors
        .map((sector) => {
          const box = sectorBBox(sector);
          if (!box) return null;
          const centreX = viewNumbers.x + viewNumbers.w / 2;
          const centreY = viewNumbers.y + viewNumbers.h / 2;
          const boxCx = box.x + box.width / 2;
          const boxCy = box.y + box.height / 2;
          const dx = centreX - boxCx;
          const dy = centreY - boxCy;
          const gap = labelSize * 1.1;
          // Push the caption off the stand's inner edge, towards the pitch.
          const point =
            Math.abs(dx) > Math.abs(dy)
              ? { x: dx > 0 ? box.x + box.width + gap : box.x - gap, y: boxCy }
              : { x: boxCx, y: dy > 0 ? box.y + box.height + gap * 1.4 : box.y - gap };
          return { sector, point };
        })
        .filter((entry): entry is { sector: SectorGeometry; point: { x: number; y: number } } =>
          Boolean(entry),
        ),
    [sectors, viewNumbers.x, viewNumbers.y, viewNumbers.w, viewNumbers.h, labelSize],
  );

  // The bowl the stands sit in — the grey surround on the printed map. Derived
  // from the blocks themselves rather than hard-coded, so it still frames the
  // stadium if the geometry changes.
  const bowl = useMemo(() => {
    const box = unionBBox(sectors.map((sector) => sectorBBox(sector)));
    if (box === null) return null;
    const pad = Math.max(box.width, box.height) * 0.045;
    return {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
      radius: Math.min(box.width, box.height) * 0.14,
    };
  }, [sectors]);

  // The 22 shapes, per stand. Everything below draws from this, never from
  // `sector.subsectors` directly — that is what keeps a grouped wedge one shape.
  const blocksBySector = useMemo(() => {
    const map = new Map<string, OverviewBlock[]>();
    for (const sector of sectors) map.set(sector.code, overviewBlocks(sector));
    return map;
  }, [sectors]);

  // One bbox per block, so the label fitter does not re-parse 22 paths on every
  // render (availability polls every 20 s, and the zoom animates the viewBox).
  // Block codes are a subset of subsector codes, so one flat map still works.
  const blockMetrics = useMemo(() => {
    const map = new Map<string, PathMetrics>();
    for (const blocks of blocksBySector.values()) {
      for (const block of blocks) {
        const metrics = pathMetrics(block.svgPath);
        if (metrics !== null) map.set(block.code, metrics);
      }
    }
    return map;
  }, [blocksBySector]);

  // Mown stripes, clipped to the pitch outline. Purely decorative.
  const stripes = useMemo(() => {
    if (pitch === null) return [];
    const count = 8;
    const width = pitch.width / count;
    return Array.from({ length: count }, (_, i) => ({
      key: i,
      x: pitch.x + i * width,
      width,
      dark: i % 2 === 0,
    }));
  }, [pitch]);

  const activate = (block: OverviewBlock, sectorCode: string): void => {
    if (!interactive) return;
    if (!(alwaysSelectSubsector || focusedSector === sectorCode)) {
      // Level 1: a click zooms the stand. A grouped block is not special here,
      // and this is where most taps land.
      onSelectSector?.(sectorCode);
      return;
    }
    if (!block.grouped) {
      onSelectSubsector?.(block.members[0].code, sectorCode);
      return;
    }
    onSelectGroup?.(block.members.map((member) => member.code), sectorCode);
  };

  return (
    <svg
      viewBox={effectiveViewBox}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={ariaLabel ?? t(locale, 'map.overviewTitle')}
      className={cn('block size-full select-none', className)}
    >
      <title>{ariaLabel ?? t(locale, 'map.overviewTitle')}</title>

      <defs>
        <clipPath id={`${uid}-pitch`}>
          <path d={overview.pitch} />
        </clipPath>
      </defs>

      {/* The bowl the stands sit in */}
      {bowl ? (
        <rect
          aria-hidden="true"
          x={bowl.x}
          y={bowl.y}
          width={bowl.width}
          height={bowl.height}
          rx={bowl.radius}
          className="fill-bowl"
        />
      ) : null}

      {/* Pitch + minimal markings */}
      <g aria-hidden="true">
        <path d={overview.pitch} className="fill-pitch" />
        <g clipPath={`url(#${uid}-pitch)`}>
          {stripes.map((stripe) =>
            stripe.dark ? (
              <rect
                key={stripe.key}
                x={stripe.x}
                y={pitch!.y}
                width={stripe.width}
                height={pitch!.height}
                fill="rgb(255 255 255 / 0.055)"
              />
            ) : null,
          )}
        </g>
        {pitch ? (
          <g fill="none" stroke="var(--pitch-line)" strokeWidth={Math.max(1, labelSize * 0.06)}>
            <line
              x1={pitch.x}
              y1={pitch.y + pitch.height / 2}
              x2={pitch.x + pitch.width}
              y2={pitch.y + pitch.height / 2}
            />
            <circle
              cx={pitch.x + pitch.width / 2}
              cy={pitch.y + pitch.height / 2}
              r={Math.min(pitch.width, pitch.height) * 0.13}
            />
          </g>
        ) : null}
      </g>

      {sectors.map((sector) => {
        const dimmed = focusedSector !== null && focusedSector !== sector.code;
        return (
          <g
            key={sector.code}
            data-sector={sector.code}
            className={cn(
              'transition-opacity duration-300 motion-reduce:transition-none',
              dimmed ? 'opacity-25' : 'opacity-100',
            )}
          >
            {(blocksBySector.get(sector.code) ?? []).map((block) => {
              const entry = blockAvailability(block, availabilityByCode);
              const level = availabilityLevel(entry?.free, entry?.total);
              const showDetail =
                detailLevel === 'all' ||
                (detailLevel === 'focused' && focusedSector === sector.code);
              const isSelected = block.members.some((m) => m.code === selectedSubsector);
              const soldOut = level === 'none';
              const shade = SCARCITY_SHADE[level];
              // A grouped block with nowhere to send the visitor must not look
              // clickable. At level 1 it only zooms, so it stays live regardless.
              const zoomedIn = alwaysSelectSubsector || focusedSector === sector.code;
              const activatable =
                interactive && (!zoomedIn || !block.grouped || onSelectGroup !== undefined);

              const metrics = blockMetrics.get(block.code);
              const codeSize = fitLabelSize(block.code, metrics, labelSize * 1.3);
              const detailText =
                entry === undefined
                  ? null
                  : soldOut
                    ? t(locale, 'subsector.soldOut')
                    : `${entry.free} ${t(locale, 'common.free')}`;
              // The count is secondary, so it is only drawn on blocks that had
              // room to spare — ones where the code itself rendered at full size.
              // Fitting each line independently is not enough: on the corner
              // slivers two stacked lines spill out of the band sideways even
              // when neither overflows on its own, and a cramped block is exactly
              // where the count matters least (the list underneath still has it).
              const roomy = codeSize !== null && codeSize >= labelSize * 1.3 * 0.85;
              const detailSize =
                showDetail && roomy && detailText !== null
                  ? fitLabelSize(detailText, metrics, codeSize! * 0.46, labelSize * 0.3)
                  : null;
              const stacked = detailSize !== null;

              // A grouped shape must not be opaque to a screen reader: it names
              // every member, then the aggregate, then where activating it goes.
              const parts = [
                block.grouped
                  ? t(locale, 'subsector.group', {
                      code: block.code,
                      count: block.members.length,
                      members: block.members.map((m) => m.code).join(', '),
                    })
                  : t(locale, 'subsector.label', { code: block.code }),
              ];
              if (entry) {
                parts.push(
                  soldOut
                    ? t(locale, 'subsector.soldOut')
                    : t(locale, 'subsector.seatsFree', { free: entry.free, total: entry.total }),
                );
              }
              if (block.grouped && activatable) parts.push(t(locale, 'subsector.groupHint'));

              return (
                <g
                  key={block.code}
                  // `data-subsector` stays the block code — identical to today
                  // for the 20 blocks drawn 1:1, which is what the e2e specs
                  // drive. `data-subsectors` is the honest full membership.
                  data-subsector={block.code}
                  data-subsectors={block.members.map((m) => m.code).join(' ')}
                  data-overview-group={block.grouped ? 'true' : undefined}
                  role={activatable ? 'button' : undefined}
                  tabIndex={activatable && !dimmed ? 0 : -1}
                  aria-label={parts.join(', ')}
                  aria-current={isSelected ? 'true' : undefined}
                  aria-disabled={activatable ? undefined : true}
                  className={cn(
                    'outline-none',
                    activatable && !dimmed ? 'cursor-pointer' : 'cursor-default',
                  )}
                  onClick={() => activate(block, sector.code)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate(block, sector.code);
                    }
                  }}
                  onFocus={() => setFocusRing(block.code)}
                  onBlur={() => setFocusRing((current) => (current === block.code ? null : current))}
                >
                  <path
                    d={block.svgPath}
                    className={cn(
                      soldOut ? 'fill-stand-sold' : sectorFill(sector.code),
                      'stroke-surface transition-[fill,opacity] duration-300 motion-reduce:transition-none',
                      activatable && !dimmed && 'hover:opacity-85',
                    )}
                    strokeWidth={Math.max(1, labelSize * 0.16)}
                  />

                  {/* Running out: darkened, so scarcity still reads on the map. */}
                  {shade !== undefined ? (
                    <path
                      d={block.svgPath}
                      aria-hidden="true"
                      className="pointer-events-none"
                      fill={`rgb(0 0 0 / ${shade})`}
                    />
                  ) : null}

                  {isSelected || focusRing === block.code ? (
                    <path
                      d={block.svgPath}
                      fill="none"
                      className={focusRing === block.code ? 'stroke-ring' : 'stroke-foreground'}
                      strokeWidth={Math.max(2, labelSize * 0.18)}
                      strokeDasharray={focusRing === block.code ? `${labelSize * 0.5}` : undefined}
                    />
                  ) : null}

                  {showLabels ? (
                    <g
                      aria-hidden="true"
                      className="pointer-events-none fill-white font-bold"
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {codeSize !== null ? (
                        <text
                          x={block.centroid.x}
                          y={block.centroid.y - (stacked ? codeSize * 0.38 : 0)}
                          fontSize={codeSize}
                        >
                          {block.code}
                        </text>
                      ) : null}
                      {stacked && detailText !== null ? (
                        <text
                          x={block.centroid.x}
                          y={block.centroid.y + codeSize! * 0.62}
                          fontSize={detailSize}
                          className="fill-white/85 font-semibold"
                        >
                          {detailText}
                        </text>
                      ) : null}
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* Stand captions: А / Б / В / Г, clickable like the shapes themselves. */}
      {showLabels
        ? sectorLabels.map(({ sector, point }) => (
            <g
              key={`label-${sector.code}`}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : -1}
              aria-label={t(locale, 'sector.label', {
                code: `${sector.code} / ${sector.latin}`,
              })}
              className={cn(
                'outline-none transition-opacity duration-300 motion-reduce:transition-none',
                interactive ? 'cursor-pointer' : 'cursor-default',
                focusedSector !== null && focusedSector !== sector.code
                  ? 'opacity-40'
                  : 'opacity-100',
              )}
              onClick={() => interactive && onSelectSector?.(sector.code)}
              onKeyDown={(event) => {
                if (interactive && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onSelectSector?.(sector.code);
                }
              }}
            >
              <text
                x={point.x}
                y={point.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={labelSize * 1.25}
                className="fill-foreground font-bold"
                stroke="var(--surface)"
                strokeWidth={labelSize * 0.32}
                style={{ paintOrder: 'stroke' }}
              >
                {`${sector.code} · ${locale === 'bg' ? sector.nameBg : sector.name}`}
              </text>
            </g>
          ))
        : null}
    </svg>
  );
}
