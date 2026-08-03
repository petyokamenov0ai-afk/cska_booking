/**
 * Static geometry loader — `docs/DATA_CONTRACT.md`.
 *
 * **Server-only.** Reads `data/stadium.json` from disk with `node:fs`; it is
 * never bundled for the browser. Map components get geometry either from a
 * Server Component that called `loadStadium()` or from the DB via
 * `lib/availability.ts` — not by importing this file into a `'use client'`
 * module.
 *
 * Why `fs` rather than `import stadium from '@/data/stadium.json'` (which
 * `tsconfig.resolveJsonModule` would allow): the file is ~2 MB and a static
 * import inlines every byte into the module graph, including client chunks that
 * transitively touch it. Reading it once at first use and caching the parse keeps
 * it out of every bundle.
 *
 * Falls back to `data/stadium.sample.json` (the synthetic fixture that satisfies
 * the same contract) so the app runs before the PDF pipeline has produced real
 * data. Both files ship to production — see `.gitignore`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SectorGeometry,
  StadiumFile,
  StadiumOverviewGeometry,
  StadiumStats,
  SubsectorGeometry,
} from '@/lib/types';

/** Preferred first, fixture second — per `docs/DATA_CONTRACT.md`. */
export const STADIUM_FILE_CANDIDATES = [
  'data/stadium.json',
  'data/stadium.sample.json',
] as const;

interface StadiumCache {
  file: StadiumFile;
  /** Repo-relative path the data actually came from. */
  source: string;
  /** Absolute path + mtime the cache was built from, for dev invalidation. */
  path: string;
  mtimeMs: number;
  subsectorsByCode: Map<string, SubsectorGeometry>;
  sectorsByCode: Map<string, SectorGeometry>;
  sectorCodeBySubsectorCode: Map<string, string>;
}

let cache: StadiumCache | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shape check, not a full validation pass — `scripts/pipeline/validate.ts` owns
 * the invariants. This exists so a truncated or wrong-file read fails loudly at
 * startup instead of producing an empty stadium three layers up.
 */
function assertStadiumShape(parsed: unknown, source: string): StadiumFile {
  if (!isRecord(parsed)) {
    throw new Error(`${source}: expected a JSON object.`);
  }
  const { overview, stats, sectors } = parsed;
  if (!isRecord(overview) || typeof overview.viewBox !== 'string') {
    throw new Error(`${source}: missing "overview.viewBox".`);
  }
  if (!isRecord(stats) || typeof stats.seatTotal !== 'number') {
    throw new Error(`${source}: missing "stats.seatTotal".`);
  }
  if (!Array.isArray(sectors) || sectors.length === 0) {
    throw new Error(`${source}: "sectors" is empty.`);
  }
  for (const sector of sectors) {
    if (!isRecord(sector) || typeof sector.code !== 'string') {
      throw new Error(`${source}: a sector is missing "code".`);
    }
    if (!Array.isArray(sector.subsectors)) {
      throw new Error(`${source}: sector ${sector.code} is missing "subsectors".`);
    }
  }
  return parsed as unknown as StadiumFile;
}

