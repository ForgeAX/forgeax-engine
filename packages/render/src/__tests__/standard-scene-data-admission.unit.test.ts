import { internJson } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { SceneDataUnavailableError } from '../errors/render';
import { MaterialResource } from '../material-resource';
import {
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import { SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA } from '../temporal/scene-data';
import { createSceneDataCatalog } from '../temporal/scene-data-catalog';
import {
  createStandardSceneSurfaceAdmission,
  ProducedStandardSceneDataAdmissionInput,
  type StandardSceneDataContributor,
  standardAoSceneDataUnavailable,
  standardSceneDataContributorForDispatch,
  standardSceneSurfaceContributorBaseline,
} from '../temporal/standard-scene-data-admission';

it('serializes each complete contributor key once instead of during every sort comparison', () => {
  const contributors = Array.from({ length: 64 }, (_, index) => ({
    id: `row-${(index * 31) % 64}`,
    publication: 'publication-"\\\n',
    materialShaderId: 'forgeax::default-standard-pbr',
    geometry: 'mesh',
    deformation: 'rigid' as const,
    entryPoint: 'fs_ao_input',
    selectedProgram: `program-${index}`,
  }));
  const input = {
    viewIdentity: 'key-work-view',
    generation: 1,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
    contributors,
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  let admission: ReturnType<typeof createStandardSceneSurfaceAdmission>;
  try {
    admission = createStandardSceneSurfaceAdmission(input);
    expect(stringify.mock.calls.length).toBeLessThan(contributors.length * 3);
  } finally {
    stringify.mockRestore();
  }
  expect(
    createStandardSceneSurfaceAdmission({ ...input, contributors: [...contributors].reverse() })
      .identity,
  ).toBe(admission.identity);
  const captured = JSON.parse(admission.identity)[8];
  expect(captured).toHaveLength(64);
  expect(captured.every((row: unknown[]) => row[1] === 'publication-"\\\n')).toBe(true);
  const singletonStringify = vi.spyOn(JSON, 'stringify');
  let singletonCalls: number;
  try {
    createStandardSceneSurfaceAdmission({ ...input, contributors: contributors.slice(0, 1) });
    singletonCalls = singletonStringify.mock.calls.length;
  } finally {
    singletonStringify.mockRestore();
  }
  expect(singletonCalls).toBe(1);
  const first = contributors[0];
  if (first === undefined) throw new Error('Missing contributor');
  first.selectedProgram = 'replacement-program';
  expect(createStandardSceneSurfaceAdmission(input).identity).not.toBe(admission.identity);
  expect(JSON.parse(admission.identity)[8]).toEqual(captured);
});

it('uses the authored Standard root while preserving the selected cooked program facts', () => {
  const selectedProgram = 'cooked:standard-forward:artifact-7';
  const snapshot = {
    materialHandle: 31,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    materialProgramKeys: { forward: selectedProgram },
    materialEntryPoints: {
      forward: [{ name: 'fs_ao_input', stage: 'fragment', bindings: [] }],
    },
    materialContext: { geometry: 'mesh', vertexColor: false },
    materialPublication: {
      identity: {
        materialGuid: 'material/standard',
        publicationGeneration: 7,
        specializationKey: 'material-root-7',
        artifactHash: 'material-artifact-7',
      },
      programs: [
        {
          pass: 'forward',
          context: { pass: 'Forward', geometry: 'mesh', vertexColor: false },
          address: 'direct',
          specializationKey: selectedProgram,
          artifactHash: 'shader-artifact-7',
        },
      ],
    },
  } as unknown as MaterialSnapshot;
  const material = new MaterialResource(snapshot);
  const row = { material, materials: [material] } as unknown as RenderableSnapshot;
  const contributor = standardSceneDataContributorForDispatch(
    { ...row, worldId: 0, entityKey: 1 },
    {
      materialHandle: snapshot.materialHandle ?? 0,
      materialShaderId: selectedProgram,
      tags: { LightMode: 'Forward' },
      passIndex: 0,
    },
    'forward',
  );

  expect(contributor).toBeDefined();
  expect(contributor?.materialShaderId).toBe('forgeax::default-standard-pbr');
  expect(JSON.parse(contributor?.publication ?? 'null')).toMatchObject({
    1: selectedProgram,
  });
  expect(JSON.parse(contributor?.selectedProgram ?? 'null')).toMatchObject({
    address: 'direct',
    context: { geometry: 'mesh' },
    specializationKey: selectedProgram,
    artifactHash: 'shader-artifact-7',
  });
  expect(contributor).toMatchObject({
    geometry: 'mesh',
    deformation: 'rigid',
    entryPoint: 'fs_ao_input',
  });
  const supportedAdmission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'view/1',
    generation: 3,
    deviceGeneration: 4,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'forward',
    contributors: contributor === undefined ? [] : [contributor],
  });
  expect(supportedAdmission).toMatchObject({
    status: 'available',
    producer: 'standard-forward-surface-pass',
  });

  const wrongSelectedProgram = standardSceneDataContributorForDispatch(
    { ...row, worldId: 0, entityKey: 1 },
    {
      materialHandle: snapshot.materialHandle ?? 0,
      materialShaderId: 'cooked:unrelated-program',
      tags: { LightMode: 'Forward' },
      passIndex: 0,
    },
    'forward',
  );
  expect(wrongSelectedProgram?.entryPoint).toBeUndefined();
  const wrongAdmission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'view/1',
    generation: 3,
    deviceGeneration: 4,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'forward',
    contributors: wrongSelectedProgram === undefined ? [] : [wrongSelectedProgram],
  });
  expect(wrongAdmission).toMatchObject({
    status: 'unavailable',
    reason: 'coverage-incomplete',
    missingContributorIds: ['[0,1,31,0]'],
    missingContributors: [
      {
        id: '[0,1,31,0]',
        sourceTuple: [0, 1, 31, 0],
        reason: 'selected-pass-missing',
        rejectedField: 'selected-pass',
        dispatchProgramKey: 'cooked:unrelated-program',
        authoredModule: 'forgeax_material::standard',
        authoredShaderId: 'forgeax::default-standard-pbr',
        canonicalStandardPbr: true,
        selectedPass: 'forward',
        expectedFragmentEntry: 'fs_ao_input',
        publishedFragmentEntries: ['fs_ao_input'],
        registryLookupKey: selectedProgram,
        programCandidates: [
          {
            pass: 'forward',
            selectedProgramKey: selectedProgram,
            registryLookupKey: selectedProgram,
            fragmentEntryPoints: ['fs_ao_input'],
          },
        ],
      },
    ],
  });

  const aoError = standardAoSceneDataUnavailable({
    admission: wrongAdmission,
    viewIdentity: 'view/1',
    generation: 3,
    deviceGeneration: 4,
    renderPath: 'forward',
    fallbackLane: 'clustered',
  });
  expect(aoError?.detail).toMatchObject({
    reason: 'coverage-incomplete',
    missingContributors:
      wrongAdmission.status === 'unavailable' ? wrongAdmission.missingContributors : [],
  });

  const catalog = createSceneDataCatalog({
    featureIdentity: 'ambient-occlusion',
    viewIdentity: 'view/1',
    generation: 3,
    deviceGeneration: 4,
    planIdentity: 'plan/1',
    rgba16floatRenderable: true,
    surfaceAdmission: wrongAdmission,
  });
  let catalogError: unknown;
  try {
    catalog.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
  } catch (error) {
    catalogError = error;
  }
  expect(catalogError).toBeInstanceOf(SceneDataUnavailableError);
  expect(catalogError).toMatchObject({
    detail: {
      reason: 'coverage-incomplete',
      missingContributorIds: ['[0,1,31,0]'],
      missingContributors: [
        {
          reason: 'selected-pass-missing',
          dispatchProgramKey: 'cooked:unrelated-program',
          authoredShaderId: 'forgeax::default-standard-pbr',
        },
      ],
    },
  });
});

