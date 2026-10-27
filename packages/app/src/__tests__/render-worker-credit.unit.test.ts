import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  type DynamicGeometryCandidate,
  MeshFilter,
  MeshRenderer,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { renderPublicationTiming } from '@forgeax/engine-render/internal';
import { Transform } from '@forgeax/engine-scene';
import { DEFAULT_UNLIT_PARAM_SCHEMA, ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  ExecutionInitMessage,
} from '../execution/protocol';
import type { RenderWorkerInput, RenderWorkerOutput } from '../execution/render-worker-protocol';
import { SourceRenderWorker } from '../execution/source-render-worker';
import { workerSelection } from './execution-fixtures';

class CreditWorker {
  static current: CreditWorker;
  listeners = new Set<(event: MessageEvent<RenderWorkerOutput>) => void>();
  addEventListener(_kind: string, listener: (event: MessageEvent<RenderWorkerOutput>) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_kind: string, listener: (event: MessageEvent<RenderWorkerOutput>) => void) {
    this.listeners.delete(listener);
  }
  onmessage?: (event: MessageEvent<RenderWorkerOutput>) => void;
  packets: Extract<RenderWorkerInput, { kind: 'draw' }>[] = [];
  controls: RenderWorkerInput[] = [];
  init?: Extract<RenderWorkerInput, { kind: 'init' }>;
  constructor() {
    CreditWorker.current = this;
  }
  emit(data: unknown) {
    for (const listener of this.listeners)
      listener(
        new MessageEvent<RenderWorkerOutput>('message', { data: data as RenderWorkerOutput }),
      );
    this.onmessage?.(
      new MessageEvent<RenderWorkerOutput>('message', { data: data as RenderWorkerOutput }),
    );
  }
  postMessage(message: RenderWorkerInput, transfer: Transferable[] = []) {
    if (message.kind === 'init') {
      this.init = message;
      queueMicrotask(() =>
        this.emit({
          kind: 'ready',
          deviceGeneration: 7,
          capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: true },
          limits: { maxStorageBuffersPerShaderStage: 8 },
        }),
      );
    } else if (message.kind === 'draw') this.packets.push(structuredClone(message, { transfer }));
    else if (message.kind === 'dispose') queueMicrotask(() => this.emit({ kind: 'disposed' }));
    else {
      this.controls.push(structuredClone(message));
      if (message.kind === 'mesh-release')
        queueMicrotask(() =>
          this.emit({
            kind: 'mesh-released',
            requestId: message.requestId,
            identity: message.identity,
            result: { ok: true, deviceGeneration: 7 },
          }),
        );
    }
  }
  terminate() {}
}
afterEach(() => vi.unstubAllGlobals());

async function programTransportFixture(post: (message: EngineToHostMessage) => void = () => {}) {
  vi.stubGlobal('Worker', CreditWorker);
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  shaders.installMaterialArtifact('test::candidate-program', {
    source:
      '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
    paramSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
  });
  const assets = new AssetRegistry({ shaderRegistry: shaders });
  const world = new World({ assets });
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      canvas,
      startupTimeoutMs: 90_000,
      bootstrapUrl: '',
      workers: workerSelection({ render: true, kernels: false }),
    },
    post,
  );
  const previous = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const meshHandle = assets.create(mesh).unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'forward',
          program: { module: 'test::candidate-program' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: { baseColor: [1, 1, 1, 1] },
    })
    .unwrap();
  await source.start(canvas);
  const worker = CreditWorker.current;
  const prepare = (signal?: AbortSignal) => {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: previous } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    return source.dynamicGeometry.prepareDynamicGeometry(
      { world, entity, meshHandle, revision: 1 },
      signal === undefined ? undefined : { signal },
    );
  };
  const requests = () => worker.controls.filter((message) => message.kind === 'mesh-prepare');
  const waitRequest = async (index: number) => {
    await vi.waitFor(() => expect(requests().length).toBeGreaterThan(index));
    const request = requests()[index];
    if (request === undefined) throw new Error('missing preparation');
    return request;
  };
  const ready = (requestId: number, deviceGeneration = 7) =>
    worker.emit({
      kind: 'mesh-ready',
      requestId,
      identity: worker.init?.identity,
      result: { ok: true, deviceGeneration },
    });
  return { source, worker, prepare, waitRequest, ready, world, canvas };
}

