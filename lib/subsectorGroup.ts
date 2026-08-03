/**
 * Grouped-corner merge — one seat map out of two or three subsectors.
 *
 * The two Б corners are drawn as continuous fans on the plan (page 1 of
 * SEATS_CSKA.pdf), but are bookable as independently numbered zones — Б6/Б6-2
 * and Б10-2/Б11/Б11-2 — each of which stage 4 of the pipeline emitted in its
 * OWN local frame, losing the corner's layout. The lost placement was measured
 * back off the drawing by `scripts/pipeline/06_group_transforms.py`, which
 * registers every member's seat cloud onto the plan; the result lives in
 * `data/stadium-groups.json` as a uniform scale + translation per member (the
 * local frames share the drawing's orientation, so no rotation exists to
 * recover). Applying those transforms here reassembles the corner exactly as
 * printed: continuous rows bending around the bend, one canvas, one scale.
 *
 * Seat ids pass through untouched, so booking and polling do not know the
 * merge exists. Each seat gains `block` — its real subsector — because
 * `row`/`number` pairs repeat across members and the UI needs to say which
 * "ред 5, място 3" a booking is for.
 */

import { getSubsectorGroupTransforms } from '@/lib/stadium';
import type { SeatDTO, SubsectorMeta } from '@/lib/types';

export interface SubsectorSeatsSlice {
  subsector: SubsectorMeta;
  seats: SeatDTO[];
}

/** Same margin stage 4 leaves around a subsector-local seat cloud. */
const LOCAL_PAD = 18;

/**
 * Merge the members of one overview group into a single subsector-shaped
 * result. `blockCode` is the group's key — also the lead member's own code,
 * whose local frame is the canvas everything else is placed into.
 */
export function mergeSubsectorGroup(
  blockCode: string,
  members: readonly SubsectorSeatsSlice[],
): SubsectorSeatsSlice {
  if (members.length === 1) return members[0];

  const transforms = getSubsectorGroupTransforms(blockCode);

  const seats: SeatDTO[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const tf = transforms?.[member.subsector.code];
    if (tf === undefined && member.subsector.code !== blockCode) {
      // Identity still renders every seat (stacked on the lead), so the page
      // stays usable — but loudly, because the layout is wrong without it.
      console.warn(
        `[subsectorGroup] no transform for ${member.subsector.code} in group ${blockCode}; ` +
          'run scripts/pipeline/06_group_transforms.py',
      );
    }
    const scale = tf?.scale ?? 1;
    const dx = tf?.dx ?? 0;
    const dy = tf?.dy ?? 0;
    for (const seat of member.seats) {
      // No angle change: the frames share one orientation, so the glyphs
      // already point the way the drawing points them.
      const x = seat.x * scale + dx;
      const y = seat.y * scale + dy;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      seats.push({ ...seat, x, y, block: member.subsector.code });
    }
  }

  // Members placed left/above the lead land at negative coordinates; shift
  // the whole corner back into a padded 0-based box, stage 4's convention.
  for (const seat of seats) {
    seat.x = seat.x - minX + LOCAL_PAD;
    seat.y = seat.y - minY + LOCAL_PAD;
  }
  const width = maxX - minX + 2 * LOCAL_PAD;
  const height = maxY - minY + 2 * LOCAL_PAD;

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
    pitchSide: lead.subsector.pitchSide,
  };

  return { subsector, seats };
}
