import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { AssetHandle } from '@forgeax/engine-types';
import { assert } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { Materials } from '../../materials';
import { worldRenderResources } from '../../publication/resource-scope';
import { fieldEditState } from '../../raytracing/field-edit';
import type { deriveFieldReceivers } from '../../raytracing/field-receiver';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import type {
  SceneFieldReceiverSource,
  SceneFieldSource,
} from '../../raytracing/scene-field-projection';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import { projectVisibleSurfaces } from '../../raytracing/visible-surface';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';
import { preparedPbrSnapshot } from '../gpu-driven-production-fixture';
import { createProbeGlobalMesh, probeGlobalProfile } from './probe-global.fixture';

/** Typed metadata controls with real encoded geometry. Admission itself is
 * exercised by the actual ready Field/Screen owner tests, not synthesized here. */
export async function receiverMetadataFixture(alphaCutoff = 0): Promise<{
  input: Parameters<typeof deriveFieldReceivers>[0];
  source: SceneFieldReceiverSource;
  instance: SdfMeshInstance;
  scene: RenderScene;
  renderable: RenderableSnapshot;
  pose: Float32Array;
  world: World;
  meshHandle: AssetHandle<'mesh'>;
  dispose(): void;
}> {
  const mesh = await createProbeGlobalMesh();
  const field = mesh.distanceField;
  assert(field && mesh.indices);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const meshHandle = assets.create(mesh).unwrap();
  const payload = Materials.standard({
    baseColor: [1, 1, 1, 1],
    ...(alphaCutoff > 0 ? { alphaCutoff } : {}),
  });
  const materialHandle = assets.create(payload).unwrap();
  const snapshot = defaultMaterialSnapshot(materialHandle);
  const material = new MaterialResource(snapshot);
  const scene = new RenderScene();
  const renderable: RenderableSnapshot = preparedPbrSnapshot({
    entityKey: 41,
    assetHandle: meshHandle,
    transform: { world: pose },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: mesh.indices.length,
        baseVertex: 0,
        materialSlot: 0,
        drawItemIndex: 0,
        topology: 'triangle-list',
        pipelineClass: 'standard',
        materialResourceClass: '',
      },
    ],
  });
  scene.apply([{ kind: 'update', entityKey: 41, snapshot: renderable }]);
  const record = [...scene.slotsSnapshot()][0];
  assert(record);
  const source: SceneFieldReceiverSource = {
    record,
    scope,
    assetHandle: meshHandle,
    assetRevision: 3,
    mesh,
    field,
    instances: undefined,
    transforms: [pose],
    materials: [
      {
        resource: material,
        materialSlot: 0,
        handle: materialHandle,
        payload,
        projection: undefined,
        alphaCoverageOmitted: alphaCutoff > 0,
        facts: snapshot,
        snapshot,
      },
    ],
  };
  const instance: SdfMeshInstance = {
    instanceId: 0,
    geometryId: meshHandle,
    mask: 255,
    transform: pose,
    field,
    surfaceCoverage: 'opaque',
  };
  const composition = packGlobalSdfComposition([instance], probeGlobalProfile.grid, {
    capacity: 2,
    index: false,
    sourceEpoch: 1,
  }).unwrap();
  const cold: SceneFieldSource = { ...source, ...record, firstInstance: 0, fieldSnapshot: field };
  const state = fieldEditState([cold], [instance]);
  const raster = projectVisibleSurfaces(scene.slotsSnapshot(), 32).unwrap();
  const input: Parameters<typeof deriveFieldReceivers>[0] = {
    owner: { identity: composition, current: () => true },
    raster,
    state,
    sourceScope: scope,
    sources: [source],
    placement: {
      instances: [instance],
      instanceData: composition.data.instances,
      surface: composition.surface,
    },
    acceptedSource: [
      composition.data.instances.byteLength / 4,
      composition.data.fields.byteLength / 4,
      1,
      1,
    ],
  };
  return {
    input,
    source,
    instance,
    scene,
    renderable,
    pose,
    world,
    meshHandle,
    dispose: () => {
      scene.dispose();
      assets.dispose();
    },
  };
}