it('retains Deferred forward-only opaque rows in required producer coverage', () => {
  const snapshot = {
    materialHandle: 52,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    materialProgramKeys: { forward: 'cooked:standard-forward' },
    materialEntryPoints: {
      forward: [{ name: 'fs_ao_input', stage: 'fragment', bindings: [] }],
    },
    materialContext: { geometry: 'mesh', vertexColor: false },
    materialPublication: {
      identity: {
        materialGuid: 'material/forward-only',
        publicationGeneration: 2,
        specializationKey: 'root-forward-only',
        artifactHash: 'root-forward-only-hash',
      },
      programs: [
        {
          pass: 'forward',
          context: { pass: 'Forward', geometry: 'mesh', vertexColor: false },
          address: 'direct',
          specializationKey: 'cooked:standard-forward',
          artifactHash: 'shader-forward-only-hash',
        },
      ],
    },
  } as unknown as MaterialSnapshot;
  const material = new MaterialResource(snapshot);
  const contributor = standardSceneDataContributorForDispatch(
    {
      ...({ material, materials: [material] } as unknown as RenderableSnapshot),
      worldId: 0,
      entityKey: 9,
    },
    {
      materialHandle: 52,
      materialShaderId: 'cooked:standard-forward',
      tags: { LightMode: 'Forward' },
      passIndex: 0,
    },
    'deferred',
  );
  const admission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'deferred-view',
    generation: 5,
    deviceGeneration: 1,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'deferred',
    contributors: contributor === undefined ? [] : [contributor],
  });

  expect(contributor).toBeDefined();
  expect(admission).toMatchObject({
    status: 'unavailable',
    reason: 'coverage-incomplete',
    missingContributorIds: ['[0,9,52,0]'],
    missingContributors: [
      {
        reason: 'missing-fragment-entry',
        rejectedField: 'fragment-entry-point',
        selectedPass: 'forward',
        expectedFragmentEntry: 'fs_gbuffer',
        publishedFragmentEntries: ['fs_ao_input'],
      },
    ],
  });

  // Stock Deferred AO consumes only GBuffer surfaces. The existing later
  // Forward pass owns this opaque material; full SceneData stays unavailable.
  expect(
    standardAoSceneDataUnavailable({
      admission,
      viewIdentity: 'deferred-view',
      generation: 5,
      deviceGeneration: 1,
      renderPath: 'deferred',
      fallbackLane: 'clustered',
    }),
  ).toBeUndefined();

  if (contributor === undefined) throw Error('Missing valid Forward dispatch');
  const base = {
    viewIdentity: 'deferred-view',
    generation: 5,
    deviceGeneration: 1,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'deferred' as const,
  };
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...contributor, id: `forward-${i}` }));
  // A module may publish both entry points while only its Forward pass is
  // selected. Presence in WGSL is not proof of a GBuffer draw.
  const forwardWithGBufferEntry = new MaterialResource({
    ...snapshot,
    materialEntryPoints: {
      forward: [
        { name: 'fs_opaque', stage: 'fragment', bindings: [] },
        { name: 'fs_gbuffer', stage: 'fragment', bindings: [] },
      ],
    },
  } as unknown as MaterialSnapshot);
  const inactiveGBuffer = standardSceneDataContributorForDispatch(
    {
      ...({
        material: forwardWithGBufferEntry,
        materials: [forwardWithGBufferEntry],
      } as unknown as RenderableSnapshot),
      worldId: 0,
      entityKey: 9,
    },
    {
      materialHandle: 52,
      materialShaderId: 'cooked:standard-forward',
      tags: { LightMode: 'Forward' },
      passIndex: 0,
    },
    'deferred',
  );
  expect(inactiveGBuffer?.entryPoint).toBeUndefined();
  expect(
    createStandardSceneSurfaceAdmission({
      ...base,
      contributors: inactiveGBuffer === undefined ? [] : [inactiveGBuffer],
    }),
  ).toMatchObject({ status: 'unavailable', deferredGBufferEmpty: true });
  const many = createStandardSceneSurfaceAdmission({ ...base, contributors: rows });
  expect(many).toMatchObject({
    status: 'unavailable',
    deferredAoCompatible: true,
    deferredGBufferEmpty: true,
    omittedMissingContributorCount: 8,
  });
  // A non-Forward rejection outside the retained diagnostic window still blocks AO.
  const mixed = createStandardSceneSurfaceAdmission({
    ...base,
    contributors: [...rows, { ...contributor, id: 'zz-invalid-gbuffer', forwardOnly: false }],
  });
  expect(mixed).toMatchObject({
    status: 'unavailable',
    deferredAoCompatible: false,
    deferredGBufferEmpty: false,
    omittedMissingContributorCount: 9,
  });
  expect(
    standardAoSceneDataUnavailable({ ...base, admission: mixed, fallbackLane: 'clustered' }),
  ).toBeInstanceOf(SceneDataUnavailableError);

  const deferredVariant = {
    ...snapshot,
    passes: [
      ...snapshot.passes,
      {
        name: 'deferred',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Deferred' } },
      },
    ],
    materialProgramKeys: {
      ...snapshot.materialProgramKeys,
      deferred: 'cooked:standard-deferred',
    },
  } as unknown as MaterialSnapshot;
  const deferredMaterial = new MaterialResource(deferredVariant);
  expect(
    standardSceneDataContributorForDispatch(
      {
        ...({
          material: deferredMaterial,
          materials: [deferredMaterial],
        } as unknown as RenderableSnapshot),
        worldId: 0,
        entityKey: 10,
      },
      {
        materialHandle: 52,
        materialShaderId: 'cooked:standard-forward',
        tags: { LightMode: 'Forward' },
        passIndex: 0,
      },
      'deferred',
    ),
  ).toBeUndefined();
});

