import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderFeatureHost, type RenderFeatureFrameBatch } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import type { RenderSystemInternals } from '../record/render-context';
import { awaitsRenderRecord } from '../world/graph-systems';
import { endRenderFrame } from '../world/render-world';
import { stageFeatureFrame } from './feature-frame-driver';
import {
  type FrameRecording,
  prepareFrameSubmission,
  submitFrameRecordings,
} from './frame-recording-driver';

async function fixture(abortThrows = false) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const events: string[] = [];
  let bufferSize = 16;
  const features: RenderFeature<undefined>[] = ['a', 'b'].map((identity) => ({
    identity,
    extract: () => {
      events.push(`extract:${identity}`);
      return ok(undefined);
    },
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [
              {
                kind: 'compute-program',
                name: 'program',
                program: {
                  wgsl: 'synthetic',
                  entryPoints: ['main'],
                  bindings: [
                    { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }] },
                  ],
                },
              },
              {
                kind: 'buffer',
                name: 'state',
                size: bufferSize,
                usage: ['storage'],
                data: new Uint32Array([1]),
              },
              {
                kind: 'compute-bindings',
                name: 'bindings',
                program: 'program',
                entries: [{ binding: 0, resource: 'state' }],
              },
            ],
            passes: [
              {
                kind: 'compute',
                name: `tick-${identity}`,
                program: 'program',
                bindings: 'bindings',
                dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
              },
            ],
          },
        ],
      }),
    onFrameSubmitted: () => {
      events.push(`submit:${identity}`);
    },
    onSourceFrameSubmitted: () => {
      events.push(`ack:${identity}`);
    },
    onFrameAborted: () => {
      events.push(`abort:${identity}`);
      if (abortThrows && identity === 'a') throw new Error('abort callback');
    },
  }));
  const reported: unknown[] = [];
  const host = createRenderFeatureHost(features, undefined, (error) =>
    reported.push(error),
  ).unwrap();
  const sceneComplete = vi.fn((submitted: boolean) => {
    events.push(`scene-complete:${submitted}`);
  });
  const capturePrepare = vi.fn(() => {
    events.push('capture-prepare');
    return [];
  });
  const internals = {
    device,
    canvas: { width: 1, height: 1 },
    errorRegistry: { fire() {} },
    renderWorld: host.world,
    featureSceneInputs: {
      work: [],
      hasSharedWork: false,
      import: () => new Map(),
      contribute() {},
    },
    rendererCaptureOwner: { prepare: capturePrepare },
  } as unknown as RenderSystemInternals;
  const encoder = device.createCommandEncoder().unwrap();
  const originalCompute = encoder.beginComputePass.bind(encoder);
  const compute = vi.spyOn(encoder, 'beginComputePass');
  // Record the real Null encoding rather than replacing the compute pass.
  compute.mockImplementation((descriptor) => {
    events.push('compute');
    return originalCompute(descriptor);
  });
  const finish = vi.spyOn(encoder, 'finish');
  // RenderRecord opens the encoder the next staged frame records into.
  let recordEncoder: RhiCommandEncoder = encoder;
  const createEncoder = device.createCommandEncoder.bind(device);
  const freshEncoder = (): RhiCommandEncoder => createEncoder().unwrap();
  vi.spyOn(device, 'createCommandEncoder').mockImplementation(() => ok(recordEncoder) as never);
  const submit = vi.spyOn(device.queue, 'submit');
  const created = vi.spyOn(device, 'createBuffer');
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  // RenderPrepare seals the frame's Feature batch over every view's input.
  function views(
    identities: readonly string[],
    frameNumber = 1,
    frameEncoder: RhiCommandEncoder = encoder,
  ): FrameRecording[] {
    const outcome = stageFeatureFrame(
      host,
      identities.map((identity) => ({
        identity,
        render: true,
        worlds: [],
        owner: 0,
        frameNumber,
        caps: device.caps,
        gpuWork,
        sceneResources: {
          prepare: () => {
            throw new Error('No scene input');
          },
          abortFeature() {},
          begin() {},
          complete: sceneComplete,
        },
      })),
    );
    if (outcome.kind !== 'sealed') throw new Error(`Feature frame ${outcome.kind}`);
    recordEncoder = frameEncoder;
    return identities.map((identity) => view(identity, outcome.batch));
  }
  function* view(identity: string, batch: RenderFeatureFrameBatch): FrameRecording {
    try {
      const prepared = batch.views.get(identity);
      expect(prepared?.errors).toEqual([]);
      events.push(`accept:${identity}`);
      yield { kind: 'shared-work', internals, sceneInputs: false };
      // The view's graph compiles in RenderRecord, before any view encodes.
      if (awaitsRenderRecord(host.world)) yield { kind: 'compile', world: host.world };
      events.push(`record:${identity}`);
      const result = yield { reportError() {} };
      return result.ok;
    } finally {
      events.push(`close:${identity}`);
    }
  }
  return {
    views,
    freshEncoder,
    input: { world: host.world, device, rendererInternals: internals },
    events,
    capturePrepare,
    sceneComplete,
    compute,
    finish,
    submit,
    created,
    destroyed,
    device,
    host,
    internals,
    reported,
    /** RenderCommit, then RenderCleanup: settle the frame's Feature work. */
    settle: () => endRenderFrame(host.world),
    setBufferSize: (size: number) => {
      bufferSize = size;
    },
    dispose: () => {
      host.dispose().unwrap();
      gpuWork.dispose().unwrap();
    },
  };
}

