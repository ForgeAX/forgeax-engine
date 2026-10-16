import { describe, expect, it } from 'vitest';
import { reflectVfxRenderer } from '../reflection.js';

const billboard = {
  kind: 'billboard',
  material: 'vfx',
  textureSheet: { columns: 4, rows: 2, frameRate: 12, frameCount: 8 },
  pivot: [0.2, 0.8],
  softParticle: { fadeDistance: 0.5 },
  sorting: 'view-depth',
} as const;

describe('billboard advanced reflection', () => {
  it('reflects executable frame, pivot, depth, and sorting inputs', () => {
    const result = reflectVfxRenderer([billboard]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatchObject({
        topology: 'billboard',
        textureSheet: { columns: 4, rows: 2, frameRate: 12, frameCount: 8 },
        pivot: [0.2, 0.8],
        softParticle: { fadeDistance: 0.5, requiresDepth: true },
        sorting: 'view-depth',
      });
      expect(result.value[0]?.shaderInputs).toEqual([
        'textureSheet',
        'pivot',
        'softParticleDepth',
        'sorting',
      ]);
    }
  });

  it.each([
    [{ ...billboard, textureSheet: { columns: 0, rows: 2, frameRate: 12 } }],
    [{ ...billboard, textureSheet: { columns: 4, rows: 2, frameRate: 12, frameCount: 99 } }],
    [{ ...billboard, pivot: [2, 0] }],
    [{ ...billboard, softParticle: { fadeDistance: 0 } }],
  ])('rejects an invalid advanced field', (renderer) => {
    expect(reflectVfxRenderer([renderer])).toMatchObject({
      ok: false,
      error: { code: 'vfx-renderer-invalid' },
    });
  });
});
