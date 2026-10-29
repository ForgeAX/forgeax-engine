import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiCommandEncoder, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { ShadowViewStatePool } from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import type { SkinSceneFrame } from '../scene/skin-scene-inputs';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';
import {
  runGpuDrivenSkinVisibleAddressEvidence,
  runGpuDrivenViewGpuEvidence,
} from './gpu-driven-view-gpu-evidence';
import { updateGpuView, updateShadowView } from './helpers/gpu-input-read-domain';
import { nativeDeviceFixture } from './native-device-fixture';
import { skinTaskFixture } from './skin-task-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing actual view Skin demand fact');
  return value;
}

it('refreshes active Skin shadow tasks each frame and recovers GPU output after pose loss and history reset', async () => {
  const f = skinTaskFixture();
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const module = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const available = GpuScene.create(device, 2, undefined, f.arena).unwrap();
  if (available.status !== 'available') throw new Error('Missing actual GPU Scene');
  const gpu = available.scene;
  const topology = new BatchTopology();
  const delta = f.scene.apply(
    [f.first, f.second].map((slot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: slot.entityKey,
      snapshot: preparedPbrSnapshot({
        ...slot.snapshot,
        assetHandle: 3,
        localAabb: new Float32Array([-0.1, -0.1, 0.1, 0.1, 0.1, 0.2]),
        gpuDrivenDraws: [
          {
            kind: 'indexed',
            first: 0,
            count: 3,
            baseVertex: 0,
            materialSlot: 0,
            topology: 'triangle-list',
            pipelineClass: 'skin',
            materialResourceClass: 'plain',
          },
        ],
      }),
    })),
  );
  gpu.sync(delta).unwrap();
  topology.apply(delta);
  const raw = topology.query(topology.sourcePlan(), undefined);
  const prepared = required(f.scene.slotsSnapshot().at(0)?.snapshot.gpuDrivenDraws?.[0]?.prepared);
  // The low-level selector fixture supplies the accepted Skin execution directly.
  const sourcePlan = {
    ...raw,
    batches: raw.batches.map((batch) => ({
      ...batch,
      prepared: { ...prepared, identity: { ...prepared.identity, deformation: 'skin' as const } },
      ...(batch.binding === undefined
        ? {}
        : {
            binding: {
              ...batch.binding,
              geometry: { ...batch.binding.geometry, deformation: 'skin' as const },
            },
          }),
    })),
  };
  const pool = ShadowViewStatePool.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(module) },
  }).unwrap();
  const identity = { kind: 'directional', index: 0 } as const;
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const draw = async (x: number | undefined, forceCompute = false) => {
    const frame =
      f.frames.recordingFrame() ?? required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    const update = updateShadowView(
      pool,
      { identity, sourcePlan, scene: gpu, planes, skin: frame },
      sourcePlan,
    ).unwrap();
    expect(update.cache).toBe('invalidated');
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const projection = pool.project(graph, identity, forceCompute).unwrap();
    expect(projection.passNames.length).toBeGreaterThan(0);
    const task = required(update.view.skinTaskBinding());
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const readback = device.createBuffer({ size: 40 + task.dataSize, usage: 9 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      encoder.copyBufferToBuffer(required(update.view.indirectBuffer), 0, readback, 0, 20);
      encoder.copyBufferToBuffer(
        required(update.view.overflowBuffer),
        update.view.overflowByteOffset,
        readback,
        20,
        4,
      );
      encoder.copyBufferToBuffer(task.auxiliary, task.auxiliaryOffset, readback, 24, 16);
      encoder.copyBufferToBuffer(task.data, 0, readback, 40, task.dataSize);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      try {
        const words = new Uint32Array(mapped.getMappedRange().unwrap());
        expect(words[1]).toBe(x === undefined ? 0 : 2);
        expect(words[5]).toBe(0);
        if (x !== undefined) {
          const candidateBase = required(words[6]),
            descriptorBase = required(words[7]);
          const floats = new Float32Array(words.buffer);
          for (let candidate = 0; candidate < 2; candidate++) {
            const hash = required(words[10 + (candidateBase + candidate) * 4]);
            const descriptor = 10 + (descriptorBase + hash) * 4;
            expect(words[descriptor + 1]).toBe(1);
            const base = required(words[descriptor + 2]);
            expect(floats[10 + (base + 3) * 4]).toBe(x);
          }
        }
      } finally {
        mapped.unmap();
      }
      pool._commitResourceReplacement();
      await f.frames.submitFrame(frame, Promise.resolve(), true);
    } finally {
      await compiled.retire();
      device.destroyBuffer(readback).unwrap();
    }
  };
  try {
    await draw(3);
    await draw(3);
    await draw(3, true);
    f.matrix[12] = 5;
    f.skin.joint(0, 19, f.matrix);
    await draw(5);
    f.skin.joint(0, 19, undefined);
    await draw(undefined);
    f.matrix[12] = 9;
    f.skin.joint(0, 19, f.matrix);
    await draw(9);
    await draw(9);
    f.frames.resetHistory();
    f.matrix[12] = 11;
    f.skin.joint(0, 19, f.matrix);
    await draw(11);
    await draw(11);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    pool.dispose();
    gpu.dispose();
    f.dispose();
  }
});

