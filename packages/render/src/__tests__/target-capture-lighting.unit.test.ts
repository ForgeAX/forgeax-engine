import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { PlanarCaptureState } from '../capture/planar-state';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { releaseAtmosphere, retainAtmosphere } from '../environment/storage';
import { getOrCreateHdrpBuffers } from '../hdrp-buffers';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphState, CubeCaptureGraphWork } from '../record/target-capture-graph';
import {
  disposeTargetCaptureLighting,
  disposeTargetCaptures,
  prepareTargetCaptureLighting,
} from '../record/target-capture-lighting';
import { POINTS_LINES_VIEW_BUFFER_SIZE, writePointsLinesViewUbo } from '../record/view-ubo';
import { getOrCreateSsaoFallbackTexture, resetSsaoResources } from '../ssao-buffers';
import type { RenderTarget } from '../targets/contracts';
import { createRenderTargetPhysical, destroyRenderTargetPhysical } from '../targets/physical';
import type { ViewLights } from '../world/render-lights';
import { earthAtmosphere } from './atmosphere-fixture';

const lights = {
  directionalCount: 0,
  point: [],
  spot: [],
  rect: [],
  pointShadow: [],
  cascades: undefined,
  shadowViews: [],
} as unknown as ViewLights;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required capture test value');
  return value;
}

