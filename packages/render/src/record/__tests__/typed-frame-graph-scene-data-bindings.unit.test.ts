import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeaturePlannedFrame } from '../../features/plan';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import type {
  SceneDataSurfaceBinding,
  SceneDataTarget,
  SceneDataTargetOwnerIdentity,
} from '../../temporal/scene-data';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA, sceneDataTargetOwner } from '../../temporal/scene-data';
import {
  createSceneDataCatalog,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
} from '../../temporal/scene-data-catalog';
import {
  createStandardSceneSurfaceAdmission,
  sceneDataSurfaceBindings,
  sceneDataTopologyFields,
} from '../../temporal/standard-scene-data-admission';
import { projectSceneDataSampledViews, targetResolver } from '../typed-frame-graph-bindings';

interface FixtureIdentity {
  readonly feature?: string;
  readonly view?: string;
  readonly generation?: number;
  readonly deviceGeneration?: number;
  readonly plan?: string;
  readonly publication?: string;
  readonly revision?: number;
}

function normalCatalog(identity: FixtureIdentity = {}) {
  const viewIdentity = identity.view ?? 'camera:4';
  const generation = identity.generation ?? 7;
  const deviceGeneration = identity.deviceGeneration ?? 3;
  const featureIdentity = identity.feature ?? 'scene-consumer';
  const planIdentity = identity.plan ?? `${featureIdentity}:${viewIdentity}:${generation}`;
  const contributor = {
    id: 'world/entity/material/pass',
    publication: identity.publication ?? 'material-publication-1',
    materialShaderId: 'forgeax::default-standard-pbr',
    geometry: 'mesh',
    deformation: 'rigid',
    entryPoint: 'fs_ao_input',
    selectedProgram: 'direct:artifact-1:forward',
  } as const;
  const surfaceAdmission = createStandardSceneSurfaceAdmission({
    viewIdentity,
    generation,
    deviceGeneration,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'direct',
    renderPath: 'forward',
    contributors: [contributor],
  });
  const catalog = createSceneDataCatalog({
    featureIdentity,
    viewIdentity,
    deviceGeneration,
    generation,
    planIdentity,
    rgba16floatRenderable: true,
    surfaceAdmission,
    surfaceAdmissionRevision: identity.revision ?? 1,
  });
  return {
    admission: surfaceAdmission,
    target: catalog.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA),
    depthTarget: catalog.require(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA),
  };
}

function normalTarget(identity: FixtureIdentity = {}) {
  return normalCatalog(identity).target;
}

function temporalTarget(identity: FixtureIdentity = {}): SceneDataTarget {
  const viewIdentity = identity.view ?? 'camera:4';
  const generation = identity.generation ?? 7;
  const featureIdentity = identity.feature ?? 'scene-consumer';
  return createSceneDataCatalog({
    featureIdentity,
    viewIdentity,
    generation,
    deviceGeneration: identity.deviceGeneration ?? 3,
    planIdentity: identity.plan ?? `${featureIdentity}:${viewIdentity}:${generation}`,
    rgba16floatRenderable: true,
  }).require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
}

