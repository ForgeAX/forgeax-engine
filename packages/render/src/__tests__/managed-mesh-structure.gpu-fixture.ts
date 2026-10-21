import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { BatchTopology, type SubmissionPlan } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { RenderScene } from '../scene/render-scene';
import { updateGpuView } from './helpers/gpu-input-read-domain';

/** Actual cull work expands executions; GPU membership bytes stay unique. */
export async function verifySharedMeshCandidates() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = _internal_getRawDevice(device);
  assert(native);
  native.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const material = new MaterialResource({
    passes: [],
    baseColor: vec3.create(1, 0, 0),
    metallic: 0,
    roughness: 1,
  });
  const source = new RenderScene();
  const draw = {
    kind: 'indexed' as const,
    first: 0,
    count: 3,
    baseVertex: 0,
    topology: 'triangle-list' as const,
  };
  const delta = source.apply(
    Array.from({ length: 3 }, (_, entityKey) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey,
      snapshot: {
        worldId: 0,
        entityKey,
        assetHandle: 7,
        material,
        materials: [material],
        materialBindingSources: ['engine-default' as const],
        localAabb: Float32Array.of(-0.25, -0.25, -0.25, 0.25, 0.25, 0.25),
        transform: { world: mat4.identity(mat4.create()) },
        gpuDrivenDraws: [
          {
            ...draw,
            materialSlot: 0,
            pipelineClass: 'mesh',
            materialResourceClass: 'shared',
            geometry: {
              receipt: {
                identity: 'mesh',
                vertexInputs: [],
                topology: 'triangle-list' as const,
                indexed: true,
              },
              draw,
              deformation: 'rigid' as const,
            },
          },
        ],
      },
    })),
  );
  const topology = new BatchTopology();
  topology.apply(delta);
  const initial = topology.query(topology.sourcePlan(), undefined);
  const root = initial.batches.at(0);
  assert(root);
  const admitted = GpuScene.create(device, 8).unwrap();
  assert(admitted.status === 'available');
  const scene = admitted.scene;
  scene.sync(delta).unwrap();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const empty = Object.freeze([]);
  const plan = (active: readonly boolean[]): SubmissionPlan => ({
    revision: active.length,
    candidateCount: active.filter(Boolean).length * 3,
    visibleCapacity: active.length * 64,
    batches: active.map((enabled, index) => ({
      ...root,
      batchId: index,
      key: { ...root.key, first: index * 3 },
      candidates: enabled ? root.candidates : empty,
      visibleBase: index * 64,
      visibleCapacity: enabled ? 3 : 0,
      visibleAllocationCapacity: 64,
      indirectOffset: index * 20,
    })),
  });
  const stages = [
    plan([true]),
    plan([true, true]),
    plan([false, true, false, true, false]),
    plan([true]),
  ];
  const readback = device.createBuffer({ size: 100, usage: 1 | 8 }).unwrap();
  try {
    for (let frame = 0; frame < 60; frame++) {
      const selected = stages[Math.floor(frame / 15)];
      assert(selected);
      updateGpuView(view, selected, scene, planes).unwrap();
      expect(view.inspect().candidateCapacity).toBe(4);
      if (frame > 0) expect(view.inspect().sharedInputUploadBytes).toBe(0);
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      view.addPasses(graph).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      view._commitResourceReplacement();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder }).unwrap();
        const indirect = view.indirectBuffer;
        assert(indirect);
        encoder.copyBufferToBuffer(indirect, 0, readback, 0, selected.batches.length * 20);
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const mapped = (await readback.mapAsync(1)).unwrap();
        const words = new Uint32Array(mapped.getMappedRange().unwrap());
        for (const [index, batch] of selected.batches.entries())
          expect(
            [...words.subarray(index * 5, index * 5 + 5)],
            `frame ${frame} / batch ${index}`,
          ).toEqual([3, batch.candidates.length, index * 3, 0, 0]);
        mapped.unmap();
      } finally {
        (await compiled.retire()).unwrap();
      }
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback);
    view.dispose();
    scene.dispose();
    await device.queue.onSubmittedWorkDone();
    native.destroy();
  }
}
