import type {
  MaterialRenderState,
  ShaderEntryPointEffects,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { predepthCoversMaterial, predepthFragmentEntry } from '../predepth-coverage';

const effects: ShaderEntryPointEffects = {
  mayDiscard: false,
  writesDepth: false,
  writesSampleMask: false,
  writesStorage: false,
};
const entry = (
  name: string,
  facts: ShaderEntryPointEffects | undefined = effects,
): ShaderEntryPointReads => ({
  name,
  stage: 'fragment',
  bindings: [],
  ...(facts === undefined ? {} : { effects: facts }),
});
const program = (entries = [entry('fs_main'), entry('fs_depth_masked')]) => ({
  receipt: { positionBounds: 'standard-input' as const },
  program: { entryPoints: entries },
});

it('requires native coverage and position facts before making a base writer depth-read-only', () => {
  expect(predepthCoversMaterial(undefined, undefined)).toBe(false);
  expect(predepthCoversMaterial({ program: program().program }, undefined)).toBe(false);
  expect(predepthCoversMaterial(program([entry('fs_main')]), undefined)).toBe(false);
  expect(
    predepthCoversMaterial(
      program([entry('fs_main'), { name: 'fs_depth_masked', stage: 'fragment', bindings: [] }]),
      undefined,
    ),
  ).toBe(false);
  expect(predepthCoversMaterial(program(), undefined)).toBe(true);
  expect(predepthCoversMaterial(program(), { depthCompare: 'less-equal' })).toBe(true);
});

it('keeps alpha/hash/view/LOD discards while rejecting duplicated shader effects', () => {
  const discarded = { ...effects, mayDiscard: true };
  expect(
    predepthCoversMaterial(
      program([entry('fs_main', discarded), entry('fs_depth_masked', discarded)]),
      undefined,
    ),
  ).toBe(true);
  for (const effect of ['writesDepth', 'writesSampleMask', 'writesStorage'] as const)
    for (const name of ['fs_main', 'fs_depth_masked']) {
      const candidate = program(
        ['fs_main', 'fs_depth_masked'].map((candidate) =>
          entry(candidate, candidate === name ? { ...effects, [effect]: true } : effects),
        ),
      );
      expect(predepthCoversMaterial(candidate, undefined), `${name}:${effect}`).toBe(false);
    }
});

it('retains authored depth, blending, scene-depth reads and fixed-function alpha coverage', () => {
  for (const state of [
    { depthWriteEnabled: false },
    { depthCompare: 'always' },
    { alphaToCoverageEnabled: true },
    { stencil: {} },
    { outputs: [{ name: 'color', format: 'rgba16float', blend: { color: {}, alpha: {} } }] },
    { blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: {} } },
  ] satisfies MaterialRenderState[])
    expect(predepthCoversMaterial(program(), state)).toBe(false);
  const declared = {
    ...program(),
    receipt: { positionBounds: 'standard-input' as const, sceneDepth: 'read-only' as const },
  };
  expect(predepthCoversMaterial(declared, undefined)).toBe(false);
});

it('uses the stock AO coverage entry when a template has no dedicated depth fragment', () => {
  const stock = program([entry('fs_main'), entry('fs_ao_input')]);
  expect(predepthCoversMaterial(stock, undefined)).toBe(true);
  expect(predepthFragmentEntry(stock)).toBe('fs_ao_input');
  expect(predepthFragmentEntry(program())).toBe('fs_depth_masked');
});

it('withholds a coverage proof from non-color entries even when their native effects are pure', () => {
  for (const fragmentEntry of ['fs_temporal', 'fs_shadow', 'fs_ao_input', 'fs_custom']) {
    const candidate = {
      ...program([entry('fs_main'), entry('fs_depth_masked'), entry(fragmentEntry)]),
      fragmentEntry,
    };
    expect(predepthCoversMaterial(candidate, undefined), fragmentEntry).toBe(false);
  }
});
