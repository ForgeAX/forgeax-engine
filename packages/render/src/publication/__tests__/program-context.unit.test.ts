import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import type { MaterialCookProgramContext } from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { PublicationMaterialProjectionAdmission } from '../programs';

const forward = {
  backend: 'webgpu',
  capability: 'storage-buffer-atmosphere',
  geometry: 'terrain',
  pass: 'forward',
  pipeline: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
} as const satisfies MaterialCookProgramContext;
const deferred = { ...forward, pipeline: 'deferred' } as const;
const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'game::terrain' } }],
};
function projection(contexts: readonly MaterialCookProgramContext[]): MaterialRenderProjection {
  return {
    materialGuid: 'material/terrain',
    publicationGeneration: 1,
    specializationKey: 'selection/terrain',
    artifactHash: 'selection/hash',
    runtimeValues: {},
    staticSelection: [],
    passes: [
      {
        name: 'Forward',
        module: 'game::terrain',
        programs: contexts.map((context) => ({
          context,
          specializationKey: 'shared/program',
          artifactHash: 'shared/bytes',
          address: 'direct',
          entry: 'vs_main',
        })),
      },
    ],
  };
}

it.each([
  [forward, deferred],
  [deferred, forward],
])('preserves shared terrain programs in both pipeline contexts (%j first)', (first, second) => {
  const owner = new PublicationMaterialProjectionAdmission();
  const source = projection([first, second]);
  const accepted = owner.admit(structuredClone(source), material, () => true);
  expect(accepted).toEqual(source);
  const rows = accepted?.passes[0]?.programs;
  expect(rows?.[0]).not.toBe(rows?.[1]);
  expect(owner.size.programs).toBe(2);
  const repeated = owner.admit(structuredClone(source), material, () => true);
  expect(repeated?.passes[0]?.programs[0]).toBe(rows?.[0]);
  expect(repeated?.passes[0]?.programs[1]).toBe(rows?.[1]);
  expect(owner.admit(source, material, () => false)).toBeUndefined();
});

it('preserves the full context across separate publications sharing program bytes', () => {
  const owner = new PublicationMaterialProjectionAdmission();
  const contexts = [
    forward,
    deferred,
    { ...deferred, visibleSurface: true },
    { ...deferred, geometry: 'mesh' },
    { ...deferred, pass: 'depth' },
  ] as const;
  for (const context of contexts) {
    const source = projection([context]);
    expect(owner.admit(source, material, () => true)).toEqual(source);
  }
  expect(owner.size.programs).toBe(contexts.length);
  owner.clear();
  expect(owner.size.programs).toBe(0);
});

it('rejects malformed context even after the same program bytes were admitted', () => {
  const owner = new PublicationMaterialProjectionAdmission();
  owner.admit(projection([forward]), material, () => true);
  const invalid = structuredClone(projection([forward]));
  Object.assign(invalid.passes[0]?.programs[0]?.context ?? {}, { pipeline: 'invalid' });
  expect(owner.admit(invalid, material, () => true)).toBeUndefined();
});
