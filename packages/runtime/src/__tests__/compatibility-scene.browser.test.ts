import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  ANTIALIAS_FXAA,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  type Renderer,
} from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-render/internal/construct-renderer';
import type { PipelineLibraryManifest, RhiAdapter, RhiInstance } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, onTestFailed } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  attachStandardPbrSkin,
  standardPbrSkinMaterial,
  standardPbrSkinMesh,
} from './helpers/standard-pbr-skin-subject';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function pixelOracle(bytes: Uint8Array, format: string, width: number, height: number) {
  if (format !== 'rgba16float' && format !== 'rgba8unorm')
    throw new Error(`Unexpected scene format ${format}`);
  const half = format === 'rgba16float';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const center: [number, number, number] = [0, 0, 0];
  const readChannel = (offset: number) =>
    half ? halfFloat.f16ToF32(view.getUint16(offset, true)) : view.getUint8(offset) / 255;
  let blueCount = 0;
  let blueY = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * (half ? 8 : 4);
      const stride = half ? 2 : 1;
      const r = readChannel(offset);
      const g = readChannel(offset + stride);
      const b = readChannel(offset + 2 * stride);
      expect([r, g, b].every(Number.isFinite)).toBe(true);
      if (x >= 28 && x < 36 && y >= 28 && y < 36) {
        center[0] += r;
        center[1] += g;
        center[2] += b;
      }
      if (x >= 42 && x < 54 && b > 0.03 && b > 1.5 * r && b > 1.5 * g) {
        blueCount++;
        blueY += y;
      }
    }
  return { center, blueCount, blueY: blueY / blueCount };
}

function assertScenePixels(images: Uint8Array[], oracles: ReturnType<typeof pixelOracle>[]) {
  expect(images).toHaveLength(2);
  expect(images[0]).not.toEqual(images[1]);
  const [red, green] = oracles;
  if (red === undefined || green === undefined) throw new Error('Missing scene controls');
  expect(red.center[0]).toBeGreaterThan(1.5 * (red.center[1] ?? 0));
  expect(green.center[1]).toBeGreaterThan(1.5 * (green.center[0] ?? 0));
  expect(red.blueCount).toBeGreaterThan(4);
  expect(green.blueCount).toBeGreaterThan(4);
  expect(Math.abs(red.blueY - green.blueY)).toBeGreaterThan(2);
  for (const image of images)
    expect(image.some((value, i) => i % 4 !== 3 && value > 20)).toBe(true);
}

/** Advertise a real, requestable core minimum; the native device enforces it. */
function minimumBackend(
  compatibility: boolean,
): RhiInstance & { readonly disposeDevice: typeof webgpu.disposeDevice } {
  return {
    ...webgpu.rhi,
    disposeDevice: webgpu.disposeDevice,
    async requestAdapter(options) {
      const selected = await webgpu.rhi.requestAdapter({
        ...options,
        featureLevel: compatibility ? 'compatibility' : 'core',
      });
      if (!selected.ok) return selected;
      const adapter = selected.value;
      const features = new Set<GPUFeatureName>(['depth32float-stencil8']);
      const bounded: RhiAdapter = {
        ...adapter,
        features,
        limits: {
          ...adapter.limits,
          maxSampledTexturesPerShaderStage: 16,
          maxColorAttachmentBytesPerSample: compatibility ? 16 : 32,
          maxComputeWorkgroupStorageSize: 16384,
        },
        async requestDevice(options) {
          expect(options?.requiredFeatures?.every((feature) => features.has(feature))).toBe(true);
          expect(options?.requiredLimits?.maxSampledTexturesPerShaderStage ?? 16).toBe(16);
          const selected = await adapter.requestDevice(options);
          if (selected.ok) {
            expect(selected.value.limits.maxSampledTexturesPerShaderStage).toBe(16);
            expect(selected.value.features.has('timestamp-query')).toBe(false);
            expect(selected.value.features.has('float32-filterable')).toBe(false);
            if (compatibility)
              expect(selected.value.features.has('core-features-and-limits')).toBe(false);
          }
          return selected;
        },
      };
      return ok(bounded);
    },
  };
}