it('bounds rejected contributor facts and preserves the exact omitted count', () => {
  const contributors = Array.from({ length: 35 }, (_, index) => ({
    id: `[0,${index},80,0]`,
    publication: `publication-${index}`,
    materialShaderId: 'custom::material',
    geometry: 'mesh',
    deformation: 'rigid' as const,
    entryPoint: 'fs_custom',
    selectedProgram: `artifact-${index}`,
  }));
  const admission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'bounded-view',
    generation: 1,
    deviceGeneration: 1,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'forward',
    contributors,
  });

  expect(admission).toMatchObject({
    status: 'unavailable',
    reason: 'coverage-incomplete',
    missingContributorIds: contributors
      .map(({ id }) => id)
      .sort()
      .slice(0, 32),
    omittedMissingContributorCount: 3,
  });
  if (admission.status === 'unavailable') {
    expect(admission.missingContributors).toHaveLength(32);
    expect(admission.missingContributors[0]).toMatchObject({
      reason: 'authored-program-not-standard-pbr',
      rejectedField: 'authored-shader-id',
    });
    expect(admission.omittedMissingContributorCount).toBe(3);
  }
});

it.each([
  ['forgeax::default-unlit', 'mesh', 'rigid', 'available'],
  ['forgeax_material::unlit', 'mesh', 'rigid', 'available'],
  ['forgeax_material::unlit', 'skinned', 'skin', 'unavailable'],
  ['forgeax_material::unlit', 'mesh', 'morph', 'available'],
  ['forgeax_material::standard', 'mesh', 'morph', 'available'],
  ['forgeax::pbr-skin', 'skinned', 'morph', 'available'],
  ['custom::unlit', 'mesh', 'rigid', 'unavailable'],
] as const)('admits Forward AO for the published Unlit root %s (%s/%s): %s', (module, geometry, deformation, status) => {
  const snapshot = {
    materialHandle: 17,
    passes: [
      { name: 'forward', program: { module }, renderState: { tags: { LightMode: 'Forward' } } },
    ],
    materialProgramKeys: { forward: 'cooked:unlit-forward' },
    materialEntryPoints: { forward: [{ name: 'fs_ao_input', stage: 'fragment', bindings: [] }] },
    materialContext: { geometry, vertexColor: false },
  } as unknown as MaterialSnapshot;
  const material = new MaterialResource(snapshot);
  const contributor = standardSceneDataContributorForDispatch(
    {
      material,
      materials: [material],
      ...(geometry === 'skinned' ? { skinBinding: {} } : {}),
      ...(deformation === 'morph' ? { morph: {} } : {}),
      worldId: 0,
      entityKey: 251,
    } as unknown as RenderableSnapshot,
    {
      materialHandle: 17,
      materialShaderId: 'cooked:unlit-forward',
      tags: { LightMode: 'Forward' },
      passIndex: 1,
    },
    'forward',
  );
  expect(contributor).toBeDefined();
  const input = {
    viewIdentity: 'unlit-view',
    generation: 1,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
    contributors: contributor === undefined ? [] : [contributor],
  };
  expect(createStandardSceneSurfaceAdmission(input).status).toBe(status);
  if (contributor !== undefined) {
    const missingEntry = createStandardSceneSurfaceAdmission({
      ...input,
      contributors: [{ ...contributor, entryPoint: undefined }],
    });
    expect(missingEntry.status).toBe('unavailable');
    if (status === 'available' && missingEntry.status === 'unavailable')
      expect(missingEntry.missingContributors?.[0]?.reason).toBe('missing-fragment-entry');
  }
});