it('prepares all views once and pauses before capture, shared compute and view encoding', async () => {
  const f = await fixture();
  const operation = prepareFrameSubmission(f.input, f.views(['left', 'right']));
  try {
    expect(operation.next()).toEqual({ done: false, value: { kind: 'features-prepared' } });
    expect(f.events).toEqual(['extract:a', 'extract:b', 'accept:left', 'accept:right']);
    expect(f.created).toHaveBeenCalledTimes(2);
    expect(f.capturePrepare).not.toHaveBeenCalled();
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(operation.next()).toEqual({ done: true, value: true });
    f.settle();
    expect(f.events.indexOf('capture-prepare')).toBeLessThan(f.events.indexOf('compute'));
    expect(f.events.indexOf('compute')).toBeLessThan(f.events.indexOf('record:left'));
    expect(f.compute).toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    for (const identity of ['a', 'b']) {
      expect(f.events.filter((event) => event === `ack:${identity}`)).toHaveLength(1);
      expect(f.events).not.toContain(`abort:${identity}`);
    }
    const settled = [...f.events];
    expect(operation.return(false)).toEqual({ done: true, value: false });
    expect(f.events).toEqual(settled);
  } finally {
    operation.return(false);
    f.dispose();
  }
});

it.each([
  'return',
  'stale',
] as const)('aborts a %s checkpoint without resuming a recorder or acknowledging work', async (mode) => {
  const f = await fixture();
  let current = true;
  const operation = prepareFrameSubmission(
    { ...f.input, isCurrent: () => current },
    f.views(['left', 'right']),
  );
  try {
    expect(operation.next().done).toBe(false);
    current = false;
    const stopped = mode === 'return' ? operation.return(false) : operation.next();
    expect(stopped).toEqual({ done: true, value: false });
    f.settle();
    expect(f.events).not.toContain('record:left');
    expect(f.events).not.toContain('record:right');
    expect(f.capturePrepare).not.toHaveBeenCalled();
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.created).toHaveBeenCalledTimes(2);
    expect(f.destroyed).toHaveBeenCalledTimes(2);
    for (const identity of ['a', 'b']) {
      expect(f.events.filter((event) => event === `abort:${identity}`)).toHaveLength(1);
      expect(f.events).not.toContain(`ack:${identity}`);
    }
    for (const identity of ['left', 'right'])
      expect(f.events.filter((event) => event === `close:${identity}`)).toHaveLength(1);
    expect(f.sceneComplete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    const settled = [...f.events];
    operation.return(false);
    expect(f.events).toEqual(settled);
  } finally {
    operation.return(false);
    f.dispose();
  }
});

