import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/brep/validate.ts';
import { buildBracket } from '../bracket.ts';
import { renderBracket } from '../render.ts';

describe('edited bracket', () => {
  it('removes one hole, splits an end face and re-merges coplanar faces', () => {
    const b = buildBracket();
    for (const shape of [b.raw, b.filled, b.split, b.simplified])
      expect(validate(shape).ok).toBe(true);
    const [raw = 0, filled = 0, split = 0, simplified = 0] = b.faceCounts;
    // the foot hole is 8 wall faces + 2 cap loops; the slot, corner hole and spare hole stay
    expect(raw - filled).toBe(8);
    expect(split - filled).toBe(1);
    // simplify undoes the split (1 face) and merges the two collinear side pairs (2 faces)
    expect(split - simplified).toBe(3);
    expect(b.volume).toBeCloseTo(b.expectedVolume, 8);
  });

  it('renders shaded, feature-line and iso-line evidence deterministically', () => {
    const a = mkdtempSync(join(tmpdir(), 'brep-edit-a-'));
    const b = mkdtempSync(join(tmpdir(), 'brep-edit-b-'));
    try {
      const ra = renderBracket(a, 240);
      const rb = renderBracket(b, 240);
      expect(ra.faceCounts).toEqual(rb.faceCounts);
      expect(ra.volume).toBe(rb.volume);
      expect(readdirSync(a).sort()).toHaveLength(37);
      expect(readFileSync(ra.sheet).equals(readFileSync(rb.sheet))).toBe(true);
    } finally {
      rmSync(a, { recursive: true });
      rmSync(b, { recursive: true });
    }
  });
});