it.each([
  ['forgeax::pbr-skin', 'forward', 'fs_ao_input', 'available'],
  ['forgeax_material::pbr-skin', 'forward', 'fs_ao_input', 'available'],
  ['custom::pbr-skin', 'forward', 'fs_ao_input', 'unavailable'],
  ['forgeax::pbr-skin', 'deferred', 'fs_gbuffer', 'available'],
  ['forgeax_material::pbr-skin', 'deferred', 'fs_gbuffer', 'available'],
  ['custom::pbr-skin', 'deferred', 'fs_gbuffer', 'unavailable'],
] as const)('admits the exact supported cooked Skin root %s (%s/%s) as %s', (module, lane, entry, status) => {
  const snapshot = {
    materialHandle: 17,
    passes: [
      {
        name: lane,
        program: { module },
        renderState: { tags: { LightMode: lane === 'deferred' ? 'Deferred' : 'Forward' } },
      },
    ],
    materialProgramKeys: { [lane]: 'cooked:skin-program' },
    materialEntryPoints: { [lane]: [{ name: entry, stage: 'fragment', bindings: [] }] },
    materialContext: { geometry: 'skinned', vertexColor: false },
  } as unknown as MaterialSnapshot;
  const material = new MaterialResource(snapshot);
  const contributor = standardSceneDataContributorForDispatch(
    {
      ...({ material, materials: [material], skinBinding: {} } as unknown as RenderableSnapshot),
      worldId: 0,
      entityKey: 251,
    },
    {
      materialHandle: 17,
      materialShaderId: 'cooked:skin-program',
      tags: { LightMode: lane === 'deferred' ? 'Deferred' : 'Forward' },
      passIndex: 1,
    },
    lane,
  );
  expect(contributor).toBeDefined();
  const admission = createStandardSceneSurfaceAdmission({
    viewIdentity: 'skin-view',
    generation: 1,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: lane,
    contributors: contributor === undefined ? [] : [contributor],
  });
  expect(admission.status).toBe(status);
  if (status === 'available') expect(admission.deferredGBufferEmpty).toBe(false);
});