it.each([
  'confirmed',
  'cleanup-error',
  'timeout',
  'dispose',
] as const)('requires a successful retirement ACK before recovering device loss with resident meshes: %s', async (retirement) => {
  const messages: EngineToHostMessage[] = [];
  const f = await programTransportFixture((message) => messages.push(message));
  try {
    const prepared = f.prepare();
    const request = await f.waitRequest(0);
    f.ready(request.requestId);
    const candidate = (await prepared).unwrap();
    const worldIdentity = f.world.identity;
    messages.length = 0;
    const terminate = vi.spyOn(f.worker, 'terminate');
    const send = f.worker.postMessage.bind(f.worker);
    const retirements: RenderWorkerInput[] = [];
    vi.spyOn(f.worker, 'postMessage').mockImplementation((message, transfer) => {
      if (message.kind === 'dispose') retirements.push(message);
      else send(message, transfer);
    });
    vi.useFakeTimers();
    f.worker.emit({
      kind: 'failed',
      stage: 'draw',
      recoverable: true,
      renderer: { state: 'device-lost' },
      error: {
        code: 'device-operation-failed',
        expected: 'a live GPU device',
        hint: 'replace the lost device',
        detail: { operation: 'complete-frame', cause: { code: 'device-lost' } },
      },
    });
    expect(retirements).toEqual([{ kind: 'dispose' }]);
    expect(f.source.hasPublicationCapacity).toBe(false);
    expect(f.source.dynamicGeometry.isDynamicGeometryCurrent(candidate)).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    const disposing = retirement === 'dispose' ? f.source.dispose() : undefined;
    expect(retirements).toHaveLength(1);

    if (retirement === 'timeout') await vi.advanceTimersByTimeAsync(5_001);
    else {
      f.worker.emit({
        kind: 'disposed',
        ...(retirement === 'cleanup-error' ? { error: { code: 'cleanup-failed' } } : {}),
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    if (disposing !== undefined) {
      await disposing;
      expect(messages).toEqual([]);
      expect(f.source.hasPublicationCapacity).toBe(false);
      expect(f.worker.controls.some((message) => message.kind === 'mesh-release')).toBe(false);
    } else if (retirement === 'confirmed') {
      expect(messages).toContainEqual(expect.objectContaining({ kind: 'render-lost', epoch: 2 }));
      expect(messages.some((message) => message.kind === 'fault')).toBe(false);
      await f.source.replace(2, f.canvas);
      expect(f.source.hasPublicationCapacity).toBe(true);
      expect(f.world.identity).toBe(worldIdentity);
      expect(f.source.dynamicGeometry.isDynamicGeometryCurrent(candidate)).toBe(false);
    } else {
      expect(messages).toContainEqual(
        expect.objectContaining({
          kind: 'fault',
          retryable: false,
          detail: expect.objectContaining({ meshReleaseUnconfirmed: true }),
        }),
      );
      expect(messages.some((message) => message.kind === 'render-lost')).toBe(false);
    }
  } finally {
    vi.useRealTimers();
    await f.source.dispose();
  }
});

it('sends first candidate programs until valid preparation ACK, then reuses publication program knowledge', async () => {
  const f = await programTransportFixture();
  try {
    const first = f.prepare();
    const a = await f.waitRequest(0);
    const programs = a.input.pipelinePreparation?.programs;
    expect(programs?.length).toBeGreaterThan(0);
    const concurrent = f.prepare();
    const b = await f.waitRequest(1);
    expect(b.input.pipelinePreparation?.programs).toEqual(programs);
    f.ready(a.requestId);
    expect((await first).ok).toBe(true);
    const next = f.prepare();
    const c = await f.waitRequest(2);
    expect(c.input.pipelinePreparation?.programs).toEqual([]);
    expect(f.worker.packets).toHaveLength(0);
    f.ready(b.requestId);
    f.ready(c.requestId);
    expect((await concurrent).ok).toBe(true);
    expect((await next).ok).toBe(true);
  } finally {
    await f.source.dispose();
  }
});

it.each([
  'failed',
  'cancelled',
  'generation',
  'epoch',
] as const)('retains candidate program payload after %s preparation response', async (failure) => {
  const f = await programTransportFixture();
  try {
    const controller = new AbortController();
    const first = f.prepare(controller.signal);
    const a = await f.waitRequest(0);
    const programs = a.input.pipelinePreparation?.programs;
    expect(programs?.length).toBeGreaterThan(0);
    if (failure === 'failed') {
      f.worker.emit({
        kind: 'mesh-ready',
        requestId: a.requestId,
        identity: f.worker.init?.identity,
        result: {
          ok: false,
          error: {
            code: 'mesh-residency-gpu-not-ready',
            expected: 'native preparation completes',
            hint: 'test failure',
          },
        },
      });
    } else if (failure === 'generation') {
      f.ready(a.requestId, 8);
    } else if (failure === 'epoch') {
      f.worker.emit({
        kind: 'mesh-ready',
        requestId: a.requestId,
        identity: { ...f.worker.init?.identity, epoch: 2 },
        result: { ok: true, deviceGeneration: 7 },
      });
      controller.abort();
    } else {
      controller.abort();
      f.ready(a.requestId);
    }
    expect((await first).ok).toBe(false);
    const next = f.prepare();
    const b = await f.waitRequest(1);
    expect(b.input.pipelinePreparation?.programs).toEqual(programs);
    f.ready(b.requestId);
    expect((await next).ok).toBe(true);
  } finally {
    await f.source.dispose();
  }
});

it('publishes geometry without a global temporal reset and faults paired recovery when release is unconfirmed', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const canvas = {} as OffscreenCanvas;
  const messages: EngineToHostMessage[] = [];
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      canvas,
      startupTimeoutMs: 90_000,
      bootstrapUrl: '',
      workers: workerSelection({ render: true, kernels: false }),
    },
    (message) => messages.push(message),
  );
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const meshHandle = assets.create(mesh).unwrap();
  const previous = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: previous } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const prepared = source.dynamicGeometry.prepareDynamicGeometry({
      world,
      entity,
      meshHandle,
      revision: 1,
    });
    await vi.waitFor(() =>
      expect(worker.controls.some((message) => message.kind === 'mesh-prepare')).toBe(true),
    );
    const request = worker.controls.find((message) => message.kind === 'mesh-prepare');
    if (request?.kind !== 'mesh-prepare') throw new Error('missing preparation');
    expect(request.input.pipelinePreparation).toMatchObject({
      entity,
      template: { snapshot: { assetHandle: meshHandle } },
    });
    // Capturing the replacement must not publish it into the live World.
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(previous);
    worker.emit({
      kind: 'mesh-ready',
      requestId: request.requestId,
      identity: worker.init?.identity,
      result: { ok: true, deviceGeneration: 7 },
    });
    let candidate: DynamicGeometryCandidate = (await prepared).unwrap();
    let accepted = false;
    world
      .addSystem(FixedUpdate, {
        name: 'geometry-admission',
        queries: [],
        fn: () => {
          if (accepted) return;
          candidate = source.dynamicGeometry
            .acceptDynamicGeometry(candidate, {
              world,
              fixedStep: world.getResource(FixedTime).tick,
            })
            .unwrap();
          accepted = true;
        },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const tick = world.getResource(FixedTime).tick;
    source.publish(
      {
        kind: 'frame',
        worldIdentity: world.identity,
        frameId: 50,
        deltaSeconds: 0,
        canvasWidth: 32,
        canvasHeight: 32,
        inputSample: {
          downKeys: new Set(),
          upKeys: new Set(),
          buttons: [false, false, false],
          movementX: 0,
          movementY: 0,
          wheelDelta: 0,
          focused: true,
          pointerLocked: false,
        },
      },
      0,
    );
    const draw = worker.packets[0];
    if (draw === undefined) throw new Error('missing publication');
    expect(renderPublicationTiming(draw.publication).temporalReset).toBe(false);
    world.update(1 / 60).unwrap();
    worker.emit({
      kind: 'completed',
      revision: draw.publication.revision,
      buffers: renderPublicationTransfers(draw.publication),
      frame: {
        kind: 'frame-complete',
        worldIdentity: world.identity,
        frameId: 50,
        deviceGeneration: 7,
        presentation: 'ready',
        engineUpdateMs: 0,
        kernelWaitMs: 0,
      },
      meshConsumption: {
        frameId: 3,
        deviceGeneration: 7,
        sourceFixedStep: tick,
        bindings: new Float64Array([request.requestId, 0]),
      },
    });
    expect(source.dynamicGeometry.dynamicGeometryReceipt(candidate)).toMatchObject({
      frameId: 3,
      deviceGeneration: 7,
      publicationFixedStep: tick,
      recordStageLane: 'cpu',
    });
    expect(world.getResource(FixedTime).tick).toBeGreaterThan(tick);
    worker.emit({
      kind: 'failed',
      recoverable: true,
      stage: 'draw',
      error: { code: 'device-operation-failed', expected: 'live device', hint: 'replace' },
    });
    expect(source.dynamicGeometry.isDynamicGeometryCurrent(candidate)).toBe(false);
    await source.replace(2, canvas);
    expect(source.dynamicGeometry.currentGeneration()).toBeUndefined();
    expect(source.dynamicGeometry.isDynamicGeometryCurrent(candidate)).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: 'fault',
        retryable: false,
        detail: expect.objectContaining({ meshReleaseUnconfirmed: true }),
      }),
    );
    expect(messages.some((message) => message.kind === 'render-lost')).toBe(false);
  } finally {
    await source.dispose();
  }
});

