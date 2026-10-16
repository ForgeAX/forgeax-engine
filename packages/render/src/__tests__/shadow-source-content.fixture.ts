import { frustum, mat4 } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { ShadowCasterClassifier } from '../gpu-driven/shadow-caster-classes';
import { ShadowViewStatePool } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const material = {
  baseColor: Float32Array.of(1, 1, 1),
  metallic: 0,
  roughness: 1,
} as MaterialSnapshot;

export function shadowSourceSnapshot(
  entityKey: number,
  x: number,
  assetHandle = 3,
): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    assetHandle,
    transform: { world },
    localAabb: Float32Array.of(-1, -1, -1, 1, 1, 1),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque',
        materialResourceClass: 'plain',
      },
    ],
  };
}

/** Real scene history, batch topology and classifier feed one retained static view. */
export function shadowSourceFixture(
  device: RhiDevice,
  shaderModuleFactory: PipelineBuilderShaderModuleFactory,
) {
  const projection = new RenderScene();
  const availability = GpuScene.create(device, 8).unwrap();
  if (availability.status !== 'available') throw Error('GPU Scene unavailable');
  const scene = availability.scene;
  const topology = new BatchTopology();
  const classifier = new ShadowCasterClassifier();
  const pool = ShadowViewStatePool.create({ device, shaderModuleFactory }).unwrap();
  const identity = { kind: 'directional' as const, index: 0, layer: 'static' as const };
  const ortho = mat4.orthographic(mat4.create(), -32, 32, -32, 32, 0.1, 100);
  const lookAt = mat4.lookAt(mat4.create(), [0, 50, 0], [0, 0, 0], [0, 0, -1]);
  const matrix = mat4.multiply(mat4.create(), ortho, lookAt);
  const planes = frustum.fromViewProjection(frustum.create(), matrix);
  const apply = (operations: Parameters<RenderScene['apply']>[0]) => {
    const delta = projection.apply(operations);
    scene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
    topology.apply(delta);
    return delta;
  };
  const update = (snapshot: RenderableSnapshot) =>
    apply([
      {
        kind: 'update',
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        snapshot,
      },
    ]);
  update(shadowSourceSnapshot(1, -10));
  update(shadowSourceSnapshot(2, 10));
  const input = () => {
    const classes = classifier.update(projection.slotsSnapshot(), scene);
    return {
      identity,
      sourcePlan: topology.plan(),
      scene,
      matrix,
      planes,
      targetSize: 1024,
      graphGeneration: 1,
      candidatePrimitiveIndices: classes.staticSlots,
      ignoredChangeSlots: classes.dynamicSet,
    };
  };
  return {
    scene,
    topology,
    projection,
    pool,
    identity,
    input,
    apply,
    update,
    dispose() {
      pool.dispose();
      scene.dispose();
    },
  };
}
