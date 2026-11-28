import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measure } from '../../../src/brep/measure';
import { validate } from '../../../src/brep/validate';
import { renderShape } from '../../brep-kit/index.ts';
import { buildLoftShowcase } from '../showcase.ts';

// Set LOFT_RENDER_DIR to keep the PNGs; otherwise they go to a temporary directory.
const outDir = process.env.LOFT_RENDER_DIR ?? mkdtempSync(join(tmpdir(), 'loft-showcase-'));

describe('loft showcase: transition duct, fuselage, hollow shaft', () => {
  it('builds watertight solids with plausible volumes and renders them', () => {
    const parts = buildLoftShowcase();
    expect(parts).toHaveLength(3);
    const volumes = parts.map((part) => {
      const report = validate(part);
      expect(report.ok, JSON.stringify(report.issues)).toBe(true);
      const m = measure(part);
      expect(m.ok).toBe(true);
      return m.ok ? m.value.volume : Number.NaN;
    });
    // Fuselage: length 6.9, cross-section areas between the tail tip and the cabin ellipse (pi*0.9*0.95).
    const fuselage = volumes[1] as number;
    expect(fuselage).toBeGreaterThan(6.9 * Math.PI * 0.12 * 0.2);
    expect(fuselage).toBeLessThan(6.9 * Math.PI * 0.9 * 0.95);
    // Duct wall: bounded by the thickest cross-section ring (outer 2.8 x 1.6 box) times its length.
    expect(volumes[0] as number).toBeGreaterThan(0);
    expect(volumes[0] as number).toBeLessThan(3.2 * 2.8 * 1.6);
    // Shaft wall: between the thinnest ring and the 2 x 2 square minus a 0.3 radius hole times 3.
    expect(volumes[2] as number).toBeGreaterThan(0);
    expect(volumes[2] as number).toBeLessThan(3 * (4 - Math.PI * 0.09));
    const result = renderShape(parts, {
      views: ['iso', 'front', 'top'],
      modes: ['shaded', 'features'],
      size: 720,
      silhouette: true,
      tessellation: { angle: Math.PI / 32, chord: 0.01 },
      outDir,
      name: 'loft-',
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    const files = readdirSync(outDir).filter((f) => f.startsWith('loft-'));
    expect(files).toHaveLength(6);
    for (const f of files) expect(statSync(join(outDir, f)).size).toBeGreaterThan(10_000);
  });
});