it.each([
  { duplicateReady: false, capacity: 2 },
  { duplicateReady: true, capacity: 2 },
  { duplicateReady: true, capacity: 3 },
  { duplicateReady: false, capacity: 4 },
  { duplicateReady: true, capacity: 4 },
] as const)('seals $capacity frames until the oldest completes (duplicate ready: $duplicateReady)', async ({
  duplicateReady,
  capacity,
}) => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const hostMessages: EngineToHostMessage[] = [];
  const init: ExecutionInitMessage = {
    kind: 'init',
    startupTimeoutMs: 90_000,
    canvas,
    bootstrapUrl: '',
    workers: workerSelection({ engine: true, render: true, kernels: false }),
    diagnostics: { renderPipelineCapacity: capacity },
  };
  const source = new SourceRenderWorker(world, assets, init, (message) =>
    hostMessages.push(message),
  );
  await source.start(canvas);
  expect(hostMessages).toContainEqual({
    kind: 'render-ready',
    epoch: 1,
    capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: true },
    limits: { maxStorageBuffersPerShaderStage: 8 },
  });
  const frame: ExecutionFrameMessage = {
    kind: 'frame',
    worldIdentity: world.identity,
    frameId: 1,
    deltaSeconds: 0,
    canvasWidth: 32,
    canvasHeight: 32,
    inputSample: {
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    },
  };
  const worker = CreditWorker.current;
  const complete = () => {
    const draw = worker.packets.shift();
    if (draw === undefined) throw new Error('No publication');
    const p = draw.publication;
    const buffers = renderPublicationTransfers(p);
    worker.emit({
      kind: 'completed',
      revision: p.revision,
      buffers,
      frame: {
        kind: 'frame-complete',
        worldIdentity: world.identity,
        frameId: draw.frameId,
        engineUpdateMs: 0,
        kernelWaitMs: 0,
      },
    });
  };
  try {
    source.publish(frame, 0);
    source.publish({ ...frame, frameId: 2, temporalReset: true }, 1);
    for (let id = 3; id <= capacity; id++) source.publish({ ...frame, frameId: id }, id - 1);
    expect(source.hasPublicationCapacity).toBe(false);
    expect(worker.packets.map((packet) => packet.frameId)).toEqual(
      Array.from({ length: capacity }, (_, index) => index + 1),
    );
    expect(renderPublicationTiming(packetAt(worker, 1).publication).temporalReset).toBe(true);
    expect(() => source.publish({ ...frame, frameId: capacity + 1 }, capacity)).toThrow();
    if (duplicateReady) {
      const clearDeadline = vi.spyOn(globalThis, 'clearTimeout');
      try {
        worker.emit({
          kind: 'ready',
          deviceGeneration: 7,
          capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: true },
          limits: { maxStorageBuffersPerShaderStage: 8 },
        });
        expect.soft(clearDeadline).not.toHaveBeenCalled();
        expect
          .soft(hostMessages.filter((message) => message.kind === 'render-ready'))
          .toHaveLength(1);
      } finally {
        clearDeadline.mockRestore();
      }
      expect(source.hasPublicationCapacity).toBe(false);
    }
    complete();
    expect(hostMessages.filter((message) => message.kind === 'fault')).toHaveLength(0);
    expect(source.hasPublicationCapacity).toBe(true);
    source.publish({ ...frame, frameId: capacity + 1 }, capacity);
    expect(worker.packets.map((packet) => packet.frameId)).toEqual(
      Array.from({ length: capacity }, (_, index) => index + 2),
    );
    expect(renderPublicationTiming(packetAt(worker, 1).publication).temporalReset).toBe(false);
    complete();
    source.publish({ ...frame, frameId: capacity + 2 }, capacity + 1);
    expect(renderPublicationTiming(packetAt(worker, 1).publication).temporalReset).toBe(false);
  } finally {
    await source.dispose();
  }
});