it('reuses an available proof only after checking current producer-owned contributor facts', () => {
  const snapshot = {
    materialHandle: 31,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    materialProgramKeys: { forward: 'cooked:forward' },
    materialEntryPoints: { forward: [{ name: 'fs_ao_input', stage: 'fragment', bindings: [] }] },
    materialContext: { geometry: 'mesh', vertexColor: false },
  } as unknown as MaterialSnapshot;
  const material = new MaterialResource(snapshot);
  const row = { material, materials: [material] } as unknown as RenderableSnapshot;
  const contributor = () => {
    const value = standardSceneDataContributorForDispatch(
      { ...row, worldId: 0, entityKey: 1 },
      {
        materialHandle: 31,
        materialShaderId: 'cooked:forward',
        tags: { LightMode: 'Forward' },
        passIndex: 0,
      },
      'forward',
    );
    if (value === undefined) throw new Error('Missing contributor');
    return value;
  };
  const input = {
    viewIdentity: 'retained-proof',
    generation: 1,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
    contributors: [contributor()],
  };
  const first = createStandardSceneSurfaceAdmission(input);
  expect(first.status).toBe('available');
  const next = { ...input, contributors: [contributor()] };
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    expect(createStandardSceneSurfaceAdmission(next, first)).toBe(first);
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
  // A forged or copied contributor has no producer-owned proof, even when all values match.
  const capturedContributor = next.contributors[0];
  if (capturedContributor === undefined) throw new Error('Missing captured contributor');
  expect(
    createStandardSceneSurfaceAdmission(
      { ...input, contributors: [{ ...capturedContributor }] },
      first,
    ),
  ).not.toBe(first);
  expect(createStandardSceneSurfaceAdmission({ ...next, deviceGeneration: 1 }, first)).not.toBe(
    first,
  );
  expect(
    createStandardSceneSurfaceAdmission({ ...next, contributors: [] }, first).identity,
  ).not.toBe(first.identity);
  // Borrowed material metadata remains live: every dispatch recaptures it.
  material.adopt({ ...snapshot, materialEntryPoints: {} });
  const rejected = createStandardSceneSurfaceAdmission(
    { ...input, contributors: [contributor()] },
    first,
  );
  expect(rejected.status).toBe('unavailable');
  expect(first.status).toBe('available');
  material.adopt(snapshot);
  expect(
    createStandardSceneSurfaceAdmission({ ...input, contributors: [contributor()] }, first),
  ).toBe(first);
});

function programObservationFixture(fixed: boolean) {
  const source = {
    ...defaultMaterialSnapshot(31),
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    materialProgramKeys: { forward: 'cooked:forward' },
    materialEntryPoints: {
      forward: [{ name: 'fs_ao_input', stage: 'fragment' as const, bindings: [] }],
    },
    materialContext: { geometry: 'mesh' as const, vertexColor: false },
    materialPublication: {
      identity: {
        materialGuid: 'material/observed',
        publicationGeneration: 1,
        specializationKey: 'root-1',
        artifactHash: 'root-hash-1',
      },
      programs: [
        {
          pass: 'forward',
          context: {
            backend: 'webgpu' as const,
            capability: 'storage-buffer' as const,
            pipeline: 'forward' as const,
            geometry: 'mesh' as const,
            pass: 'forward' as const,
            profile: 'forgeax-material-wgsl-v1' as const,
            toolchain: 'naga-oil' as const,
            instrumentation: 'none' as const,
          },
          address: 'direct' as const,
          specializationKey: 'cooked:forward',
          artifactHash: 'program-hash-1',
        },
      ],
    },
  };
  const groups = fixed
    ? internJson(
        structuredClone({
          passes: source.passes,
          materialProgramKeys: source.materialProgramKeys,
          materialEntryPoints: source.materialEntryPoints,
          materialContext: source.materialContext,
          materialPublication: source.materialPublication,
        }),
      )
    : undefined;
  const snapshot = fixed ? Object.freeze({ ...source, ...groups }) : source;
  const material = new MaterialResource(snapshot);
  const row = { material, materials: [material] } as unknown as RenderableSnapshot;
  const produce = (previous?: StandardSceneDataContributor) =>
    standardSceneDataContributorForDispatch(
      { ...row, worldId: 0, entityKey: 1 },
      {
        materialHandle: 31,
        materialShaderId: 'cooked:forward',
        tags: { LightMode: 'Forward' },
        passIndex: 0,
      },
      'forward',
      previous,
    );
  return { source, snapshot, material, row, produce };
}

it('serializes fixed program facts once while keeping each contribution current', () => {
  const f = programObservationFixture(true);
  const first = f.produce();
  if (first === undefined) throw new Error('Expected opaque contribution');
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    for (let index = 0; index < 32; index++) {
      const next = f.produce();
      expect(next?.publication).toBe(first.publication);
      expect(next?.selectedProgram).toBe(first.selectedProgram);
      expect(next?.facts?.selectedProgramFacts).toBe(first.facts?.selectedProgramFacts);
    }
    expect(stringify.mock.calls).toEqual(Array.from({ length: 32 }, () => [[0, 1, 31, 0]]));
  } finally {
    stringify.mockRestore();
  }
  const replacement = programObservationFixture(true).snapshot;
  f.material.adopt(
    Object.freeze({
      ...replacement,
      materialPublication: internJson(
        structuredClone({
          ...replacement.materialPublication,
          programs: replacement.materialPublication.programs.map((program) => ({
            ...program,
            artifactHash: 'program-hash-2',
          })),
        }),
      ),
    }),
  );
  const changed = f.produce();
  expect(changed?.selectedProgram).not.toBe(first.selectedProgram);
  expect(first.selectedProgram).toContain('program-hash-1');
  expect(first.facts?.selectedProgramFacts?.artifactHash).toBe('program-hash-1');
});

