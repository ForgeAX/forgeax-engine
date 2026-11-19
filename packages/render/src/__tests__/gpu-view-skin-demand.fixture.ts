import { frustum, mat4 } from '@forgeax/engine-math';
import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, vi } from 'vitest';
import { BatchTopology, type SubmissionPlan } from '../gpu-driven/batch-topology';
import {
  POINT_SELECTION_BATCH_PASS,
  ShadowViewStatePool,
  shadowViewLabelPrefix,
} from '../gpu-driven/shadow-views';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { SkinFrames, SkinSceneInputs } from '../scene/skin-scene-inputs';
import { updateGpuView, updateShadowView } from './helpers/gpu-input-read-domain';
import { nativeDeviceFixture } from './native-device-fixture';

/** A real Scene with Skin inputs and independent rigid/Skin view demands. */
export async function verifyGpuViewSkinDemandBoundary(): Promise<void> {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw Error('GPU Scene required');
  const gpu = available.scene,
    scene = new RenderScene(),
    topology = new BatchTopology();
  const identity = mat4.identity(mat4.create());
  const inputs = new SkinSceneInputs(gpu.inputs.arena, () => ({
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: identity,
  }));
  const frames = new SkinFrames(inputs);
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const row = (entityKey: number, deformation: 'rigid' | 'skin'): RenderableSnapshot => ({
    entityKey,
    assetHandle: 3,
    transform: { world: identity },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    localAabb: new Float32Array([-0.1, -0.1, 0.1, 0.1, 0.1, 0.2]),
    ...(deformation === 'skin' ? { skinBinding: { skeleton: 7, joints: [19] } } : {}),
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: deformation,
        materialResourceClass: 'plain',
        geometry: {
          receipt: {
            identity: 'skin-demand-boundary',
            vertexInputs: [],
            topology: 'triangle-list',
            indexed: true,
          },
          draw: { kind: 'indexed', first: 0, count: 3, baseVertex: 0, topology: 'triangle-list' },
          deformation,
        },
      },
    ],
  });
  const delta = scene.apply(
    [row(1, 'rigid'), row(2, 'skin'), row(3, 'skin')].map((snapshot) => ({
      kind: 'update',
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  inputs.apply(delta);
  inputs.joint(19, identity);
  const skin = frames.prepareFrame(scene.slotsSnapshot());
  if (skin === undefined || skin.current.jointCapacity === 0)
    throw Error('Unrelated Scene Skin demand must exist');
  gpu.sync(delta).unwrap();
  topology.apply(delta);
  const source = topology.query(topology.sourcePlan(), undefined);
  const select = (deformation: 'rigid' | 'skin'): SubmissionPlan => {
    const batches = source.batches.filter(
      (batch) => batch.binding?.geometry.deformation === deformation,
    );
    return {
      ...source,
      batches,
      candidateCount: batches.reduce((sum, batch) => sum + batch.candidates.length, 0),
    };
  };
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: {
      createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
    },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), identity);
  let cached: CompiledRenderGraph<{ encoder: RhiCommandEncoder }> | undefined;
  const run = async (plan: SubmissionPlan, reuse = false) => {
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
      skin,
    ).unwrap();
    const hasSkin = view.skinTaskBinding() !== undefined;
    if (!reuse) {
      const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
      view
        .addPasses(
          graph,
          'test',
          true,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          'combined',
        )
        .unwrap();
      const next = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      await cached?.retire();
      cached = next;
      view._commitResourceReplacement();
    }
    const compiled = cached;
    if (compiled === undefined) throw Error('A retained graph must precede reuse');
    const readback = device.createBuffer({ size: 20, usage: 9 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      const passes = vi.spyOn(encoder, 'beginComputePass');
      compiled.execute({ encoder }).unwrap();
      const indirect = view.indirectBuffer;
      if (indirect === undefined) throw Error('Indirect command buffer required');
      encoder.copyBufferToBuffer(
        indirect,
        plan.batches.at(0)?.indirectOffset ?? 0,
        readback,
        0,
        20,
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const words = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      const skinPasses = passes.mock.calls
        .map((call) => call[0]?.label)
        .filter((label) => label?.includes('.skin-'));
      return {
        hasSkin,
        skinPasses,
        computePassCount: passes.mock.calls.length,
        instanceCount: words[1],
      };
    } finally {
      await device.queue.onSubmittedWorkDone();
      device.destroyBuffer(readback).unwrap();
    }
  };
  try {
    expect(select('rigid').candidateCount).toBe(1);
    expect(await run(select('rigid'))).toEqual({
      hasSkin: false,
      skinPasses: [],
      computePassCount: 1,
      instanceCount: 1,
    });
    expect(await run(select('skin'))).toEqual({
      hasSkin: true,
      skinPasses: ['test.skin-demand'],
      computePassCount: 2,
      instanceCount: 2,
    });
    // A retained view may keep capacity after Skin, but cannot reuse stale Skin constants.
    expect(await run(select('rigid'), true)).toEqual({
      hasSkin: false,
      skinPasses: [],
      computePassCount: 1,
      instanceCount: 1,
    });
    const previousCapacity = view.inspect().visibleBufferCapacity;
    const rigid = select('rigid');
    const grownRigid = {
      ...rigid,
      batches: rigid.batches.map((batch) => ({
        ...batch,
        visibleAllocationCapacity: previousCapacity * 2,
      })),
    };
    expect(await run(grownRigid)).toEqual({
      hasSkin: false,
      skinPasses: [],
      computePassCount: 1,
      instanceCount: 1,
    });
    expect(view.inspect().visibleBufferCapacity).toBeGreaterThan(previousCapacity);

    // The stock point-face collector shares resolve/selection across views.
    // Each face's dispatch arguments must stay separate from every draw buffer.
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: {
        createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
      },
    }).unwrap();
    const facePlan = select('skin');
    const identities = [0, 1].map((index) => ({ kind: 'point' as const, index, face: 0 }));
    const firstSlot = scene.slotsSnapshot().lookup(2)?.slot;
    if (firstSlot === undefined) throw Error('Skin source slot required');
    const singleFace: SubmissionPlan = {
      ...facePlan,
      candidateCount: 1,
      batches: facePlan.batches.map((batch) => {
        const { members, ...rest } = batch;
        return {
          ...rest,
          candidates: batch.candidates.filter(
            (candidate) => candidate.primitiveIndex === firstSlot,
          ),
        };
      }),
    };
    const updates = identities.map((identity, index) => {
      const task = index === 0 ? facePlan : singleFace;
      return updateShadowView(
        pool,
        { identity, sourcePlan: task, scene: gpu, planes, skin },
        task,
      ).unwrap();
    });
    const batchGraph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    const firstIdentity = identities.at(0);
    if (firstIdentity === undefined) throw Error('Point face identity required');
    pool.project(batchGraph, firstIdentity, false, undefined, true).unwrap();
    const batchCompiled = batchGraph
      .compile({ device, surfaceSize: { width: 1, height: 1 } })
      .unwrap();
    const readback = device.createBuffer({ size: 40, usage: 9 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap(),
        calls = vi.spyOn(encoder, 'beginComputePass');
      batchCompiled.execute({ encoder }).unwrap();
      updates.forEach((update, index) => {
        const buffer = update.view.indirectBuffer;
        if (buffer === undefined) throw Error('Point face indirect required');
        encoder.copyBufferToBuffer(
          buffer,
          update.plan.batches.at(0)?.indirectOffset ?? 0,
          readback,
          index * 20,
          20,
        );
      });
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const counts = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      expect([counts[1], counts[6]]).toEqual([2, 1]);
      expect(calls.mock.calls.map((call) => call[0]?.label)).toEqual([
        ...identities.map((identity) => `${shadowViewLabelPrefix(identity)}.skin-demand`),
        POINT_SELECTION_BATCH_PASS,
      ]);
    } finally {
      await device.queue.onSubmittedWorkDone();
      await batchCompiled.retire();
      device.destroyBuffer(readback).unwrap();
      pool.dispose();
    }

    expect(await native.popErrorScope()).toBeNull();
  } finally {
    await device.queue.onSubmittedWorkDone();
    await cached?.retire();
    view.dispose();
    frames.resetHistory();
    inputs.dispose();
    gpu.dispose();
  }
}
