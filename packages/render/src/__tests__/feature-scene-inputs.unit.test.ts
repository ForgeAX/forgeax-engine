import { mat4 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createFeatureSceneInputs } from '../assembly/feature-scene-inputs';
import { type FrameRecording, submitFrameRecordings } from '../assembly/frame-recording';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import {
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignatureEvidenceMatches,
} from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';

const camera = () => ({
  position: new Float32Array([3, 0, 3]),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.1, 0, -3, 0, 0.5, 1]),
});

async function fixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const runtime = {
    device,
    canvas: { width: 64, height: 32 },
    deviceScope: { generation: 0 },
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const noise = vi.fn(() => undefined);
  const owner = createFeatureSceneInputs(runtime, noise);
  runtime.featureSceneInputs = owner;
  return { runtime, device, adapter, owner, noise };
}

function simulationFeature(): RenderFeature<undefined> {
  return {
    identity: 'simulation',
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [
              { kind: 'scene-depth', name: 'depth', camera: camera() },
              {
                kind: 'compute-program',
                name: 'program',
                program: {
                  wgsl: 'synthetic',
                  entryPoints: ['main'],
                  bindings: [
                    {
                      entries: [
                        {
                          binding: 0,
                          visibility: 4,
                          texture: { sampleType: 'depth', viewDimension: '2d' },
                        },
                      ],
                    },
                  ],
                },
              },
              {
                kind: 'compute-bindings',
                name: 'inputs',
                program: 'program',
                entries: [{ binding: 0, resource: 'depth' }],
              },
            ],
            passes: [
              {
                kind: 'compute',
                name: 'simulate',
                program: 'program',
                bindings: 'inputs',
                dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
              },
            ],
          },
        ],
      }),
  };
}