it.each([
  false,
  true,
])('keeps publication admission pending across render loss (full: %s)', async (full) => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const messages: EngineToHostMessage[] = [];
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      canvas,
      startupTimeoutMs: 90_000,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
    },
    (message) => messages.push(message),
  );
  const frame: ExecutionFrameMessage = {
    kind: 'frame',
    worldIdentity: world.identity,
    frameId: 1,
    deltaSeconds: 1 / 60,
    canvasWidth: 32,
    canvasHeight: 32,
    inputSample: {
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    },
  };
  try {
    await source.start(canvas);
    const previous = CreditWorker.current;
    if (full) {
      source.publish(frame, 0);
      source.publish({ ...frame, frameId: 2 }, 1 / 60);
    }
    let admitted = false;
    const admission = source.waitForPublicationCapacity().then(() => {
      admitted = true;
    });
    // Loss either invalidates a resolved readiness wait or releases a full queue.
    previous.emit({
      kind: 'failed',
      recoverable: true,
      stage: 'draw',
      error: { code: 'device-operation-failed', expected: 'live device', hint: 'replace' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(source.hasPublicationCapacity).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({ kind: 'render-lost', epoch: 2 }));
    await source.replace(2, canvas);
    await admission;
    expect(admitted).toBe(true);
    world.update(1 / 60).unwrap();
    source.publish({ ...frame, frameId: 3 }, 2 / 60);
    expect(CreditWorker.current).not.toBe(previous);
    expect(CreditWorker.current.packets).toHaveLength(1);
    expect(CreditWorker.current.packets[0]?.publication.epoch).toBe(2);
    expect(world.identity).toBe(frame.worldIdentity);
    source.publish({ ...frame, frameId: 4 }, 3 / 60);
    const pending = source.waitForPublicationCapacity();
    await source.dispose();
    expect(await pending).toBe(false);
  } finally {
    await source.dispose();
  }
});