/** Detached failure facts only; never await another fence or retain a scene inventory. */
function sceneFailureDiagnostics(renderer: Renderer) {
  const errorFact = (cause: unknown, depth = 0): unknown => {
    try {
      if (cause === null || typeof cause !== 'object') return String(cause).slice(0, 1024);
      const input = cause as Record<string, unknown>,
        output: Record<string, unknown> = {};
      for (const key of [
        'name',
        'message',
        'stack',
        'code',
        'expected',
        'hint',
        'reason',
        'operation',
      ]) {
        const field = input[key];
        if (typeof field === 'string') output[key] = field.slice(0, key === 'stack' ? 2048 : 1024);
      }
      if (depth < 2)
        for (const key of ['cause', 'error', 'detail', 'webgpuError']) {
          if (input[key] !== undefined) output[key] = errorFact(input[key], depth + 1);
        }
      return output;
    } catch {
      return { diagnosticError: 'Error projection unavailable' };
    }
  };
  type Signal = {
    state: 'absent' | 'pending' | 'ok' | 'error' | 'rejected';
    error?: unknown;
    phase?: string;
    settledAtMs?: number;
  };
  type Receipt = {
    frameId: number;
    deviceGeneration: number;
    presentation: string;
    submittedAtMs: number;
    pendingReason: unknown;
    preparation: Signal;
    completion: Signal;
  };
  const receipts: Receipt[] = [],
    nativeEvents: { phase: string; kind: string; atMs: number; detail: unknown }[] = [];
  let phase = 'scene',
    nativeStatus: unknown = 'not-observed';
  const safe = (action: () => void) => {
    try {
      action();
    } catch {
      /* Diagnostics cannot replace the original failure. */
    }
  };
  const nativeEvent = (kind: string, detail: unknown) => {
    nativeEvents.push({ phase, kind, atMs: performance.now(), detail });
    if (nativeEvents.length > 4) nativeEvents.shift();
  };
  const watch = (
    signal: import('@forgeax/engine-render').FrameReceipt['completed'] | undefined,
  ): Signal => {
    const result: Signal = { state: signal === undefined ? 'absent' : 'pending' };
    void signal?.then(
      (value) =>
        safe(() => {
          result.state = value.ok ? 'ok' : 'error';
          result.phase = phase;
          result.settledAtMs = performance.now();
          if (!value.ok) result.error = errorFact(value.error);
        }),
      (cause) =>
        safe(() => {
          result.state = 'rejected';
          result.phase = phase;
          result.settledAtMs = performance.now();
          result.error = errorFact(cause);
        }),
    );
    return result;
  };
  let unsubscribe = () => {
    /* No listener if diagnostic subscription is unavailable. */
  };
  safe(() => {
    unsubscribe = renderer.subscribe((event) =>
      safe(() => {
        if (event.kind !== 'frame-submitted') return;
        const receipt = event.receipt;
        receipts.push({
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          presentation: receipt.presentation,
          submittedAtMs: performance.now(),
          pendingReason:
            receipt.presentationPendingReason === undefined
              ? null
              : { ...receipt.presentationPendingReason },
          preparation: watch(receipt.preparationCompleted),
          completion: watch(receipt.completed),
        });
        if (receipts.length > 4) receipts.shift();
      }),
    );
  });
  let device: GPUDevice | undefined;
  const onUncaptured = (event: GPUUncapturedErrorEvent) =>
    safe(() => nativeEvent('uncapturederror', errorFact(event.error)));
  safe(() => {
    const selected = renderer.nativeDevice();
    if (!selected.ok) {
      nativeStatus = errorFact(selected.error);
      return;
    }
    nativeStatus = 'observed-initial-device';
    device = selected.value;
    device.addEventListener('uncapturederror', onUncaptured);
    void device.lost.then(
      (loss) =>
        safe(() =>
          nativeEvent('device-lost', { reason: loss.reason, message: loss.message.slice(0, 1024) }),
        ),
      (cause) => safe(() => nativeEvent('device-lost-rejected', errorFact(cause))),
    );
  });
  return {
    errorFact,
    freeze() {
      const pod: { renderer: unknown; [key: string]: unknown } = {
        phase: 'before-dispose',
        observedAtMs: performance.now(),
        nativeStatus,
        nativeEvents,
        receipts,
        renderer: null,
      };
      try {
        const inspection = renderer.inspect({
          fields: ['state', 'recovery', 'pipelineLibrary'],
          runtimeRequests: true,
        });
        const library = inspection.pipelineLibrary,
          history = library?.runtimeRequests;
        pod.renderer = {
          state: inspection.state,
          recovery: inspection.recovery,
          pipelineLibrary:
            library === undefined
              ? null
              : {
                  state: library.state,
                  renderPipelines: library.renderPipelines,
                  computePipelines: library.computePipelines,
                  synchronousCreations: library.synchronousCreations,
                  asynchronousCreations: library.asynchronousCreations,
                  compilationCompleted: library.compilationCompleted,
                  compilationPending: library.compilationPending,
                  failures: library.failures,
                  overflow: library.overflow,
                  runtimeRequests:
                    history === undefined
                      ? null
                      : {
                          libraryId: history.libraryId,
                          capacity: history.capacity,
                          overwritten: history.overwritten,
                          latestSequence: history.latestSequence,
                          observedAtMs: history.observedAtMs,
                          total: history.requests.length,
                          truncated: Math.max(0, history.requests.length - 32),
                          requests: history.requests.slice(-32).map((row) => ({
                            sequence: row.sequence,
                            mode: row.mode,
                            kind: row.kind,
                            label: row.label?.slice(0, 256) ?? null,
                            origin: row.origin,
                            preloadAtDemand: row.preloadAtDemand,
                            requestedAtMs: row.requestedAtMs,
                            demandedAtMs: row.demandedAtMs,
                            startedAtMs: row.startedAtMs,
                            completedAtMs: row.completedAtMs,
                            outcome: row.outcome,
                            pipeline:
                              row.pipeline === null
                                ? null
                                : {
                                    localIdentity: row.pipeline.localIdentity,
                                    identity: row.pipeline.identity,
                                    kind: row.pipeline.kind,
                                    preload: row.pipeline.preload,
                                  },
                          })),
                        },
                },
        };
      } catch (cause) {
        // An inspection failure must not discard native events or receipt settlements.
        pod.renderer = { diagnosticError: errorFact(cause) };
      }
      try {
        // Promise observers may settle during disposal; never rewrite the first-failure snapshot.
        return JSON.parse(JSON.stringify(pod)) as unknown;
      } catch (cause) {
        return { diagnosticError: errorFact(cause) };
      }
    },
    beginDispose() {
      // This label starts at disposal entry, including destroy-induced loss during its await.
      phase = 'after-dispose';
      safe(unsubscribe);
    },
    stop() {
      safe(() => device?.removeEventListener('uncapturederror', onUncaptured));
    },
    lateNativeEvents() {
      return nativeEvents.filter((row) => row.phase === 'after-dispose');
    },
  };
}

