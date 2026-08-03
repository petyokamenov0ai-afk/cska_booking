/**
 * Grouped-corner merge — one seat map out of two or three subsectors.
 *
 * The overview map draws the Б corners as single wedges, but the seats behind
 * them live in independently-numbered blocks whose coordinates are each
 * normalised to their OWN local space (`data/stadium.json` records no
 * local→overview transform, so the true relative placement is unrecoverable).
 * What CAN be built honestly is an unrolled corner: rotate every member
 * upright — so its seats face the pitch the way a straight stand's do — and
 * lay the members side by side in block order. Rows read continuously, one
 * pitch band spans the whole thing, and every member renders at the SAME
 * scale, which three separately-letterboxed maps could not do.
 *
 * Pure geometry, no I/O: `lib/availability.ts` calls this with the per-member
 * query results. Seat ids pass through untouched, so booking and polling do
 * not know the merge exists. Each seat gains `block` — its real subsector —
 * because `row`/`number` pairs repeat across members and the UI needs to say
 * which "ред 5, място 3" a booking is for.
 */

import type { SeatDTO, SubsectorMeta } from '@/lib/types';

export interface SubsectorSeatsSlice {
  subsector: SubsectorMeta;
  seats: SeatDTO[];
}

/** Circular mean of the seat glyph angles, in degrees. Circular because А mixes
 *  -179° and +179°, which average to ±180°, not 0°. */
function circularMeanDeg(seats: readonly SeatDTO[]): number {
  let sx = 0;
  let sy = 0;
  for (const seat of seats) {
    const rad = (seat.angle * Math.PI) / 180;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
  }
  return (Math.atan2(sy, sx) * 180) / Math.PI;
}

/** Into (-180, 180], so a rotated glyph angle stays in the range the data uses. */
function normalizeDeg(angle: number): number {
  let a = angle % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a;
}

/**
 * Merge the members of one overview group into a single subsector-shaped
 * result. `members` must be in block order (the order `data/stadium.json`
 * lists them, which is the order they sit around the corner); `blockCode` is
 * the group's key — also the lead member's own code.
 */
export function mergeSubsectorGroup(
  blockCode: string,
  members: readonly SubsectorSeatsSlice[],
): SubsectorSeatsSlice {
  if (members.length === 1) return members[0];

  // Rotate each member upright: after subtracting the member's mean glyph
  // angle, its seats face the way a `pitchSide: 'bottom'` stand's do, and the
  // merged map is simply a wide straight-ish stand with the pitch below.
  const rotated = members.map(({ subsector, seats }) => {
    const theta = circularMeanDeg(seats);
    const rad = (-theta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const placed = seats.map((seat) => {
      const x = seat.x * cos - seat.y * sin;
      const y = seat.x * sin + seat.y * cos;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return { ...seat, x, y, angle: normalizeDeg(seat.angle - theta), block: subsector.code };
    });
    return { subsector, seats: placed, minX, minY, maxX, maxY };
  });

  // Side by side, BACK rows on one line: the top row number is the one every
  // member shares (row 23 runs the whole corner), so aligning the top edges is
  // the alignment that reads continuous. The fronts genuinely differ — Б10-2's
  // sparse row-1 arc reaches far forward — and get to hang lower.
  const height = Math.max(...rotated.map((m) => m.maxY - m.minY));
  const totalWidth = rotated.reduce((sum, m) => sum + (m.maxX - m.minX), 0);
  // Wide enough for the per-row labels that live in the seams between members.
  const gap = totalWidth * 0.04;

  const seats: SeatDTO[] = [];
  let cursor = 0;
  for (const member of rotated) {
    const dx = cursor - member.minX;
    const dy = -member.minY;
    for (const seat of member.seats) {
      seats.push({ ...seat, x: seat.x + dx, y: seat.y + dy });
    }
    cursor += member.maxX - member.minX + gap;
  }
  const width = cursor - gap;

  const lead =
    members.find((member) => member.subsector.code === blockCode) ?? members[0];

  const subsector: SubsectorMeta = {
    code: blockCode,
    latin: lead.subsector.latin,
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    rowCount: members.reduce((sum, member) => sum + member.subsector.rowCount, 0),
    seatCount: seats.length,
    pitchSide: 'bottom',
  };

  return { subsector, seats };
}