it.each([
  false,
  true,
])('forwards timing and depth experiment %s to the child and retains the latest completed observation', async (featureReadOnlyDepthBatchDiagnostic) => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const messages: EngineToHostMessage[] = [];
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
      diagnostics: {
        gpuPassTiming: { retentionFrames: 4 },
        featureReadOnlyDepthBatchDiagnostic,
        gbufferBatchOrderDiagnostic: {
          order: 'near',
          programDigests: [`sha256:${'a'.repeat(64)}`],
        },
        geometryLane: 'direct',
        renderTaskYield: 'completion',
        renderPipelineCapacity: 3,
      },
      bootstrapData: { isolateVfxViewGraph: true },
    },
    (message) => messages.push(message),
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  expect(worker.init?.gpuPassTiming).toEqual({ retentionFrames: 4 });
  expect(worker.init).toHaveProperty(
    'featureReadOnlyDepthBatchDiagnostic',
    featureReadOnlyDepthBatchDiagnostic,
  );
  expect(worker.init).toHaveProperty('gbufferBatchOrderDiagnostic', {
    order: 'near',
    programDigests: [`sha256:${'a'.repeat(64)}`],
  });
  expect(worker.init).toHaveProperty('geometryLane', 'direct');
  expect(worker.init).toHaveProperty('renderTaskYield', 'completion');
  expect(worker.init).toHaveProperty('renderPipelineCapacity', 3);
  expect(worker.init?.bootstrapData).toEqual({ isolateVfxViewGraph: true });
  source.publish(
    {
      kind: 'frame',
      worldIdentity: world.identity,
      frameId: 7,
      deltaSeconds: 0,
      canvasWidth: 32,
      canvasHeight: 32,
      inputSample: {
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      },
    },
    0,
  );
  const draw = worker.packets.shift();
  if (draw === undefined) throw new Error('No timing publication');
  const publication = draw.publication;
  expect(draw).not.toHaveProperty('geometryLane');
  expect(publication).not.toHaveProperty('geometryLane');
  const observation = {
    status: 'unavailable',
    reason: { code: 'timestamp-query-unsupported' },
    capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
  } as const;
  worker.emit({
    kind: 'completed',
    revision: publication.revision,
    buffers: renderPublicationTransfers(publication),
    gpuPassTiming: observation,
    frame: {
      kind: 'frame-complete',
      worldIdentity: world.identity,
      frameId: 7,
      presentation: 'pending',
      presentationPendingReason: {
        code: 'scene-pipeline-preparation',
        pass: 'fs_gbuffer',
        shader: 'test::opaque',
      },
      engineUpdateMs: 0,
      kernelWaitMs: 0,
    },
  });
  expect(source.inspectGpuPassTiming()).toEqual({ frameId: 7, observation });
  // Render notices bypass the Engine; it only hands the Host the session port.
  expect(messages.some((message) => message.kind === 'render-complete')).toBe(false);
  expect(messages).toContainEqual(expect.objectContaining({ kind: 'render-host-port', epoch: 1 }));
  expect(worker.init?.hostPort).toBeDefined();
  await source.dispose();
});

it('routes capture results once, cancels the remote request, and settles it on render loss', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
      diagnostics: { rhiCapture: true },
    },
    () => {},
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const first = source.captureFrame();
    expect((await source.captureFrame()).ok).toBe(false);
    const request = worker.controls.at(-1);
    if (request?.kind !== 'capture') throw new Error('Capture was not sent');
    const submittedFrame = {
      status: 'remote-complete' as const,
      captureGeneration: 4,
      receipt: { frameId: 17, deviceGeneration: 7, graphGeneration: 2 },
    };
    const artifact = {
      kind: 'rhi-tape' as const,
      bytes: new Uint8Array([1, 2, 3]),
      submittedFrame,
    };
    worker.emit({
      kind: 'capture-result',
      requestId: request.requestId + 1,
      result: { ok: true, value: artifact },
    });
    expect((await source.captureFrame()).ok).toBe(false);
    worker.emit({
      kind: 'capture-result',
      requestId: request.requestId,
      result: { ok: true, value: artifact },
    });
    const received = (await first).unwrap();
    expect(received).toMatchObject({
      kind: 'rhi-tape',
      byteLength: 3,
      bytes: artifact.bytes,
      submittedFrame,
    });
    expect([...received.chunks(2)].map((chunk) => [...chunk.bytes])).toEqual([[1, 2], [3]]);
    const controller = new AbortController();
    const cancelled = source.captureFrame({ signal: controller.signal });
    controller.abort();
    expect((await cancelled).ok).toBe(false);
    expect(worker.controls.at(-1)?.kind).toBe('capture-cancel');
    const lost = source.captureFrame();
    worker.emit({
      kind: 'failed',
      error: {
        code: 'device-lost',
        expected: 'alive',
        hint: 'replace',
        detail: 'device lost during capture',
      },
      stage: 'draw',
      recoverable: true,
    });
    expect((await lost).ok).toBe(false);
  } finally {
    await source.dispose();
  }
});

