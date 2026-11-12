import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { stageFeatureFrame } from '../../__tests__/feature-frame-driver';
import { createRenderFeatureHost } from '../../features/host';
import { createRenderFeatureGpuWorkOwner } from '../../features/prepared-gpu-work';
import type { RenderFeature } from '../../features/types';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  encodeSharedFeatureGraph,
  RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
  sharedFeatureGraphOutcome,
  stageSharedFeatureGraph,
} from '../feature-graph-systems';
import { stageRecordedFeatureGraph } from '../feature-systems';
import { RENDER_FEATURE_GRAPH_ENCODE_SYSTEM } from '../graph-seal-systems';
import { frameEncoder } from '../record-systems';
import { ViewSubmission } from '../render-views';
import {
  endRenderFrame,
  publishRenderSubmission,
  RenderRecord,
  runRenderRecord,
} from '../render-world';

async function fixture(systemEncode = false) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const submitted = vi.fn();
  const aborted = vi.fn();
  const feature: RenderFeature<undefined> = {
    identity: 'shared-copy',
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [
              {
                kind: 'buffer',
                name: 'source',
                size: 16,
                usage: ['copy-src'],
                data: new Uint32Array([7, 0, 0, 0]),
              },
              { kind: 'buffer', name: 'destination', size: 16, usage: ['storage'] },
            ],
            passes: [
              {
                kind: 'copy',
                name: 'shared-copy-pass',
                copies: [{ source: 'source', destination: 'destination', size: 16 }],
              },
            ],
          },
        ],
      }),
    onFrameSubmitted: submitted,
    onFrameAborted: aborted,
  };
  const host = createRenderFeatureHost([feature as RenderFeature<unknown>]).unwrap();
  const staged = stageFeatureFrame(host, [
    {
      identity: 'view',
      render: true,
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 0,
      caps: device.caps,
      gpuWork: gpu,
    },
  ]);
  if (staged.kind !== 'sealed') throw new Error(`Feature frame ${staged.kind}`);
  expect(staged.batch.frame.errors).toEqual([]);
  const world = host.world;
  const internals = {
    device,
    canvas: { width: 8, height: 8 },
    renderWorld: world,
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  stageSharedFeatureGraph(world, internals);
  // These kernel tests isolate compile from encode; system execution has its own same-path tests.
  if (!systemEncode) world.removeSystem(RenderRecord, RENDER_FEATURE_GRAPH_ENCODE_SYSTEM).unwrap();
  const record = () => runRenderRecord(world, { device, frameId: 1 });
  const finish = (accepted: boolean, completion?: Promise<void>) => {
    publishRenderSubmission(world, {
      accepted,
      completion,
      creditCompletion: undefined,
      generation: 0,
    });
    endRenderFrame(world);
  };
  const dispose = () => {
    host.dispose();
    gpu.dispose().unwrap();
  };
  return { world, staged, submitted, aborted, record, finish, dispose };
}

