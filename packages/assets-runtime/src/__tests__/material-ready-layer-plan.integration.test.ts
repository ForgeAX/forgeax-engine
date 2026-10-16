import type { MaterialParameter } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('material runtime readiness layer contract', () => {
  it('keeps physical runtime readiness forward-only', () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'sheenColor', type: 'vec3' },
      { name: 'sheenRoughness', type: 'f32' },
    ];
    const plan = deriveStandardLayerPlan(parameters);
    expect(plan.mode).toBe('physical');
    expect(plan.passFamily).toEqual(['forward', 'shadow']);
  });
});
