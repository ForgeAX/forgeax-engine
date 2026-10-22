import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  type RenderError,
  type RendererEvent,
  RendererOperationError,
  type RenderFrameInput,
} from '@forgeax/engine-render';
import { tapeArtifact } from '@forgeax/engine-rhi-debug';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RenderWorkerInput } from '../execution/render-worker-protocol';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  draw: vi.fn(),
  scheduled: vi.fn(),
  observe: vi.fn(),
  geometry: vi.fn(),
  bounds: vi.fn(),
  dispose: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  configure: vi.fn(),
  inspect: vi.fn(),
  setProfile: vi.fn(),
  installFeature: vi.fn(),
  uninstallFeature: vi.fn(),
  prepareMesh: vi.fn(),
  attachment: undefined as unknown,
  onFrameBoundary: undefined as (() => void) | undefined,
  state: vi.fn(),
  turn: vi.fn(),
  listener: undefined as ((event: RendererEvent) => void) | undefined,
}));
vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: (...args: unknown[]) => {
    mocks.construct(...args);
    mocks.onFrameBoundary = (
      args[1] as { readonly rhiInstrumentation?: { readonly onFrameBoundary?: () => void } }
    ).rhiInstrumentation?.onFrameBoundary;
    return Promise.resolve({
      ok: true,
      value: {
        featureHost: {
          installRenderFeature: mocks.installFeature,
          uninstallRenderFeature: mocks.uninstallFeature,
        },
        renderer: {
          draw: mocks.draw,
          drawScheduled: mocks.scheduled,
          observe: mocks.observe,
          observeGeometry: mocks.geometry,
          bounds: mocks.bounds,
          dispose: mocks.dispose,
          subscribe: mocks.subscribe,
          state: mocks.state,
          inspect: mocks.inspect,
          setProfile: mocks.setProfile,
          preparePublishedMeshResidency: mocks.prepareMesh,
        },
      },
    });
  },
}));
vi.mock('../internal/worker-rhi-capture', () => ({
  attachWorkerRhiRecorder: () => mocks.attachment,
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: async () => ({ ok: true, value: { configureRenderer: mocks.configure } }),
}));
vi.mock('../execution/render-worker-task-turn', () => ({
  yieldRenderWorkerTaskTurn: () => mocks.turn(),
  createRenderWorkerTaskTurns: () => ({ yield: () => mocks.turn(), dispose: () => undefined }),
}));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.listener = undefined;
  mocks.attachment = undefined;
  mocks.onFrameBoundary = undefined;
  mocks.subscribe.mockImplementation((listener: (event: RendererEvent) => void) => {
    mocks.listener = listener;
    return mocks.unsubscribe;
  });
  mocks.configure.mockResolvedValue(undefined);
  mocks.installFeature.mockResolvedValue({ ok: true, value: undefined });
  mocks.uninstallFeature.mockResolvedValue({ ok: true, value: undefined });
  mocks.state.mockReturnValue('alive');
  mocks.turn.mockReset().mockResolvedValue(undefined);
  mocks.scheduled.mockReset().mockImplementation(async (input, schedule) => {
    await schedule.checkpoint();
    if (schedule.signal?.aborted || schedule.isCurrent?.() === false)
      return { ok: false, error: rendererLossError() };
    return mocks.draw(input);
  });
  mocks.inspect.mockReturnValue({
    state: 'alive',
    frame: { frameId: 0, deviceGeneration: 7 },
    capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
    limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
  });
});

async function start(
  options: {
    readonly rhiCapture?: boolean;
    readonly gpuPassTiming?: object;
    readonly shadowWorkload?: boolean;
    readonly featureReadOnlyDepthBatchDiagnostic?: boolean;
    readonly gbufferBatchOrderDiagnostic?: {
      readonly order: 'near' | 'far';
      readonly programDigests: readonly string[];
    };
    readonly geometryLane?: RenderFrameInput['geometryLane'];
    readonly dynamicGeometryMeshBudgetBytes?: number;
    readonly renderTaskYield?: 'none' | 'completion' | 'features';
    readonly renderPipelineCapacity?: 2 | 3 | 4;
  } = {},
  ready = true,
) {
  const post = vi.fn();
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal('close', vi.fn());
  vi.stubGlobal('onmessage', undefined);
  await import('../execution/render-worker-runtime');
  const receive = globalThis.onmessage as unknown as (event: { data: unknown }) => void;
  receive({
    data: {
      kind: 'init',
      canvas: {} as OffscreenCanvas,
      bootstrapUrl: 'test://bootstrap',
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
      ...options,
    } satisfies Extract<RenderWorkerInput, { kind: 'init' }>,
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ready ? 'ready' : 'failed' }),
    ),
  );
  return { post, receive };
}

