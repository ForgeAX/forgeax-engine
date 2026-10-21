import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { ShadowViewStatePool } from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { updateShadowView } from './helpers/gpu-input-read-domain';
import { nativeDeviceFixture } from './native-device-fixture';

export async function stableCommandAddressFrames() {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const shaderModuleFactory = { createShaderModule: () => ok(shader) };
  const projection = new RenderScene();
  const available = GpuScene.create(device, 8).unwrap();
  if (available.status !== 'available') throw Error('GPU Scene unavailable');
  const scene = available.scene;
  const topology = new BatchTopology();
  const apply = (operations: Parameters<RenderScene['apply']>[0]) => {
    const delta = projection.apply(operations);
    scene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
    topology.apply(delta);
  };
  const snapshot = (entityKey: number, x: number, instanceCount = 1): RenderableSnapshot => {
    const world = mat4.identity(mat4.create());
    world[12] = x;
    const material = new MaterialResource({
      passes: [],
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
    });
    return {
      worldId: 0,
      entityKey,
      assetHandle: entityKey + 3,
      transform: { world },
      localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      instances: {
        transforms: new Float32Array(
          Array.from({ length: instanceCount }, () => [...mat4.identity(mat4.create())]).flat(),
        ),
        instanceCount,
        cacheKey: entityKey,
        archVersion: instanceCount,
      },
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: 3,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'opaque',
          materialResourceClass: 'plain',
          geometry: {
            receipt: {
              identity: 'stable-window',
              vertexInputs: [],
              topology: 'triangle-list',
              indexed: true,
            },
            draw: { kind: 'indexed', first: 0, count: 3, baseVertex: 0, topology: 'triangle-list' },
            deformation: 'rigid',
          },
        },
      ],
    };
  };
  const update = (value: RenderableSnapshot) => ({
    kind: 'update' as const,
    worldId: 0,
    entityKey: value.entityKey,
    snapshot: value,
  });
  apply([update(snapshot(1, -4)), update(snapshot(2, 0)), update(snapshot(3, 4))]);
  const initial = topology.query(topology.sourcePlan(), undefined);
  const light = mat4.lookAt(mat4.create(), [0, 0, 10], [0, 0, 0], [0, 1, 0]);
  const views = [
    [-6, 6],
    [-2, 2],
    [2, 6],
  ].map(([left = -6, right = 6], index) => {
    const matrix = mat4.multiply(
      mat4.create(),
      mat4.orthographic(mat4.create(), left, right, -2, 2, 0.1, 100),
      light,
    );
    return {
      identity: { kind: 'directional' as const, index, layer: 'static' as const },
      matrix,
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      ...(index === 1 ? { candidatePrimitiveIndices: [1, 2] } : {}),
    };
  });
  let pool = ShadowViewStatePool.create({ device, shaderModuleFactory }).unwrap();
  const readback = device.createBuffer({ size: 3 * 3 * 2048, usage: 1 | 8 }).unwrap();
  try {
    for (let frame = 0; frame < 60; frame++) {
      if (frame === 8) apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
      if (frame === 16) apply([update(snapshot(1, -4, 65))]);
      if (frame === 24) apply([update(snapshot(1, -4))]);
      if (frame === 32)
        apply([{ kind: 'remove', worldId: 0, entityKey: 1 }, update(snapshot(4, -4))]);
      if (frame === 40) {
        pool.dispose();
        pool = ShadowViewStatePool.create({ device, shaderModuleFactory }).unwrap();
      }
      if (frame === 48) topology.rebuild(projection.slotsSnapshot());
      const source = topology.query(topology.sourcePlan(), undefined);
      if (frame < 48) {
        for (const batch of initial.batches.slice(1))
          expect(
            source.batches.find((current) => current.key.assetHandle === batch.key.assetHandle),
          ).toBe(batch);
      }
      pool.invalidate('view-clipping-changed');
      const current = views.map((view) =>
        updateShadowView(pool, { ...view, sourcePlan: source, scene }).unwrap(),
      );
      for (const view of current)
        for (const batch of view.plan.batches) {
          const sourceBatch = source.batches.find(
            (sourceBatch) => sourceBatch.batchId === batch.batchId,
          );
          expect(batch.visibleBase).toBe(sourceBatch?.visibleBase);
          expect(batch.indirectOffset).toBe(sourceBatch?.indirectOffset);
        }
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      for (const view of views) pool.project(graph, view.identity).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder }).unwrap();
        const rows = current.flatMap(({ plan, view }, viewIndex) =>
          plan.batches.map((batch) => ({ batch, view, viewIndex })),
        );
        for (const [index, { batch, view }] of rows.entries()) {
          if (view.indirectBuffer === undefined || view.visibleBuffer === undefined)
            throw Error('Missing view outputs');
          encoder.copyBufferToBuffer(
            view.indirectBuffer,
            batch.indirectOffset,
            readback,
            index * 2048,
            20,
          );
          encoder.copyBufferToBuffer(
            view.visibleBuffer,
            batch.visibleBase * 16,
            readback,
            index * 2048 + 32,
            batch.visibleCapacity * 16,
          );
        }
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        pool._commitResourceReplacement();
        const mapped = (await readback.mapAsync(1)).unwrap();
        try {
          const words = new Uint32Array(mapped.getMappedRange().unwrap());
          for (const [index, { batch, viewIndex }] of rows.entries()) {
            const expected = batch.candidates
              .filter((candidate) => viewIndex === 0 || candidate.primitiveIndex === viewIndex)
              .map((candidate) =>
                scene.instanceIndexForSlot(candidate.primitiveIndex, candidate.instanceOrdinal),
              );
            expect(
              [...words.subarray(index * 512, index * 512 + 5)],
              `frame ${frame}, view ${viewIndex}, batch ${batch.batchId}`,
            ).toEqual([3, expected.length, 0, 0, 0]);
            const actual = expected.map((_, member) => words[index * 512 + 8 + member * 4]);
            expect(actual.sort()).toEqual(expected.sort());
          }
        } finally {
          mapped.unmap();
        }
      } finally {
        (await compiled.retire()).unwrap();
      }
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback).unwrap();
    pool.dispose();
    scene.dispose();
    native.destroy();
  }
}
