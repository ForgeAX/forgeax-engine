import type { MaterialParameter } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('compiler Standard layer admission', () => {
  it('shares the root layer plan and rejects a physical Deferred pass', () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ];
    const plan = deriveStandardLayerPlan(parameters);
    expect(plan.mode).toBe('physical');
    expect(plan.passFamily).not.toContain('deferred');
    expect(plan.layers[0]?.name).toBe('clearcoat');
  });

  it('preserves a stable identity independent of authored values', () => {
    const parameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ];
    const first = deriveStandardLayerPlan(parameters);
    const second = deriveStandardLayerPlan(parameters);
    expect(first.identity).toBe(second.identity);
  });
});