async function scene(library?: PipelineLibraryManifest, fallback = false) {
  const webkit = import.meta.env.FORGEAX_COMPAT_WEBKIT;
  const backend = minimumBackend(false);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const initialization = constructRuntimeRendererHost(canvas, {
    ...(webkit || fallback ? {} : { rhi: backend }),
    ...(library === undefined ? {} : { pipelineLibrary: library }),
  });
  const host = value(await initialization);
  const { renderer, assets } = host;
  const failures: unknown[] = [];
  const diagnostics = sceneFailureDiagnostics(renderer);
  let firstFailure: unknown;
  onTestFailed(() => {
    try {
      // biome-ignore lint/suspicious/noConsole: Preserve explicit bounded POD; a key whitelist drops native/receipt facts.
      console.log(
        JSON.stringify({
          kind: 'compatibility-scene-failure',
          fallback,
          imported: library !== undefined,
          failures: failures.slice(0, 8).map((cause) => diagnostics.errorFact(cause)),
          failuresTotal: failures.length,
          oracles,
          completedFrames,
          firstFailure,
          afterDisposeNativeEvents: diagnostics.lateNativeEvents(),
        }),
      );
    } catch {
      /* Reporting must not hide the original test failure. */
    }
  });
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') failures.push(event.error);
  });
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1.5, 1.5, 0.2).unwrap()).unwrap();
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format: 'rgba8unorm',
      data: new Uint8Array([
        255, 255, 255, 255, 180, 180, 180, 255, 180, 180, 180, 255, 255, 255, 255, 255,
      ]),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    })
    .unwrap();
  const material = assets
    .create(
      Materials.standard({
        baseColor: [1, 0.1, 0.1, 1],
        baseColorTexture: texture,
        roughness: 0.7,
        metallic: 0,
      }),
    )
    .unwrap();
  const subject = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const skinMesh = assets
    .create(standardPbrSkinMesh(createBoxGeometry(0.5, 0.5, 0.2).unwrap()))
    .unwrap();
  const skinMaterial = assets
    .create(standardPbrSkinMaterial(Materials.standard({ baseColor: [0.1, 0.2, 1, 1] })))
    .unwrap();
  const skinned = world
    .spawn(
      { component: Transform, data: { pos: [1.3, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: skinMesh } },
      { component: MeshRenderer, data: { materials: [skinMaterial] } },
    )
    .unwrap();
  const { joint } = attachStandardPbrSkin(world, assets, skinned, [1.3, 0, 0]);
  const transparent = assets
    .create(
      Materials.standard({
        baseColor: [0.2, 0.4, 1, 0.5],
        queue: 3000,
        renderState: {
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      }),
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [-1.3, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: skinMesh } },
      { component: MeshRenderer, data: { materials: [transparent] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -1, 0], scale: [3, 0.1, 2] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: 128,
          cascadeCount: 1,
          shadowDistance: 15,
          intensity: 3,
          direction: [-0.5, -1, -0.3],
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 50 }),
          antialias: ANTIALIAS_FXAA,
        },
      },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  const images: Uint8Array[] = [];
  const oracles: ReturnType<typeof pixelOracle>[] = [];
  let completedFrames = 0;
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe(
      webkit || fallback ? 'wgpu-webgl2' : 'webgpu',
    );
    for (let frame = 0; frame < 60; frame++) {
      if (frame === 30) {
        assets.update(material, { values: { baseColor: [0.1, 1, 0.1, 1] } }).unwrap();
        world.set(subject, Transform, { pos: [0.2, 0, 0] }).unwrap();
        world.set(joint, Transform, { pos: [1.3, 0.5, 0] }).unwrap();
      }
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const capture = frame === 29 || frame === 59;
      const receipt = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        capture ? ['linear-ldr'] : undefined,
        library !== undefined && frame === 0 ? { preparationCompleted: initialization } : undefined,
      );
      completedFrames++;
      if (capture) {
        const observed = value(await renderer.observe(receipt, { include: ['linear-ldr'] }));
        const output = observed.observations?.find((row) => row.domain === 'linear-ldr');
        if (output === undefined) throw new Error('Missing actual scene pixels');
        images.push(output.bytes.slice());
        oracles.push(
          pixelOracle(
            output.bytes,
            output.metadata.format,
            output.metadata.width,
            output.metadata.height,
          ),
        );
      }
    }
    expect(completedFrames).toBe(60);
    assertScenePixels(images, oracles);
    expect(failures).toEqual([]);
    const inspection = renderer.inspect({ pipelineLibrary: !webkit && !fallback });
    if (!webkit && !fallback) {
      expect(inspection.pipelineLibraryManifest?.renderPipelines.length).toBeGreaterThan(0);
      expect(inspection.pipelineLibraryManifest?.shaders.length).toBeGreaterThan(0);
    }
    // biome-ignore lint/suspicious/noConsole: Completed-frame, backend and archive evidence belongs to this gate.
    console.log(
      JSON.stringify({
        kind: 'compatibility-scene',
        backend: inspection.capabilities.backendKind,
        imported: library !== undefined,
        fallback,
        completedFrames,
        oracles,
        pipelines: inspection.pipelineLibraryManifest?.renderPipelines.length,
      }),
    );
    return inspection.pipelineLibraryManifest;
  } catch (cause) {
    failures.push(cause);
    firstFailure = diagnostics.freeze();
    throw cause;
  } finally {
    unsubscribe();
    diagnostics.beginDispose();
    try {
      await renderer.dispose();
    } finally {
      diagnostics.stop();
    }
    canvas.remove();
  }
}