it('uses the App startup budget for child initialization and still bounds a stalled child', async () => {
  class DelayedReadyWorker extends CreditWorker {
    override postMessage(message: RenderWorkerInput, transfer: Transferable[] = []) {
      if (message.kind !== 'init') super.postMessage(message, transfer);
    }
  }
  vi.useFakeTimers();
  vi.stubGlobal('Worker', DelayedReadyWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const init = {
    kind: 'init',
    canvas,
    bootstrapUrl: '',
    workers: workerSelection({ engine: true, render: true, kernels: false }),
    startupTimeoutMs: 90_000,
  } as const;
  const source = new SourceRenderWorker(world, assets, init, () => {});
  let settled = false;
  const starting = source.start(canvas).then(
    () => {
      settled = true;
      return 'ready';
    },
    (error) => {
      settled = true;
      return String(error);
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(false);
    CreditWorker.current.emit({
      kind: 'ready',
      capabilities: { backendKind: 'webgpu', storageBuffer: true },
    });
    expect(await starting).toBe('ready');
    await source.dispose();
    const next = new SourceRenderWorker(world, assets, init, () => {});
    const failure = next.start(canvas).catch((error) => String(error));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await failure).toContain('initialization timed out');
    await next.dispose();
  } finally {
    await source.dispose();
    vi.useRealTimers();
  }
});

it('forwards the startup pipeline libraries only with the start that supplies them', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const pipelineLibrary = {
    version: 1 as const,
    backend: 'webgpu' as const,
    shaders: [],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [],
  };
  const backgroundPipelineLibrary = { ...pipelineLibrary, shaders: [{ code: '// background' }] };
  for (const resupplied of [undefined, pipelineLibrary]) {
    const source = new SourceRenderWorker(
      world,
      assets,
      {
        kind: 'init',
        canvas,
        bootstrapUrl: '',
        workers: workerSelection({ engine: true, render: true, kernels: false }),
        startupTimeoutMs: 90_000,
      },
      () => {},
    );
    try {
      await source.start(canvas, pipelineLibrary, backgroundPipelineLibrary);
      expect(CreditWorker.current.init?.pipelineLibrary).toBe(pipelineLibrary);
      expect(CreditWorker.current.init?.backgroundPipelineLibrary).toBe(backgroundPipelineLibrary);
      const lost = CreditWorker.current;
      lost.emit({
        kind: 'failed',
        recoverable: true,
        stage: 'draw',
        error: { code: 'device-operation-failed', expected: 'live device', hint: 'replace' },
      });
      // Replacement carries only what the Host supplies with it; nothing was retained.
      const background = resupplied === undefined ? undefined : backgroundPipelineLibrary;
      await source.replace(2, canvas, resupplied, background);
      expect(CreditWorker.current).not.toBe(lost);
      expect(CreditWorker.current.init?.pipelineLibrary).toBe(resupplied);
      expect(CreditWorker.current.init?.backgroundPipelineLibrary).toBe(background);
    } finally {
      await source.dispose();
    }
  }
});

it('reads remote bounds without advancing a frame and retires pending reads on disposal', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
    },
    () => {},
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const read = source.bounds(7);
    const request = worker.controls.at(-1);
    if (request?.kind !== 'bounds') throw new Error('missing bounds request');
    const bounds = { min: [1, 2, 3], max: [4, 5, 6] };
    worker.emit({ kind: 'bounds-result', requestId: request.requestId, bounds });
    expect(await read).toEqual(bounds);
    expect(worker.packets).toHaveLength(0);
    const pending = expect(source.bounds(8)).rejects.toThrow('session ended');
    await source.dispose();
    await pending;
    worker.emit({ kind: 'bounds-result', requestId: request.requestId, bounds });
  } finally {
    await source.dispose();
  }
});

it('keeps renderer capabilities beside the exact failed publication in the host fault', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const posted = vi.fn();
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
    },
    posted,
  );
  await source.start(canvas);
  const error = {
    code: 'device-operation-failed',
    expected: 'the active device generation completes the renderer-owned operation',
    hint: 'inspect renderer state and the structured cause, then retry or recover',
    detail: { requested: 1, admitted: 0 },
  } as const;
  const renderer = {
    state: 'faulted',
    frameId: 0,
    capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
    limits: { maxStorageBuffersPerShaderStage: 0, maxStorageBufferBindingSize: 0 },
  } as const;
  const publication = { source: 'sdk-source', epoch: 2, revision: 1, frameId: 3 } as const;
  try {
    CreditWorker.current.emit({
      kind: 'failed',
      error,
      renderer,
      stage: 'draw',
      publication,
      recoverable: false,
    });
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'fault',
        detail: {
          cause: error.detail,
          stage: 'draw',
          publication,
          renderer,
        },
      }),
    );
  } finally {
    await source.dispose();
  }
});

