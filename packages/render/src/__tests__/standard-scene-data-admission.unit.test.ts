import { expect, it } from 'vitest';
import { SceneDataUnavailableError } from '../errors/render';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA } from '../temporal/scene-data';
import { createSceneDataCatalog } from '../temporal/scene-data-catalog';
import {
  createStandardSceneSurfaceAdmission,
  standardAoSceneDataUnavailable,
  standardSceneDataContributorForDispatch,
} from '../temporal/standard-scene-data-admission';

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
  const contributor = standardSceneDataContributorForDispatch({
    row,
    sourceTuple: [0, 1, 31, 0],
    materialHandle: snapshot.materialHandle ?? 0,
    materialShaderId: selectedProgram,
    tags: { LightMode: 'Forward' },
    lane: 'forward',
    id: '[0,1,31,0]',
  });

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

  const wrongSelectedProgram = standardSceneDataContributorForDispatch({
    row,
    sourceTuple: [0, 1, 31, 0],
    materialHandle: snapshot.materialHandle ?? 0,
    materialShaderId: 'cooked:unrelated-program',
    tags: { LightMode: 'Forward' },
    lane: 'forward',
    id: '[0,1,31,0]',
  });
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
  const contributor = standardSceneDataContributorForDispatch({
    row: { material, materials: [material] } as unknown as RenderableSnapshot,
    sourceTuple: [0, 9, 52, 0],
    materialHandle: 52,
    materialShaderId: 'cooked:standard-forward',
    tags: { LightMode: 'Forward' },
    lane: 'deferred',
    id: '[0,9,52,0]',
  });
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
  const inactiveGBuffer = standardSceneDataContributorForDispatch({
    row: {
      material: forwardWithGBufferEntry,
      materials: [forwardWithGBufferEntry],
    } as unknown as RenderableSnapshot,
    sourceTuple: [0, 9, 52, 0],
    materialHandle: 52,
    materialShaderId: 'cooked:standard-forward',
    tags: { LightMode: 'Forward' },
    lane: 'deferred',
    id: 'inactive-gbuffer',
  });
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
    standardSceneDataContributorForDispatch({
      row: {
        material: deferredMaterial,
        materials: [deferredMaterial],
      } as unknown as RenderableSnapshot,
      sourceTuple: [0, 10, 52, 0],
      materialHandle: 52,
      materialShaderId: 'cooked:standard-forward',
      tags: { LightMode: 'Forward' },
      lane: 'deferred',
      id: '[0,10,52,0]',
    }),
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
  ['forgeax_material::unlit', 'mesh', 'morph', 'unavailable'],
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
  const contributor = standardSceneDataContributorForDispatch({
    row: {
      material,
      materials: [material],
      ...(deformation === 'skin' ? { skinBinding: {} } : {}),
      ...(deformation === 'morph' ? { morph: {} } : {}),
    } as unknown as RenderableSnapshot,
    sourceTuple: [0, 251, 17, 1],
    materialHandle: 17,
    materialShaderId: 'cooked:unlit-forward',
    tags: { LightMode: 'Forward' },
    lane: 'forward',
    id: 'unlit',
  });
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
  const contributor = standardSceneDataContributorForDispatch({
    row: { material, materials: [material], skinBinding: {} } as unknown as RenderableSnapshot,
    sourceTuple: [0, 251, 17, 1],
    materialHandle: 17,
    materialShaderId: 'cooked:skin-program',
    tags: { LightMode: lane === 'deferred' ? 'Deferred' : 'Forward' },
    lane,
    id: 'skin',
  });
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
