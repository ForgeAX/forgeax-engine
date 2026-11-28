import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHousing, housingIssues } from '../housing.ts';
import { renderHousing } from '../render.ts';

describe('flanged housing showcase', () => {
  it('builds 12 valid parts from extrude, revolve, cylinder and box', () => {
    const parts = buildHousing();
    expect(parts.length).toBe(12);
    expect(housingIssues(parts)).toEqual([]);
    const surfaces = new Set(parts.flatMap((p) => p.shape.surfaces.map((s) => s.kind)));
    expect([...surfaces].sort()).toEqual(['cylinder', 'plane']);
  });

  it('has the designed extents: the top plate ends at z = 61 and the port flange at x = 52', () => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const part of buildHousing())
      for (const v of part.shape.vertices)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k] as number, v.p[k] as number);
          hi[k] = Math.max(hi[k] as number, v.p[k] as number);
        }
    expect(hi[2]).toBeCloseTo(61, 9);
    expect(lo[2]).toBeCloseTo(0, 9);
    expect(hi[0]).toBeCloseTo(52, 9);
    expect(lo[0]).toBeCloseTo(-46, 9);
  });

  it('renders every view, reports the plates the quad layout rejects, and is byte-stable', () => {
    const a = mkdtempSync(join(tmpdir(), 'housing-a-'));
    const b = mkdtempSync(join(tmpdir(), 'housing-b-'));
    try {
      const ra = renderHousing(a, 200);
      renderHousing(b, 200);
      expect(ra.quadRejected.map((r) => r.name)).toEqual(['base flange', 'top plate']);
      expect(ra.quadRejected.every((r) => r.reason === 'no-perfect-matching')).toBe(true);
      expect(ra.quadParts.length).toBe(12 - 2);
      expect(ra.edgeCounts.concave).toBe(3);
      expect(ra.edgeCounts.boundary).toBe(0);
      const files = readdirSync(a).sort();
      expect(files.length).toBe(4 * 5 + 1);
      for (const f of files)
        expect(readFileSync(join(a, f)).equals(readFileSync(join(b, f)))).toBe(true);
    } finally {
      rmSync(a, { recursive: true });
      rmSync(b, { recursive: true });
    }
  });
});
