#!/usr/bin/env node
/**
 * Generates data/stadium.sample.json — a synthetic bowl that satisfies
 * docs/DATA_CONTRACT.md exactly. Lets the DB/API/UI be built and tested
 * without waiting on the PDF extraction. Deterministic: no randomness.
 *
 *   node scripts/pipeline/make-sample.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Overview space: landscape, А bottom / В top / Б right / Г left.
const OW = 2220;
const OH = 1615;

/** Pitch, centred, with the running track margin around it. */
const PITCH = { x: 560, y: 430, w: 1100, h: 760 };

const SECTORS = [
  { code: 'А', latin: 'A', name: 'South', nameBg: 'Юг', order: 1, side: 'bottom', subs: ['А1', 'А2', 'А3', 'А4', 'А5'] },
  { code: 'Б', latin: 'B', name: 'East', nameBg: 'Изток', order: 2, side: 'right', subs: ['Б6', 'Б7', 'Б8', 'Б9', 'Б10', 'Б11'] },
  { code: 'В', latin: 'V', name: 'North', nameBg: 'Север', order: 3, side: 'top', subs: ['В12', 'В13', 'В14', 'В15', 'В16'] },
  { code: 'Г', latin: 'G', name: 'West', nameBg: 'Запад', order: 4, side: 'left', subs: ['Г17', 'Г18', 'Г19', 'Г20', 'Г21', 'Г22'] },
];

const CYR_TO_LAT = { А: 'A', Б: 'B', В: 'V', Г: 'G' };
const latinOf = (code) => CYR_TO_LAT[code[0]] + code.slice(1);

/** Seat pitch in subsector-local units. */
const SX = 22;
const SY = 26;
const PAD = 18;

let order = 0;
const sectors = SECTORS.map((s) => {
  const n = s.subs.length;
  const subsectors = s.subs.map((code, i) => {
    order += 1;
    // Vary the shape a little so the UI is exercised with unequal blocks.
    const rowCount = 18 + ((i * 3) % 9);
    const seatsPerRow = 20 + ((i * 5) % 11);

    const width = seatsPerRow * SX + PAD * 2;
    const height = rowCount * SY + PAD * 2;

    const seats = [];
    const rows = [];
    for (let r = 1; r <= rowCount; r += 1) {
      // Rows further from the pitch are slightly wider (bowl geometry).
      const count = seatsPerRow - Math.max(0, 3 - Math.floor((r - 1) / 4));
      // row 1 closest to the pitch => smallest y (drawn at the top)
      const y = PAD + (r - 1) * SY;
      const rowW = count * SX;
      const x0 = (width - rowW) / 2 + SX / 2;
      for (let k = 0; k < count; k += 1) {
        const isWheelchair = r === rowCount && k < 2 && s.side === 'top';
        const isCompanion = r === rowCount && k === 2 && s.side === 'top';
        seats.push({
          row: r,
          number: k + 1,
          x: Math.round((x0 + k * SX) * 10) / 10,
          y: Math.round(y * 10) / 10,
          angle: 0,
          type: isWheelchair ? 'WHEELCHAIR' : isCompanion ? 'COMPANION' : 'STANDARD',
          // Fake the "ЦСКА" letters: a light band across the В stand.
          white: s.code === 'В' && r >= 6 && r <= 11 && k >= 4 && k <= 13,
        });
      }
      rows.push({ row: r, count, firstSeat: 1, lastSeat: count });
    }

    // Outline + centroid in overview space: lay the blocks out along their side.
    const band = 300; // depth of the stand in overview space
    const inset = 40;
    let ox;
    let oy;
    let ow;
    let oh;
    if (s.side === 'bottom' || s.side === 'top') {
      const usable = OW - inset * 2;
      ow = usable / n - 12;
      oh = band;
      ox = inset + (usable / n) * i + 6;
      oy = s.side === 'bottom' ? OH - inset - band : inset;
    } else {
      const usable = OH - inset * 2;
      oh = usable / n - 12;
      ow = band;
      oy = inset + (usable / n) * i + 6;
      ox = s.side === 'right' ? OW - inset - band : inset;
    }
    const r2 = (v) => Math.round(v * 10) / 10;
    const svgPath =
      `M ${r2(ox)} ${r2(oy)} L ${r2(ox + ow)} ${r2(oy)} ` +
      `L ${r2(ox + ow)} ${r2(oy + oh)} L ${r2(ox)} ${r2(oy + oh)} Z`;

    return {
      code,
      latin: latinOf(code),
      order,
      viewBox: `0 0 ${r2(width)} ${r2(height)}`,
      width: r2(width),
      height: r2(height),
      // The fixture keeps rows horizontal everywhere, so the pitch is always on
      // top. The real pipeline varies this per stand (see docs/DATA_CONTRACT.md).
      pitchSide: 'top',
      svgPath,
      centroid: { x: r2(ox + ow / 2), y: r2(oy + oh / 2) },
      seatCount: seats.length,
      rowCount,
      rows,
      seats,
    };
  });
  return { code: s.code, latin: s.latin, name: s.name, nameBg: s.nameBg, order: s.order, subsectors };
});

const seatTotal = sectors.reduce(
  (a, s) => a + s.subsectors.reduce((b, ss) => b + ss.seatCount, 0),
  0,
);

const out = {
  generatedAt: new Date().toISOString(),
  source: 'SYNTHETIC (development fixture — not the real drawing)',
  overview: {
    width: OW,
    height: OH,
    viewBox: `0 0 ${OW} ${OH}`,
    pitch: `M ${PITCH.x} ${PITCH.y} L ${PITCH.x + PITCH.w} ${PITCH.y} L ${PITCH.x + PITCH.w} ${PITCH.y + PITCH.h} L ${PITCH.x} ${PITCH.y + PITCH.h} Z`,
  },
  stats: { seatTotal, subsectorCount: sectors.reduce((a, s) => a + s.subsectors.length, 0) },
  sectors,
};

mkdirSync(resolve(ROOT, 'data'), { recursive: true });
const dest = resolve(ROOT, 'data/stadium.sample.json');
writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${dest}: ${seatTotal} seats across ${out.stats.subsectorCount} subsectors`);