function drawMessage(revision: number, close = vi.fn(), source: 'video' | 'canvas' = 'video') {
  return {
    kind: 'draw',
    frameId: revision,
    sourceFixedStep: revision + 10,
    worldIdentity: 'test-world',
    width: 32,
    height: 32,
    publication: {
      source: 'test',
      epoch: 1,
      revision,
      features: [],
      templates: [],
      materials: [],
      videoFrames: source === 'video' ? [{ frame: { close } }] : [],
      canvasFrames:
        source === 'canvas'
          ? [
              { id: 1, version: revision, disposed: false, frame: { close } },
              { id: 2, version: revision, disposed: true },
            ]
          : [],
      upserts: new Float32Array(0),
      removed: new Uint32Array(0),
      transformEntities: new Uint32Array(0),
      transforms: new Float32Array(0),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workerCaptureRecorder() {
  let generation = 0;
  let phase: 'idle' | 'armed' | 'recording' = 'idle';
  let resolveCapture!: (result: { readonly ok: true; readonly value: unknown }) => void;
  let captureResolved = false;
  const bytes = new Uint8Array([7, 8, 9]);
  const encoded = tapeArtifact([bytes]);
  const attachment = {
    backend: { rhi: {} },
    get captureGeneration() {
      return generation;
    },
    isRecordingCapture(expected: number) {
      return phase === 'recording' && expected === generation;
    },
    readPipelineReference: () => undefined,
    captureFrame: vi.fn(() => {
      generation += 1;
      phase = 'armed';
      return new Promise((resolve) => {
        resolveCapture = resolve as typeof resolveCapture;
      });
    }),
    frameBoundary: vi.fn(async () => {
      if (phase === 'armed') {
        phase = 'recording';
      } else if (phase === 'recording') {
        phase = 'idle';
        captureResolved = true;
        resolveCapture({ ok: true, value: encoded });
      }
      return { ok: true as const, value: undefined };
    }),
    deviceLost: vi.fn(),
    dispose: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  mocks.attachment = attachment;
  return {
    attachment,
    bytes,
    get captureResolved() {
      return captureResolved;
    },
  };
}

function timingFor(frameId: number) {
  return {
    status: 'complete' as const,
    frame: {
      schemaVersion: '1.0' as const,
      frameId,
      deviceGeneration: 7,
      graphGeneration: 3,
      backendKind: 'webgpu' as const,
      timestampPeriodNanoseconds: 1,
      passCapacity: 16,
      executedPassCount: 1,
      measuredPassCount: 1,
      droppedPassCount: 0,
      passes: [],
      measuredPassNanoseconds: 0,
    },
  };
}

it('binds a Worker RHI capture only to its recording draw receipt and that receipt timing', async () => {
  const { attachment, bytes } = workerCaptureRecorder();
  const receipts: { readonly frameId: number }[] = [];
  mocks.draw.mockImplementation(() => {
    const receipt = {
      frameId: 40 + receipts.length,
      deviceGeneration: 7,
      graphGeneration: 3,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true as const, value: undefined }),
    };
    receipts.push(receipt);
    mocks.onFrameBoundary?.();
    return { ok: true, value: receipt };
  });
  mocks.observe.mockImplementation(async (receipt: { readonly frameId: number }) => ({
    ok: true as const,
    value: { timings: timingFor(receipt.frameId) },
  }));
  const { post, receive } = await start({ rhiCapture: true, gpuPassTiming: {} });

  receive({ data: { kind: 'capture', requestId: 91, options: {} } });
  expect(attachment.captureFrame).toHaveBeenCalledOnce();
  receive({ data: drawMessage(1) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', revision: 1 }),
      expect.any(Array),
    ),
  );
  expect(post.mock.calls.some(([message]) => message.kind === 'capture-result')).toBe(false);

  receive({ data: drawMessage(2) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture-result',
        requestId: 91,
        result: expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            kind: 'rhi-tape',
            bytes,
            submittedFrame: {
              status: 'remote-complete',
              captureGeneration: 1,
              receipt: { frameId: 41, deviceGeneration: 7, graphGeneration: 3 },
              gpuPassTiming: timingFor(41),
            },
          }),
        }),
      }),
      [bytes.buffer],
    ),
  );
  expect(mocks.observe.mock.calls[1]?.[0]).toBe(receipts[1]);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('waits for the captured receipt when a later draw completes first', async () => {
  const recorder = workerCaptureRecorder();
  const { bytes } = recorder;
  const capturedCompletion = deferred<{ readonly ok: true; readonly value: undefined }>();
  const laterCompletion = deferred<{ readonly ok: true; readonly value: undefined }>();
  const capturedTiming = deferred<{
    readonly ok: true;
    readonly value: { readonly timings: ReturnType<typeof timingFor> };
  }>();
  const receipts: { readonly frameId: number }[] = [];
  mocks.draw.mockImplementation(() => {
    const drawIndex = receipts.length;
    const receipt = {
      frameId: 100 + drawIndex,
      deviceGeneration: 7,
      graphGeneration: 3,
      presentation: 'ready',
      completed:
        drawIndex === 1
          ? capturedCompletion.promise
          : drawIndex === 2
            ? laterCompletion.promise
            : Promise.resolve({ ok: true as const, value: undefined }),
    };
    receipts.push(receipt);
    mocks.onFrameBoundary?.();
    return { ok: true, value: receipt };
  });
  mocks.observe.mockImplementation((receipt: { readonly frameId: number }) =>
    receipt.frameId === 101
      ? capturedTiming.promise
      : Promise.resolve({ ok: true as const, value: { timings: timingFor(receipt.frameId) } }),
  );
  const { post, receive } = await start({ rhiCapture: true, gpuPassTiming: {} });

  receive({ data: { kind: 'capture', requestId: 94, options: {} } });
  receive({ data: drawMessage(1) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', revision: 1 }),
      expect.any(Array),
    ),
  );
  receive({ data: drawMessage(2) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'submitted', revision: 2 })),
  );
  expect(recorder.captureResolved).toBe(true);
  receive({ data: drawMessage(3) });
  await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalledTimes(3));
  laterCompletion.resolve({ ok: true, value: undefined });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(post.mock.calls.some(([message]) => message.kind === 'capture-result')).toBe(false);

  capturedCompletion.resolve({ ok: true, value: undefined });
  capturedTiming.resolve({ ok: true, value: { timings: timingFor(101) } });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture-result',
        requestId: 94,
        result: expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            kind: 'rhi-tape',
            bytes,
            submittedFrame: {
              status: 'remote-complete',
              captureGeneration: 1,
              receipt: { frameId: 101, deviceGeneration: 7, graphGeneration: 3 },
              gpuPassTiming: timingFor(101),
            },
          }),
        }),
      }),
      [bytes.buffer],
    ),
  );
  expect(mocks.observe.mock.calls[1]?.[0]).toBe(receipts[1]);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('keeps a capture unavailable when cancelled after tape resolution and before receipt completion', async () => {
  const recorder = workerCaptureRecorder();
  const capturedCompletion = deferred<{ readonly ok: true; readonly value: undefined }>();
  const capturedTiming = deferred<{
    readonly ok: true;
    readonly value: { readonly timings: ReturnType<typeof timingFor> };
  }>();
  let drawIndex = 0;
  mocks.draw.mockImplementation(() => {
    const frameId = 120 + drawIndex++;
    const receipt = {
      frameId,
      deviceGeneration: 7,
      graphGeneration: 3,
      presentation: 'ready',
      completed:
        frameId === 121
          ? capturedCompletion.promise
          : Promise.resolve({ ok: true as const, value: undefined }),
    };
    mocks.onFrameBoundary?.();
    return { ok: true, value: receipt };
  });
  mocks.observe.mockImplementation((receipt: { readonly frameId: number }) =>
    receipt.frameId === 121
      ? capturedTiming.promise
      : Promise.resolve({ ok: true as const, value: { timings: timingFor(receipt.frameId) } }),
  );
  const { post, receive } = await start({ rhiCapture: true, gpuPassTiming: {} });

  receive({ data: { kind: 'capture', requestId: 95, options: {} } });
  receive({ data: drawMessage(1) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', revision: 1 }),
      expect.any(Array),
    ),
  );
  receive({ data: drawMessage(2) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'submitted', revision: 2 })),
  );
  expect(recorder.captureResolved).toBe(true);
  receive({ data: { kind: 'capture-cancel', requestId: 95 } });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture-result',
        requestId: 95,
        result: expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            submittedFrame: { status: 'unavailable', reason: 'capture-invalidated' },
          }),
        }),
      }),
      expect.any(Array),
    ),
  );

  capturedCompletion.resolve({ ok: true, value: undefined });
  capturedTiming.resolve({ ok: true, value: { timings: timingFor(121) } });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(
    post.mock.calls.filter(
      ([message]) => message.kind === 'capture-result' && message.requestId === 95,
    ),
  ).toHaveLength(1);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('reports a failed captured receipt completion as submit-failed', async () => {
  workerCaptureRecorder();
  const submitError = new RendererOperationError('device-operation-failed', {
    operation: 'complete-frame',
    cause: {
      code: 'device-lost',
      expected: 'live receipt generation',
      hint: 'discard the receipt',
    },
  });
  let drawIndex = 0;
  mocks.draw.mockImplementation(() => {
    const frameId = 140 + drawIndex++;
    const receipt = {
      frameId,
      deviceGeneration: 7,
      graphGeneration: 3,
      presentation: 'ready',
      completed: Promise.resolve(
        frameId === 141
          ? { ok: false as const, error: submitError }
          : { ok: true as const, value: undefined },
      ),
    };
    mocks.onFrameBoundary?.();
    return { ok: true, value: receipt };
  });
  mocks.observe.mockImplementation(async (receipt: { readonly frameId: number }) => ({
    ok: true as const,
    value: { timings: timingFor(receipt.frameId) },
  }));
  const { post, receive } = await start({ rhiCapture: true, gpuPassTiming: {} });

  receive({ data: { kind: 'capture', requestId: 96, options: {} } });
  receive({ data: drawMessage(1) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', revision: 1 }),
      expect.any(Array),
    ),
  );
  receive({ data: drawMessage(2) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture-result',
        requestId: 96,
        result: expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            submittedFrame: { status: 'unavailable', reason: 'submit-failed' },
          }),
        }),
      }),
      expect.any(Array),
    ),
  );
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it.each([
  {
    label: 'failed timing with an older latest-known-good value',
    observation: {
      status: 'failed',
      error: {
        code: 'gpu-pass-timing-read-failed',
        expected: 'the captured receipt timing query resolves',
        hint: 'retain the failure reason',
      },
      latestKnownGood: { frameId: 2, deviceGeneration: 7, graphGeneration: 3 },
    },
    forwarded: {
      status: 'failed',
      error: {
        code: 'gpu-pass-timing-read-failed',
        expected: 'the captured receipt timing query resolves',
        hint: 'retain the failure reason',
      },
    },
  },
  {
    label: 'unavailable timing with its original reason and capability',
    observation: {
      status: 'unavailable',
      reason: {
        code: 'timestamp-query-unavailable',
        expected: 'timestamp queries are supported',
        hint: 'report the unavailable capability',
      },
      capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
    },
    forwarded: {
      status: 'unavailable',
      reason: {
        code: 'timestamp-query-unavailable',
        expected: 'timestamp queries are supported',
        hint: 'report the unavailable capability',
      },
      capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
    },
  },
] as const)('preserves $label without stale timing facts', async ({ observation, forwarded }) => {
  workerCaptureRecorder();
  let drawIndex = 0;
  mocks.draw.mockImplementation(() => {
    const receipt = {
      frameId: 70 + drawIndex++,
      deviceGeneration: 7,
      graphGeneration: 3,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true as const, value: undefined }),
    };
    mocks.onFrameBoundary?.();
    return { ok: true, value: receipt };
  });
  mocks.observe.mockResolvedValue({ ok: true, value: { timings: observation } });
  const { post, receive } = await start({ rhiCapture: true, gpuPassTiming: {} });

  receive({ data: { kind: 'capture', requestId: 92, options: {} } });
  receive({ data: drawMessage(1) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', revision: 1 }),
      expect.any(Array),
    ),
  );
  receive({ data: drawMessage(2) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture-result',
        requestId: 92,
        result: expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            submittedFrame: expect.objectContaining({
              status: 'remote-complete',
              gpuPassTiming: forwarded,
            }),
          }),
        }),
      }),
      expect.any(Array),
    ),
  );
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('does not substitute an older timing observation when receipt observe returns an error', async () => {
  workerCaptureRecorder();
  let drawIndex = 0;
  mocks.draw.mockImplementation(() => {
    const receipt = {
      frameId: 80 + drawIndex++,
      deviceGeneration: 7,
      graphGeneration: 3,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true as const, value: undefined }),
    };
    mocks.onFrameBoundary?.();
    return { ok: true, value: receipt };
  });
  mocks.observe.mockResolvedValue({
    ok: false,
    error: {
      code: 'frame-receipt-stale',
      expected: 'the same live receipt generation',
      hint: 'do not substitute another frame timing',
    },
  });
  const { post, receive } = await start({ rhiCapture: true, gpuPassTiming: {} });

  receive({ data: { kind: 'capture', requestId: 93, options: {} } });
  receive({ data: drawMessage(1) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', revision: 1 }),
      expect.any(Array),
    ),
  );
  receive({ data: drawMessage(2) });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture-result',
        requestId: 93,
        result: expect.objectContaining({
          ok: true,
          value: expect.objectContaining({
            submittedFrame: expect.objectContaining({ status: 'remote-complete' }),
          }),
        }),
      }),
      expect.any(Array),
    ),
  );
  const response = post.mock.calls.find(
    ([message]) => message.kind === 'capture-result' && message.requestId === 93,
  )?.[0];
  expect(response?.result.ok && response.result.value.submittedFrame).not.toHaveProperty(
    'gpuPassTiming',
  );
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('forwards the pending cause captured on the completed receipt, without inspecting a later frame', async () => {
  const completion = deferred<{ ok: true; value: undefined }>();
  const reason = {
    code: 'feature-preparation',
    featureIdentity: 'forgeax.vfx-render.gpu-particles',
    preparationStage: 'graphics-pipeline',
    pass: 'particle-draw',
    shader: 'actual-material-guid',
    resource: 'view::variant-program',
    operation: 'resolve',
    reason: 'pipeline-pending',
  } as const;
  mocks.draw
    .mockReturnValueOnce({
      ok: true,
      value: {
        deviceGeneration: 7,
        graphGeneration: 111,
        presentation: 'pending',
        presentationPendingReason: reason,
        completed: completion.promise,
      },
    })
    .mockReturnValueOnce({
      ok: true,
      value: {
        deviceGeneration: 7,
        graphGeneration: 112,
        presentation: 'ready',
        presentationPendingReason: { code: 'sky-cubemap' },
        completed: Promise.resolve({ ok: true, value: undefined }),
      },
    });
  const { post, receive } = await start();
  try {
    receive({ data: drawMessage(1) });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([m]) => m.kind === 'submitted')).toHaveLength(1),
    );
    receive({ data: drawMessage(2) });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([m]) => m.kind === 'submitted')).toHaveLength(2),
    );
    completion.resolve({ ok: true, value: undefined });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([m]) => m.kind === 'completed')).toHaveLength(2),
    );
    const completed = post.mock.calls.filter(([m]) => m.kind === 'completed');
    expect(completed[0]?.[0]).toMatchObject({
      frame: {
        frameId: 1,
        graphGeneration: 111,
        presentation: 'pending',
        presentationPendingReason: reason,
      },
    });
    expect(completed[1]?.[0].frame).not.toHaveProperty('presentationPendingReason');
    expect(structuredClone(completed[0]?.[0]).frame.presentationPendingReason).toEqual(reason);
  } finally {
    completion.resolve({ ok: true, value: undefined });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  'completion',
  'features',
] as const)('retires a real predecessor during one controlled %s task turn before drawing its successor', async (mode) => {
  const first = deferred<{ ok: true; value: undefined }>();
  const second = deferred<{ ok: true; value: undefined }>();
  const turn = deferred<void>();
  const events: string[] = [];
  mocks.turn.mockReturnValue(turn.promise);
  mocks.draw
    .mockImplementationOnce(() => {
      events.push('draw:1');
      return { ok: true, value: { deviceGeneration: 7, completed: first.promise } };
    })
    .mockImplementationOnce(() => {
      events.push('draw:2');
      return { ok: true, value: { deviceGeneration: 7, completed: second.promise } };
    });
  mocks.scheduled.mockImplementation(async (input, schedule) => {
    await schedule.checkpoint();
    return mocks.draw(input);
  });
  const { post, receive } = await start({ renderTaskYield: mode });
  post.mockImplementation((message) => {
    if (message.kind === 'submitted' || message.kind === 'completed')
      events.push(`${message.kind}:${message.revision}`);
  });
  try {
    receive({ data: drawMessage(1) });
    await vi.waitFor(() => expect(events).toEqual(['draw:1', 'submitted:1']));
    expect(mocks.turn).not.toHaveBeenCalled();
    receive({ data: drawMessage(2) });
    await vi.waitFor(() => expect(mocks.turn).toHaveBeenCalledOnce());
    expect(events).toEqual(['draw:1', 'submitted:1']);
    expect(mocks.draw).toHaveBeenCalledOnce();
    first.resolve({ ok: true, value: undefined });
    await vi.waitFor(() => expect(events).toEqual(['draw:1', 'submitted:1', 'completed:1']));
    expect(mocks.draw).toHaveBeenCalledOnce();
    turn.resolve(undefined);
    await vi.waitFor(() =>
      expect(events).toEqual(['draw:1', 'submitted:1', 'completed:1', 'draw:2', 'submitted:2']),
    );
    second.resolve({ ok: true, value: undefined });
    await vi.waitFor(() => expect(events.at(-1)).toBe('completed:2'));
    expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
    expect(mocks.turn).toHaveBeenCalledOnce();
  } finally {
    turn.resolve(undefined);
    first.resolve({ ok: true, value: undefined });
    second.resolve({ ok: true, value: undefined });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  'completion',
  'features',
] as const)('discards yielded and queued publications exactly once when %s disposal starts', async (mode) => {
  const first = deferred<{ ok: true; value: undefined }>();
  const turn = deferred<void>();
  const closes = [vi.fn(), vi.fn(), vi.fn()];
  mocks.turn.mockReturnValue(turn.promise);
  mocks.draw.mockReturnValue({
    ok: true,
    value: { deviceGeneration: 7, completed: first.promise },
  });
  const { post, receive } = await start({ renderTaskYield: mode });
  try {
    receive({ data: drawMessage(1, closes[0]) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2, closes[1], 'canvas') });
    await vi.waitFor(() => expect(mocks.turn).toHaveBeenCalledOnce());
    expect(post.mock.calls.filter(([message]) => message.kind === 'submitted')).toHaveLength(1);
    first.resolve({ ok: true, value: undefined });
    await vi.waitFor(() => expect(closes[0]).toHaveBeenCalledOnce());
    // Only the actual completed receipt frees the credit for this queued frame.
    receive({ data: drawMessage(3, closes[2]) });
    receive({ data: { kind: 'dispose' } });
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(closes[1]).not.toHaveBeenCalled();
    expect(closes[2]).not.toHaveBeenCalled();
    turn.resolve(undefined);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
    expect(mocks.draw).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'submitted')
        .map(([message]) => message.revision),
    ).toEqual([1]);
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'completed')
        .map(([message]) => message.revision),
    ).toEqual([1]);
    expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  } finally {
    turn.resolve(undefined);
    first.resolve({ ok: true, value: undefined });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  'completion',
  'features',
] as const)('latches receipt failure during a %s task turn without drawing or acknowledging the waiting frame', async (mode) => {
  const first = deferred<{ ok: false; error: RenderError }>();
  const turn = deferred<void>();
  const closes = [vi.fn(), vi.fn(), vi.fn()];
  const error = rendererLossError('complete-frame');
  mocks.turn.mockReturnValue(turn.promise);
  mocks.draw.mockReturnValue({
    ok: true,
    value: { deviceGeneration: 7, completed: first.promise },
  });
  const { post, receive } = await start({ renderTaskYield: mode });
  try {
    receive({ data: drawMessage(1, closes[0]) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2, closes[1], 'canvas') });
    await vi.waitFor(() => expect(mocks.turn).toHaveBeenCalledOnce());
    first.resolve({ ok: false, error });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'failed',
          recoverable: true,
          publication: expect.objectContaining({ revision: 1 }),
        }),
      ),
    );
    mocks.state.mockReturnValue('device-lost');
    mocks.listener?.({ kind: 'error', error: rendererLossError() });
    mocks.listener?.({ kind: 'error', error: rendererLossError() });
    receive({ data: drawMessage(3, closes[2]) });
    turn.resolve(undefined);
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
    expect(mocks.draw).toHaveBeenCalledOnce();
    expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(1);
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'submitted')
        .map(([message]) => message.revision),
    ).toEqual([1]);
    expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  } finally {
    turn.resolve(undefined);
    first.resolve({ ok: false, error });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it("keeps mesh preparation behind the yielded frame's existing serial draw drain", async () => {
  const first = deferred<{ ok: true; value: undefined }>();
  const second = deferred<{ ok: true; value: undefined }>();
  const turn = deferred<void>();
  mocks.turn.mockReturnValue(turn.promise);
  mocks.draw
    .mockImplementationOnce(() => ({
      ok: true,
      value: { deviceGeneration: 7, completed: first.promise },
    }))
    .mockImplementationOnce(() => ({
      ok: true,
      value: { deviceGeneration: 7, completed: second.promise },
    }));
  mocks.prepareMesh.mockResolvedValue({
    ok: true,
    value: {
      deviceGeneration: 7,
      isCurrent: () => true,
      recordStageLane: () => ({ ok: true, value: undefined }),
      release: () => Promise.resolve(),
    },
  });
  const { post, receive } = await start({ renderTaskYield: 'features' });
  try {
    receive({ data: drawMessage(1) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2) });
    await vi.waitFor(() => expect(mocks.turn).toHaveBeenCalledOnce());
    receive({
      data: {
        kind: 'mesh-prepare',
        requestId: 1,
        entity: 42,
        input: {
          source: 'test',
          epoch: 1,
          meshHandle: 1,
          mesh: createBoxGeometry(1, 1, 1).unwrap(),
        },
      },
    });
    await Promise.resolve();
    expect(mocks.prepareMesh).not.toHaveBeenCalled();
    first.resolve({ ok: true, value: undefined });
    turn.resolve(undefined);
    await vi.waitFor(() => expect(mocks.prepareMesh).toHaveBeenCalledOnce());
    expect(mocks.draw).toHaveBeenCalledTimes(2);
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'submitted')
        .map(([message]) => message.revision),
    ).toEqual([1, 2]);
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'completed')
        .map(([message]) => message.revision),
    ).toEqual([1]);
  } finally {
    first.resolve({ ok: true, value: undefined });
    second.resolve({ ok: true, value: undefined });
    turn.resolve(undefined);
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  undefined,
  'automatic',
  'direct',
] as const)('retains the initialized geometry lane across published frames: %s', async (geometryLane) => {
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      deviceGeneration: 7,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  });
  const { post, receive } = await start(geometryLane === undefined ? {} : { geometryLane });
  try {
    for (const revision of [1, 2]) {
      const message = drawMessage(revision);
      receive({ data: message });
      await vi.waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'completed', revision }),
          expect.any(Array),
        ),
      );
      const request = mocks.draw.mock.calls.at(-1)?.[0];
      expect(request.publication).toBe(message.publication);
      if (geometryLane === undefined) expect(request).not.toHaveProperty('geometryLane');
      else expect(request).toHaveProperty('geometryLane', geometryLane);
    }
    expect(mocks.turn).not.toHaveBeenCalled();
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('freezes mesh consumption on each real draw and delivers it only after ordered GPU completion', async () => {
  const completions: (() => void)[] = [];
  let drawn = 0;
  const lane = vi.fn((receipt: { frameId: number }, entity: number) => {
    expect(entity).toBe(42);
    expect(receipt.frameId).toBe(100 + drawn);
    return { ok: true, value: drawn === 1 ? 'cpu' : 'gpu' };
  });
  mocks.prepareMesh.mockResolvedValue({
    ok: true,
    value: {
      deviceGeneration: 7,
      isCurrent: () => true,
      recordStageLane: lane,
      release: vi.fn(() => Promise.resolve()),
    },
  });
  mocks.draw.mockImplementation(() => ({
    ok: true,
    value: {
      frameId: 100 + ++drawn,
      deviceGeneration: 7,
      presentation: 'ready',
      completed: new Promise((resolve) =>
        completions.push(() => resolve({ ok: true, value: undefined })),
      ),
    },
  }));
  const { post, receive } = await start();
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'ready', deviceGeneration: 7 }),
  );
  receive({
    data: {
      kind: 'mesh-prepare',
      requestId: 1,
      entity: 42,
      input: { source: 'test', epoch: 1, meshHandle: 1, mesh: createBoxGeometry(1, 1, 1).unwrap() },
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mesh-ready' })),
  );
  try {
    receive({ data: drawMessage(1) });
    receive({ data: drawMessage(2) });
    await vi.waitFor(() => expect(lane).toHaveBeenCalledTimes(2));
    completions[1]?.();
    await Promise.resolve();
    expect(post.mock.calls.filter(([message]) => message.kind === 'completed')).toEqual([]);
    completions[0]?.();
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([message]) => message.kind === 'completed')).toHaveLength(2),
    );
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'completed')
        .map(([message]) => ({
          hostFrameId: message.frame.frameId,
          proof: message.meshConsumption,
        })),
    ).toEqual([
      {
        hostFrameId: 1,
        proof: {
          frameId: 101,
          deviceGeneration: 7,
          sourceFixedStep: 11,
          bindings: new Float64Array([1, 0]),
        },
      },
      {
        hostFrameId: 2,
        proof: {
          frameId: 102,
          deviceGeneration: 7,
          sourceFixedStep: 12,
          bindings: new Float64Array([1, 1]),
        },
      },
    ]);
    for (const [message, transfer] of post.mock.calls) {
      if (message.kind !== 'completed') continue;
      const evidence = message.meshConsumption.bindings as Float64Array;
      expect(transfer).toContain(evidence.buffer);
      expect(message.buffers).not.toContain(evidence.buffer);
      const expected = Array.from(evidence);
      const received = structuredClone(message, { transfer });
      expect(evidence.byteLength).toBe(0);
      expect(Array.from(received.meshConsumption.bindings)).toEqual(expected);
    }
  } finally {
    for (const complete of completions) complete();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('still disposes the Renderer when a mesh release fence rejects', async () => {
  mocks.prepareMesh.mockResolvedValue({
    ok: true,
    value: {
      deviceGeneration: 7,
      release: () => Promise.reject(new Error('release fence failed')),
    },
  });
  const { post, receive } = await start();
  receive({
    data: {
      kind: 'mesh-prepare',
      requestId: 1,
      input: { source: 'test', epoch: 1, meshHandle: 1, mesh: createBoxGeometry(1, 1, 1).unwrap() },
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mesh-ready' })),
  );
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'disposed', error: expect.anything() }),
    ),
  );
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('reports a failed successor immediately even when its timing observation and predecessor wait', async () => {
  let completeFirst!: () => void;
  let finishTiming!: () => void;
  const completed = new Promise((resolve) => {
    completeFirst = () => resolve({ ok: true, value: undefined });
  });
  const error = new RendererOperationError('device-operation-failed', {
    operation: 'complete-frame',
    cause: { code: 'device-lost', expected: 'live device', hint: 'replace the device' },
  });
  mocks.draw
    .mockReturnValueOnce({ ok: true, value: { deviceGeneration: 1, completed } })
    .mockReturnValueOnce({
      ok: true,
      value: { deviceGeneration: 1, completed: Promise.resolve({ ok: false, error }) },
    });
  mocks.observe.mockResolvedValueOnce({ ok: true, value: {} }).mockReturnValueOnce(
    new Promise((resolve) => {
      finishTiming = () => resolve({ ok: true, value: {} });
    }),
  );
  const { post, receive } = await start({ gpuPassTiming: {} });
  try {
    receive({ data: drawMessage(1) });
    receive({ data: drawMessage(2) });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'failed',
          recoverable: true,
          publication: expect.objectContaining({ revision: 2 }),
        }),
      ),
    );
    receive({ data: { kind: 'dispose' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
  } finally {
    finishTiming();
    completeFirst();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(1);
  expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
});

it.each([
  'video',
  'canvas',
] as const)('retires %s frames on admission failure and shutdown', async (source) => {
  let complete!: () => void;
  const completed = new Promise((resolve) => {
    complete = () => resolve({ ok: true, value: undefined });
  });
  mocks.draw.mockReturnValue({ ok: true, value: { deviceGeneration: 1, completed } });
  const { post, receive } = await start();
  const closes = [vi.fn(), vi.fn(), vi.fn()];
  try {
    receive({ data: drawMessage(1, closes[0], source) });
    receive({ data: drawMessage(2, closes[1], source) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(2));
    receive({ data: drawMessage(3, closes[2], source) });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        publication: expect.objectContaining({ revision: 3 }),
      }),
    );
    expect(mocks.draw).toHaveBeenCalledTimes(2);
    expect(closes[0]).not.toHaveBeenCalled();
    expect(closes[1]).not.toHaveBeenCalled();
    expect(closes[2]).toHaveBeenCalledTimes(1);
  } finally {
    complete();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
});

