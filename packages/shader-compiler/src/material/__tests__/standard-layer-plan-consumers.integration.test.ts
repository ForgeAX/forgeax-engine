import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const standardPlan = deriveStandardLayerPlan([
  { name: 'clearcoat', type: 'f32' },
  { name: 'clearcoatRoughness', type: 'f32' },
]);

describe('StandardLayerPlan compiler consumers', () => {
  it('is the shared pure projection consumed by compiler callers', () => {
    expect(standardPlan).toMatchObject({
      mode: 'physical',
      layers: [{ name: 'clearcoat', parameters: ['clearcoat', 'clearcoatRoughness'] }],
      passFamily: ['forward', 'shadow'],
    });
  });

  it('derives a stable identity without a second plan wire', () => {
    expect(standardPlan.identity).toBe(
      'standard-layer-plan-v1:physical:clearcoat(clearcoat,clearcoatRoughness):forward,shadow',
    );
    expect(JSON.stringify(standardPlan)).toContain('standard-layer-plan-v1:physical');
  });
});
