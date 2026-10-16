import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { projectRayScene } from '../../raytracing/scene-projection';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { RenderScene } from '../../scene/render-scene';

/** Actual World handles and retained RenderScene slots feed the GPU transport. */
export function retainedTransportPlane(asset: MaterialAsset) {
  const world = new World();
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
  const material = {
    ...defaultMaterialSnapshot(),
    materialHandle: Number(world.allocSharedRef('MaterialAsset', asset)),
  };
  const source: RenderableSnapshot = {
    worldId: 0,
    entityKey: 31,
    assetHandle: Number(world.allocSharedRef('MeshAsset', mesh)),
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
  };
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
    project: () => projectRayScene(retained.slotsSnapshot(), [world], 16),
  };
}