function sampledSurfacePlan(target: SceneDataTarget): RenderFeaturePlannedFrame {
  return {
    featureIdentity: 'scene-consumer',
    scope: { view: 'camera:4' },
    generation: 7,
    signature: 'same-plan',
    plan: {
      resources: [
        {
          kind: 'compute-program',
          name: 'consumer-program',
          program: {
            wgsl: '@group(0) @binding(0) var surface: texture_2d<u32>; @compute @workgroup_size(1) fn consume() {}',
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

function semanticTarget(
  resource: SceneDataTarget,
  bindingSchema: SceneDataSurfaceBinding['schema'] = resource.schema,
  bindingOwner: SceneDataTargetOwnerIdentity | undefined = sceneDataTargetOwner(resource),
) {
  const texture = {};
  const view = {};
  const target = {
    texture,
    view,
    format: resource.format,
    sampleCount: 1,
    sceneDataBindings: [
      {
        schema: bindingSchema,
        owners: bindingOwner === undefined ? [] : [bindingOwner],
      },
    ],
  } as unknown as RenderPipelineTarget;
  return { target, texture, view };
}

describe('typed frame graph SceneData bindings', () => {
  it.each([
    { bindings: undefined },
    { bindings: [] },
  ])('omits unconsumed topology admission with bindings %j', ({ bindings }) => {
    const { admission } = normalCatalog();
    expect(sceneDataTopologyFields(admission, bindings)).toEqual({});
  });

  it('retains consumed topology admission and binding identities', () => {
    const { admission, target } = normalCatalog();
    const bindings = sceneDataSurfaceBindings([sampledSurfacePlan(target)], admission);
    expect(sceneDataTopologyFields(admission, bindings)).toEqual({
      sceneDataAdmission: admission,
      sceneDataBindings: bindings,
    });
  });

  it('projects only SceneData depth reads onto a separate depth-only view of the same texture', () => {
    const builder = new RenderGraphBuilder<RenderPipelineFrame>();
    const texture = builder
      .createTexture('surface-depth', {
        format: 'depth32float-stencil8',
        size: { width: 8, height: 8 },
      })
      .unwrap();
    const attachmentView = builder.view(texture).unwrap();
    const createView = vi.spyOn(builder, 'view');
    const depthTarget = normalCatalog().depthTarget;
    const depthPhysical = semanticTarget(depthTarget);
    const depthSemantic = {
      ...depthPhysical.target,
      texture,
      view: attachmentView,
    } as unknown as RenderPipelineTarget;
    const depthViews = new Map<RenderPipelineTarget['texture'], RenderPipelineTarget['view']>();

    const projected = projectSceneDataSampledViews(builder, [depthSemantic], depthViews).unwrap();
    const sampledDepth = targetResolver([], projected)(depthTarget);
    expect(createView).toHaveBeenCalledTimes(1);
    expect(createView).toHaveBeenCalledWith(texture, { aspect: 'depth-only' });
    expect(sampledDepth?.texture).toBe(texture);
    expect(sampledDepth?.view).toBe(projected[0]?.view);
    expect(sampledDepth?.view).not.toBe(attachmentView);
    expect(depthSemantic.view).toBe(attachmentView);
    const staleDepth = normalCatalog({
      generation: 8,
      plan: 'scene-consumer:camera:4:8',
    }).depthTarget;
    expect(targetResolver([], projected)(staleDepth)).toBeUndefined();

    const normal = normalTarget();
    const temporal = temporalTarget();
    const normalPhysical = semanticTarget(normal);
    const temporalPhysical = semanticTarget(temporal);
    const nonDepth = projectSceneDataSampledViews(
      builder,
      [normalPhysical.target, temporalPhysical.target],
      depthViews,
    ).unwrap();
    expect(createView).toHaveBeenCalledTimes(1);
    expect(targetResolver([], nonDepth)(normal)?.view).toBe(normalPhysical.view);
    expect(targetResolver([], nonDepth)(temporal)?.view).toBe(temporalPhysical.view);
  });

  it('resolves only the exact schema, feature, view, plan, generation, device and admission', () => {
    const admitted = normalTarget();
    const physical = semanticTarget(admitted);
    const resolve = targetResolver([], [physical.target]);
    expect(resolve(admitted)).toEqual({ texture: physical.texture, view: physical.view });

    const wrongSchema = semanticTarget(admitted, SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA);
    expect(targetResolver([], [wrongSchema.target])(admitted)).toBeUndefined();

    const admittedOwner = sceneDataTargetOwner(admitted);
    if (admittedOwner === undefined) throw new Error('admitted test target has no owner');
    const mismatchedOwner = semanticTarget(admitted, undefined, {
      ...admittedOwner,
      viewIdentity: 'camera:other',
    });
    expect(targetResolver([], [mismatchedOwner.target])(admitted)).toBeUndefined();

    const foreignView = normalTarget({
      view: 'camera:other',
      plan: 'scene-consumer:camera:other:7',
    });
    const staleGeneration = normalTarget({ generation: 8, plan: 'scene-consumer:camera:4:8' });
    const foreignPlan = normalTarget({ plan: 'replacement-plan' });
    const staleDevice = normalTarget({ deviceGeneration: 4 });
    const staleAdmission = normalTarget({ publication: 'material-publication-2' });
    const staleRevision = normalTarget({ revision: 2 });
    for (const [name, token] of [
      ['view', foreignView],
      ['generation', staleGeneration],
      ['plan', foreignPlan],
      ['device', staleDevice],
      ['admission', staleAdmission],
      ['admission revision', staleRevision],
    ] as const) {
      expect(resolve(token), `stale ${name} token must not resolve`).toBeUndefined();
    }
  });

  it('keeps same-admission tokens from distinct structural revisions as separate owners', () => {
    const first = normalCatalog({ revision: 1 });
    const second = normalCatalog({ revision: 2 });
    expect(first.admission.identity).toBe(second.admission.identity);

    const bindings = sceneDataSurfaceBindings(
      [sampledSurfacePlan(first.target), sampledSurfacePlan(second.target)],
      first.admission,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.owners.map((owner) => owner.surfaceAdmissionRevision)).toEqual([1, 2]);
  });

  it('binds temporal owners without surface admission and preserves the exact temporal identity', () => {
    const temporal = temporalTarget();
    const physical = semanticTarget(temporal);
    const resolve = targetResolver([], [physical.target]);
    expect(resolve(temporal)).toEqual({ texture: physical.texture, view: physical.view });

    const owner = sceneDataTargetOwner(temporal);
    if (owner === undefined) throw new Error('temporal target has no owner');
    expect(owner).not.toHaveProperty('surfaceAdmissionIdentity');
    expect(owner).not.toHaveProperty('surfaceAdmissionRevision');
    const bindings = sceneDataSurfaceBindings([sampledSurfacePlan(temporal)], undefined);
    expect(bindings).toEqual([{ schema: SCENE_DATA_TEMPORAL_V1_SCHEMA, owners: [owner] }]);

    const wrongSchema = semanticTarget(temporal, SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
    expect(targetResolver([], [wrongSchema.target])(temporal)).toBeUndefined();
    const { sceneDataBindings, ...unannotatedTarget } = physical.target;
    expect(sceneDataBindings).toHaveLength(1);
    expect(targetResolver([], [unannotatedTarget])(temporal)).toBeUndefined();
    const temporalResolve = targetResolver([], [physical.target]);
    for (const [name, stale] of [
      ['feature', temporalTarget({ feature: 'other-feature' })],
      ['view', temporalTarget({ view: 'camera:other' })],
      ['plan', temporalTarget({ plan: 'replacement-plan' })],
      ['generation', temporalTarget({ generation: 8 })],
      ['device', temporalTarget({ deviceGeneration: 4 })],
    ] as const) {
      expect(temporalResolve(stale), `foreign temporal ${name} must not resolve`).toBeUndefined();
    }
  });
});
