import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { ok, type RhiDevice, type ShaderModule } from '@forgeax/engine-rhi';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';
import { updateGpuView } from './helpers/gpu-input-read-domain';

export function uploadFixture(device: RhiDevice, shader: ShaderModule) {
  const scene = new RenderScene();
  const world = mat4.identity(mat4.create());
  const material = new MaterialResource({
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    materialHandle: 100,
    passes: [],
  });
  const source = preparedPbrSnapshot({
    worldId: 0,
    entityKey: 1,
    assetHandle: 3,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    instances: {
      transforms: new Float32Array([...world, ...world]),
      instanceCount: 2,
      cacheKey: 1,
      archVersion: 1,
    },
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'standard-pbr',
        materialResourceClass: 'standard-pbr-resources',
      },
    ],
  });
  scene.reset([1, 2, 3].map((entityKey) => ({ ...source, entityKey })));
  const slots = scene.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const original = topology.query(topology.sourcePlan(), undefined);
  const availability = GpuScene.create(device, 8).unwrap();
  if (availability.status !== 'available') throw Error('GPU Scene unavailable');
  availability.scene
    .sync({
      created: slots.length,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [...slots],
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      previous: new Map(),
      resynced: 0,
    })
    .unwrap();
  const changed = {
    ...original,
    revision: original.revision + 1,
    batches: original.batches.map((batch, index) =>
      index !== 0
        ? batch
        : {
            ...batch,
            key: { ...batch.key, count: batch.key.count + 1 },
            candidates: batch.candidates.map((candidate, ordinal) =>
              ordinal !== 0
                ? candidate
                : {
                    ...candidate,
                    instanceOrdinal: candidate.instanceOrdinal === 0 ? 1 : 0,
                  },
            ),
          },
    ),
  };
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  return {
    gpuScene: availability.scene,
    projection: scene,
    material: source.material,
    view,
    original,
    changed,
    update: (plan = original) => updateGpuView(view, plan, availability.scene, planes),
    close() {
      view.dispose();
      availability.scene.dispose();
    },
  };
}
