import { internJson } from '@forgeax/engine-types';
import { bench, describe } from 'vitest';
import type { RenderFeaturePlannedFrame, RenderFeatureWorkPlan } from '../src/features/plan';
import { captureMaterialSnapshot, MaterialResource } from '../src/material-resource';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../src/render-system-extract';
import type { StandardSceneSurfaceAdmission } from '../src/temporal/scene-data';
import {
  createSceneDataCatalog,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
} from '../src/temporal/scene-data-catalog';
import {
  createStandardSceneSurfaceAdmission,
  ProducedStandardSceneDataAdmissionInput,
  sceneDataSurfaceBindings,
  standardSceneDataContributorForDispatch,
  standardSceneSurfaceContributorBaseline,
} from '../src/temporal/standard-scene-data-admission';

// A steady frame of the Feature view preparation: about 1,000 visible
// Forward dispatches over shared frozen material publications (plus one
// ShadowCaster dispatch per row that the admission filters out), and a VFX
// Feature plan with many compute passes next to one SceneData consumer.
const ROWS = 1_000;
const MATERIALS = 48;
const EMITTERS = 96;
const options = { time: 1_000, warmupTime: 200, warmupIterations: 20 };

function standardSnapshot(handle: number, module: string): MaterialSnapshot {
  const programKey = `cooked:${module}:forward:${handle}`;
  return captureMaterialSnapshot({
    ...defaultMaterialSnapshot(),
    materialHandle: handle,
    passes: internJson([
      { name: 'forward', program: { module }, renderState: { tags: { LightMode: 'Forward' } } },
      {
        name: 'shadow',
        program: { module },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ]),
    materialProgramKeys: internJson({ forward: programKey, shadow: `${programKey}:shadow` }),
    materialEntryPoints: internJson({
      forward: [{ name: 'fs_ao_input', stage: 'fragment', bindings: [] }],
    }),
    materialContext: internJson({ geometry: 'mesh', vertexColor: false }),
    materialPublication: internJson({
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
    }),
  } as unknown as MaterialSnapshot);
}

interface FrameFixture {
  readonly rows: readonly RenderableSnapshot[];
  readonly dispatch: readonly DispatchEntry[];
}

/** `custom` rows author a non-Standard root, which leaves the admission unavailable. */
function frameFixture(custom: number): FrameFixture {
  const materials = Array.from({ length: MATERIALS }, (_, index) => {
    const module = index < custom ? 'game::custom_surface' : 'forgeax_material::standard';
    return new MaterialResource(standardSnapshot(index + 1, module));
  });
  const rows: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  for (let row = 0; row < ROWS; row++) {
    const material = materials[row % MATERIALS] as MaterialResource;
    rows.push({ worldId: 0, entityKey: row + 1, material, materials: [material] } as never);
    const snapshot = material.snapshot;
    snapshot.passes.forEach((pass, passIndex) => {
      dispatch.push({
        entityIndex: row,
        materialHandle: snapshot.materialHandle ?? 0,
        renderableIndex: row,
        passIndex,
        queue: 2000,
        layer: 0,
        tags: (pass.renderState?.tags ?? {}) as Record<string, string>,
        renderState: pass.renderState,
        defines: undefined,
        vertexEntry: undefined,
        fragmentEntry: undefined,
        materialShaderId: snapshot.materialProgramKeys?.[pass.name],
      } as DispatchEntry);
    });
  }
  return { rows, dispatch };
}

/** The per-view admission loop of `prepareFeatureFrameInput`. */
function admitFrame(
  fixture: FrameFixture,
  previous: StandardSceneSurfaceAdmission | undefined,
): StandardSceneSurfaceAdmission {
  const input = new ProducedStandardSceneDataAdmissionInput();
  input.capture({
    viewIdentity: 'camera:1',
    generation: 1,
    deviceGeneration: 1,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered',
    renderPath: 'forward',
  });
  const contributors = input.contributors;
  const baseline = standardSceneSurfaceContributorBaseline(previous);
  let index = 0;
  for (const dispatch of fixture.dispatch) {
    const contributor = standardSceneDataContributorForDispatch(
      fixture.rows[dispatch.renderableIndex],
      dispatch,
      'forward',
      baseline?.[index],
    );
    if (contributor !== undefined) {
      contributors.push(contributor);
      index++;
    }
  }
  return createStandardSceneSurfaceAdmission(input, previous);
}

function vfxPlan(): RenderFeatureWorkPlan {
  const resources: RenderFeatureWorkPlan['resources'][number][] = [];
  const passes: RenderFeatureWorkPlan['passes'][number][] = [];
  for (let emitter = 0; emitter < EMITTERS; emitter++) {
    const prefix = `emitter-${emitter}`;
    resources.push(
      {
        kind: 'compute-program',
        name: `${prefix}.program`,
        program: {
          wgsl: '@compute @workgroup_size(64) fn simulate() {}',
          entryPoints: ['simulate'],
          bindings: [
            {
              entries: [
                { binding: 0, visibility: 4, buffer: { type: 'storage' } },
                { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
              ],
            },
          ],
        },
      },
      { kind: 'buffer', name: `${prefix}.particles`, size: 4_096, usage: ['storage'] },
      { kind: 'buffer', name: `${prefix}.runtime`, size: 16, usage: ['uniform'] },
      {
        kind: 'compute-bindings',
        name: `${prefix}.bindings`,
        program: `${prefix}.program`,
        entries: [
          { binding: 0, resource: `${prefix}.particles` },
          { binding: 1, resource: `${prefix}.runtime` },
        ],
      },
    );
    passes.push({
      kind: 'compute',
      name: `${prefix}.simulate`,
      program: `${prefix}.program`,
      bindings: `${prefix}.bindings`,
      dispatches: [{ kind: 'direct', entryPoint: 'simulate', workgroups: [1] }],
    });
  }
  return { resources, passes };
}

function consumerPlan(admission: StandardSceneSurfaceAdmission): RenderFeaturePlannedFrame {
  const target = createSceneDataCatalog({
    featureIdentity: 'scene-consumer',
    viewIdentity: 'camera:1',
    deviceGeneration: 1,
    generation: 1,
    planIdentity: 'scene-consumer:camera:1:1',
    rgba16floatRenderable: true,
    surfaceAdmission: admission,
    surfaceAdmissionRevision: 1,
  }).require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
  return {
    featureIdentity: 'scene-consumer',
    scope: { view: 'camera:1' },
    generation: 1,
    signature: 'scene-consumer',
    plan: {
      resources: [
        {
          kind: 'compute-program',
          name: 'consumer-program',
          program: {
            wgsl: '@compute @workgroup_size(1) fn consume() {}',
            entryPoints: ['consume'],
            bindings: [
              {
                entries: [
                  {
                    binding: 0,
                    visibility: 4,
                    texture: { sampleType: 'uint', viewDimension: '2d', multisampled: false },
                  },
                ],
              },
            ],
          },
        },
        {
          kind: 'prepared-gpu-resource',
          name: 'surface-view',
          resource: { kind: 'texture-view', value: undefined },
          logicalTarget: target,
        },
        {
          kind: 'compute-bindings',
          name: 'consumer-bindings',
          program: 'consumer-program',
          entries: [{ binding: 0, resource: 'surface-view' }],
        },
      ],
      passes: [
        {
          kind: 'compute',
          name: 'consume-surface',
          program: 'consumer-program',
          bindings: 'consumer-bindings',
          dispatches: [{ kind: 'direct', entryPoint: 'consume', workgroups: [1, 1, 1] }],
        },
      ],
    },
  } as RenderFeaturePlannedFrame;
}

const available = frameFixture(0);
const unavailable = frameFixture(1);
let availablePrevious = admitFrame(available, undefined);
let unavailablePrevious = admitFrame(unavailable, undefined);
if (availablePrevious.status !== 'available' || unavailablePrevious.status !== 'unavailable')
  throw new Error('admission fixture did not reach its intended status');

const plans: readonly RenderFeaturePlannedFrame[] = [
  {
    featureIdentity: 'forgeax.vfx-render.gpu-particles',
    scope: { view: 'camera:1' },
    generation: 1,
    signature: 'vfx',
    plan: vfxPlan(),
  },
  consumerPlan(availablePrevious),
];
if (sceneDataSurfaceBindings(plans, availablePrevious).length !== 1)
  throw new Error('pass-access fixture lost its SceneData consumer');

describe(`feature frame admission (${ROWS} visible rows, steady frame)`, () => {
  bench(
    'admit all-Standard surface contributors',
    () => {
      availablePrevious = admitFrame(available, availablePrevious);
    },
    options,
  );
  bench(
    'admit surface contributors with one non-Standard material',
    () => {
      unavailablePrevious = admitFrame(unavailable, unavailablePrevious);
    },
    options,
  );
});

describe(`feature plan SceneData bindings (${EMITTERS} VFX compute passes)`, () => {
  bench(
    'derive SceneData surface bindings',
    () => {
      sceneDataSurfaceBindings(plans, availablePrevious);
    },
    options,
  );
});
