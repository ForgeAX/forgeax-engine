import { createMaterialShaderProgram } from '@forgeax/engine-shader';
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

it('leaves old templates with color-writing predepth on the Base Pass', () => {
  const stock = program([entry('fs_main'), entry('fs_ao_input')]);
  expect(predepthCoversMaterial(stock, undefined)).toBe(false);
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

it('keeps color-entry effects independent across fixed and borrowed shader revisions', () => {
  const inputs = [
    entry('fs_main'),
    entry('fs_opaque', { ...effects, writesDepth: true }),
    entry('fs_forward_screen'),
    entry('fs_ao_input'),
    entry('fs_depth_masked'),
  ];
  const borrowed = program(inputs);
  const fixed = { ...borrowed, program: createMaterialShaderProgram('depth-entry-test', inputs) };
  const covers = (artifact: typeof borrowed | typeof fixed, fragmentEntry: string) =>
    predepthCoversMaterial({ ...artifact, fragmentEntry }, undefined);
  for (const artifact of [borrowed, fixed]) {
    expect(covers(artifact, 'fs_main')).toBe(true);
    expect(covers(artifact, 'fs_opaque')).toBe(false);
    expect(covers(artifact, 'fs_forward_screen')).toBe(true);
  }
  inputs.splice(3, 2, entry('fs_ao_input', { ...effects, writesStorage: true }));
  expect(covers(borrowed, 'fs_main')).toBe(false);
  expect(predepthFragmentEntry(borrowed)).toBe('fs_ao_input');
  expect(covers(fixed, 'fs_main')).toBe(true);
  expect(predepthFragmentEntry(fixed)).toBe('fs_depth_masked');
  const replaced = { ...fixed, program: { ...fixed.program, entryPoints: inputs } };
  expect(covers(replaced, 'fs_main')).toBe(false);
});

it('checks changing draw state without iterating admitted shader reflection again', () => {
  const entries = Object.freeze(
    ['fs_main', 'fs_opaque', 'fs_depth_masked'].map((name) =>
      Object.freeze({
        name,
        stage: 'fragment' as const,
        bindings: Object.freeze([]),
        effects: Object.freeze({ ...effects }),
      }),
    ),
  );
  let indexedReads = 0;
  const observed = new Proxy(entries, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) indexedReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const shader = createMaterialShaderProgram('fixed-depth-entry-test', observed);
  expect(shader.entryPoints).toBe(observed);
  const afterAdmission = indexedReads;
  const draw = { receipt: { positionBounds: 'standard-input' as const }, program: shader };
  for (let frame = 0; frame < 60; frame++) {
    const writes = frame % 2 === 0;
    expect(predepthCoversMaterial(draw, { depthWriteEnabled: writes })).toBe(writes);
    expect(predepthFragmentEntry(draw)).toBe('fs_depth_masked');
  }
  expect(indexedReads).toBe(afterAdmission);
});
