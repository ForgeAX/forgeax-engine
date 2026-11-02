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