it('keeps mutable and accessor program metadata live despite shallow ownership flags', () => {
  const f = programObservationFixture(false);
  f.material.adopt(Object.freeze({ ...f.snapshot, immutableValues: true as const }));
  const first = f.produce();
  const context = f.source.materialPublication.programs[0]?.context;
  const getter = vi.fn(() => context);
  const program = f.source.materialPublication.programs[0];
  if (program === undefined || context === undefined) throw new Error('Expected program');
  Object.defineProperty(program, 'context', { get: getter, configurable: true });
  Reflect.set(context, 'instrumentation', 'validation');
  const next = f.produce();
  expect(getter).toHaveBeenCalled();
  expect(next?.selectedProgram).not.toBe(first?.selectedProgram);
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    f.produce();
    expect(stringify).toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it('does not reuse sparse frozen program tables as fixed observations', () => {
  const f = programObservationFixture(false);
  const entries = f.source.materialEntryPoints.forward;
  entries.length = 2;
  Object.freeze(entries[0]?.bindings);
  Object.freeze(entries[0]);
  Object.freeze(entries);
  Object.freeze(f.source.materialEntryPoints);
  const fixed = internJson(
    structuredClone({
      passes: f.source.passes,
      materialProgramKeys: f.source.materialProgramKeys,
      materialContext: f.source.materialContext,
      materialPublication: f.source.materialPublication,
    }),
  );
  f.material.adopt(Object.freeze({ ...f.source, ...fixed }));
  f.produce();
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    f.produce();
    expect(stringify).toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it('materializes dispatch identity only for contributors and retains missing-row diagnostics', () => {
  const dispatch = {
    materialHandle: 71,
    materialShaderId: 'cooked:shadow',
    passIndex: 3,
    tags: { LightMode: 'ShadowCaster' },
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    expect(standardSceneDataContributorForDispatch(undefined, dispatch, 'forward')).toBeUndefined();
    expect(stringify).not.toHaveBeenCalled();
    const missing = standardSceneDataContributorForDispatch(
      undefined,
      { ...dispatch, tags: { LightMode: 'Forward' } },
      'forward',
    );
    expect(missing?.id).toBe('[-1,-1,71,3]');
    expect(missing?.facts?.sourceTuple).toEqual([-1, -1, 71, 3]);
    expect(Object.isFrozen(missing?.facts?.sourceTuple)).toBe(true);
    expect(missing?.facts?.materialSnapshotMissing).toBe(true);
  } finally {
    stringify.mockRestore();
  }
});

it('captures dispatch identity and selection once before borrowed material reads', () => {
  const f = programObservationFixture(false);
  const observations: string[] = [];
  const row = {
    ...f.row,
    get worldId() {
      observations.push('world');
      return 2;
    },
    get entityKey() {
      observations.push('entity');
      return 9;
    },
    get materials() {
      observations.push('materials');
      return [f.material];
    },
  };
  const dispatch = {
    get materialHandle() {
      observations.push('handle');
      return 31;
    },
    get passIndex() {
      observations.push('pass');
      return 0;
    },
    get materialShaderId() {
      observations.push('shader');
      return 'cooked:forward';
    },
    get tags() {
      observations.push('tags');
      return { LightMode: 'Forward' };
    },
  };
  const contributor = standardSceneDataContributorForDispatch(row, dispatch, 'forward');
  expect(contributor?.id).toBe('[2,9,31,0]');
  expect(observations.slice(0, 6)).toEqual(['world', 'entity', 'handle', 'pass', 'shader', 'tags']);
  for (const field of ['world', 'entity', 'handle', 'pass', 'shader', 'tags'])
    expect(observations.filter((entry) => entry === field)).toHaveLength(1);
});

it('reuses complete fixed contributor observations and keeps held proofs independent', () => {
  const f = programObservationFixture(true);
  const first = f.produce();
  if (first === undefined) throw new Error('Expected contribution');
  const input = {
    viewIdentity: 'producer-observations',
    generation: 1,
    deviceGeneration: 0,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
    contributors: [first],
  };
  const admitted = createStandardSceneSurfaceAdmission(input);
  expect(admitted.status).toBe('available');
  expect(standardSceneSurfaceContributorBaseline(admitted)).toEqual([first]);
  input.contributors.length = 0;
  expect(standardSceneSurfaceContributorBaseline(admitted)).toEqual([first]);
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    expect(f.produce(first)).toBe(first);
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
  const dispatch = {
    materialHandle: 31,
    materialShaderId: 'cooked:forward',
    tags: { LightMode: 'Forward' },
    passIndex: 0,
  };
  const row = { ...f.row, worldId: 0, entityKey: 1 };
  const moved = standardSceneDataContributorForDispatch(
    { ...row, entityKey: 2 },
    dispatch,
    'forward',
    first,
  );
  expect(moved).not.toBe(first);
  expect(moved?.facts?.sourceTuple).toEqual([0, 2, 31, 0]);
  const morphed = standardSceneDataContributorForDispatch(
    { ...row, morph: {} as NonNullable<RenderableSnapshot['morph']> },
    dispatch,
    'forward',
    first,
  );
  if (morphed === undefined) throw new Error('Expected morphed contribution');
  expect(morphed.deformation).toBe('morph');
  expect(morphed?.facts?.morphWeightsPresent).toBe(true);
  expect(
    createStandardSceneSurfaceAdmission({ ...input, contributors: [morphed] }, admitted).status,
  ).toBe('available');
  expect(
    createStandardSceneSurfaceAdmission(
      { ...input, contributors: [{ ...morphed, deformation: 'unknown' }] },
      admitted,
    ).status,
  ).toBe('unavailable');
  const deferred = standardSceneDataContributorForDispatch(row, dispatch, 'deferred', first);
  expect(deferred?.forwardOnly).toBe(true);
  expect(deferred?.facts?.expectedFragmentEntry).toBe('fs_gbuffer');
  expect(first.facts?.morphWeightsPresent).toBe(false);
  expect(first.facts?.expectedFragmentEntry).toBe('fs_ao_input');
  f.material.adopt(
    Object.freeze({
      ...f.snapshot,
      materialContext: Object.freeze({ geometry: 'sprite' as const, vertexColor: false }),
    }),
  );
  expect(f.produce(first)?.geometry).toBe('sprite');
  expect(first.geometry).toBe('mesh');
});

it('ignores foreign prior getters and recaptures borrowed and rejected observations', () => {
  const fixed = programObservationFixture(true);
  const getter = vi.fn(() => {
    throw new Error('foreign prior was read');
  });
  const foreign = Object.defineProperty({}, 'facts', {
    get: getter,
  }) as StandardSceneDataContributor;
  expect(fixed.produce(foreign)).toBeDefined();
  expect(getter).not.toHaveBeenCalled();
  const borrowed = programObservationFixture(false);
  const first = borrowed.produce();
  const next = borrowed.produce(first);
  expect(next).not.toBe(first);
  expect(next).toEqual(first);
  borrowed.source.materialEntryPoints.forward.length = 0;
  expect(borrowed.produce(first)?.entryPoint).toBeUndefined();
  const dispatch = {
    materialHandle: 31,
    materialShaderId: 'cooked:forward',
    tags: { LightMode: 'Forward' },
    passIndex: 0,
  };
  const missing = standardSceneDataContributorForDispatch(undefined, dispatch, 'forward');
  expect(standardSceneDataContributorForDispatch(undefined, dispatch, 'forward', missing)).not.toBe(
    missing,
  );
});

/** A frozen published material whose forward pass authors `module`. */
function frozenSurfaceMaterial(handle: number, module: string): MaterialResource {
  const programKey = `cooked:${module}:${handle}`;
  return new MaterialResource(
    Object.freeze({
      ...defaultMaterialSnapshot(handle),
      ...internJson({
        passes: [
          {
            name: 'forward',
            program: { module },
            renderState: { tags: { LightMode: 'Forward' } },
          },
        ],
        materialProgramKeys: { forward: programKey },
        materialEntryPoints: {
          forward: [{ name: 'fs_ao_input', stage: 'fragment', bindings: [] }],
        },
        materialContext: { geometry: 'mesh', vertexColor: false },
        materialPublication: {
          identity: {
            materialGuid: `material/${handle}`,
            publicationGeneration: 1,
            specializationKey: `root-${handle}`,
            artifactHash: `material-artifact-${handle}`,
          },
          programs: [
            {
              pass: 'forward',
              context: { pass: 'Forward', geometry: 'mesh', vertexColor: false },
              address: 'direct',
              specializationKey: programKey,
              artifactHash: `shader-artifact-${handle}`,
            },
          ],
        },
      }),
    }) as unknown as MaterialSnapshot,
  );
}

type VisibleRow = {
  readonly row: RenderableSnapshot | undefined;
  readonly handle: number;
  readonly shaderId: string | undefined;
};

function visibleRow(entityKey: number, material: MaterialResource): VisibleRow {
  return {
    row: {
      worldId: 0,
      entityKey,
      material,
      materials: [material],
    } as unknown as RenderableSnapshot,
    handle: material.snapshot.materialHandle ?? 0,
    shaderId: material.snapshot.materialProgramKeys?.forward,
  };
}

const unavailableHeader = {
  viewIdentity: 'unavailable-proof',
  generation: 1,
  deviceGeneration: 0,
  standardPipeline: true,
  cameraAvailable: true,
  lane: 'clustered' as const,
  renderPath: 'forward' as const,
};

/** One view frame of the Feature view producer: produce against the baseline, then admit. */
function admitVisible(
  rows: readonly VisibleRow[],
  previous: ReturnType<typeof createStandardSceneSurfaceAdmission> | undefined,
  header: Omit<
    Parameters<typeof createStandardSceneSurfaceAdmission>[0],
    'contributors'
  > = unavailableHeader,
) {
  const baseline = standardSceneSurfaceContributorBaseline(previous);
  const input = new ProducedStandardSceneDataAdmissionInput();
  input.capture(header);
  const contributors = input.contributors;
  for (const { row, handle, shaderId } of rows) {
    const contributor = standardSceneDataContributorForDispatch(
      row,
      {
        materialHandle: handle,
        materialShaderId: shaderId,
        tags: { LightMode: 'Forward' },
        passIndex: 0,
      },
      header.renderPath === 'deferred' ? 'deferred' : 'forward',
      baseline?.[contributors.length],
    );
    if (contributor !== undefined) contributors.push(contributor);
  }
  return {
    input,
    admission: createStandardSceneSurfaceAdmission(input, previous),
    // The complete route without any prior proof, for result equivalence.
    fresh: () =>
      createStandardSceneSurfaceAdmission({ ...header, contributors: [...contributors] }),
  };
}

it('reuses an unchanged unavailable admission and its diagnostics without recomputing them', () => {
  const standard = frozenSurfaceMaterial(41, 'forgeax_material::standard');
  const custom = frozenSurfaceMaterial(42, 'game::custom_surface');
  const rows = [visibleRow(1, standard), visibleRow(2, custom), visibleRow(3, standard)];
  const first = admitVisible(rows, undefined);
  expect(first.admission).toMatchObject({
    status: 'unavailable',
    reason: 'coverage-incomplete',
    missingContributorIds: ['[0,2,42,0]'],
  });
  expect(standardSceneSurfaceContributorBaseline(first.admission)).toEqual(
    first.input.contributors,
  );

  const stringify = vi.spyOn(JSON, 'stringify');
  let second: ReturnType<typeof admitVisible>;
  try {
    second = admitVisible(rows, first.admission);
    expect(second.admission).toBe(first.admission);
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
  // Producer-owned prior observations are carried forward unchanged.
  expect(
    second.input.contributors.every((row, index) => row === first.input.contributors[index]),
  ).toBe(true);
  expect(second.fresh()).toEqual(first.admission);
  expect(second.fresh()).not.toBe(first.admission);
  expect(admitVisible(rows, second.admission).admission).toBe(first.admission);
});

it('invalidates an unavailable proof when material, visible set or view header changes', () => {
  const standard = frozenSurfaceMaterial(41, 'forgeax_material::standard');
  const custom = frozenSurfaceMaterial(42, 'game::custom_surface');
  const otherCustom = frozenSurfaceMaterial(42, 'game::other_surface');
  const rows = [visibleRow(1, standard), visibleRow(2, custom), visibleRow(3, standard)];
  const previous = admitVisible(rows, undefined).admission;
  expect(previous.status).toBe('unavailable');

  const changed = (name: string, next: ReturnType<typeof admitVisible>) => {
    expect(next.admission, `${name} must not reuse the prior proof`).not.toBe(previous);
    expect(next.admission, `${name} must equal the complete route`).toEqual(next.fresh());
    return next.admission;
  };
  // Material swapped: to a Standard material, then to another non-Standard root.
  const healed = changed(
    'Standard swap',
    admitVisible([rows[0], visibleRow(2, standard), rows[2]] as VisibleRow[], previous),
  );
  expect(healed.status).toBe('available');
  const swapped = changed(
    'custom swap',
    admitVisible([rows[0], visibleRow(2, otherCustom), rows[2]] as VisibleRow[], previous),
  );
  expect(swapped.status).toBe('unavailable');
  expect(swapped.identity).not.toBe(previous.identity);
  if (swapped.status === 'unavailable')
    expect(swapped.missingContributors[0]?.authoredModule).toBe('game::other_surface');

  // Visible set changed: removed, added, reordered and moved rows.
  expect(changed('removed row', admitVisible(rows.slice(0, 2), previous)).identity).not.toBe(
    previous.identity,
  );
  expect(
    changed('added row', admitVisible([...rows, visibleRow(4, custom)], previous)).identity,
  ).not.toBe(previous.identity);
  changed('reordered rows', admitVisible([rows[2], rows[1], rows[0]] as VisibleRow[], previous));
  const moved = changed(
    'moved rejected row',
    admitVisible([rows[0], visibleRow(5, custom), rows[2]] as VisibleRow[], previous),
  );
  if (moved.status === 'unavailable') expect(moved.missingContributorIds).toEqual(['[0,5,42,0]']);

  // View header changed: every admission input field.
  for (const [name, header] of [
    ['view', { ...unavailableHeader, viewIdentity: 'other-view' }],
    ['generation', { ...unavailableHeader, generation: 2 }],
    ['device', { ...unavailableHeader, deviceGeneration: 1 }],
    ['pipeline', { ...unavailableHeader, standardPipeline: false }],
    ['camera', { ...unavailableHeader, cameraAvailable: false }],
    ['lane', { ...unavailableHeader, lane: 'direct' as const }],
    ['render path', { ...unavailableHeader, renderPath: 'deferred' as const }],
    ['no render path', { ...unavailableHeader, renderPath: undefined }],
  ] as const)
    changed(name, admitVisible(rows, previous, header));
});