it.each([
  [false, false],
  [true, false],
  [false, true],
] as const)('resolves view Skin before culling, clears incomplete demand and reports overflow and capsule transitions (force=%s capsule=%s)', async (forceOverflow, capsuleLifecycle) => {
  const f = skinTaskFixture();
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const module = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const available = GpuScene.create(device, 2, undefined, f.arena).unwrap();
  if (available.status !== 'available') throw new Error('Missing actual GPU Scene');
  const gpu = available.scene;
  // Production compiles each new label asynchronously. Only the module the
  // view requested at creation is ready, so Skin kernels must not need another.
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: {
      createShaderModule: ({ label }) =>
        label === 'gpu-driven-view'
          ? ok(module)
          : err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'a compiled module',
                hint: `${label} pending`,
              }),
            ),
    },
  }).unwrap();
  const delta = f.scene.apply(
    [f.first, f.second].map((slot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: slot.entityKey,
      snapshot: {
        ...slot.snapshot,
        capsuleShadowRequested: true as const,
        assetHandle: 3,
        // A root far outside the view must not be applied to world-space Skin.
        transform: { world: mat4.fromTranslation(mat4.create(), new Float32Array([100, 0, 0])) },
        localAabb: new Float32Array([-0.1, -0.1, 0.1, 0.1, 0.1, 0.2]),
        gpuDrivenDraws: [
          {
            kind: 'indexed' as const,
            first: 0,
            count: 3,
            baseVertex: 0,
            materialSlot: 0,
            topology: 'triangle-list' as const,
            pipelineClass: 'skin-pbr' as const,
            materialResourceClass: 'plain' as const,
            geometry: {
              receipt: {
                identity: 'actual-skin-demand',
                vertexInputs: [],
                topology: 'triangle-list' as const,
                indexed: true,
              },
              draw: {
                kind: 'indexed' as const,
                first: 0,
                count: 3,
                baseVertex: 0,
                topology: 'triangle-list' as const,
              },
              deformation: 'skin' as const,
            },
          },
        ],
      },
    })),
  );
  gpu.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const plan = topology.query(topology.sourcePlan(), undefined);
  expect(plan.candidateCount).toBe(2);
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const results: { visible: number; overflow: number; samples: number[][]; output: object }[] = [];
  const draw = async (frame: SkinSceneFrame, capsuleDirectional = false) => {
    updateGpuView(
      view,
      plan,
      gpu,
      planes,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      frame,
      capsuleDirectional,
    ).unwrap();
    const task = required(view.skinTaskBinding());
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const readback = device.createBuffer({ size: 40 + task.dataSize, usage: 9 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      encoder.copyBufferToBuffer(required(view.indirectBuffer), 0, readback, 0, 20);
      encoder.copyBufferToBuffer(
        required(view.overflowBuffer),
        view.overflowByteOffset,
        readback,
        20,
        4,
      );
      encoder.copyBufferToBuffer(task.auxiliary, task.auxiliaryOffset, readback, 24, 16);
      encoder.copyBufferToBuffer(task.data, 0, readback, 40, task.dataSize);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      try {
        const words = new Uint32Array(mapped.getMappedRange().unwrap());
        const floats = new Float32Array(words.buffer);
        const candidateBase = required(words[6]),
          descriptorBase = required(words[7]);
        const samples: number[][] = [];
        for (let candidate = 0; candidate < plan.candidateCount; candidate++) {
          const hash = required(words[10 + (candidateBase + candidate) * 4]);
          const descriptor = 10 + (descriptorBase + hash) * 4;
          const count = required(words[descriptor + 1]),
            base = required(words[descriptor + 2]);
          samples.push([
            required(words[descriptor + 3]),
            count,
            required(floats[10 + (base + 3) * 4]),
            required(floats[10 + (base + count * 4 + 3) * 4]),
          ]);
        }
        results.push({
          visible: required(words[1]),
          overflow: required(words[5]),
          samples,
          output: task.data,
        });
      } finally {
        mapped.unmap();
      }
    } finally {
      await compiled.retire();
      device.destroyBuffer(readback).unwrap();
    }
  };
  try {
    await f.frames.submitFrame(f.frame, Promise.resolve(), true);
    f.matrix[12] = 5;
    f.skin.joint(0, 19, f.matrix);
    const first = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    if (forceOverflow) {
      // Deliberately under-admit palette capacity while retaining the real
      // immutable root. This exercises the actual View overflow owner.
      await draw({
        ...first,
        current: Object.create(first.current, { jointCapacity: { value: 1 } }),
      });
      expect(results.shift()).toMatchObject({ visible: 0, overflow: 1 });
      view._recoverFromOverflow().unwrap();
    }
    await draw(first);
    await f.frames.submitFrame(first, Promise.resolve(), true);
    f.skin.joint(0, 19, undefined);
    const missing = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    await draw(missing);
    await f.frames.submitFrame(missing, Promise.resolve(), false);
    f.matrix[12] = 9;
    f.skin.joint(0, 19, f.matrix);
    const restored = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    await draw(restored);
    expect(results.slice(0, 3).map((row) => row.overflow)).toEqual([0, 0, 0]);
    expect(results.slice(0, 3).map((row) => row.visible)).toEqual([2, 0, 2]);
    expect(results[0]?.samples).toEqual([
      [3, 1, 5, 3],
      [3, 1, 5, 3],
    ]);
    expect(results[1]?.samples.map((sample) => sample[0])).toEqual([0, 0]);
    expect(results[2]?.samples).toEqual([
      [3, 1, 9, 5],
      [3, 1, 9, 5],
    ]);
    expect(results[1]?.output).toBe(results[0]?.output);
    expect(results[2]?.output).toBe(results[0]?.output);
    // Accepted history that lacks a joint the current pose has reseeds every
    // previous matrix from current instead of publishing a partial history.
    await f.frames.submitFrame(restored, Promise.resolve(), true);
    f.skin.joint(0, 19, undefined);
    const gap = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    await draw(gap);
    await f.frames.submitFrame(gap, Promise.resolve(), true);
    f.matrix[12] = 11;
    f.skin.joint(0, 19, f.matrix);
    const reseeded = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    await draw(reseeded);
    expect(results.slice(3).map((row) => row.visible)).toEqual([0, 2]);
    expect(results[4]?.samples).toEqual([
      [1, 1, 11, 11],
      [1, 1, 11, 11],
    ]);
    if (capsuleLifecycle) {
      await f.frames.submitFrame(reseeded, Promise.resolve(), true);
      const capsules = {
        joints: new Uint16Array([0]),
        shapes: new Float32Array([0, 0, 0, 0, 1, 0, 0.1]),
      };
      for (const shadowCapsules of [
        capsules,
        undefined,
        { joints: new Uint16Array(), shapes: new Float32Array() },
        capsules,
      ]) {
        f.skin.skeletonChanged(0, 7, {
          kind: 'skeleton',
          jointCount: 1,
          inverseBindMatrices: mat4.identity(mat4.create()),
          ...(shadowCapsules === undefined ? {} : { shadowCapsules }),
        });
        const frame = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
        await draw(frame, true);
        await f.frames.submitFrame(frame, Promise.resolve(), false);
      }
      expect(results.slice(5).map((row) => row.visible)).toEqual([0, 2, 2, 0]);
      expect(results.slice(5).map((row) => row.overflow)).toEqual([0, 0, 0, 0]);
      for (const row of results.slice(5)) expect(row.output).toBe(results[0]?.output);
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    view.dispose();
    gpu.dispose();
    f.dispose();
  }
});

// The ordinary Dawn roster compacts the older standalone view file. Keep a
// rigid control in this actual task gate so the combined shader cannot pass
// Skin while breaking the existing view/reset/indirect contract.
it('preserves actual rigid view compaction beside Skin demand', async () => {
  await expect(runGpuDrivenViewGpuEvidence()).resolves.toMatchObject({
    visibleInstance: 0,
    indexCount: 12,
    instanceCount: 1,
    overflow: 0,
    firstVisible: 1,
    recoveredVisible: 0,
  });
});

it('resolves the true Skin slot when two preceding rigid draws share another instance', async () => {
  const result = await runGpuDrivenSkinVisibleAddressEvidence();
  expect(result).toEqual({
    visibleInstance: 0,
    candidateIndex: 2,
    sourceSlot: 1,
    primitiveIndex: 0,
  });
});
