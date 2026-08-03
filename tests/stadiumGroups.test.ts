/**
 * data/stadium-groups.json — the measured corner-member placements — must keep
 * up with data/stadium.json's group definitions: a grouped member without a
 * transform renders stacked on its group lead (see lib/subsectorGroup.ts), and
 * nothing else would fail loudly before a human noticed the corner was wrong.
 *
 * Skipped wholesale when the geometry has no groups (the sample fixture).
 */

import { describe, expect, it } from 'vitest';

import {
  getSubsectorGroupTransforms,
  listSubsectors,
} from '@/lib/stadium';

const grouped = listSubsectors().filter((sub) => sub.overviewGroup !== undefined);

describe.skipIf(grouped.length === 0)('data/stadium-groups.json', () => {
  it('carries a transform for every grouped member', () => {
    for (const sub of grouped) {
      const block = sub.overviewGroup!;
      const transforms = getSubsectorGroupTransforms(block);
      expect(transforms, `group ${block} is missing entirely`).not.toBeNull();
      expect(
        transforms![sub.code],
        `group ${block} has no transform for member ${sub.code}`,
      ).toBeDefined();
    }
  });

  it('keeps every transform a near-identity scale with finite offsets', () => {
    // The members share one drawing, so a scale far from 1 means a bad
    // registration (an alias lock), not a real difference in seat pitch.
    for (const sub of grouped) {
      const tf = getSubsectorGroupTransforms(sub.overviewGroup!)?.[sub.code];
      if (tf === undefined) continue; // the first test already reports this
      expect(tf.scale, sub.code).toBeGreaterThan(0.9);
      expect(tf.scale, sub.code).toBeLessThan(1.1);
      expect(Number.isFinite(tf.dx), sub.code).toBe(true);
      expect(Number.isFinite(tf.dy), sub.code).toBe(true);
    }
  });
});