it.each([
  'video',
  'canvas',
] as const)('retires %s publications in order while submitting ahead', async (source) => {
  const releases: (() => void)[] = [];
  const closes = [vi.fn(), vi.fn()];
  mocks.draw.mockImplementation(() => ({
    ok: true,
    value: {
      deviceGeneration: 1,
      completed: new Promise((resolve) => {
        releases.push(() => resolve({ ok: true, value: undefined }));
      }),
    },
  }));
  const { post, receive } = await start();
  const completedRevisions = () =>
    post.mock.calls
      .filter(([message]) => message.kind === 'completed')
      .map(([message]) => message.revision);
  try {
    for (const revision of [1, 2])
      receive({ data: drawMessage(revision, closes[revision - 1], source) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(2));
    expect(completedRevisions()).toEqual([]);
    releases[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completedRevisions()).toEqual([]);
    for (const close of closes) expect(close).not.toHaveBeenCalled();
    receive({ data: { kind: 'dispose' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.dispose).not.toHaveBeenCalled();
    releases[0]?.();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
    expect(completedRevisions()).toEqual([1, 2]);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  } finally {
    for (const release of releases) release();
    // The baseline only creates the second receipt after releasing the first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases) release();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('constructs timing in the Render Worker and returns the receipt-bound observation', async () => {
  const timing = {
    status: 'complete',
    frame: {
      schemaVersion: '1.0',
      frameId: 1,
      deviceGeneration: 1,
      graphGeneration: 1,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 1,
      passCapacity: 4,
      executedPassCount: 1,
      measuredPassCount: 1,
      droppedPassCount: 0,
      passes: [],
      measuredPassNanoseconds: 10,
    },
  } as const;
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      deviceGeneration: 1,
      graphGeneration: 1,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  });
  mocks.observe.mockResolvedValue({ ok: true, value: { timings: timing } });
  const dynamicGeometryMeshBudgetBytes = 512 * 1024 * 1024;
  const { post, receive } = await start({
    gpuPassTiming: { retentionFrames: 4 },
    dynamicGeometryMeshBudgetBytes,
  });
  expect(mocks.construct.mock.calls[0]?.[1]).toMatchObject({
    gpuPassTiming: { retentionFrames: 4 },
    dynamicGeometryMeshBudgetBytes,
  });
  receive({
    data: {
      kind: 'draw',
      frameId: 1,
      worldIdentity: 'test-world',
      width: 32,
      height: 32,
      publication: {
        source: 'test',
        epoch: 1,
        revision: 1,
        features: [],
        templates: [],
        materials: [],
        videoFrames: [],
        upserts: new Float32Array(0),
        removed: new Uint32Array(0),
        transformEntities: new Uint32Array(0),
        transforms: new Float32Array(0),
      },
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completed', gpuPassTiming: timing }),
      expect.any(Array),
    ),
  );
  expect(mocks.observe).toHaveBeenCalledWith(expect.objectContaining({ deviceGeneration: 1 }), {
    include: ['timings'],
  });
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('reports publication overflow as deterministic protocol failure and drains owned frames', async () => {
  let complete!: () => void;
  const completed = new Promise((resolve) => {
    complete = () => resolve({ ok: true, value: undefined });
  });
  mocks.draw.mockReturnValue({ ok: true, value: { deviceGeneration: 1, completed } });
  const { post, receive } = await start();
  const closeFrames = [vi.fn(), vi.fn(), vi.fn()];
  const draw = (revision: number) => ({
    kind: 'draw',
    frameId: revision,
    worldIdentity: 'test-world',
    width: 32,
    height: 32,
    publication: {
      source: 'test',
      epoch: 1,
      revision,
      features: [],
      templates: [],
      materials: [],
      videoFrames: [{ frame: { close: closeFrames[revision - 1] } }],
      upserts: new Float32Array(0),
      removed: new Uint32Array(0),
      transformEntities: new Uint32Array(0),
      transforms: new Float32Array(0),
    },
  });
  try {
    receive({ data: draw(1) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(1));
    receive({ data: draw(2) });
    expect(() => receive({ data: draw(3) })).not.toThrow();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        stage: 'draw',
        recoverable: false,
        publication: { source: 'test', epoch: 1, revision: 3, frameId: 3 },
      }),
    );
  } finally {
    complete();
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  expect(mocks.draw).toHaveBeenCalledTimes(1);
  for (const close of closeFrames) expect(close).toHaveBeenCalledTimes(1);
});

it('preserves the actual renderer capability and limit snapshot on draw failure', async () => {
  mocks.draw.mockImplementationOnce(() => {
    throw new Error('standard-cluster-transport-unavailable');
  });
  const { post, receive } = await start();
  receive({ data: drawMessage(1) });
  try {
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'failed',
          stage: 'draw',
          publication: expect.objectContaining({ source: 'test', epoch: 1, revision: 1 }),
          renderer: {
            state: 'alive',
            frameId: 0,
            capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
            limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
          },
        }),
      ),
    );
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  'device-lost',
  'disposed',
  'stale-generation',
  'producer-invalid',
])('classifies a %s completion fence using the receipt even before health changes', async (code) => {
  const error = new RendererOperationError('device-operation-failed', {
    operation: 'complete-frame',
    cause: { code, expected: 'live receipt generation', hint: 'inspect the receipt' },
  });
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      deviceGeneration: 1,
      completed: Promise.resolve({ ok: false, error }),
    },
  });
  const { post, receive } = await start();
  receive({
    data: {
      kind: 'draw',
      frameId: 1,
      width: 32,
      height: 32,
      publication: {
        source: 'test',
        epoch: 1,
        revision: 1,
        features: [],
        templates: [],
        materials: [],
        videoFrames: [],
      },
    },
  });
  try {
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'failed',
          recoverable: code !== 'producer-invalid',
          error: expect.objectContaining({ code: 'device-operation-failed' }),
        }),
      ),
    );
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('answers bounds queries against the bound publication source without drawing', async () => {
  const bounds = { min: [1, 2, 3], max: [4, 5, 6] };
  mocks.bounds.mockReturnValue(bounds);
  const { post, receive } = await start();
  receive({ data: { kind: 'bounds', requestId: 1, entity: 7 } });
  expect(mocks.bounds).toHaveBeenCalledWith({ source: 'test', epoch: 1 }, 7);
  expect(post).toHaveBeenCalledWith({ kind: 'bounds-result', requestId: 1, bounds });
  expect(mocks.draw).not.toHaveBeenCalled();
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

function asynchronousRendererError() {
  return new RendererOperationError('device-operation-failed', {
    operation: 'renderer-event',
    cause: {
      code: 'gpu-validation-error',
      expected: 'valid GPU command',
      hint: 'inspect the original GPU error',
      detail: { label: 'asynchronous fixture' },
    },
  });
}

function rendererLossError(
  operation: 'draw' | 'complete-frame' | 'renderer-event' = 'renderer-event',
) {
  return new RendererOperationError('device-operation-failed', {
    operation,
    cause: {
      code: 'device-lost',
      expected: 'device remains alive',
      hint: 'fixture device loss',
    },
  });
}

it('routes confirmed ready-time device loss through one existing recoverable boundary', async () => {
  const { post, receive } = await start();
  const error = rendererLossError();
  mocks.state.mockReturnValue('device-lost');
  mocks.listener?.({ kind: 'error', error });
  mocks.listener?.({ kind: 'error', error });
  expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(1);
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'failed',
      recoverable: true,
      error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    }),
  );
  expect(post.mock.calls.some(([message]) => message.kind === 'renderer-error')).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it.each([
  'alive',
  'device-lost',
])('preserves genuine validation errors while renderer is %s', async (state) => {
  const { post, receive } = await start();
  const error = asynchronousRendererError();
  mocks.state.mockReturnValue(state);
  mocks.listener?.({ kind: 'error', error });
  expect(post).toHaveBeenCalledWith({
    kind: 'renderer-error',
    identity: { source: 'test', epoch: 1 },
    error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    renderer: {
      state: 'alive',
      frameId: 0,
      capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
    },
  });
  expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('does not classify a loss-shaped event from an alive renderer as a lifecycle transition', async () => {
  const { post, receive } = await start();
  const error = rendererLossError();
  mocks.listener?.({ kind: 'error', error });
  expect(post).toHaveBeenCalledWith({
    kind: 'renderer-error',
    identity: { source: 'test', epoch: 1 },
    error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    renderer: {
      state: 'alive',
      frameId: 0,
      capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
    },
  });
  expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('preserves operation failures that are not the renderer device-loss event', async () => {
  const { post, receive } = await start();
  const error = rendererLossError('draw');
  mocks.state.mockReturnValue('device-lost');
  mocks.listener?.({ kind: 'error', error });
  expect(post).toHaveBeenCalledWith({
    kind: 'renderer-error',
    identity: { source: 'test', epoch: 1 },
    error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    renderer: {
      state: 'alive',
      frameId: 0,
      capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
    },
  });
  expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('keeps pre-ready device loss on the original initialization failure boundary', async () => {
  const error = rendererLossError();
  mocks.configure.mockImplementation(() => {
    mocks.state.mockReturnValue('device-lost');
    mocks.listener?.({ kind: 'error', error });
  });
  const { post, receive } = await start({}, false);
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'failed',
      stage: 'init',
      error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    }),
  );
  expect(
    post.mock.calls.some(
      ([message]) => message.kind === 'ready' || message.kind === 'renderer-error',
    ),
  ).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('forwards a ready-time public Renderer error without consuming frame credit', async () => {
  const { post, receive } = await start();
  const error = asynchronousRendererError();
  mocks.listener?.({ kind: 'error', error });
  expect(post).toHaveBeenCalledWith({
    kind: 'renderer-error',
    identity: { source: 'test', epoch: 1 },
    error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    renderer: {
      state: 'alive',
      frameId: 0,
      capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
      limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
    },
  });
  expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
  mocks.draw.mockReturnValue({
    ok: true,
    value: { deviceGeneration: 1, completed: Promise.resolve({ ok: true, value: undefined }) },
  });
  try {
    receive({ data: drawMessage(1) });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'completed', revision: 1 }),
        expect.any(Array),
      ),
    );
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  const delivered = post.mock.calls.length;
  mocks.listener?.({ kind: 'error', error });
  expect(post).toHaveBeenCalledTimes(delivered);
});

it('retains initialization Renderer errors as failure without posting ready', async () => {
  const error = asynchronousRendererError();
  mocks.configure.mockImplementation(() => mocks.listener?.({ kind: 'error', error }));
  const { post, receive } = await start({}, false);
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'failed',
      stage: 'init',
      error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
    }),
  );
  expect(post.mock.calls.some(([message]) => message.kind === 'ready')).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});