describe('shared Feature graph systems', () => {
  it('compiles before execution and acknowledges exactly its encoded receipt', async () => {
    const f = await fixture();
    expect(sharedFeatureGraphOutcome(f.world)).toBeUndefined();
    expect(f.record().ok).toBe(true);
    const compiled = sharedFeatureGraphOutcome(f.world);
    if (compiled?.ok !== true || compiled.receipt.kind !== 'compiled')
      throw new Error('Missing compiled receipt');
    expect(compiled.receipt.plans).toBe(f.staged.batch.frame.plans);
    expect(compiled.receipt.graph.inspect().passes.map((pass) => pass.name)).toContain(
      'shared-copy-pass',
    );
    const encoder = frameEncoder(f.world);
    const copies = vi.spyOn(encoder, 'copyBufferToBuffer');
    expect(copies).not.toHaveBeenCalled();
    const encoded = encodeSharedFeatureGraph(f.world, encoder);
    expect(encoded.ok && encoded.value).toBe(compiled.receipt);
    expect(copies).toHaveBeenCalledTimes(1);
    expect(f.submitted).not.toHaveBeenCalled();
    expect(encodeSharedFeatureGraph(f.world, encoder).ok).toBe(false);
    expect(copies).toHaveBeenCalledTimes(1);
    f.finish(true, Promise.resolve());
    expect(f.submitted).toHaveBeenCalledTimes(1);
    expect(f.aborted).not.toHaveBeenCalled();
    expect(sharedFeatureGraphOutcome(f.world)).toBeUndefined();
    f.dispose();
  });

  it('has no graph or acknowledgment when its compile system is removed', async () => {
    const f = await fixture();
    f.world.removeSystem(RenderRecord, RENDER_FEATURE_GRAPH_COMPILE_SYSTEM).unwrap();
    expect(f.record().ok).toBe(true);
    const encoded = encodeSharedFeatureGraph(f.world, frameEncoder(f.world));
    expect(encoded.ok).toBe(false);
    if (!encoded.ok)
      expect(encoded.error).toMatchObject({
        code: 'render-feature-stage-failed',
        detail: { stage: 'record' },
      });
    f.finish(false);
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
    f.dispose();
  });

  it('returns encode failure as data without advancing Feature history', async () => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const encoder = frameEncoder(f.world);
    vi.spyOn(encoder, 'copyBufferToBuffer').mockImplementation(() => {
      throw new Error('copy rejected');
    });
    const encoded = encodeSharedFeatureGraph(f.world, encoder);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok)
      expect(encoded.error).toMatchObject({
        code: 'render-feature-stage-failed',
        detail: { stage: 'record' },
      });
    f.finish(false);
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
    f.dispose();
  });

  it.each([
    'stale-frame',
    'stale-generation',
    'rejected-view',
  ] as const)('does not acknowledge a delayed graph receipt with %s', async (failure) => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const compiled = sharedFeatureGraphOutcome(f.world);
    if (compiled?.ok !== true) throw new Error('Missing compiled receipt');
    const receipt = compiled.receipt;
    const rejected = f.world
      .spawn({
        component: ViewSubmission,
        data: {
          accepted: false,
          attempt: receipt.frame,
          scene: true,
          temporal: false,
        },
      })
      .unwrap();
    // The compiler receipt models a late encoder notification; no backend acceptance is inferred.
    stageRecordedFeatureGraph(f.world, {
      ...receipt,
      frame: receipt.frame + (failure === 'stale-frame' ? 1 : 0),
      generation: receipt.generation + (failure === 'stale-generation' ? 1 : 0),
      view: failure === 'rejected-view' ? rejected : undefined,
    });
    f.finish(true, Promise.resolve());
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
    f.dispose();
  });

  it('pins an encoded graph until physical completion', async () => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const compiled = sharedFeatureGraphOutcome(f.world);
    if (compiled?.ok !== true || compiled.receipt.kind !== 'compiled')
      throw new Error('Missing compiled receipt');
    const retire = vi.spyOn(compiled.receipt.graph, 'retire');
    expect(encodeSharedFeatureGraph(f.world, frameEncoder(f.world)).ok).toBe(true);
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    f.finish(true, completion);
    expect(retire).not.toHaveBeenCalled();
    resolve();
    await completion;
    await Promise.resolve();
    expect(retire).toHaveBeenCalledTimes(1);
    f.dispose();
  });
});

it('encodes the shared Feature graph in RenderRecord without a manual encode call', async () => {
  const f = await fixture(true);
  try {
    expect(f.record().ok).toBe(true);
    const { sharedFeatureGraphEncoded } = await import('../feature-graph-systems');
    expect(sharedFeatureGraphEncoded(f.world)).toBe(true);
    expect(f.submitted).not.toHaveBeenCalled();
    f.finish(true, Promise.resolve());
    expect(f.submitted).toHaveBeenCalledTimes(1);
    expect(f.aborted).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('does not encode or acknowledge routed scene inputs when their view stops before graph seal', async () => {
  const f = await fixture(true);
  try {
    const { ViewCaptureWork } = await import('../capture-systems');
    f.world
      .spawn({
        component: ViewCaptureWork,
        data: {
          state: f.world.allocUniqueRef('ViewCaptureWork', {
            frame: 1,
            outcome: {
              kind: 'prepared',
              value: { sceneInputs: [{}], cube: [], auxiliaryCameras: [], faces: [] },
            },
          }),
        },
      })
      .unwrap();
    expect(f.record().ok).toBe(true);
    const { sharedFeatureGraphEncoded, sharedFeatureSceneInputsPending } = await import(
      '../feature-graph-systems'
    );
    expect(sharedFeatureGraphEncoded(f.world)).toBe(false);
    expect(sharedFeatureSceneInputsPending(f.world)).toBe(true);
    f.finish(false, Promise.resolve());
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
  } finally {
    f.dispose();
  }
});
