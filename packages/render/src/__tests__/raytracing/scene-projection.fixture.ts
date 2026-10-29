import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { AssetHandle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { loadMaterialFixture } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { MaterialResource } from '../../material-resource';
import { worldRenderResources } from '../../publication/resource-scope';
import { projectRayScene } from '../../raytracing/scene-projection';
import { projectVisibleSurfaces } from '../../raytracing/visible-surface';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';
import { preparedPbrSnapshot } from '../gpu-driven-production-fixture';
import type { RayPublicationFixture } from './path-tracer.commands';

/** Actual World handles and retained RenderScene slots feed the GPU transport. */
export function retainedTransportPlane(
  asset: MaterialAsset,
  admitted?: { assets: AssetRegistry; handle: AssetHandle<'material'> },
) {
  if (asset.parent !== undefined) throw new Error('transport fixture requires a root material');
  const assets = admitted?.assets ?? new AssetRegistry();
  const world = new World({ assets });
  const positions = new Float32Array([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]);
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: positions,
    attributes: {
      position: positions,
      uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      uv1: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    },
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 4, materialSlot: 0, topology: 'triangle-list' },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
  const material = MaterialResource.from({
    ...defaultMaterialSnapshot(),
    materialHandle:
      admitted?.handle ??
      assets
        .create({
          ...asset,
          passes:
            asset.passes ??
            ([{ name: 'forward', program: { module: 'forgeax::default-standard-pbr' } }] as const),
        })
        .unwrap(),
  });
  const source: RenderableSnapshot = preparedPbrSnapshot({
    worldId: 0,
    entityKey: 31,
    assetHandle: assets
      .create({
        ...mesh,
        vertices: packInterleavedVertexAttributes(mesh.attributes, 4).unwrap().vertices,
      })
      .unwrap(),
    transform: { world: mat4.identity(mat4.create()) },
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 6,
        baseVertex: 0,
        materialSlot: 0,
        drawItemIndex: 0,
        topology: 'triangle-list',
        pipelineClass: 'standard',
        materialResourceClass: '',
      },
    ],
  });
  const retained = new RenderScene();
  const update = (x: number, entityKey = 31) => {
    const transform = mat4.identity(mat4.create());
    transform[12] = x;
    retained.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey,
        snapshot: {
          ...source,
          entityKey,
          transform: { world: transform },
        },
      },
    ]);
  };
  update(0);
  return {
    world,
    retained,
    update,
    project: () =>
      projectRayScene(
        retained.slotsSnapshot(),
        [world].map(worldRenderResources),
        projectVisibleSurfaces(retained.slotsSnapshot(), 16).unwrap(),
      ),
  };
}

/** Geometry transport keeps the material admitted by the same published cook. */
export async function retainedPublishedTransportPlane(material: RayPublicationFixture['material']) {
  const assets = new AssetRegistry();
  const record = validateCookedMaterialRecord(
    JSON.parse(material.cookedPublication.record),
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid: material.guid,
      record,
      artifacts: Object.fromEntries(
        Object.entries(material.cookedPublication.artifacts).map(([path, bytes]) => [
          path,
          { bytes: new TextEncoder().encode(bytes) },
        ]),
      ),
    }),
  }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
  if (ready.status !== 'Ready')
    throw new Error(`transport material failed: ${JSON.stringify(ready)}`);
  const loaded = (await loadMaterialFixture(assets, ready.record)).unwrap();
  return retainedTransportPlane(material.asset, { assets, handle: loaded.handle });
}