it('retains error transport failure on the existing failure boundary', async () => {
  const { post, receive } = await start();
  const error = asynchronousRendererError();
  post.mockImplementationOnce(() => {
    throw new Error('transport fixture');
  });
  expect(() => mocks.listener?.({ kind: 'error', error })).not.toThrow();
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'failed',
      stage: 'init',
      error: expect.objectContaining({
        code: 'render-error-forwarding-failed',
        detail: expect.objectContaining({
          rendererError: expect.objectContaining({ code: error.code, detail: error.detail }),
          cause: expect.objectContaining({
            detail: expect.objectContaining({ message: 'transport fixture' }),
          }),
        }),
      }),
    }),
  );
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});

it('retains pre-ready guidance when Renderer detail serialization throws', async () => {
  const error = asynchronousRendererError();
  const readDetail = vi.fn(() => {
    throw new Error('serialization fixture');
  });
  Object.defineProperty(error, 'detail', { get: readDetail });
  mocks.configure.mockImplementation(() => {
    expect(() => mocks.listener?.({ kind: 'error', error })).not.toThrow();
  });
  const { post, receive } = await start({}, false);
  try {
    expect(readDetail).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        stage: 'init',
        recoverable: false,
        error: expect.objectContaining({
          code: 'render-error-forwarding-failed',
          detail: {
            rendererError: {
              code: error.code,
              expected: error.expected,
              hint: error.hint,
              detail: undefined,
            },
            detailSerialized: false,
            cause: expect.objectContaining({
              detail: expect.objectContaining({ message: 'serialization fixture' }),
            }),
          },
        }),
      }),
    );
    expect(post.mock.calls.some(([message]) => message.kind === 'ready')).toBe(false);
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('delivers one terminal bridge failure after the first pre-ready failed post throws', async () => {
  const error = asynchronousRendererError();
  mocks.configure.mockImplementation(() => {
    vi.mocked(globalThis.postMessage).mockImplementationOnce(() => {
      throw new Error('pre-ready transport fixture');
    });
    expect(() => mocks.listener?.({ kind: 'error', error })).not.toThrow();
  });
  const { post, receive } = await start({}, false);
  try {
    expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(2);
    expect(post.mock.results[0]?.type).toBe('throw');
    expect(post.mock.results[1]?.type).toBe('return');
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'failed',
        stage: 'init',
        recoverable: false,
        error: expect.objectContaining({
          code: 'render-error-forwarding-failed',
          detail: {
            rendererError: {
              code: error.code,
              expected: error.expected,
              hint: error.hint,
              detail: error.detail,
            },
            detailSerialized: true,
            cause: expect.objectContaining({
              detail: expect.objectContaining({ message: 'pre-ready transport fixture' }),
            }),
          },
        }),
      }),
    );
    expect(post.mock.calls.some(([message]) => message.kind === 'ready')).toBe(false);
    const deliveries = post.mock.calls.length;
    mocks.listener?.({ kind: 'error', error });
    expect(post).toHaveBeenCalledTimes(deliveries);
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('forwards public RenderError guidance when the union member has no detail field', async () => {
  const { post, receive } = await start();
  const error: RenderError = Object.assign(new Error('uninitialized atlas fixture'), {
    code: 'point-shadow-atlas-uninitialized' as const,
    expected: 'an allocated shadow atlas',
    hint: 'initialize the owning atlas',
  });
  try {
    mocks.listener?.({ kind: 'error', error });
    expect(post).toHaveBeenCalledWith({
      kind: 'renderer-error',
      identity: { source: 'test', epoch: 1 },
      error: { code: error.code, expected: error.expected, hint: error.hint, detail: undefined },
      renderer: {
        state: 'alive',
        frameId: 0,
        capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
        limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
      },
    });
    expect(post.mock.calls.some(([message]) => message.kind === 'failed')).toBe(false);
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('returns the full actual Renderer snapshot with no draw, capture or field projection', async () => {
  const { post, receive } = await start();
  const facts = {
    profile: { renderPath: 'deferred' },
    perFramePassNames: ['lighting', 'ssr-compose'],
    capabilities: { backendKind: 'webgpu' },
    frame: { frameId: 8 },
    extraOwnerFacts: { value: 19 },
  };
  mocks.inspect.mockReturnValue(facts);
  receive({
    data: {
      kind: 'inspect',
      requestId: 4,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  const result = post.mock.calls.map(([row]) => row).find((row) => row.kind === 'inspect-result');
  expect(result).toMatchObject({
    requestId: 4,
    identity: { source: 'test', epoch: 1 },
    worldIdentity: 'test-world',
    result: { ok: true, value: facts },
  });
  expect(result.result.value).not.toBe(facts);
  facts.extraOwnerFacts.value = 20;
  expect(result.result.value.extraOwnerFacts.value).toBe(19);
  expect(mocks.draw).not.toHaveBeenCalled();
});
it('rejects a wrong World/source/epoch rather than labeling a current inspection as old', async () => {
  const { post, receive } = await start();
  for (const [requestId, identity, worldIdentity] of [
    [10, { source: 'old', epoch: 1 }, 'test-world'],
    [11, { source: 'test', epoch: 2 }, 'test-world'],
    [12, { source: 'test', epoch: 1 }, 'old-world'],
  ] as const)
    receive({ data: { kind: 'inspect', requestId, identity, worldIdentity } });
  const results = post.mock.calls
    .map(([row]) => row)
    .filter((row) => row.kind === 'inspect-result');
  expect(results).toHaveLength(3);
  expect(results.every((row) => row.result.ok === false)).toBe(true);
  expect(mocks.draw).not.toHaveBeenCalled();
});
it('returns inspection and clone failures without stopping normal draw admission', async () => {
  const { post, receive } = await start();
  for (const read of [
    () => {
      throw new Error('owner-read');
    },
    () => ({ impossible: () => {} }),
  ]) {
    mocks.inspect.mockImplementation(read);
    receive({
      data: {
        kind: 'inspect',
        requestId: 20,
        identity: { source: 'test', epoch: 1 },
        worldIdentity: 'test-world',
      },
    });
  }
  expect(
    post.mock.calls
      .map(([row]) => row)
      .filter((row) => row.kind === 'inspect-result')
      .every((row) => row.result.ok === false),
  ).toBe(true);
  expect(post.mock.calls.some(([row]) => row.kind === 'failed')).toBe(false);
});
it('retains a failed first inspection delivery as one structured failure response', async () => {
  const { post, receive } = await start();
  mocks.inspect.mockReturnValue({ profile: { renderPath: 'deferred' } });
  post.mockImplementationOnce(() => {
    throw new Error('send-failed');
  });
  receive({
    data: {
      kind: 'inspect',
      requestId: 30,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'inspect-result',
      result: {
        ok: false,
        error: expect.objectContaining({
          detail: expect.objectContaining({ reason: 'transport' }),
        }),
      },
    }),
  );
  expect(post.mock.calls.some(([row]) => row.kind === 'failed')).toBe(false);
});

it('responds before initialization with an explicit failed read', async () => {
  const post = vi.fn();
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal('close', vi.fn());
  await import('../execution/render-worker-runtime');
  const receive = globalThis.onmessage as unknown as (event: { data: unknown }) => void;
  receive({
    data: {
      kind: 'inspect',
      requestId: 50,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'inspect-result',
      result: expect.objectContaining({ ok: false }),
    }),
  );
});

it('returns an explicit failed inspection after the actual ready-time device-loss boundary', async () => {
  const { post, receive } = await start();
  mocks.state.mockReturnValue('device-lost');
  mocks.listener?.({ kind: 'error', error: rendererLossError() });
  const failedBeforeRead = post.mock.calls.filter(([row]) => row.kind === 'failed').length;
  receive({
    data: {
      kind: 'inspect',
      requestId: 51,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'inspect-result',
      result: expect.objectContaining({ ok: false }),
    }),
  );
  expect(post.mock.calls.filter(([row]) => row.kind === 'failed')).toHaveLength(failedBeforeRead);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});
it('retains unavailable double delivery without an unhandled runtime rejection or SUT failure', async () => {
  const { post, receive } = await start();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    post.mockImplementationOnce(() => {
      throw new Error('first-send');
    });
    post.mockImplementationOnce(() => {
      throw new Error('failure-send');
    });
    receive({
      data: {
        kind: 'inspect',
        requestId: 52,
        identity: { source: 'test', epoch: 1 },
        worldIdentity: 'test-world',
      },
    });
    await Promise.resolve();
    expect(log).toHaveBeenCalledOnce();
    expect(post.mock.calls.some(([row]) => row.kind === 'failed')).toBe(false);
    expect(mocks.draw).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('installs game-owned fullscreen declarations before drawing and retires their plugin lease', async () => {
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      deviceGeneration: 7,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  });
  const { post, receive } = await start();
  const descriptor = { identity: 'game::late', source: 'fn fs_main() {}', reads: ['sceneColor'] };
  try {
    for (const [revision, enabled] of [
      [1, false],
      [2, true],
      [3, false],
      [4, true],
    ] as const) {
      const message = drawMessage(revision);
      const row = {
        identity: descriptor.identity,
        data: enabled,
        ...(revision === 1 ? { fullscreen: structuredClone(descriptor) } : {}),
      };
      receive({ data: { ...message, publication: { ...message.publication, features: [row] } } });
      await vi.waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'completed', revision }),
          expect.any(Array),
        ),
      );
      expect(mocks.installFeature).toHaveBeenCalledTimes(1);
      const feature = mocks.installFeature.mock.calls[0]?.[0];
      expect(feature.identity).toBe(descriptor.identity);
      expect(feature.plan(enabled, {}).unwrap().work).toHaveLength(enabled ? 1 : 0);
    }
    receive({ data: drawMessage(5) });
    await vi.waitFor(() => expect(mocks.uninstallFeature).toHaveBeenCalledTimes(1));
    const message = drawMessage(6);
    receive({
      data: {
        ...message,
        publication: {
          ...message.publication,
          features: [{ identity: descriptor.identity, data: true }],
        },
      },
    });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'completed', revision: 6 }),
        expect.any(Array),
      ),
    );
    expect(mocks.installFeature).toHaveBeenCalledTimes(2);
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  3, 4,
] as const)('keeps %i admitted publications in FIFO order across a held preparation and real out-of-order GPU completion', async (capacity) => {
  const prepared = deferred<void>();
  const completions = Array.from({ length: capacity }, () =>
    deferred<{ ok: true; value: undefined }>(),
  );
  const closes = Array.from({ length: capacity }, () => vi.fn());
  mocks.scheduled.mockImplementation(async (input) => {
    if (input.publication.revision === 1) await prepared.promise;
    return mocks.draw(input);
  });
  mocks.draw.mockImplementation((input) => ({
    ok: true,
    value: { deviceGeneration: 7, completed: completions[input.publication.revision - 1]?.promise },
  }));
  const { post, receive } = await start({
    renderTaskYield: 'features',
    renderPipelineCapacity: capacity,
  });
  const revisions = (kind: string) =>
    post.mock.calls
      .filter(([message]) => message.kind === kind)
      .map(([message]) => message.revision);
  try {
    receive({ data: drawMessage(1, closes[0]) });
    await vi.waitFor(() => expect(mocks.scheduled).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2, closes[1], 'canvas') });
    for (let id = 3; id <= capacity; id++) receive({ data: drawMessage(id, closes[id - 1]) });
    expect(revisions('submitted')).toEqual([]);
    prepared.resolve(undefined);
    await vi.waitFor(() =>
      expect(revisions('submitted')).toEqual(
        Array.from({ length: capacity }, (_, index) => index + 1),
      ),
    );
    expect(mocks.draw.mock.calls.map(([input]) => input.publication.revision)).toEqual(
      Array.from({ length: capacity }, (_, index) => index + 1),
    );
    expect(revisions('completed')).toEqual([]);
    for (let index = capacity - 1; index > 0; index--)
      completions[index]?.resolve({ ok: true, value: undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(revisions('completed')).toEqual([]);
    for (const close of closes) expect(close).not.toHaveBeenCalled();
    completions[0]?.resolve({ ok: true, value: undefined });
    await vi.waitFor(() =>
      expect(revisions('completed')).toEqual(
        Array.from({ length: capacity }, (_, index) => index + 1),
      ),
    );
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    expect(revisions('failed')).toEqual([]);
  } finally {
    prepared.resolve(undefined);
    for (const completion of completions) completion.resolve({ ok: true, value: undefined });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it.each([
  { terminal: 'dispose', capacity: 3 },
  { terminal: 'overflow', capacity: 3 },
  { terminal: 'dispose', capacity: 4 },
  { terminal: 'overflow', capacity: 4 },
] as const)('closes all $capacity accepted FIFO owners exactly once on $terminal without publishing fake completions', async ({
  terminal,
  capacity,
}) => {
  const prepared = deferred<void>();
  const closes = Array.from({ length: capacity + 1 }, () => vi.fn());
  mocks.scheduled.mockImplementation(async (_input, schedule) => {
    await prepared.promise;
    if (schedule.signal.aborted || !schedule.isCurrent())
      return { ok: false, error: rendererLossError() };
    return mocks.draw(_input);
  });
  const { post, receive } = await start({
    renderTaskYield: 'features',
    renderPipelineCapacity: capacity,
  });
  try {
    receive({ data: drawMessage(1, closes[0]) });
    await vi.waitFor(() => expect(mocks.scheduled).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2, closes[1], 'canvas') });
    for (let id = 3; id <= capacity; id++) receive({ data: drawMessage(id, closes[id - 1]) });
    if (terminal === 'overflow') receive({ data: drawMessage(capacity + 1, closes[capacity]) });
    receive({ data: { kind: 'dispose' } });
    prepared.resolve(undefined);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
    expect(mocks.draw).not.toHaveBeenCalled();
    expect(
      post.mock.calls.some(
        ([message]) => message.kind === 'submitted' || message.kind === 'completed',
      ),
    ).toBe(false);
    expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(
      terminal === 'overflow' ? 1 : 0,
    );
    for (const close of closes.slice(0, terminal === 'overflow' ? capacity + 1 : capacity))
      expect(close).toHaveBeenCalledOnce();
  } finally {
    prepared.resolve(undefined);
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('drains the third FIFO owner without ACK when an older real receipt fails during preparation', async () => {
  const completion = deferred<{ ok: false; error: RenderError }>();
  const turn = deferred<void>();
  const closes = [vi.fn(), vi.fn(), vi.fn()];
  mocks.turn.mockReturnValue(turn.promise);
  mocks.draw.mockReturnValue({
    ok: true,
    value: { deviceGeneration: 7, completed: completion.promise },
  });
  const { post, receive } = await start({ renderTaskYield: 'features', renderPipelineCapacity: 3 });
  try {
    receive({ data: drawMessage(1, closes[0]) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2, closes[1], 'canvas') });
    await vi.waitFor(() => expect(mocks.turn).toHaveBeenCalledOnce());
    receive({ data: drawMessage(3, closes[2]) });
    completion.resolve({ ok: false, error: rendererLossError('complete-frame') });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([message]) => message.kind === 'failed')).toHaveLength(1),
    );
    turn.resolve(undefined);
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
    expect(mocks.draw).toHaveBeenCalledOnce();
    expect(
      post.mock.calls
        .filter(([message]) => message.kind === 'submitted')
        .map(([message]) => message.revision),
    ).toEqual([1]);
    expect(post.mock.calls.some(([message]) => message.kind === 'completed')).toBe(false);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  } finally {
    completion.resolve({ ok: false, error: rendererLossError('complete-frame') });
    turn.resolve(undefined);
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('holds one requested geometry receipt through readback and resumes ordinary queued draws', async () => {
  const read = deferred<unknown>();
  mocks.geometry.mockReturnValue(read.promise);
  mocks.draw.mockImplementation((input) => ({
    ok: true,
    value: {
      frameId: input.publication.revision,
      deviceGeneration: 7,
      graphGeneration: 3,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  }));
  const { receive, post } = await start();
  receive({
    data: {
      kind: 'geometry-observe-next',
      requestId: 81,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  receive({ data: drawMessage(1) });
  receive({ data: drawMessage(2) });
  await vi.waitFor(() => expect(mocks.geometry).toHaveBeenCalledTimes(1));
  expect(mocks.draw).toHaveBeenCalledTimes(1);
  expect(mocks.draw.mock.calls[0]?.[0].geometryObservation).toBe(true);
  expect(mocks.draw.mock.calls[0]?.[0].geometryObservationSourceWorldIdentity).toBe('test-world');
  read.resolve({
    status: 'complete',
    scope: 'primary-display-view-gpu-commands',
    frameId: 1,
    deviceGeneration: 7,
    commands: [],
  });
  await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(2));
  expect(mocks.draw.mock.calls[1]?.[0].geometryObservation).toBeUndefined();
  expect(mocks.draw.mock.calls[1]?.[0].geometryObservationSourceWorldIdentity).toBeUndefined();
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'geometry-observation-result',
      requestId: 81,
      result: expect.objectContaining({ ok: true, value: expect.objectContaining({ frameId: 1 }) }),
    }),
  );
});
it('rejects geometry source World mismatch without arming or reading another World', async () => {
  mocks.geometry.mockReset();
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      frameId: 1,
      deviceGeneration: 7,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  });
  const { receive, post } = await start();
  receive({
    data: {
      kind: 'geometry-observe-next',
      requestId: 84,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  receive({ data: { ...drawMessage(1), worldIdentity: 'another-world' } });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'geometry-observation-result',
        requestId: 84,
        result: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            detail: expect.objectContaining({ reason: 'stale-session' }),
          }),
        }),
      }),
    ),
  );
  expect(mocks.draw.mock.calls[0]?.[0].geometryObservation).toBeUndefined();
  expect(mocks.draw.mock.calls[0]?.[0].geometryObservationSourceWorldIdentity).toBeUndefined();
  expect(mocks.geometry).not.toHaveBeenCalled();
  expect(post.mock.calls.some(([row]) => row.kind === 'failed')).toBe(false);
});
it('cancels a pending geometry request before any draw without arming ordinary frames', async () => {
  mocks.geometry.mockReset();
  mocks.draw.mockReturnValue({
    ok: true,
    value: {
      frameId: 1,
      deviceGeneration: 7,
      completed: Promise.resolve({ ok: true, value: undefined }),
    },
  });
  const { receive, post } = await start();
  receive({
    data: {
      kind: 'geometry-observe-next',
      requestId: 82,
      identity: { source: 'test', epoch: 1 },
      worldIdentity: 'test-world',
    },
  });
  receive({ data: { kind: 'geometry-observe-cancel', requestId: 82 } });
  receive({ data: drawMessage(1) });
  await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(1));
  expect(mocks.draw.mock.calls[0]?.[0].geometryObservation).toBeUndefined();
  expect(mocks.geometry).not.toHaveBeenCalled();
  expect(post.mock.calls.some(([message]) => message.kind === 'geometry-observation-result')).toBe(
    false,
  );
});
it('rejects an observation from a foreign publication epoch before arming a frame', async () => {
  const { receive, post } = await start();
  receive({
    data: {
      kind: 'geometry-observe-next',
      requestId: 83,
      identity: { source: 'test', epoch: 2 },
      worldIdentity: 'test-world',
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'geometry-observation-result',
        requestId: 83,
        result: expect.objectContaining({ ok: false }),
      }),
    ),
  );
  expect(mocks.draw).not.toHaveBeenCalled();
});

