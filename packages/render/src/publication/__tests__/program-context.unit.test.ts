import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import {
  createMaterialArtifactDigest,
  type MaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import type { MaterialRootAsset } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicationMaterialProjectionAdmission } from '../programs';

afterEach(() => vi.restoreAllMocks());

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
const material: MaterialRootAsset = {
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
  const accepted = owner.stage(() => true)(structuredClone(source), material);
  expect(accepted).toEqual(source);
  const rows = accepted?.passes[0]?.programs;
  expect(rows?.[0]).not.toBe(rows?.[1]);
  expect(owner.size.programs).toBe(2);
  const repeated = owner.stage(() => true)(structuredClone(source), material);
  expect(repeated?.passes[0]?.programs[0]).toBe(rows?.[0]);
  expect(repeated?.passes[0]?.programs[1]).toBe(rows?.[1]);
  expect(owner.stage(() => false)(source, material)).toBeUndefined();
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
    expect(owner.stage(() => true)(source, material)).toEqual(source);
  }
  expect(owner.size.programs).toBe(contexts.length);
  owner.clear();
  expect(owner.size.programs).toBe(0);
});

it('rejects malformed context even after the same program bytes were admitted', () => {
  const owner = new PublicationMaterialProjectionAdmission();
  owner.stage(() => true)(projection([forward]), material);
  const invalid = structuredClone(projection([forward]));
  Object.assign(invalid.passes[0]?.programs[0]?.context ?? {}, { pipeline: 'invalid' });
  expect(owner.stage(() => true)(invalid, material)).toBeUndefined();
});

it('shares exact source evidence within a packet and rejects changed bytes at the same digest', () => {
  const sources = { engine: { 'game::terrain': '// terrain source' }, project: {} };
  const serialized = JSON.stringify(sources);
  const digest = createMaterialArtifactDigest(new TextEncoder().encode(serialized));
  const row = (guid: string): MaterialRenderProjection => ({
    ...projection([]),
    materialGuid: guid,
    artifactHash: digest,
    sourceTemplate: {
      publication: {
        schemaVersion: 'material-template/1',
        guid,
        resolved: material,
        refs: { parent: [], textures: [], samplers: [], modules: ['game::terrain'] },
        sourceArtifact: { path: `material-sources/${digest.slice(7)}.json`, digest },
      },
      sources,
    },
  });
  const first = row('019fb7ce-3d00-7000-8000-000000000001');
  const second = row('019fb7ce-3d00-7000-8000-000000000002');
  const altered = structuredClone(second);
  if (altered.sourceTemplate === undefined) throw new Error('Missing test template');
  Object.assign(altered.sourceTemplate.sources.engine, { 'game::terrain': '// different source' });

  const owner = new PublicationMaterialProjectionAdmission();
  const admit = owner.stage(() => true);
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  expect(admit(structuredClone(first), material)).toEqual(first);
  expect(admit(altered, material)).toBeUndefined();
  expect(admit(structuredClone(second), material)).toEqual(second);
  expect(admit({ ...second, materialGuid: first.materialGuid }, material)).toBeUndefined();
  expect(owner.stage(() => true)(altered, material)).toBeUndefined();
  expect(encode.mock.calls.filter(([input]) => input === serialized)).toHaveLength(1);
  expect(owner.stage(() => true)(first, material)).toEqual(first);
  expect(encode.mock.calls.filter(([input]) => input === serialized)).toHaveLength(2);
});