it('renders changing Standard, skinned shadow and FXAA output for sixty completed frames, then reimports the actual archive', {
  timeout: 120_000,
}, async () => {
  const manifest = await scene();
  if (!import.meta.env.FORGEAX_COMPAT_WEBKIT) {
    if (manifest === undefined) throw new Error('Missing exported scene archive');
    await scene(JSON.parse(JSON.stringify(manifest)));
  }
});

if (!import.meta.env.FORGEAX_COMPAT_WEBKIT) {
  it('refuses unsupported stock shaders before claiming the canvas on a real compatibility device', async () => {
    const canvas = document.createElement('canvas');
    const created = await constructRuntimeRendererHost(canvas, { rhi: minimumBackend(true) });
    try {
      expect(created.ok).toBe(false);
      if (created.ok) throw new Error('Unsupported native mode was admitted');
      expect(created.error).toBeInstanceOf(EngineEnvironmentError);
      if (!(created.error instanceof EngineEnvironmentError)) throw created.error;
      const cause = created.error.detail.webgpuError;
      expect(cause).toBeInstanceOf(RhiError);
      if (!(cause instanceof RhiError)) throw cause;
      expect(cause.code).toBe('feature-not-enabled');
      expect(cause.expected).toContain('caps.depthTextureLoad');
      expect(canvas.getContext('webgl2')).not.toBeNull();
    } finally {
      if (created.ok) await created.value.renderer.dispose();
      canvas.remove();
    }
  });

  it('automatically falls back from a real restricted native device and completes the changing WebGL2 scene', async () => {
    const gpu = navigator.gpu;
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
    let nativeRequests = 0;
    const nativeCoreFeatures: boolean[] = [];
    const nativeLosses: string[] = [];
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: new Proxy(gpu, {
        get(target, key) {
          if (key === 'requestAdapter')
            return async (options?: GPURequestAdapterOptions) => {
              nativeRequests++;
              const requested = { ...options, featureLevel: 'compatibility' };
              const adapter = await target.requestAdapter(requested);
              if (adapter === null) return null;
              return new Proxy(adapter, {
                get(target, key) {
                  if (key === 'requestDevice')
                    return async (options?: GPUDeviceDescriptor) => {
                      const device = await target.requestDevice(options);
                      nativeCoreFeatures.push(device.features.has('core-features-and-limits'));
                      device.lost.then((info) => nativeLosses.push(info.reason));
                      return device;
                    };
                  const item = Reflect.get(target, key, target);
                  return typeof item === 'function' ? item.bind(target) : item;
                },
              });
            };
          const item = Reflect.get(target, key, target);
          return typeof item === 'function' ? item.bind(target) : item;
        },
      }),
    });
    try {
      await scene(undefined, true);
      expect(nativeRequests).toBeGreaterThan(0);
      expect(nativeCoreFeatures.length).toBeGreaterThan(0);
      expect(nativeCoreFeatures.every((core) => !core)).toBe(true);
      expect(nativeLosses).toEqual(nativeCoreFeatures.map(() => 'destroyed'));
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor);
      else Reflect.deleteProperty(navigator, 'gpu');
    }
  });
}