it('binds composite and predecessor continuation marks to each original receipt without changing FIFO retirement', async () => {
  const events: unknown[] = [];
  const execution = { enabled: true, failures: 0, emit: (event: unknown) => events.push(event) };
  vi.stubGlobal('__forgeaxFramePhaseDiagnostics', { execution });
  const first = deferred<{ ok: true; value: undefined }>(),
    second = deferred<{ ok: true; value: undefined }>();
  mocks.draw
    .mockReturnValueOnce({ ok: true, value: { deviceGeneration: 7, completed: first.promise } })
    .mockReturnValueOnce({ ok: true, value: { deviceGeneration: 8, completed: second.promise } });
  const { post, receive } = await start();
  try {
    receive({ data: drawMessage(1) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledOnce());
    receive({ data: drawMessage(2) });
    await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(2));
    second.resolve({ ok: true, value: undefined });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        event: 'render-own-composite-continuation',
        worldIdentity: 'test-world',
        frameId: 2,
        deviceGeneration: 8,
        source: 'test',
        epoch: 1,
        revision: 2,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ event: 'render-previous-prefix-passed', frameId: 2 }),
    );
    expect(post.mock.calls.filter(([message]) => message.kind === 'completed')).toHaveLength(0);
    first.resolve({ ok: true, value: undefined });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([message]) => message.kind === 'completed')).toHaveLength(2),
    );
    expect(events).toEqual([
      {
        event: 'render-own-composite-continuation',
        worldIdentity: 'test-world',
        frameId: 2,
        deviceGeneration: 8,
        source: 'test',
        epoch: 1,
        revision: 2,
      },
      {
        event: 'render-own-composite-continuation',
        worldIdentity: 'test-world',
        frameId: 1,
        deviceGeneration: 7,
        source: 'test',
        epoch: 1,
        revision: 1,
      },
      {
        event: 'render-previous-prefix-passed',
        worldIdentity: 'test-world',
        frameId: 1,
        deviceGeneration: 7,
        source: 'test',
        epoch: 1,
        revision: 1,
      },
      {
        event: 'render-previous-prefix-passed',
        worldIdentity: 'test-world',
        frameId: 2,
        deviceGeneration: 8,
        source: 'test',
        epoch: 1,
        revision: 2,
      },
    ]);
    expect(execution.failures).toBe(0);
  } finally {
    first.resolve({ ok: true, value: undefined });
    second.resolve({ ok: true, value: undefined });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});

