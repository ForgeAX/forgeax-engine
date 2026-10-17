import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  type RenderError,
  type RendererEvent,
  RendererOperationError,
  type RenderFrameInput,
} from '@forgeax/engine-render';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RenderWorkerInput } from '../execution/render-worker-protocol';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  draw: vi.fn(),
  observe: vi.fn(),
  bounds: vi.fn(),
  dispose: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  configure: vi.fn(),
  inspect: vi.fn(),
  installFeature: vi.fn(),
  uninstallFeature: vi.fn(),
  prepareMesh: vi.fn(),
  state: vi.fn(),
  listener: undefined as ((event: RendererEvent) => void) | undefined,
}));
vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: (...args: unknown[]) => {
    mocks.construct(...args);
    return Promise.resolve({
      ok: true,
      value: {
        featureHost: {
          installRenderFeature: mocks.installFeature,
          uninstallRenderFeature: mocks.uninstallFeature,
        },
        renderer: {
          draw: mocks.draw,
          observe: mocks.observe,
          bounds: mocks.bounds,
          dispose: mocks.dispose,
          subscribe: mocks.subscribe,
          state: mocks.state,
          inspect: mocks.inspect,
          preparePublishedMeshResidency: mocks.prepareMesh,
        },
      },
    });
  },
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: async () => ({ ok: true, value: { configureRenderer: mocks.configure } }),
}));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.listener = undefined;
  mocks.subscribe.mockImplementation((listener: (event: RendererEvent) => void) => {
    mocks.listener = listener;
    return mocks.unsubscribe;
  });
  mocks.configure.mockResolvedValue(undefined);
  mocks.installFeature.mockResolvedValue({ ok: true, value: undefined });
  mocks.uninstallFeature.mockResolvedValue({ ok: true, value: undefined });
  mocks.state.mockReturnValue('alive');
  mocks.inspect.mockReturnValue({
    state: 'alive',
    frame: { frameId: 0, deviceGeneration: 7 },
    capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
    limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
  });
});

async function start(
  options: {
    readonly gpuPassTiming?: object;
    readonly geometryLane?: RenderFrameInput['geometryLane'];
    readonly dynamicGeometryMeshBudgetBytes?: number;
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
      publication: { source: 'test', epoch: 1, revision: 1, features: [], videoFrames: [] },
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
