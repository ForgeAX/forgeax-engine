import { type MaterialAsset, RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';
import { streamingMaterialRejection } from '../streaming-material';

const blend: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

describe('static Scene material eligibility', () => {
  it('admits opaque and masked materials without requiring a device or a pipeline receipt', () => {
    expect(
      streamingMaterialRejection(Materials.standard({ baseColor: '#ffffff' })),
    ).toBeUndefined();
    expect(
      streamingMaterialRejection(Materials.standard({ baseColor: '#ffffff', alphaCutoff: 0.5 })),
    ).toBeUndefined();
  });

  it('rejects blend on any pass, including a secondary pass', () => {
    const opaque = Materials.standard({ baseColor: '#ffffff' });
    const first = opaque.passes?.[0];
    if (first === undefined) throw new Error('missing fixture pass');
    const material: MaterialAsset = {
      ...opaque,
      passes: [first, { ...first, name: 'extra', renderState: { blend } }],
    };
    expect(streamingMaterialRejection(material)).toBe('blended-material');
  });

  it('does not infer blending from an ordering queue alone', () => {
    expect(
      streamingMaterialRejection(
        Materials.standard({ baseColor: '#ffffff', queue: RenderQueue.Transparent }),
      ),
    ).toBeUndefined();
  });

  it('uses Standard surface semantics for transmission, including cooked module identities', () => {
    const material = Materials.standard({ baseColor: '#ffffff', transmission: 0.4 });
    expect(streamingMaterialRejection(material)).toBe('transmission-material');
    const first = material.passes?.[0];
    if (first === undefined) throw new Error('missing fixture pass');
    expect(
      streamingMaterialRejection({
        ...material,
        surface: { model: 'standard', module: 'fixture::surface' },
        passes: [{ ...first, program: { module: 'cooked::opaque-hash' } }],
      }),
    ).toBe('transmission-material');
  });

  it('does not infer Standard transmission from an unrelated custom parameter name', () => {
    expect(
      streamingMaterialRejection({
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'fixture::opaque' } }],
        values: { transmission: 1 },
      }),
    ).toBeUndefined();
  });

  it('refuses the separate medium and sprite geometry routes', () => {
    expect(
      streamingMaterialRejection({
        kind: 'material',
        surface: { model: 'single-layer-medium', module: 'fixture::medium' },
        passes: [{ name: 'forward', program: { module: 'fixture::cooked-medium' } }],
      }),
    ).toBe('medium-material');
    expect(
      streamingMaterialRejection({
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'forgeax::single-layer-medium' } }],
      }),
    ).toBe('medium-material');
    expect(
      streamingMaterialRejection({
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'forgeax::sprite' } }],
      }),
    ).toBe('sprite-material');
  });
});
