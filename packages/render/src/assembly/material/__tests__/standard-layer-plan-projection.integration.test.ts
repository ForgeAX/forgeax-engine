import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectStandardSurfacePasses } from '../surface-projection.js';

describe('StandardLayerPlan pass projection', () => {
  it('keeps a physical Standard material on Forward and shadow passes', () => {
    const plan = deriveStandardLayerPlan([
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);
    const passes = projectStandardSurfacePasses({
      surfaceModule: 'game::surface',
      values: {},
      layerPlan: plan,
    });
    expect(passes.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
  });
});
