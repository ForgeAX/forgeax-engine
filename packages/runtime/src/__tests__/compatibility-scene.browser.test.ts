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
  onTestFailed(() => {
    // biome-ignore lint/suspicious/noConsole: Preserve nested native validation before the browser retires.
    console.log(
      JSON.stringify(
        { kind: 'compatibility-scene-failure', fallback, failures, oracles, completedFrames },
        [
          'kind',
          'fallback',
          'failures',
          'oracles',
          'center',
          'blueCount',
          'blueY',
          'completedFrames',
          'name',
          'message',
          'code',
          'detail',
          'expected',
          'hint',
          'cause',
          'operation',
          'error',
          'reason',
        ],
      ),
    );
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
    throw cause;
  } finally {
    unsubscribe();
    await renderer.dispose();
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
