import { describe, expect, it } from 'vitest';
import type { MaterialParameter } from '../asset.js';
import { deriveStandardLayerPlan, MaterialPhysicalContractError } from '../standard-layer-plan.js';

const baseParameters: readonly MaterialParameter[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
];

describe('Standard layer plan contract', () => {
  it('derives base-only without reading values', () => {
    const plan = deriveStandardLayerPlan(baseParameters);
    expect(plan.mode).toBe('base-only');
    expect(plan.layers).toEqual([]);
    expect(plan.passFamily).toEqual(['forward', 'deferred', 'shadow']);
  });

  it('keeps a declared zero-factor layer present', () => {
    const plan = deriveStandardLayerPlan([
      ...baseParameters,
      { name: 'clearcoat', type: 'f32', default: 0 },
      { name: 'clearcoatRoughness', type: 'f32', default: 0 },
    ]);
    expect(plan.mode).toBe('physical');
    expect(plan.layers).toEqual([
      { name: 'clearcoat', parameters: ['clearcoat', 'clearcoatRoughness'] },
    ]);
    expect(plan.passFamily).toEqual(['forward', 'shadow']);
  });

  it('uses one canonical order for multiple declared layers', () => {
    const plan = deriveStandardLayerPlan([
      ...baseParameters,
      { name: 'sheenColor', type: 'vec3' },
      { name: 'sheenRoughness', type: 'f32' },
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);
    expect(plan.layers.map((layer) => layer.name)).toEqual(['sheen', 'clearcoat']);
  });
  it('admits thin-surface diffuse transmission as a Forward-only physical layer', () => {
    const plan = deriveStandardLayerPlan([
      ...baseParameters,
      { name: 'diffuseTransmission', type: 'f32', default: 0 },
      { name: 'diffuseTransmissionColor', type: 'vec3', default: [1, 1, 1] },
    ]);
    expect(plan.mode).toBe('physical');
    expect(plan.layers).toEqual([
      {
        name: 'diffuseTransmission',
        parameters: ['diffuseTransmission', 'diffuseTransmissionColor'],
      },
    ]);
    expect(plan.passFamily).toEqual(['forward', 'shadow']);
  });

  it('names the incomplete diffuse-transmission layer and rejects a Deferred pass', () => {
    let incomplete: unknown;
    try {
      deriveStandardLayerPlan([...baseParameters, { name: 'diffuseTransmission', type: 'f32' }]);
    } catch (error) {
      incomplete = error;
    }
    expect(incomplete).toBeInstanceOf(MaterialPhysicalContractError);
    expect((incomplete as MaterialPhysicalContractError).detail).toMatchObject({
      layer: 'diffuseTransmission',
      missing: ['diffuseTransmissionColor'],
      reason: 'incomplete-layer',
    });
    let deferred: unknown;
    try {
      deriveStandardLayerPlan(
        [
          ...baseParameters,
          { name: 'diffuseTransmission', type: 'f32' },
          { name: 'diffuseTransmissionColor', type: 'vec3' },
        ],
        [{ name: 'deferred' } as never],
      );
    } catch (error) {
      deferred = error;
    }
    expect((deferred as MaterialPhysicalContractError).detail).toMatchObject({
      layer: 'diffuseTransmission',
      pass: 'deferred',
      reason: 'deferred-pass',
    });
  });
});