it('forwards only the current child Renderer error without consuming publication credit', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const forwarded = vi.fn();
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
    },
    forwarded,
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  const identity = worker.init?.identity;
  if (identity === undefined) throw new Error('Missing child publication identity');
  const error = {
    code: 'device-operation-failed',
    expected: 'valid GPU command',
    hint: 'inspect the GPU error',
    detail: { operation: 'renderer-event', cause: { code: 'gpu-validation-error' } },
  } as const;
  const renderer = {
    state: 'alive',
    frameId: 3,
    capabilities: { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
    limits: { maxStorageBuffersPerShaderStage: 0 },
  } as const;
  try {
    forwarded.mockClear();
    worker.emit({
      kind: 'renderer-error',
      identity: { ...identity, source: 'other-source' },
      error,
    });
    worker.emit({
      kind: 'renderer-error',
      identity: { ...identity, epoch: identity.epoch + 1 },
      error,
    });
    expect(forwarded).not.toHaveBeenCalled();
    worker.emit({ kind: 'renderer-error', identity, error, renderer });
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveBeenCalledWith({
      kind: 'render-error',
      identity,
      worldIdentity: world.identity,
      error,
      renderer,
    });
    const frame: ExecutionFrameMessage = {
      kind: 'frame',
      worldIdentity: world.identity,
      frameId: 1,
      deltaSeconds: 0,
      canvasWidth: 32,
      canvasHeight: 32,
      inputSample: {
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      },
    };
    source.publish(frame, 0);
    source.publish({ ...frame, frameId: 2 }, 1);
    expect(worker.packets.map((packet) => packet.frameId)).toEqual([1, 2]);
    expect(() => source.publish({ ...frame, frameId: 3 }, 2)).toThrow();
    expect(forwarded).toHaveBeenCalledTimes(1);
  } finally {
    await source.dispose();
  }
  const delivered = forwarded.mock.calls.length;
  worker.emit({ kind: 'renderer-error', identity, error, renderer });
  expect(forwarded).toHaveBeenCalledTimes(delivered);
});

async function inspectionOwner() {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      canvas,
      startupTimeoutMs: 90_000,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
    },
    () => {},
  );
  return { source, world, canvas };
}
const inspectedFacts = {
  profile: { renderPath: 'deferred' },
  perFramePassNames: ['lighting', 'ssr-compose'],
  capabilities: { backendKind: 'webgpu' },
  frame: { frameId: 7, deviceGeneration: 0 },
  extraOwnerFacts: { preserved: true },
};
function packetAt(worker: CreditWorker, index: number) {
  const packet = worker.packets[index];
  if (packet === undefined) throw new Error(`missing publication ${index}`);
  return packet;
}

function inspectionReply(request: Extract<RenderWorkerInput, { kind: 'inspect' }>) {
  return {
    kind: 'inspect-result',
    requestId: request.requestId,
    identity: request.identity,
    worldIdentity: request.worldIdentity,
    result: { ok: true, value: inspectedFacts },
  };
}
function inspectionRequest(worker: CreditWorker): Extract<RenderWorkerInput, { kind: 'inspect' }> {
  const request = [...worker.controls].reverse().find((row) => row.kind === 'inspect');
  if (request?.kind !== 'inspect') throw new Error('No actual inspection request');
  return request;
}
it('rejects before-ready inspection without starting a child or drawing', async () => {
  const { source } = await inspectionOwner();
  try {
    expect(await source.inspectRenderer()).toMatchObject({ ok: false });
  } finally {
    await source.dispose();
  }
});
it('carries selected inspection fields to the child without adding frame work', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const pending = source.inspectRenderer({
      fields: ['frame', 'pipelineLibrary'],
      runtimeRequests: true,
    });
    const request = inspectionRequest(worker);
    expect(request.fields).toEqual(['frame', 'pipelineLibrary']);
    expect(request.runtimeRequests).toBe(true);
    const value = { frame: inspectedFacts.frame, pipelineLibrary: undefined };
    worker.emit({ ...inspectionReply(request), result: { ok: true, value } });
    expect(await pending).toEqual({ ok: true, value });
    expect(worker.packets).toEqual([]);
  } finally {
    await source.dispose();
  }
});
it('fences child inspection by request, source, epoch and World without touching frame credits', async () => {
  const { source, canvas, world } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    let settled = false;
    const pending = source.inspectRenderer({ pipelineLibrary: true });
    void pending.then(() => {
      settled = true;
    });
    const request = inspectionRequest(worker);
    expect(request.worldIdentity).toBe(world.identity);
    expect(request.pipelineLibrary).toBe(true);
    expect(worker.init?.worldIdentity).toBe(world.identity);
    for (const changed of [
      { ...inspectionReply(request), requestId: request.requestId + 1 },
      { ...inspectionReply(request), identity: { ...request.identity, source: 'other' } },
      {
        ...inspectionReply(request),
        identity: { ...request.identity, epoch: request.identity.epoch + 1 },
      },
      { ...inspectionReply(request), worldIdentity: 'old-world' },
    ])
      worker.emit(changed);
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit(inspectionReply(request));
    expect(await pending).toEqual({ ok: true, value: inspectedFacts });
    expect(worker.packets).toEqual([]);
  } finally {
    await source.dispose();
  }
});
it('cancels a pending child read and discards its late result', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current,
    controller = new AbortController();
  try {
    const pending = source.inspectRenderer({ signal: controller.signal });
    const old = inspectionRequest(worker);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false });
    const next = source.inspectRenderer();
    const fresh = inspectionRequest(worker);
    expect(fresh.requestId).toBeGreaterThan(old.requestId);
    worker.emit(inspectionReply(old));
    worker.emit(inspectionReply(fresh));
    expect(await next).toEqual({ ok: true, value: inspectedFacts });
  } finally {
    await source.dispose();
  }
});
it('settles pending inspection on child loss and refuses old-session reads', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const pending = source.inspectRenderer();
    worker.emit({
      kind: 'failed',
      stage: 'draw',
      error: { code: 'fixture-failure', expected: 'live', hint: 'preserve' },
      recoverable: false,
    });
    expect(await pending).toMatchObject({ ok: false });
    expect(await source.inspectRenderer()).toMatchObject({ ok: false });
  } finally {
    await source.dispose();
  }
});
it('settles pending inspection immediately when disposal fences the child', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const pending = source.inspectRenderer();
  const disposal = source.dispose();
  expect(await pending).toMatchObject({ ok: false });
  await disposal;
  expect(await source.inspectRenderer()).toMatchObject({ ok: false });
});
it('bounds the new child inspection read at 30000ms without waiting for a frame', async () => {
  vi.useFakeTimers();
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  try {
    const pending = source.inspectRenderer();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ ok: false, error: { detail: { reason: 'timeout' } } });
    expect(CreditWorker.current.packets).toEqual([]);
  } finally {
    await source.dispose();
  }
});