it('applies the explicit startup order after project configuration before ready, preserving profile', async () => {
  const profile = {
    pipelineId: 'forgeax::standard',
    renderPath: 'deferred',
    lightCount: 256,
    ssao: true,
  };
  const gbufferBatchOrderDiagnostic = {
    order: 'far' as const,
    programDigests: [`sha256:${'a'.repeat(64)}`],
  };
  mocks.inspect.mockReturnValue({ ...mocks.inspect(), profile });
  mocks.setProfile.mockReturnValue({ ok: true, value: undefined });
  await start({ gbufferBatchOrderDiagnostic });
  expect(mocks.setProfile).toHaveBeenCalledWith({ ...profile, gbufferBatchOrderDiagnostic });
  expect(mocks.configure.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.setProfile.mock.invocationCallOrder[0] as number,
  );
});

it.each([
  false,
  true,
])('applies explicit read-only depth experiment %s after configuration before ready', async (featureReadOnlyDepthBatchDiagnostic) => {
  const profile = {
    pipelineId: 'forgeax::standard',
    renderPath: 'deferred',
    lightCount: 256,
    ssao: true,
  };
  mocks.inspect.mockReturnValue({ ...mocks.inspect(), profile });
  mocks.setProfile.mockReturnValue({ ok: true, value: undefined });
  await start({ featureReadOnlyDepthBatchDiagnostic });
  expect(mocks.setProfile).toHaveBeenCalledWith({
    ...profile,
    featureReadOnlyDepthBatchDiagnostic,
  });
  expect(mocks.configure.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.setProfile.mock.invocationCallOrder[0] as number,
  );
});

