import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { expect, it } from 'vitest';
import { renderMaterialContext } from '../../extract/material-context';
import { ReceivingMaterialProjections } from '../material-projections';

function context(limit = 26): MaterialCookRasterContext {
  const selected = renderMaterialContext(
    { backendKind: 'webgpu', storageBuffer: true },
    { maxSampledTexturesPerShaderStage: limit },
  ).materialContext;
  if (selected === undefined) throw new Error('Missing receiver context');
  return selected;
}

function projection(): MaterialRenderProjection {
  const selected = context();
  const contexts = [
    selected,
    { ...selected, pipeline: 'deferred' as const, geometry: 'skinned' as const },
    { ...selected, geometry: 'terrain' as const, visibleSurface: true },
    { ...selected, pass: 'shadow' as const },
    { ...selected, backend: 'webgl2' as const },
    context(16),
    { ...selected, pipeline: 'ray', pass: 'ray-hit' },
  ];
  return {
    materialGuid: 'material/root',
    publicationGeneration: 1,
    specializationKey: 'set/root',
    artifactHash: 'hash/root',
    runtimeValues: {},
    staticSelection: [],
    passes: [
      {
        name: 'Forward',
        module: 'game::material',
        programs: contexts.map((value, index) => ({
          context:
            value as MaterialRenderProjection['passes'][number]['programs'][number]['context'],
          specializationKey: `program/${index}`,
          artifactHash: `hash/${index}`,
          address: index === 1 ? 'scene-index' : 'direct',
        })),
      },
    ],
  };
}

it('keeps all pipelines, geometry, addresses, visibility and ray programs within the receiver domain', () => {
  const owner = new ReceivingMaterialProjections(),
    source = projection();
  const selected = owner.project(source, context());
  expect(selected?.passes[0]?.programs.map((program) => program.specializationKey)).toEqual([
    'program/0',
    'program/1',
    'program/2',
    'program/3',
    'program/6',
  ]);
  expect(owner.project(source, { ...context() })).toBe(selected);
  expect(selected?.passes[0]?.programs[1]).toBe(source.passes[0]?.programs[1]);
  expect(source.passes[0]?.programs).toHaveLength(7);
});

it('re-evaluates borrowed receiver facts and starts a fresh domain on device replacement', () => {
  const source = projection(),
    owner = new ReceivingMaterialProjections();
  const borrowed = { ...context() };
  owner.project(source, borrowed);
  borrowed.capability = context(16).capability;
  expect(
    owner.project(source, borrowed)?.passes[0]?.programs.map((p) => p.specializationKey),
  ).toEqual(['program/5', 'program/6']);
  const replacement = new ReceivingMaterialProjections();
  expect(replacement.project(source, context())?.passes[0]?.programs).toHaveLength(5);
});

it('preserves unsupported/custom and unknown receiver contracts for normal admission', () => {
  const source = projection(),
    owner = new ReceivingMaterialProjections();
  expect(owner.project(source, undefined)).toBe(source);
  expect(owner.project(undefined, context())).toBeUndefined();
  expect(owner.project(source, { ...context(), backend: 'wgpu-native' })).toBe(source);
  const pass = source.passes[0],
    other = pass?.programs[4];
  if (pass === undefined || other === undefined) throw new Error('Missing fixture program');
  const missingPass = {
    ...source,
    passes: [...source.passes, { ...pass, programs: [other] }],
  };
  expect(owner.project(missingPass, context())).toBe(missingPass);
});
