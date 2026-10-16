import { describe, expect, it } from 'vitest';
import {
  createMaterialSpecializationKey,
  type MaterialSpecializationKeyInput,
} from '../material/specialization-key.js';

const input: MaterialSpecializationKeyInput = {
  contractHash: 'contract-hash',
  passes: [
    {
      name: 'Forward',
      module: 'game::paint',
      entries: { vertex: 'vs_main', fragment: 'fs_main' },
      sourceClosure: { 'game::paint': 'source-hash' },
      defs: {
        QUALITY: { type: 'int', value: 2 },
        DEBUG: { type: 'bool', value: false },
        UNSET: { type: 'undefined' },
      },
      moduleSlots: { lighting: 'game::pbr' },
      renderState: { cull: 'back', blend: 'opaque' },
    },
  ],
  vertexInputs: [{ location: 0, format: 'float32x3' }],
  versions: {
    profile: 'forgeax-material-wgsl-v1',
    adapter: '2.0.0',
    compiler: 'naga-oil-0.19.0',
  },
};
const basePass: MaterialSpecializationKeyInput['passes'][number] = input.passes.at(0) ?? {
  name: 'Forward',
  module: 'game::paint',
};

describe('MaterialAsset specialization key', () => {
  it('matches the canonical preimage and digest golden', () => {
    const result = createMaterialSpecializationKey(input);

    expect(result.preimage).toBe(
      '{"contractHash":"contract-hash","passes":[{"defs":{"DEBUG":{"type":"bool","value":false},"QUALITY":{"type":"int","value":2},"UNSET":{"type":"undefined"}},"entries":{"fragment":"fs_main","vertex":"vs_main"},"module":"game::paint","moduleSlots":[{"module":"game::pbr","name":"lighting"}],"name":"Forward","renderState":{"blend":"opaque","cull":"back"},"sourceClosure":{"game::paint":"source-hash"}}],"schema":"forgeax.material.specialization.v1","versions":{"adapter":"2.0.0","compiler":"naga-oil-0.19.0","profile":"forgeax-material-wgsl-v1"},"vertexInputs":[{"format":"float32x3","location":0}]}',
    );
    expect(result.digest).toBe('f55694b1ae1900260948ac00dd7b26467298c733e74e90fb7ec653d9bba92a06');
  });

  it('is invariant to construction order and excludes path and generation', () => {
    const reordered = createMaterialSpecializationKey({
      ...input,
      path: '/moved/paint.wgsl',
      generation: 99,
      passes: [
        {
          ...basePass,
          defs: {
            UNSET: { type: 'undefined' },
            DEBUG: { type: 'bool', value: false },
            QUALITY: { type: 'int', value: 2 },
          },
          renderState: { cull: 'back', blend: 'opaque' },
          moduleSlots: { lighting: 'game::pbr' },
        },
      ],
    });

    const baseline = createMaterialSpecializationKey(input);
    expect(reordered).toEqual(baseline);
  });

  it('distinguishes undefined, false, zero, and every static input change', () => {
    const undefinedKey = createMaterialSpecializationKey(input);
    const falseKey = createMaterialSpecializationKey({
      ...input,
      passes: [
        {
          ...basePass,
          defs: { ...basePass.defs, UNSET: { type: 'bool', value: false } },
        },
      ],
    });
    const zeroKey = createMaterialSpecializationKey({
      ...input,
      passes: [{ ...basePass, defs: { ...basePass.defs, UNSET: { type: 'int', value: 0 } } }],
    });
    const stateKey = createMaterialSpecializationKey({
      ...input,
      passes: [{ ...basePass, renderState: { blend: 'alpha', cull: 'back' } }],
    });

    expect(
      new Set([undefinedKey.digest, falseKey.digest, zeroKey.digest, stateKey.digest]).size,
    ).toBe(4);
  });

  it('characterizes the current specialization identity boundary', () => {
    const baseline = createMaterialSpecializationKey(input);
    const withPathAndGeneration = createMaterialSpecializationKey({
      ...input,
      path: '/different/source.wgsl',
      generation: 42,
    });

    expect(withPathAndGeneration).toEqual(baseline);
    expect(baseline.preimage).toContain('forgeax.material.specialization.v1');
    expect(baseline.preimage).not.toContain('/different/source.wgsl');
  });

  it('does not include module slots in the material layout identity', () => {
    const withoutSlot = createMaterialSpecializationKey({
      ...input,
      passes: [{ name: basePass.name, module: basePass.module }],
    });
    const withSlot = createMaterialSpecializationKey(input);
    expect(withSlot.digest).not.toBe(withoutSlot.digest);
    expect(withSlot.preimage).toContain('moduleSlots');
  });
});