it('relays receipt-owned shadow workload with independent Renderer identity through submitted and completed', async () => {
  const complete = deferred<{ ok: true; value: undefined }>();
  const shadowWorkload = Object.freeze({
    status: 'complete',
    scope: 'display-views',
    frameId: 901,
    deviceGeneration: 7,
    graphGeneration: 111,
    views: Object.freeze([]),
  });
  mocks.draw.mockReturnValueOnce({
    ok: true,
    value: {
      frameId: 901,
      deviceGeneration: 7,
      graphGeneration: 111,
      shadowWorkload,
      completed: complete.promise,
    },
  });
  const { post, receive } = await start({ shadowWorkload: true });
  try {
    expect(mocks.construct.mock.calls[0]?.[1]).toMatchObject({ shadowWorkload: true });
    receive({ data: drawMessage(1) });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([m]) => m.kind === 'submitted')).toHaveLength(1),
    );
    complete.resolve({ ok: true, value: undefined });
    await vi.waitFor(() =>
      expect(post.mock.calls.filter(([m]) => m.kind === 'completed')).toHaveLength(1),
    );
    for (const [message] of post.mock.calls) {
      if (message.kind === 'submitted' || message.kind === 'completed') {
        expect(message.frame.frameId).toBe(1);
        expect(message.frame.shadowWorkload).toBe(shadowWorkload);
        expect(structuredClone(message).frame.shadowWorkload.frameId).toBe(901);
      }
    }
  } finally {
    complete.resolve({ ok: true, value: undefined });
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
});