describe('Renderer scene inputs', () => {
  it('keeps signature evidence valid when an explicit camera changes across plan revisions', () => {
    const host = createRenderFeatureHost([]).unwrap();
    const makePlan = (size: number): RenderFeatureWorkPlan => ({
      resources: [
        { kind: 'scene-depth', name: 'depth', camera: camera() },
        { kind: 'buffer', name: 'state', size, usage: ['storage'] },
      ],
      passes: [],
    });
    const initial = makePlan(16);
    const initialSignature = host.recordPlanSignature?.('particles', initial);
    if (initialSignature === undefined) throw new Error('signature owner missing');
    expect(renderFeaturePlanSignatureEvidenceMatches(initial, initialSignature)).toBe(true);
    const revised = makePlan(32);
    const revisionSignature = host.recordPlanSignature?.('particles', revised);
    if (revisionSignature === undefined) throw new Error('signature owner missing');
    expect(revisionSignature).not.toBe(initialSignature);
    expect(renderFeaturePlanSignatureEvidenceMatches(revised, revisionSignature)).toBe(true);
    const moved = makePlan(32);
    const depth = moved.resources[0];
    if (depth?.kind !== 'scene-depth') throw new Error('depth resource missing');
    depth.camera.position[0] = 10;
    depth.camera.viewProjection[12] = -10;
    expect(host.recordPlanSignature?.('particles', moved)).toBe(revisionSignature);
    expect(renderFeaturePlanSignatureEvidenceMatches(moved, revisionSignature)).toBe(true);
    const state = moved.resources[1];
    if (state === undefined) throw new Error('state resource missing');
    Object.assign(state, { size: 64 });
    expect(renderFeaturePlanSignatureEvidenceMatches(moved, revisionSignature)).toBe(false);
    host.dispose().unwrap();
  });

  it('allocates only on demand and retains the explicit camera and root extent', async () => {
    const f = await fixture();
    const created = vi.spyOn(f.device, 'createTexture');
    f.owner.begin(1);
    f.owner.complete(true);
    expect(created).not.toHaveBeenCalled();
    expect(f.noise).not.toHaveBeenCalled();
    const input = { kind: 'scene-depth' as const, name: 'simulation', camera: camera() };
    const first = f.owner.prepare('particles', input);
    const allocations = created.mock.calls.length;
    expect(f.owner.prepare('particles', input)).toEqual(first);
    expect(f.owner.work).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(allocations);
    const work = f.owner.work[0];
    if (work === undefined) throw new Error('depth work missing');
    expect(work.physical.descriptor).toMatchObject({ width: 64, height: 32, sampleCount: 1 });
    expect(created).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: 'depth32float-stencil8' }),
    );
    expect(work.physical.sampledDepth).toBe(true);
    const actual = mat4.multiply(
      mat4.create(),
      computeProjectionMatrix(work.faceCamera),
      computeViewMatrix(work.faceCamera),
    );
    actual.forEach((value, index) => {
      expect(value).toBeCloseTo(input.camera.viewProjection[index] ?? 0);
    });
    f.owner.complete(true);
    f.owner.begin(2);
    expect(f.owner.prepare('particles', input)).toEqual(first);
    expect(created).toHaveBeenCalledTimes(allocations);
    f.owner.dispose();
  });

  it('retires removed and recovered resources against their allocation device fence', async () => {
    const f = await fixture();
    let finish!: () => void;
    const fence = new Promise<undefined>((resolve) => {
      finish = () => resolve(undefined);
    });
    vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
    const destroyed = vi.spyOn(f.device, 'destroyTexture');
    f.owner.begin(1);
    const input = { kind: 'scene-depth' as const, name: 'simulation', camera: camera() };
    f.owner.prepare('particles', input);
    const previous = f.owner.work[0]?.physical;
    const next = (await f.adapter.requestDevice()).unwrap();
    const nextDestroyed = vi.spyOn(next, 'destroyTexture');
    Object.assign(f.runtime, { device: next });
    f.owner.complete(true);
    f.owner.begin(2);
    f.owner.prepare('particles', input);
    expect(f.owner.work[0]?.physical).not.toBe(previous);
    expect(destroyed).not.toHaveBeenCalled();
    f.owner.complete(true);
    finish();
    await fence;
    expect(destroyed).toHaveBeenCalled();
    expect(nextDestroyed).not.toHaveBeenCalled();
    f.owner.begin(3);
    f.owner.complete(true);
    await Promise.resolve();
    expect(nextDestroyed).toHaveBeenCalled();
    f.owner.dispose();
  });

  it('keeps submitted depth on resize abort and frees the unpublished candidate', async () => {
    const f = await fixture();
    const destroyed = vi.spyOn(f.device, 'destroyTexture');
    const input = { kind: 'scene-depth' as const, name: 'simulation', camera: camera() };
    f.owner.begin(1);
    const accepted = f.owner.prepare('particles', input);
    const previous = f.owner.work[0]?.physical;
    if (previous === undefined) throw new Error('accepted depth missing');
    const topology = f.owner.topologyKey;
    f.owner.complete(true);
    f.runtime.canvas.width = 128;
    f.owner.begin(2);
    f.owner.prepare('particles', input);
    const candidate = f.owner.work[0]?.physical;
    if (candidate === undefined) throw new Error('candidate depth missing');
    expect(f.owner.topologyKey).not.toBe(topology);
    f.owner.complete(false);
    expect(destroyed).toHaveBeenCalledWith(candidate.texture);
    expect(destroyed).not.toHaveBeenCalledWith(previous.texture);
    f.runtime.canvas.width = 64;
    f.owner.begin(3);
    expect(f.owner.prepare('particles', input)).toEqual(accepted);
    expect(f.owner.topologyKey).toBe(topology);
    f.owner.complete(true);
    f.owner.dispose();
  });

  it('withdraws captures when a Feature fails after preparing scene inputs', async () => {
    const f = await fixture();
    const shader = (await rhi.createShaderModule(f.device, { code: 'synthetic' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => f.device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const host = createRenderFeatureHost([simulationFeature()]).unwrap();
    const destroyed = vi.spyOn(f.device, 'destroyTexture');
    const failed = vi.fn(() => {
      throw new Error('injected binding failure');
    });
    const beginFeature = gpu.beginFeature.bind(gpu);
    vi.spyOn(gpu, 'beginFeature').mockImplementation((...args) => ({
      ...beginFeature(...args),
      prepareBindings: failed,
    }));
    f.owner.begin(1);
    const batch = runRenderFeatureFrame(host, [
      {
        identity: 'left',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: f.device.caps,
        gpuWork: gpu,
        sceneResources: f.owner,
      },
    ]);
    expect(failed).toHaveBeenCalled();
    expect(batch.frame.errors).not.toHaveLength(0);
    expect(f.owner.work).toHaveLength(0);
    expect(destroyed).toHaveBeenCalledTimes(2);
    batch.onAborted();
    f.owner.complete(false);
    host.dispose();
    gpu.dispose().unwrap();
    f.owner.dispose();
  });

  it('reports failed RHI retirement and still drains every candidate and the transaction', async () => {
    const f = await fixture();
    f.owner.begin(1);
    f.owner.prepare('particles', { kind: 'scene-depth', name: 'first', camera: camera() });
    f.owner.prepare('particles', { kind: 'scene-depth', name: 'second', camera: camera() });
    const destroy = vi.spyOn(f.device, 'destroyTexture').mockReturnValueOnce(
      err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'injected retirement failure',
          hint: 'recover',
        }),
      ),
    );
    f.owner.complete(false);
    expect(destroy).toHaveBeenCalledTimes(4);
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'render-target-operation-failed',
        detail: expect.objectContaining({
          operation: 'destroy',
          stage: 'retire',
          recovery: 'recover',
        }),
      }),
    );
    expect(f.owner.work).toHaveLength(0);
    expect(() => f.owner.begin(2)).not.toThrow();
    f.owner.dispose();
  });

  it.each([1, 4, 5])('releases partial target allocations if view %s fails', async (failedView) => {
    const f = await fixture();
    const destroyed = vi.spyOn(f.device, 'destroyTexture');
    const createView = f.device.createTextureView.bind(f.device);
    let viewCalls = 0;
    vi.spyOn(f.device, 'createTextureView').mockImplementation((texture, descriptor) =>
      ++viewCalls === failedView
        ? err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'injected allocation failure',
              hint: 'retry',
            }),
          )
        : createView(texture, descriptor),
    );
    f.owner.begin(1);
    expect(() =>
      f.owner.prepare('particles', { kind: 'scene-depth', name: 'depth', camera: camera() }),
    ).toThrow();
    expect(destroyed).toHaveBeenCalledTimes(failedView === 1 ? 1 : 2);
    expect(f.owner.work).toHaveLength(0);
    f.owner.complete(false);
    f.owner.dispose();
  });

  it.each([
    true,
    false,
  ])('records scene capture then one shared simulation before displays (render=%s)', async (render) => {
    const f = await fixture();
    const shader = (await rhi.createShaderModule(f.device, { code: 'synthetic' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => f.device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const feature = simulationFeature();
    const host = createRenderFeatureHost([feature]).unwrap();
    const encoder = f.device.createCommandEncoder().unwrap();
    const compute = vi.spyOn(encoder, 'beginComputePass');
    const events: string[] = [];
    function* record(identity: string): FrameRecording {
      let captures: readonly CubeCaptureGraphWork[] = [];
      yield {
        kind: 'features',
        host,
        internals: f.runtime,
        encoder,
        input: {
          identity,
          render,
          worlds: [],
          owner: 0,
          frameNumber: 1,
          caps: f.device.caps,
          gpuWork: gpu,
          sceneResources: f.owner,
        },
        captures: {
          snapshots: [],
          auxiliary: [],
          exclusive: false,
          accept: (_work, _auxiliary, scene) => {
            captures = scene;
          },
        },
        accept: (result) => {
          expect(result.errors).toEqual([]);
        },
      };
      if (captures.length > 0) {
        expect(compute).not.toHaveBeenCalled();
        events.push('depth');
        f.runtime.framePassNames?.push('feature-scene-depth-face.0');
        yield { kind: 'scene-inputs', encoder };
      }
      expect(compute).toHaveBeenCalledTimes(1);
      events.push(identity);
      f.runtime.framePassNames?.push(identity);
      return (yield { device: f.device, encoder, reportError() {} }).ok;
    }
    try {
      expect(submitFrameRecordings([record('left'), record('right')], undefined, f.runtime)).toBe(
        true,
      );
      expect(events).toEqual(['depth', 'left', 'right']);
      expect(f.runtime.submittedPassNames).toEqual([
        'feature-scene-depth-face.0',
        'simulate',
        'left',
        'right',
      ]);
    } finally {
      host.dispose();
      gpu.dispose().unwrap();
      f.owner.dispose();
    }
  });
});