async function device() {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

function pipeline(device: RhiDevice): PipelineState {
  return {
    hdrpClusterMembershipPipeline: null,
    hdrpClusterMembershipBindGroupLayout: null,
    pointsLinesViewBuffer: device
      .createBuffer({ size: POINTS_LINES_VIEW_BUFFER_SIZE, usage: 0x48 })
      .unwrap(),
  } as unknown as PipelineState;
}

async function fixture() {
  const gpu = await device();
  const runtime = {
    device: gpu,
    errorRegistry: {
      fire: (error: unknown) => {
        throw error;
      },
    },
  } as unknown as RenderSystemInternals;
  const state = { pointShadowAtlas: null, hdrpClusterMembership: null } as RenderFrameState;
  const basePipeline = pipeline(gpu);
  const work = [0, 7].map((x) => {
    const camera = makeZeroCameraFallbackSnapshot();
    camera.world[12] = x;
    camera.position[0] = x;
    return { target: {} as RenderTarget, faceCamera: camera } as CubeCaptureGraphWork;
  });
  const owner: CubeCaptureGraphState = { work };
  const prepare = (index = 0, base = basePipeline) =>
    prepareTargetCaptureLighting(owner, required(work[index]), runtime, state, base, lights);
  return { gpu, runtime, state, basePipeline, owner, prepare };
}

describe('target capture lighting ownership', () => {
  it('recreates planar capture on the replacement device and ignores the retired generation completion', async () => {
    const f = await fixture();
    const descriptor = {
      shape: '2d',
      width: 16,
      height: 16,
      format: 'rgba16float',
      sampleCount: 1,
      mipLevels: 1,
      sampled: true,
      readback: false,
    } as const;
    const sourceResult = createRenderTargetPhysical(f.gpu, descriptor, 1);
    if (!sourceResult.ok) throw sourceResult.error;
    const source = sourceResult.value;
    const camera = {
      ...makeZeroCameraFallbackSnapshot(),
      target: required(f.owner.work[0]).target,
      planarReflection: {
        normal: new Float32Array([0, 1, 0]),
        distance: 0,
        clipBias: 0,
        updateIntervalFrames: 4,
        requestVersion: 0,
      },
    };
    const oldPlanar = new PlanarCaptureState();
    f.owner.planar = oldPlanar;
    const oldCapture = required(oldPlanar.prepare(camera, source, 0));
    const oldLighting = f.prepare();
    const oldFallback = required(getOrCreateSsaoFallbackTexture(oldLighting.runtime));
    let finishCapture!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    oldPlanar.submit(true, completion);
    let finishFence!: (value: undefined) => void;
    const fence = new Promise<undefined>((resolve) => {
      finishFence = resolve;
    });
    vi.spyOn(f.gpu.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
    const destroyOldTexture = vi.spyOn(f.gpu, 'destroyTexture');
    const destroyOldBuffer = vi.spyOn(f.gpu, 'destroyBuffer');

    disposeTargetCaptures(f.owner);
    expect(f.owner.work).toEqual([]);
    expect(f.owner.planar).toBeUndefined();
    expect(oldPlanar.current()).toBeUndefined();
    expect(destroyOldTexture).not.toHaveBeenCalled();
    expect(destroyOldBuffer).not.toHaveBeenCalled();

    const replacement = await device();
    const nextSourceResult = createRenderTargetPhysical(replacement, descriptor, 2);
    if (!nextSourceResult.ok) throw nextSourceResult.error;
    const nextSource = nextSourceResult.value;
    const createOld = vi.spyOn(f.gpu, 'createTexture');
    const createNew = vi.spyOn(replacement, 'createTexture');
    // This is the same lazy recreation used by prepareCubeCapture after resetForRecover.
    f.owner.planar ??= new PlanarCaptureState();
    const nextCapture = required(f.owner.planar.prepare(camera, nextSource, 1));
    expect(createOld).not.toHaveBeenCalled();
    expect(createNew).not.toHaveBeenCalled();
    expect(nextCapture.physical.generation).toBe(2);
    expect(nextCapture.physical.texture).not.toBe(oldCapture.physical.texture);
    finishCapture();
    await completion;
    expect(oldPlanar.current()).toBeUndefined();
    expect(f.owner.planar.current()).toBe(nextCapture);
    finishFence(undefined);
    await fence;
    expect(destroyOldTexture).not.toHaveBeenCalledWith(oldCapture.physical.texture);
    expect(destroyOldTexture).toHaveBeenCalledWith(oldFallback.texture);
    expect(destroyOldTexture).not.toHaveBeenCalledWith(source.texture);
    expect(destroyOldTexture).not.toHaveBeenCalledWith(nextCapture.physical.texture);
    expect(destroyOldBuffer).toHaveBeenCalledWith(oldLighting.pipeline.viewUniformBuffer);
    disposeTargetCaptures(f.owner);
    await Promise.resolve();
    destroyRenderTargetPhysical(source);
    destroyRenderTargetPhysical(nextSource);
  });

  it('releases a partial private allocation and can retry without retiring parent buffers', async () => {
    const f = await fixture();
    const failure = new RhiError({
      code: 'internal-error',
      expected: 'capture buffer allocation',
      hint: 'injected allocation failure',
    });
    const allocate = f.gpu.createBuffer.bind(f.gpu);
    const create = vi
      .spyOn(f.gpu, 'createBuffer')
      .mockImplementationOnce(allocate)
      .mockReturnValueOnce(err(failure));
    const destroy = vi.spyOn(f.gpu, 'destroyBuffer');
    expect(() => f.prepare()).toThrow(failure);
    const first = required(create.mock.results[0]);
    expect(first.type).toBe('return');
    expect(destroy.mock.calls).toEqual([[first.value.unwrap()]]);
    expect(destroy).not.toHaveBeenCalledWith(f.basePipeline.pointsLinesViewBuffer);
    expect(f.prepare().pipeline.viewUniformBuffer).not.toBe(first.value.unwrap());
    disposeTargetCaptureLighting(f.owner);
    await Promise.resolve();
  });
  it('fences every capture resource while leaving the parent fallback and Points/Lines buffer alive', async () => {
    const f = await fixture();
    const parentFallback = required(getOrCreateSsaoFallbackTexture(f.runtime));
    const captured = f.prepare();
    const fallback = required(getOrCreateSsaoFallbackTexture(captured.runtime));
    const clusters = required(getOrCreateHdrpBuffers(captured.runtime));
    if (clusters.kind !== 'storage') throw new Error('Expected Standard storage allocation');
    const destroyBuffer = vi.spyOn(f.gpu, 'destroyBuffer');
    const destroyTexture = vi.spyOn(f.gpu, 'destroyTexture');
    let complete!: (value: undefined) => void;
    const fence = new Promise<undefined>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(f.gpu.queue, 'onSubmittedWorkDone').mockReturnValue(fence);

    const capturedPointsBuffer = captured.pipeline.pointsLinesViewBuffer;
    disposeTargetCaptureLighting(f.owner);
    disposeTargetCaptureLighting(f.owner);
    expect(destroyBuffer).not.toHaveBeenCalled();
    expect(destroyTexture).not.toHaveBeenCalled();
    complete(undefined);
    await fence;

    expect(destroyTexture.mock.calls.map(([texture]) => texture)).toEqual([fallback.texture]);
    for (const buffer of [
      captured.pipeline.viewUniformBuffer,
      capturedPointsBuffer,
      clusters.lightDataBuffer,
      clusters.clusterGridBuffer,
      clusters.lightIndexListBuffer,
      clusters.clusterUniformBuffer,
      clusters.lightBoundsBuffer,
    ]) {
      expect(destroyBuffer.mock.calls.filter(([value]) => value === buffer)).toHaveLength(1);
    }
    expect(destroyBuffer).not.toHaveBeenCalledWith(f.basePipeline.pointsLinesViewBuffer);
    expect(getOrCreateSsaoFallbackTexture(f.runtime)).toBe(parentFallback);
    resetSsaoResources(f.runtime);
  });

  it('replaces buffers on device change and retires the old capture through its creation device', async () => {
    const f = await fixture();
    const old = f.prepare();
    const oldPointsBuffer = old.pipeline.pointsLinesViewBuffer;
    const oldFallback = required(getOrCreateSsaoFallbackTexture(old.runtime));
    const destroyOldBuffer = vi.spyOn(f.gpu, 'destroyBuffer');
    const destroyOldTexture = vi.spyOn(f.gpu, 'destroyTexture');
    let complete!: (value: undefined) => void;
    const fence = new Promise<undefined>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(f.gpu.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
    const replacement = await device();
    const destroyNewBuffer = vi.spyOn(replacement, 'destroyBuffer');
    const destroyNewTexture = vi.spyOn(replacement, 'destroyTexture');
    Object.defineProperty(f.runtime, 'device', { value: replacement });
    const next = f.prepare(0, pipeline(replacement));

    expect(next.pipeline.viewUniformBuffer).not.toBe(old.pipeline.viewUniformBuffer);
    expect(next.pipeline.pointsLinesViewBuffer).not.toBe(oldPointsBuffer);
    expect(old.runtime.device).toBe(f.gpu);
    expect(next.runtime.device).toBe(replacement);
    expect(destroyOldBuffer).not.toHaveBeenCalled();
    expect(destroyOldTexture).not.toHaveBeenCalled();
    complete(undefined);
    await fence;
    expect(destroyOldBuffer).toHaveBeenCalledWith(old.pipeline.viewUniformBuffer);
    expect(destroyOldBuffer).toHaveBeenCalledWith(oldPointsBuffer);
    expect(destroyOldTexture).toHaveBeenCalledWith(oldFallback.texture);
    expect(destroyNewBuffer).not.toHaveBeenCalled();
    expect(destroyNewTexture).not.toHaveBeenCalled();
    disposeTargetCaptureLighting(f.owner);
    await Promise.resolve();
  });

  it('gives each same-frame writer of one layered target its own view uniform', async () => {
    const f = await fixture();
    const target = {} as RenderTarget;
    const writers = [0, 1, 2].map((layer) => {
      const camera = makeZeroCameraFallbackSnapshot();
      camera.position[0] = layer;
      return { target, layer, faceCamera: camera } as CubeCaptureGraphWork;
    });
    f.owner.work = writers;
    const prepare = (work: CubeCaptureGraphWork) =>
      prepareTargetCaptureLighting(
        f.owner,
        work,
        f.runtime,
        {} as RenderFrameState,
        f.basePipeline,
        lights,
      ).pipeline.viewUniformBuffer;
    const buffers = writers.map(prepare);
    expect(new Set(buffers).size).toBe(3);
    const destroy = vi.spyOn(f.gpu, 'destroyBuffer');
    // A later frame with one writer reuses ordinal 0 and retires the others.
    f.owner.work = [required(writers[2])];
    expect(prepare(required(writers[2]))).toBe(buffers[0]);
    await Promise.resolve();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledWith(buffers[1]);
    expect(destroy).toHaveBeenCalledWith(buffers[2]);
    expect(destroy).not.toHaveBeenCalledWith(buffers[0]);
    disposeTargetCaptureLighting(f.owner);
    await Promise.resolve();
  });

  it('keeps different camera payloads at the same Points/Lines draw slot in separate buffers', async () => {
    const f = await fixture();
    const first = f.prepare(0);
    const second = f.prepare(1);
    const write = vi.spyOn(f.gpu.queue, 'writeBuffer');
    for (const capture of [first, second])
      writePointsLinesViewUbo(
        f.gpu.queue,
        required(capture.pipeline.pointsLinesViewBuffer),
        capture.work.faceCamera,
        16,
        16,
      );
    const [a, b] = write.mock.calls;
    expect(a?.[0]).not.toBe(b?.[0]);
    expect(a?.[0]).not.toBe(f.basePipeline.pointsLinesViewBuffer);
    expect(b?.[0]).not.toBe(f.basePipeline.pointsLinesViewBuffer);
    expect(a?.[1]).toBe(0);
    expect(b?.[1]).toBe(0);
    expect(a?.[2]).not.toEqual(b?.[2]);
    expect(f.prepare(0).pipeline.pointsLinesViewBuffer).toBe(first.pipeline.pointsLinesViewBuffer);
    disposeTargetCaptureLighting(f.owner);
    await Promise.resolve();
  });
});

it('uses current Fog while retaining the captured atmosphere and sun', async () => {
  const f = await fixture();
  const scope = DeviceScope.create(1, 'capture-fog');
  Object.assign(f.runtime, { deviceScope: scope });
  const first = selectEnvironment({
    environments: [
      { kind: 'atmosphere', entityKey: 1, sourceKey: 'sky', atmosphere: earthAtmosphere },
    ],
    suns: [{ entityKey: 2, direction: [0, 1, 0], color: [1, 1, 1], intensity: 100000 }],
    fogs: [],
  }).unwrap();
  const capture = retainAtmosphere(f.runtime, first);
  const fog = {
    entityKey: 3,
    color: [0.2, 0.3, 0.4] as const,
    density: 0.02,
    heightFalloff: 0.1,
    maxOpacity: 1,
    mode: 'exp' as const,
    near: 0,
    far: 100,
  };
  f.state.environmentFrame = selectEnvironment({
    environments: [
      { kind: 'atmosphere', entityKey: 1, sourceKey: 'sky', atmosphere: earthAtmosphere },
    ],
    suns: [{ entityKey: 2, direction: [1, 0, 0], color: [1, 1, 1], intensity: 100000 }],
    fogs: [fog],
  }).unwrap();
  Object.assign(required(f.owner.work[0]), { atmosphere: capture.storage, candidateGeneration: 1 });
  try {
    const prepared = f.prepare();
    expect(prepared.capturedAtmosphere).toBe(capture.storage);
    expect(prepared.frameState.environmentFrame?.sun).toEqual(first.sun);
    expect(prepared.frameState.environmentFrame?.fog).toEqual(fog);
    expect(prepared.frameState.environmentFrame?.fogSignature).toBe(
      f.state.environmentFrame.fogSignature,
    );
    expect(prepared.frameState.environmentFrame?.environmentSignature).toBe(
      first.environmentSignature,
    );
  } finally {
    disposeTargetCaptureLighting(f.owner);
    capture.release();
    releaseAtmosphere(f.runtime);
    await f.gpu.queue.onSubmittedWorkDone();
    scope.retire();
  }
});
