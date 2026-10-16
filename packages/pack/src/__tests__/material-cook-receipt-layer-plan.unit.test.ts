import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('material cook receipt layer identity', () => {
  it('derives one stable identity from the published parameter contract', () => {
    const parameters = [
      { name: 'baseColor', type: 'color' as const },
      { name: 'metallic', type: 'f32' as const },
      { name: 'roughness', type: 'f32' as const },
    ];
    const first = deriveStandardLayerPlan(parameters);
    const second = deriveStandardLayerPlan(parameters);
    expect(first.identity).toBe(second.identity);
    expect(first.passFamily).toEqual(['forward', 'deferred', 'shadow']);
  });
});