it('drains sibling cleanup when checkpoint cancellation and one producer abort both throw', async () => {
  const f = await fixture(true);
  const operation = prepareFrameSubmission(f.input, f.views(['left', 'right']));
  try {
    operation.next();
    expect(() => operation.throw(new Error('checkpoint failure'))).toThrow('checkpoint failure');
    // The producer abort throw is contained by render-feature-abort and reported.
    f.settle();
    expect(f.reported).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          error: expect.objectContaining({ code: 'render-feature-settlement-failed' }),
        }),
      }),
    ]);
    expect(f.destroyed).toHaveBeenCalledTimes(2);
    for (const identity of ['a', 'b'])
      expect(f.events.filter((event) => event === `abort:${identity}`)).toHaveLength(1);
    expect(f.sceneComplete).toHaveBeenCalledOnce();
    expect(f.events.some((event) => event.startsWith('ack:'))).toBe(false);
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    const settled = [...f.events];
    operation.return(false);
    expect(f.events).toEqual(settled);
  } finally {
    operation.return(false);
    f.dispose();
  }
});

it('keeps the synchronous drain on the same preparation and submission path', async () => {
  const f = await fixture();
  try {
    expect(submitFrameRecordings(f.input, f.views(['left', 'right']))).toBe(true);
    f.settle();
    // `render-capture-schedule` owns capture scheduling; the drain never re-runs it.
    expect(f.capturePrepare).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.startsWith('ack:'))).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

it('retires an older submitted batch while the current frame remains prepared at its checkpoint', async () => {
  const f = await fixture();
  const retirement = vi.spyOn(f.host, 'retirePreparedGraphics');
  const completion = vi.spyOn(f.device.queue, 'onSubmittedWorkDone');
  let completeOld!: () => void;
  const oldCompletion = new Promise<undefined>((resolve) => {
    completeOld = () => resolve(undefined);
  });
  let current: ReturnType<typeof prepareFrameSubmission> | undefined;
  try {
    // Seed a real accepted allocation. Its replacement below gives the old
    // receipt a nonempty retirement batch instead of vacuously retiring [].
    f.setBufferSize(16);
    expect(submitFrameRecordings(f.input, f.views(['left'], 1))).toBe(true);
    f.settle();
    await f.device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    retirement.mockClear();
    const original = f.created.mock.results.map((result) => result.value.unwrap());
    completion.mockReturnValue(oldCompletion);
    f.setBufferSize(32);
    const oldEncoder = f.freshEncoder();
    expect(submitFrameRecordings(f.input, f.views(['left'], 2, oldEncoder))).toBe(true);
    f.settle();
    const retained = f.created.mock.results.slice(2).map((result) => result.value.unwrap());
    expect(retained).toHaveLength(2);
    expect(retirement).not.toHaveBeenCalled();
    expect(f.destroyed).not.toHaveBeenCalled();
    f.events.length = 0;
    const nextEncoder = f.freshEncoder();
    current = prepareFrameSubmission(f.input, f.views(['left'], 3, nextEncoder));
    expect(current.next()).toEqual({ done: false, value: { kind: 'features-prepared' } });
    expect(f.created).toHaveBeenCalledTimes(4);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.events.some((event) => event.startsWith('ack:'))).toBe(false);
    completeOld();
    await oldCompletion;
    await Promise.resolve();
    expect(retirement).toHaveBeenCalledOnce();
    expect(retirement.mock.calls[0]?.[0]?.length).toBeGreaterThan(0);
    expect(f.destroyed).toHaveBeenCalledTimes(2);
    expect(
      original.every((buffer) => f.destroyed.mock.calls.some(([value]) => value === buffer)),
    ).toBe(true);
    expect(
      retained.some((buffer) => f.destroyed.mock.calls.some(([value]) => value === buffer)),
    ).toBe(false);
    expect(f.events).not.toContain('record:left');
    expect(f.events.some((event) => event.startsWith('ack:'))).toBe(false);
    completion.mockRestore();
    expect(current.next()).toEqual({ done: true, value: true });
    f.settle();
    expect(f.submit).toHaveBeenCalledTimes(3);
    expect(f.created).toHaveBeenCalledTimes(4);
    expect(f.events.filter((event) => event.startsWith('ack:'))).toEqual(['ack:a', 'ack:b']);
    expect(f.destroyed).toHaveBeenCalledTimes(2);
  } finally {
    completeOld();
    completion.mockRestore();
    current?.return(false);
    retirement.mockRestore();
    f.dispose();
  }
});