it('returns the child request transport failure without issuing a frame', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current;
  const send = vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => {
    throw new Error('inspection-send');
  });
  try {
    expect(await source.inspectRenderer()).toMatchObject({
      ok: false,
      error: { detail: { reason: 'transport' } },
    });
    expect(worker.packets).toEqual([]);
  } finally {
    send.mockRestore();
    await source.dispose();
  }
});

it('rejects an already-aborted read and bounds outstanding reads at 32', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current,
    controller = new AbortController();
  controller.abort();
  expect(await source.inspectRenderer({ signal: controller.signal })).toMatchObject({
    ok: false,
    error: { detail: { reason: 'cancelled' } },
  });
  const pending = Array.from({ length: 32 }, () => source.inspectRenderer());
  expect(worker.controls.filter((row) => row.kind === 'inspect')).toHaveLength(32);
  expect(await source.inspectRenderer()).toMatchObject({
    ok: false,
    error: { detail: { reason: 'request-limit' } },
  });
  await source.dispose();
  expect(
    (await Promise.all(pending)).every((row) => !row.ok && row.error.detail.reason === 'disposed'),
  ).toBe(true);
  expect(worker.packets).toEqual([]);
});

it('fences the old actual child after recovery while the new read remains attached', async () => {
  const { source, canvas } = await inspectionOwner();
  await source.start(canvas);
  const oldWorker = CreditWorker.current,
    oldPending = source.inspectRenderer();
  const oldRequest = inspectionRequest(oldWorker);
  oldWorker.emit({
    kind: 'failed',
    stage: 'draw',
    error: { code: 'lost', expected: 'alive', hint: 'recover' },
    recoverable: true,
  });
  expect(await oldPending).toMatchObject({ ok: false });
  await source.replace(oldRequest.identity.epoch + 1, canvas);
  const freshWorker = CreditWorker.current,
    pending = source.inspectRenderer();
  const freshRequest = inspectionRequest(freshWorker);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  try {
    oldWorker.emit(inspectionReply(freshRequest));
    await Promise.resolve();
    expect(settled).toBe(false);
    freshWorker.emit(inspectionReply(freshRequest));
    expect(await pending).toEqual({ ok: true, value: inspectedFacts });
    expect(oldWorker.packets).toEqual([]);
    expect(freshWorker.packets).toEqual([]);
  } finally {
    await source.dispose();
  }
});

it('bounds one geometry observation, validates its source epoch and cancels without consuming publication credit', async () => {
  const { source, canvas, world } = await inspectionOwner();
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const abort = new AbortController();
    const pending = source.observeNextGeometry({ signal: abort.signal });
    const request = worker.controls.find((row) => row.kind === 'geometry-observe-next');
    if (request?.kind !== 'geometry-observe-next') throw Error('No geometry request');
    expect(request.worldIdentity).toBe(world.identity);
    expect((await source.observeNextGeometry()).ok).toBe(false);
    expect(worker.packets).toHaveLength(0);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    worker.emit({
      kind: 'geometry-observation-result',
      requestId: request.requestId,
      identity: { ...request.identity, epoch: 99 },
      worldIdentity: world.identity,
      result: { ok: true, value: { frameId: 99 } },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    abort.abort();
    expect((await pending).ok).toBe(false);
    expect(worker.controls).toContainEqual({
      kind: 'geometry-observe-cancel',
      requestId: request.requestId,
    });
    const next = source.observeNextGeometry();
    const wanted = worker.controls.filter((row) => row.kind === 'geometry-observe-next').at(-1);
    if (wanted?.kind !== 'geometry-observe-next') throw Error('No next request');
    worker.emit({
      kind: 'geometry-observation-result',
      requestId: wanted.requestId,
      identity: wanted.identity,
      worldIdentity: world.identity,
      result: { ok: true, value: { frameId: 7, status: 'complete', commands: [] } },
    });
    expect(await next).toMatchObject({ ok: true, value: { frameId: 7 } });
  } finally {
    await source.dispose();
  }
});
