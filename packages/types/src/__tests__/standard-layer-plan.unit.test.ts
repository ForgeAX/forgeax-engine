import { describe, expect, it } from 'vitest';
import { deriveStandardLayerPlan, type MaterialParameter } from '../material/index.js';

const clearcoatParameters: readonly MaterialParameter[] = [
  { name: 'clearcoat', type: 'f32', default: 0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 0 },
];

describe('StandardLayerPlan root contract', () => {
  it('derives a physical layer from declared parameters, not values', () => {
    const plan = deriveStandardLayerPlan(clearcoatParameters);

    expect(plan).toMatchObject({
      mode: 'physical',
      layers: [{ name: 'clearcoat', parameters: ['clearcoat', 'clearcoatRoughness'] }],
      passFamily: ['forward', 'shadow'],
    });
    expect(plan.identity).toContain('standard-layer-plan-v1:physical');
  });

  it('keeps a complete layer when its factor default is zero', () => {
    const plan = deriveStandardLayerPlan([
      ...clearcoatParameters,
      { name: 'ironColor', type: 'color', default: [0.4, 0.45, 0.47, 1] },
    ]);

    expect(plan.layers.map((layer) => layer.name)).toEqual(['clearcoat']);
    expect(plan.mode).toBe('physical');
  });

  it('rejects an incomplete physical fragment with structured detail', () => {
    let thrown: unknown;
    try {
      deriveStandardLayerPlan(clearcoatParameters.slice(0, 1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'material-physical-contract-invalid',
      detail: {
        layer: 'clearcoat',
        missing: ['clearcoatRoughness'],
        reason: 'incomplete-layer',
      },
    });
  });

  it('does not infer a layer from values, textures, or a full default schema', () => {
    expect(deriveStandardLayerPlan([{ name: 'ironColor', type: 'color' }])).toMatchObject({
      mode: 'base-only',
      layers: [],
      passFamily: ['forward', 'deferred', 'shadow'],
    });
  });

  it.each([
    ['anisotropy', ['anisotropyStrength', 'anisotropyRotation']],
    ['sheen', ['sheenColor', 'sheenRoughness']],
    [
      'iridescence',
      [
        'iridescence',
        'iridescenceIor',
        'iridescenceThicknessMinimum',
        'iridescenceThicknessMaximum',
      ],
    ],
  ] as const)('rejects the known but not-yet-executable %s layer', (layer, names) => {
    const plan = deriveStandardLayerPlan(names.map((name) => ({ name, type: 'f32' as const })));

    expect(plan.mode).toBe('physical');
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]?.name).toBe(layer);
    expect(plan.passFamily).toEqual(['forward', 'shadow']);
  });
});
