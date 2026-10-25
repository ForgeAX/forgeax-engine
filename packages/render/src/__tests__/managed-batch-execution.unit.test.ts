import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { ok } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import type { GpuDrivenCandidate, SubmissionPlan } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_MEMBER_RECORD_WORDS } from '../gpu-scene-inputs';
import { MaterialResource } from '../material-resource';
import { RenderScene } from '../scene/render-scene';
import { updateGpuView } from './helpers/gpu-input-read-domain';

it('observes unqualified candidate getters on every actual execution update', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const available = GpuScene.create(device, 256).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = available.scene,
    projection = new RenderScene();
  const material = new MaterialResource({
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    passes: [],
  });
  const transform = { world: mat4.identity(mat4.create()) };
  const snapshots = Array.from({ length: 256 }, (_, entityKey) => ({
    worldId: 0,
    entityKey,
    assetHandle: 3,
    material,
    materials: [material],
    materialBindingSources: ['engine-default' as const],
    transform,
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
  }));
  scene
    .sync(
      projection.apply(
        snapshots.map((snapshot) => ({
          kind: 'update' as const,
          worldId: 0,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      ),
    )
    .unwrap();
  let reads = 0;
  const candidates: readonly GpuDrivenCandidate[] = Object.freeze(
    projection.slotsSnapshot().map(
      (slot) =>
        new Proxy(
          Object.freeze({
            primitiveIndex: slot.slot,
            generation: slot.generation,
            drawItemIndex: 0,
            instanceOrdinal: 0,
          }),
          {
            get(target, key, receiver) {
              if (key === 'primitiveIndex') reads++;
              return Reflect.get(target, key, receiver);
            },
          },
        ),
    ),
  );
  const original: SubmissionPlan = {
    revision: 1,
    candidateCount: candidates.length,
    visibleCapacity: candidates.length,
    batches: [
      {
        batchId: 0,
        generation: 0,
        contentEpoch: 0,
        candidates,
        visibleBase: 0,
        visibleCapacity: candidates.length,
        indirectOffset: 0,
        key: {
          assetHandle: 3,
          drawKind: 'indexed',
          first: 0,
          count: 3,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'before',
          materialResourceClass: 'shared',
        },
      },
    ],
  };
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const update = (plan: SubmissionPlan) => updateGpuView(view, plan, scene, planes).unwrap();
  try {
    update(original);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    const changed: SubmissionPlan = {
      ...original,
      revision: 2,
      batches: original.batches.map((batch) => ({
        ...batch,
        contentEpoch: 1,
        key: { ...batch.key, pipelineClass: 'after', count: 6 },
      })),
    };
    update(changed);
    expect(reads).toBe(2 * candidates.length);
    reads = 0;
    expect(view.inspect().sharedInputUploadBytes).toBeGreaterThanOrEqual(
      candidates.length * GPU_MEMBER_RECORD_WORDS * 4,
    );
    expect(view.inspect().batchUploadBytes).toBeGreaterThan(0);
    update(original);
    expect(reads).toBe(2 * candidates.length);
    reads = 0;
    expect(view.inspect().sharedInputUploadBytes).toBeGreaterThanOrEqual(
      candidates.length * GPU_MEMBER_RECORD_WORDS * 4,
    );
    expect(view.inspect().batchUploadBytes).toBeGreaterThan(0);
    update({ ...original, revision: 3 });
    expect(reads).toBe(2 * candidates.length);
    reads = 0;
    expect(view.inspect().sharedInputUploadBytes).toBeGreaterThanOrEqual(
      candidates.length * GPU_MEMBER_RECORD_WORDS * 4,
    );
    expect(view.inspect().batchUploadBytes).toBeGreaterThan(0); // Fresh raw member root.
    const first = snapshots[0];
    if (first === undefined) throw new Error('Missing first candidate');
    const added = {
      ...first,
      entityKey: snapshots.length,
      material: new MaterialResource(material.snapshot),
    };
    scene
      .sync(
        projection.apply([
          { kind: 'update', worldId: 0, entityKey: added.entityKey, snapshot: added },
        ]),
      )
      .unwrap();
    update({ ...changed, revision: 4 });
    expect(reads).toBe(2 * candidates.length);
    reads = 0;
    expect(view.inspect().sharedInputUploadBytes).toBeGreaterThanOrEqual(
      candidates.length * GPU_MEMBER_RECORD_WORDS * 4,
    );
  } finally {
    view.dispose();
    scene.dispose();
  }
});
