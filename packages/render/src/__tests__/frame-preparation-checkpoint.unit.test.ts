import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  type FrameRecording,
  prepareFrameSubmission,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import { createRenderFeatureHost, type RenderFeatureFrameResult } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import type { RenderSystemInternals } from '../record/render-context';

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
  const host = createRenderFeatureHost(features).unwrap();
  const sceneComplete = vi.fn((submitted: boolean) => {
    events.push(`scene-complete:${submitted}`);
  });
  const capturePrepare = vi.fn(() => {
    events.push('capture-prepare');
    return [];
  });
  const captureComplete = vi.fn((submitted: boolean) => {
    events.push(`capture-complete:${submitted}`);
  });
  const internals = {
    device,
    canvas: { width: 1, height: 1 },
    errorRegistry: { fire() {} },
    featureSceneInputs: {
      begin() {},
      work: [],
      hasSharedWork: false,
      import: () => new Map(),
      contribute() {},
      complete: sceneComplete,
    },
    rendererCaptureOwner: { prepare: capturePrepare, complete: captureComplete },
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
  const submit = vi.spyOn(device.queue, 'submit');
  const created = vi.spyOn(device, 'createBuffer');
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  function* view(
    identity: string,
    frameNumber = 1,
    frameEncoder: RhiCommandEncoder = encoder,
  ): FrameRecording {
    let prepared: RenderFeatureFrameResult | undefined;
    try {
      yield {
        kind: 'features',
        host,
        internals,
        encoder: frameEncoder,
        input: {
          identity,
          render: true,
          worlds: [],
          owner: 0,
          frameNumber,
          caps: device.caps,
          gpuWork,
        },
        captures: { snapshots: [], exclusive: false, accept() {} },
        accept: (result) => {
          expect(result.errors).toEqual([]);
          prepared = result;
          events.push(`accept:${identity}`);
        },
      };
      events.push(`record:${identity}`);
      const result = yield { device, encoder: frameEncoder, reportError() {} };
      if (result.ok) prepared?.onSubmitted();
      else prepared?.onAborted();
      return result.ok;
    } finally {
      events.push(`close:${identity}`);
    }
  }
  return {
    view,
    events,
    capturePrepare,
    captureComplete,
    sceneComplete,
    compute,
    finish,
    submit,
    created,
    destroyed,
    device,
    host,
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
  const operation = prepareFrameSubmission([f.view('left'), f.view('right')]);
  try {
    expect(operation.next()).toEqual({ done: false, value: { kind: 'features-prepared' } });
    expect(f.events).toEqual(['extract:a', 'extract:b', 'accept:left', 'accept:right']);
    expect(f.created).toHaveBeenCalledTimes(2);
    expect(f.capturePrepare).not.toHaveBeenCalled();
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(operation.next()).toEqual({ done: true, value: true });
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
    [f.view('left'), f.view('right')],
    undefined,
    undefined,
    () => current,
  );
  try {
    expect(operation.next().done).toBe(false);
    current = false;
    const stopped = mode === 'return' ? operation.return(false) : operation.next();
    expect(stopped).toEqual({ done: true, value: false });
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
    expect(f.captureComplete).toHaveBeenCalledExactlyOnceWith(false, undefined);
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
  const operation = prepareFrameSubmission([f.view('left'), f.view('right')]);
  try {
    operation.next();
    expect(() => operation.throw(new Error('checkpoint failure'))).toThrow(
      'Renderer view finalization failed',
    );
    expect(f.destroyed).toHaveBeenCalledTimes(2);
    for (const identity of ['a', 'b'])
      expect(f.events.filter((event) => event === `abort:${identity}`)).toHaveLength(1);
    expect(f.sceneComplete).toHaveBeenCalledOnce();
    expect(f.captureComplete).toHaveBeenCalledOnce();
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
    expect(submitFrameRecordings([f.view('left'), f.view('right')])).toBe(true);
    expect(f.capturePrepare).toHaveBeenCalledOnce();
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
    expect(submitFrameRecordings([f.view('left', 1)])).toBe(true);
    await f.device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    retirement.mockClear();
    const original = f.created.mock.results.map((result) => result.value.unwrap());
    completion.mockReturnValue(oldCompletion);
    f.setBufferSize(32);
    const oldEncoder = f.device.createCommandEncoder().unwrap();
    expect(submitFrameRecordings([f.view('left', 2, oldEncoder)])).toBe(true);
    const retained = f.created.mock.results.slice(2).map((result) => result.value.unwrap());
    expect(retained).toHaveLength(2);
    expect(retirement).not.toHaveBeenCalled();
    expect(f.destroyed).not.toHaveBeenCalled();
    f.events.length = 0;
    const nextEncoder = f.device.createCommandEncoder().unwrap();
    current = prepareFrameSubmission([f.view('left', 3, nextEncoder)]);
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
