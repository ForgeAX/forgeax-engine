import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measure } from '../../../src/brep/measure';
import { validate } from '../../../src/brep/validate';
import { renderShape } from '../../brep-kit/index.ts';
import { buildSweepShowcase } from '../showcase.ts';

// Set SWEEP_RENDER_DIR to keep the PNGs; otherwise they go to a temporary directory.
const outDir = process.env.SWEEP_RENDER_DIR ?? mkdtempSync(join(tmpdir(), 'sweep-showcase-'));

describe('sweep showcase: hollow helical spring, S-bend rail, twisted ribbon', () => {
  it('builds watertight solids with positive volume and renders them', () => {
    const parts = buildSweepShowcase();
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      const report = validate(part);
      expect(report.ok, JSON.stringify(report.issues)).toBe(true);
      const m = measure(part);
      expect(m.ok).toBe(true);
      if (m.ok) expect(m.value.volume).toBeGreaterThan(0);
    }
    const result = renderShape(parts, {
      views: ['iso', 'front', 'top'],
      modes: ['shaded', 'features'],
      size: 720,
      silhouette: true,
      tessellation: { angle: Math.PI / 32, chord: 0.01 },
      outDir,
      name: 'showcase-',
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    const files = readdirSync(outDir).filter((f) => f.startsWith('showcase-'));
    expect(files).toHaveLength(6);
    for (const f of files) expect(statSync(join(outDir, f)).size).toBeGreaterThan(10_000);
  });
});
