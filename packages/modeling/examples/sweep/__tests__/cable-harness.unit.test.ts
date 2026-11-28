import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/brep/validate';
import { renderShape } from '../../brep-kit/index.ts';
import { buildCableHarness } from '../cable-harness.ts';

const rendered = join(dirname(fileURLToPath(import.meta.url)), '../rendered');

describe('curved cable harness sweep example', () => {
  it('builds watertight holed cables and renders the assembly', () => {
    const { parts, cablePaths } = buildCableHarness();
    expect(parts).toHaveLength(15);
    expect(cablePaths).toHaveLength(3);
    for (const cable of parts.slice(0, 1)) expect(validate(cable).ok).toBe(true);
    for (const part of parts) expect(validate(part).ok).toBe(true);

    const result = renderShape(parts, {
      views: ['iso', 'front'],
      modes: ['shaded', 'features'],
      size: 640,
      silhouette: true,
      tessellation: { angle: Math.PI / 32, chord: 0.01 },
      outDir: rendered,
      name: 'cable-harness-',
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    expect(readdirSync(rendered).sort()).toEqual([
      'cable-harness-features-front.png',
      'cable-harness-features-iso.png',
      'cable-harness-shaded-front.png',
      'cable-harness-shaded-iso.png',
    ]);
    for (const file of readdirSync(rendered))
      expect(statSync(join(rendered, file)).size).toBeGreaterThan(10_000);
  });
});