function buildCache(): StadiumCache {
  const root = process.cwd();
  const relative = STADIUM_FILE_CANDIDATES.find((candidate) =>
    existsSync(join(root, candidate)),
  );

  if (relative === undefined) {
    throw new Error(
      `No stadium geometry found. Expected one of ${STADIUM_FILE_CANDIDATES.join(
        ' or ',
      )} relative to ${root}. Run \`npm run pipeline:sample\` to generate the fixture.`,
    );
  }

  const raw = readFileSync(join(root, relative), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${relative}: not valid JSON.`, { cause });
  }

  const file = assertStadiumShape(parsed, relative);

  const subsectorsByCode = new Map<string, SubsectorGeometry>();
  const sectorsByCode = new Map<string, SectorGeometry>();
  const sectorCodeBySubsectorCode = new Map<string, string>();

  for (const sector of file.sectors) {
    sectorsByCode.set(sector.code, sector);
    for (const subsector of sector.subsectors) {
      subsectorsByCode.set(subsector.code, subsector);
      sectorCodeBySubsectorCode.set(subsector.code, sector.code);
    }
  }

  return {
    file,
    source: relative,
    path: join(root, relative),
    mtimeMs: statSync(join(root, relative)).mtimeMs,
    subsectorsByCode,
    sectorsByCode,
    sectorCodeBySubsectorCode,
  };
}

/**
 * Re-reads when the geometry file has been rewritten.
 *
 * The pipeline regenerates `data/stadium.json` regularly, and a module-level
 * cache alone means a long-lived dev server keeps serving the *previous* bowl —
 * silently, because nothing errors and the page still renders. Comparing mtime
 * costs one `stat` per call and removes that trap. In production the file never
 * changes under a running process, so this is simply always a cache hit.
 */
function ensureCache(): StadiumCache {
  if (cache !== null) {
    try {
      if (statSync(cache.path).mtimeMs === cache.mtimeMs) return cache;
    } catch {
      return cache; // unreadable now; keep serving what we already parsed
    }
  }
  cache = buildCache();
  return cache;
}

/**
 * Loads `data/stadium.json`, falling back to `data/stadium.sample.json`. Cached
 * for the lifetime of the process — the geometry only changes when the stadium
 * does.
 *
 * @throws if neither file exists or the JSON is not shaped like the contract.
 */
export function loadStadium(): StadiumFile {
  return ensureCache().file;
}

/** Which file `loadStadium()` actually read. Diagnostics / dev banner. */
export function stadiumSource(): string {
  return ensureCache().source;
}

/**
 * Geometry of one subsector by its **Cyrillic** code (`"А1"`, U+0410 — not
 * Latin `"A1"`). Callers coming from a URL must `decodeURIComponent` first.
 */
export function getSubsectorGeometry(code: string): SubsectorGeometry | null {
  return ensureCache().subsectorsByCode.get(code) ?? null;
}

/** Geometry of one sector/stand by its Cyrillic code (`"А" | "Б" | "В" | "Г"`). */
export function getSectorGeometry(code: string): SectorGeometry | null {
  return ensureCache().sectorsByCode.get(code) ?? null;
}

/** The sector a subsector belongs to, e.g. `"А1"` → `"А"`. */
export function getSectorCodeForSubsector(subsectorCode: string): string | null {
  return ensureCache().sectorCodeBySubsectorCode.get(subsectorCode) ?? null;
}

/**
 * Every subsector drawn as the same overview shape as `code`, in file order —
 * `["Б6", "Б6-2"]` for either Б6 corner code, `[code]` for the 20 ungrouped
 * blocks, `null` for an unknown code. The overview map routes a grouped wedge
 * to its block code, and the subsector page uses this to render the whole
 * corner rather than the one member the URL happens to name.
 */
export function getSubsectorGroupCodes(code: string): string[] | null {
  const store = ensureCache();
  const subsector = store.subsectorsByCode.get(code);
  if (subsector === undefined) return null;
  const group = subsector.overviewGroup;
  if (!group) return [code];
  const sector = store.sectorsByCode.get(store.sectorCodeBySubsectorCode.get(code)!);
  if (sector === undefined) return [code];
  return sector.subsectors
    .filter((member) => (member.overviewGroup ?? member.code) === group)
    .map((member) => member.code);
}

/** Overview-space canvas + pitch path, for the level-1 map. */
export function getStadiumOverview(): StadiumOverviewGeometry {
  return ensureCache().file.overview;
}

export function getStadiumStats(): StadiumStats {
  return ensureCache().file.stats;
}

/** All sectors in drawing order (А Б В Г). */
export function listSectors(): SectorGeometry[] {
  return [...ensureCache().file.sectors].sort((a, b) => a.order - b.order);
}

/** All 22 subsectors in drawing order, flattened across sectors. */
export function listSubsectors(): SubsectorGeometry[] {
  return [...ensureCache().subsectorsByCode.values()].sort(
    (a, b) => a.order - b.order,
  );
}

/**
 * Drops the cache so the next call re-reads from disk. For tests and for the
 * pipeline, which writes `stadium.json` while a dev server may be running.
 */
export function resetStadiumCache(): void {
  cache = null;
}
