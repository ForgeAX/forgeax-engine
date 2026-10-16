import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  _internal_getRawDevice,
  createShaderModule,
  rhi,
  translateErrorEventToRhiError as translateWebgpuError,
} from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { shaderManifestUrl } from '../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  TONEMAP_LINEAR,
} from '../../components';
import { constructRendererHost, type RhiBackendPack } from '../../construct-renderer';
import { Materials } from '../../materials';
import { DEFAULT_STANDARD_PROFILE } from '../../pipeline/standard-profile';
import type { FrameReceipt } from '../../render-contract';

const WIDTH = 32;
const HEIGHT = 32;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_MAP_MODE_READ = 0x0001;
const TEST_REACTIVE = 0;
const LIGHTWEIGHT_DAWN = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
const ROSTER_SMOKE = process.env.FORGEAX_DAWN_ROSTER_SMOKE === '1';
const requestedSmokeFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const ROSTER_SMOKE_FRAMES =
  Number.isInteger(requestedSmokeFrames) && requestedSmokeFrames > 0 ? requestedSmokeFrames : 60;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);
const DAWN_BACKEND: RhiBackendPack = {
  rhi,
  createShaderModule,
  _internal_getRawDevice,
  translateErrorEventToRhiError: translateWebgpuError as NonNullable<
    RhiBackendPack['translateErrorEventToRhiError']
  >,
};

interface TransmissionCase {
  readonly name: string;
  readonly transmission: number;
  readonly ior: number;
  readonly thickness: number;
  readonly roughness: number;
  readonly attenuationColor: readonly [number, number, number];
  readonly attenuationDistance?: number;
  readonly transmissionTexture?: number;
  readonly thicknessTexture?: number;
  readonly masked?: boolean;
  readonly overlap?: boolean;
  readonly renderPath?: 'forward' | 'deferred';
  readonly surfaceQuat?: readonly [number, number, number, number];
  readonly directionalLight?: boolean;
  readonly localLight?: boolean;
  readonly splitBackdrop?: boolean;
  /** Clamp the device below the dedicated 21-texture transmission layout. */
  readonly sampledTextureLimit?: number;
  /** Author a split metallic map, which owns a shared-transmission host pair. */
  readonly metallicTexture?: boolean;
}

function textureAsset(value: number): TextureAsset {
  const channel = Math.round(value * 255);
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    data: Uint8Array.from([channel, channel, channel, 255]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

async function readCenter(
  device: GPUDevice,
  target: GPUTexture,
): Promise<[number, number, number, number]> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const readback = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPU_MAP_MODE_READ);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const offset = Math.floor(HEIGHT / 2) * bytesPerRow + Math.floor(WIDTH / 2) * 4;
  return [
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  ];
}

async function renderCase(
  testCase: TransmissionCase,
  frameCount = 1,
): Promise<{
  readonly pixel: readonly [number, number, number, number];
  readonly passNames: readonly string[];
  readonly observation: boolean;
  readonly errors: readonly string[];
  readonly errorEvents: readonly { readonly code: string; readonly detail?: unknown }[];
  readonly framesObserved: number;
}> {
  let device: GPUDevice | undefined;
  let configuredDevice: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const next = await requestDevice(
        testCase.sampledTextureLimit === undefined
          ? descriptor
          : {
              ...descriptor,
              requiredLimits: {
                ...descriptor?.requiredLimits,
                maxSampledTexturesPerShaderStage: testCase.sampledTextureLimit,
              },
            },
      );
      device ??= next;
      return next;
    };
    return adapter;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          configuredDevice ??= desc.device;
          target ??= desc.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_RENDER_ATTACHMENT,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (target === undefined) throw new Error('render target was not configured');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let host: Awaited<ReturnType<typeof constructRendererHost>>;
  try {
    host = await constructRendererHost(
      canvas,
      {
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: testCase.renderPath ?? DEFAULT_STANDARD_PROFILE.renderPath,
        },
      },
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
      DAWN_BACKEND,
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  expect(host.ok).toBe(true);
  if (!host.ok || device === undefined) {
    throw new Error('runtime Dawn renderer was not ready');
  }

  const { renderer } = host.value;
  const errors: { readonly code: string; readonly detail?: unknown }[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const world = new World();
    const lease = renderer.attach(world);
    if (!lease.ok) throw lease.error;
    const plane = createPlaneGeometry(2, 2);
    if (!plane.ok) throw plane.error;
    const mesh = world.allocSharedRef('MeshAsset', {
      ...plane.value,
      materialSlots: [{ slotName: 'Default' }],
    });
    const transmissionHandle =
      testCase.transmissionTexture === undefined
        ? undefined
        : world.allocSharedRef('TextureAsset', textureAsset(testCase.transmissionTexture));
    const thicknessHandle =
      testCase.thicknessTexture === undefined
        ? undefined
        : world.allocSharedRef('TextureAsset', textureAsset(testCase.thicknessTexture));
    const material = Materials.standard({
      baseColor: [0.7, 0.8, 0.9, testCase.masked ? 0.35 : 1],
      metallic: 0,
      roughness: testCase.roughness,
      transmission: testCase.transmission,
      ior: testCase.ior,
      thickness: testCase.thickness,
      attenuationColor: testCase.attenuationColor,
      ...(testCase.attenuationDistance === undefined
        ? {}
        : { attenuationDistance: testCase.attenuationDistance }),
      ...(testCase.masked
        ? {
            queue: 2450,
            alphaCutoff: 0.5,
            baseColorTexture: {
              texture: world.allocSharedRef('TextureAsset', {
                kind: 'texture',
                width: 2,
                height: 2,
                format: 'rgba8unorm',
                data: Uint8Array.from([
                  255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0,
                ]),
                colorSpace: 'linear',
                mipmap: false,
              }),
            },
          }
        : { queue: 2000 }),
      ...(testCase.surfaceQuat === undefined ? {} : { renderState: { cullMode: 'none' as const } }),
      ...(transmissionHandle === undefined
        ? {}
        : { transmissionTexture: { texture: transmissionHandle as never } }),
      ...(thicknessHandle === undefined
        ? {}
        : { thicknessTexture: { texture: thicknessHandle as never } }),
      ...(testCase.metallicTexture === true
        ? {
            metallicTexture: {
              texture: world.allocSharedRef('TextureAsset', textureAsset(0)) as never,
            },
          }
        : {}),
    });
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    const meshEntity = world.spawn(
      {
        component: Transform,
        data: testCase.surfaceQuat === undefined ? {} : { quat: testCase.surfaceQuat },
      },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    expect(meshEntity.ok, `${testCase.name}: mesh spawn must succeed`).toBe(true);
    if (!meshEntity.ok) throw meshEntity.error;
    if (testCase.overlap) {
      const overlay = Materials.unlit([0.1, 0.9, 0.2, 0.35], {
        queue: 3000,
        renderState: {
          cullMode: 'none',
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      });
      const overlayHandle = world.allocSharedRef('MaterialAsset', overlay);
      const overlayEntity = world.spawn(
        { component: Transform, data: { pos: [0, 0, -0.1] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [overlayHandle] } },
      );
      expect(overlayEntity.ok, `${testCase.name}: overlay spawn must succeed`).toBe(true);
      if (!overlayEntity.ok) throw overlayEntity.error;
    }
    if (testCase.splitBackdrop) {
      for (const [color, y] of [
        [[1, 0, 0, 1], 2],
        [[0, 0, 1, 1], -2],
      ] as const) {
        const half = world.allocSharedRef('MaterialAsset', Materials.unlit(color));
        const halfEntity = world.spawn(
          { component: Transform, data: { pos: [0, y, -2], scale: [3, 2, 1] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [half] } },
        );
        expect(halfEntity.ok, `${testCase.name}: backdrop spawn must succeed`).toBe(true);
        if (!halfEntity.ok) throw halfEntity.error;
      }
    }
    const cameraEntity = world.spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 10,
          tonemap: TONEMAP_LINEAR,
          clearColor: [0.05, 0.1, 0.15, 1],
        },
      },
    );
    expect(cameraEntity.ok, `${testCase.name}: camera spawn must succeed`).toBe(true);
    if (!cameraEntity.ok) throw cameraEntity.error;
    if (testCase.directionalLight !== false) {
      const lightEntity = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
      });
      expect(lightEntity.ok, `${testCase.name}: light spawn must succeed`).toBe(true);
      if (!lightEntity.ok) throw lightEntity.error;
    }
    if (testCase.localLight === true) {
      const localLightEntity = world.spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: PointLight, data: { intensity: 8, range: 10 } },
      );
      expect(localLightEntity.ok, `${testCase.name}: local light spawn must succeed`).toBe(true);
      if (!localLightEntity.ok) throw localLightEntity.error;
    }
    if (!Number.isSafeInteger(frameCount) || frameCount < 1)
      throw new Error(`invalid transmission frame count: ${frameCount}`);
    world.update().unwrap();
    let lastDraw: FrameReceipt | undefined;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (frame > 0) world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [lease.value],
        camera: { lease: lease.value },
        environment: { lease: lease.value },
      });
      expect(
        drawn.ok,
        drawn.ok ? undefined : JSON.stringify({ error: drawn.error, events: errors }),
      ).toBe(true);
      if (!drawn.ok) throw drawn.error;
      const completed = await drawn.value.completed;
      expect(completed.ok, completed.ok ? undefined : JSON.stringify(completed.error)).toBe(true);
      if (!completed.ok) throw completed.error;
      lastDraw = drawn.value;
    }
    if (lastDraw === undefined) throw new Error('transmission smoke did not submit a frame');
    const observation = await renderer.observe(lastDraw, { include: ['draws', 'bindings'] });
    expect(observation.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (target === undefined) throw new Error('render target was not configured after draw');
    const renderDevice = configuredDevice ?? device;
    if (testCase.sampledTextureLimit !== undefined)
      expect(renderDevice.limits.maxSampledTexturesPerShaderStage).toBe(
        testCase.sampledTextureLimit,
      );
    const passNames = renderer.inspect().perFramePassNames;
    expect(renderer.inspect().renderScene.projectionRecords).toBeGreaterThanOrEqual(1);
    return {
      pixel: await readCenter(renderDevice, target),
      passNames,
      observation: observation.ok,
      errors: errors.map((error) => error.code),
      errorEvents: errors,
      framesObserved: frameCount,
    };
  } finally {
    unsubscribe();
    await device.queue.onSubmittedWorkDone();
    await renderer.dispose();
    target?.destroy();
    device.destroy();
    expect((await device.lost).reason).toBe('destroyed');
  }
}

function luma(pixel: readonly [number, number, number, number]): number {
  return 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
}

describe('Standard transmission Dawn ROI', () => {
  it('completes a 60-frame transmission stream without renderer errors', async () => {
    const result = await renderCase(
      {
        name: 'sustained-transmission',
        transmission: 1,
        ior: 1.5,
        thickness: 0.5,
        roughness: 0.3,
        attenuationColor: [0.7, 0.8, 0.9],
        attenuationDistance: 2,
        renderPath: 'forward',
      },
      60,
    );
    expect(result.framesObserved).toBe(60);
    expect(result.errors).toEqual([]);
    expect(result.observation).toBe(true);
    expect(result.passNames).toContain('transmission-forward');
    expect(result.pixel.every(Number.isFinite)).toBe(true);
    process.stdout.write(
      `[transmission-smoke-frames] ${JSON.stringify({ framesObserved: result.framesObserved })}\n`,
    );
  }, 120_000);

  it('uses linear HDR observation and responds to F0, Beer, texture, TIR, and fallback inputs', async () => {
    const baseline = await renderCase({
      name: 'baseline',
      transmission: 0,
      ior: 1.5,
      thickness: 0,
      roughness: 0.5,
      attenuationColor: [1, 1, 1],
    });
    const transmitted = await renderCase({
      name: 'transmitted',
      transmission: 1,
      ior: 1.5,
      thickness: 0.5,
      roughness: 0.5,
      attenuationColor: [0.1, 0.4, 0.8],
      attenuationDistance: 1,
      transmissionTexture: 1,
      thicknessTexture: 1,
    });
    const tir = await renderCase({
      name: 'total-internal-reflection',
      transmission: 1,
      ior: 1.5,
      thickness: 0.5,
      roughness: 0.5,
      attenuationColor: [0.1, 0.4, 0.8],
      attenuationDistance: 1,
      transmissionTexture: 1,
      thicknessTexture: 1,
      // Back side at a grazing angle: eta=ior exercises TIR. The old case
      // duplicated the air-to-glass inputs (eta=1/ior), where TIR is impossible.
      surfaceQuat: [0, Math.sin((Math.PI * 235) / 360), 0, Math.cos((Math.PI * 235) / 360)],
    });

    expect(baseline.passNames).not.toContain('transmission-forward');
    expect(transmitted.passNames).toContain('linear-hdr-observation');
    expect(transmitted.passNames).toContain('transmission-forward');
    expect(transmitted.observation).toBe(true);
    expect(transmitted.pixel.every(Number.isFinite)).toBe(true);
    expect(transmitted.pixel).not.toEqual(baseline.pixel);
    expect(tir.pixel).not.toEqual(transmitted.pixel);
    expect(TEST_REACTIVE).toBe(0);
  }, 120_000);

  it('keeps IOR, thickness, and roughness monotonic in a finite linear ROI', async () => {
    const fullCases = [
      {
        name: 'ior-low',
        transmission: 1,
        ior: 1.1,
        thickness: 0.1,
        roughness: 0.1,
        attenuationColor: [0.8, 0.8, 0.8],
        attenuationDistance: 4,
      },
      {
        name: 'ior-high',
        transmission: 1,
        ior: 2.2,
        thickness: 0.1,
        roughness: 0.1,
        attenuationColor: [0.8, 0.8, 0.8],
        attenuationDistance: 4,
      },
      {
        name: 'thick',
        transmission: 1,
        ior: 1.5,
        thickness: 1.5,
        roughness: 0.1,
        attenuationColor: [0.1, 0.1, 0.1],
        attenuationDistance: 1,
      },
      {
        name: 'rough',
        transmission: 1,
        ior: 1.5,
        thickness: 0.1,
        roughness: 0.9,
        attenuationColor: [0.8, 0.8, 0.8],
        attenuationDistance: 4,
      },
    ] as const;
    // Browser parity still exercises every transmission fixture. The PR
    // Dawn lane keeps the low/high IOR and roughness boundaries, while the
    // full local/nightly lane retains the thickness case as well.
    const selectedCases = LIGHTWEIGHT_DAWN ? [fullCases[0], fullCases[1], fullCases[3]] : fullCases;
    // Each fixture temporarily owns navigator.gpu.requestAdapter. Run it to
    // completion before installing the next hook or allocating its device.
    const cases = [];
    for (const testCase of selectedCases) cases.push(await renderCase(testCase));
    for (const result of cases) expect(result.pixel.every(Number.isFinite)).toBe(true);
    expect(cases[1]?.pixel).not.toEqual(cases[0]?.pixel);
    if (!LIGHTWEIGHT_DAWN) expect(cases[2]?.pixel).not.toEqual(cases[0]?.pixel);
    const rough = LIGHTWEIGHT_DAWN ? cases[2] : cases[3];
    expect(luma(rough?.pixel ?? [0, 0, 0, 0])).toBeLessThanOrEqual(
      luma(cases[0]?.pixel ?? [0, 0, 0, 0]) + 2,
    );
  }, 120_000);

  it('samples the backdrop where the refracted ray exits, in screen orientation', async () => {
    // Rotating +Z by +30 deg about X tilts the glass normal down (y < 0). The
    // ray refracts toward -normal, so its exit point rises and the center pixel
    // must read the red upper backdrop half; the mirrored tilt reads blue. A
    // world-space xy offset added to screen UV (V points down) inverts both.
    const half = Math.PI / 12;
    const tilted = (sign: 1 | -1) =>
      renderCase({
        name: sign > 0 ? 'tilt-down-normal' : 'tilt-up-normal',
        transmission: 1,
        ior: 1.5,
        thickness: 3,
        roughness: 0,
        attenuationColor: [1, 1, 1],
        surfaceQuat: [sign * Math.sin(half), 0, 0, Math.cos(half)],
        directionalLight: false,
        splitBackdrop: true,
      });
    const up = await tilted(1);
    const down = await tilted(-1);
    expect(up.errors).toEqual([]);
    expect(down.errors).toEqual([]);
    expect(up.pixel[0], `tilt-down-normal center ${up.pixel}`).toBeGreaterThan(up.pixel[2] + 32);
    expect(down.pixel[2], `tilt-up-normal center ${down.pixel}`).toBeGreaterThan(
      down.pixel[0] + 32,
    );
  }, 120_000);

  it('exercises both Standard render paths and transmission-before-BLEND overlap order', async () => {
    const forward = await renderCase({
      name: 'forward',
      transmission: 1,
      ior: 1.5,
      thickness: 0.5,
      roughness: 0.3,
      attenuationColor: [0.7, 0.8, 0.9],
      attenuationDistance: 2,
      overlap: true,
      renderPath: 'forward',
    });
    const deferred = await renderCase({
      name: 'deferred',
      transmission: 1,
      ior: 1.5,
      thickness: 0.5,
      roughness: 0.3,
      attenuationColor: [0.7, 0.8, 0.9],
      attenuationDistance: 2,
      overlap: true,
      renderPath: 'deferred',
    });
    const transmissionIndex = forward.passNames.indexOf('transmission-forward');
    const transparentIndex = forward.passNames.indexOf('transparent');
    expect(transmissionIndex).toBeGreaterThanOrEqual(0);
    expect(transparentIndex).toBeGreaterThan(transmissionIndex);
    expect(deferred.pixel.every(Number.isFinite)).toBe(true);
    expect(forward.pixel.every(Number.isFinite)).toBe(true);
  }, 120_000);

  it('submits a real clustered local-light frame through the Standard front door', async () => {
    const clustered = await renderCase({
      name: 'clustered-local-light',
      transmission: 0,
      ior: 1.5,
      thickness: 0,
      roughness: 0.4,
      attenuationColor: [1, 1, 1],
      directionalLight: false,
      localLight: true,
      renderPath: 'forward',
    });

    expect(clustered.passNames).toEqual(
      expect.arrayContaining(['cluster-membership-producer', 'main', 'output-transform']),
    );
    expect(clustered.observation).toBe(true);
    expect(clustered.errors).toEqual([]);
  }, 120_000);

  it('refracts through the shared-slot variant at a 16-texture limit', async () => {
    // The tilted glass reads the red upper backdrop half (see the screen
    // orientation case). No light keeps every channel below saturation, so the
    // parity check and both falsifiers compare unclamped transmission output.
    const half = Math.PI / 12;
    const glass = (
      name: string,
      options: {
        readonly sign?: 1 | -1;
        readonly transmissionTexture?: number;
        readonly sampledTextureLimit?: number;
      } = {},
    ): TransmissionCase => ({
      name,
      transmission: 1,
      ior: 1.5,
      thickness: 3,
      roughness: 0,
      attenuationColor: [1, 1, 1],
      transmissionTexture: options.transmissionTexture ?? 1,
      thicknessTexture: 1,
      surfaceQuat: [(options.sign ?? 1) * Math.sin(half), 0, 0, Math.cos(half)],
      directionalLight: false,
      splitBackdrop: true,
      renderPath: 'forward',
      ...(options.sampledTextureLimit === undefined
        ? {}
        : { sampledTextureLimit: options.sampledTextureLimit }),
    });
    const full = await renderCase(glass('full-limit'));
    const shared = await renderCase(glass('shared-slots', { sampledTextureLimit: 16 }));
    const mirrored = await renderCase(
      glass('shared-slots-mirrored', { sign: -1, sampledTextureLimit: 16 }),
    );
    const masked = await renderCase(
      glass('shared-slots-zero-map', { transmissionTexture: 0, sampledTextureLimit: 16 }),
    );

    expect(shared.errors).toEqual([]);
    expect(shared.observation).toBe(true);
    expect(shared.passNames).toContain('transmission-forward');
    expect(shared.pixel[0], `shared center ${shared.pixel}`).toBeGreaterThan(shared.pixel[2] + 32);
    expect(shared.pixel[0]).toBeLessThan(255);
    // Only binding numbers move, so the two limits resolve the same pixel.
    for (let channel = 0; channel < 3; channel += 1)
      expect(
        Math.abs((shared.pixel[channel] ?? 0) - (full.pixel[channel] ?? 0)),
      ).toBeLessThanOrEqual(2);
    // Falsifiers: the backdrop at binding 22 follows the refracted exit point,
    // and the transmission map at the shared pair scales the refracted term.
    expect(mirrored.pixel[2], `mirrored center ${mirrored.pixel}`).toBeGreaterThan(
      mirrored.pixel[0] + 32,
    );
    expect(masked.pixel[0], `zero-map center ${masked.pixel}`).toBeLessThan(shared.pixel[0] - 32);
  }, 120_000);

  it('reports and falls back when a split scalar map owns a shared slot', async () => {
    const half = Math.PI / 12;
    const budgetCase = (
      name: string,
      transmission: number,
      sampledTextureLimit?: number,
    ): TransmissionCase => ({
      name,
      transmission,
      ior: 1.5,
      thickness: transmission === 0 ? 0 : 3,
      roughness: 0,
      attenuationColor: [1, 1, 1],
      surfaceQuat: [Math.sin(half), 0, 0, Math.cos(half)],
      directionalLight: false,
      splitBackdrop: true,
      renderPath: 'forward',
      metallicTexture: true,
      ...(sampledTextureLimit === undefined ? {} : { sampledTextureLimit }),
    });
    const dedicated = await renderCase(budgetCase('budget-dedicated', 1));
    const exceeded = await renderCase(budgetCase('budget-exceeded', 1, 16), 3);
    const opaque = await renderCase(budgetCase('budget-opaque', 0, 16));

    expect(dedicated.errors).toEqual([]);
    expect(exceeded.errors).toEqual(['material-sampled-texture-budget-exceeded']);
    expect(exceeded.errorEvents[0]?.detail).toMatchObject({
      limit: 16,
      required: 21,
      conflicts: ['metallicTexture'],
    });
    expect(opaque.errors).toEqual([]);
    for (let channel = 0; channel < 3; channel += 1)
      expect(
        Math.abs((exceeded.pixel[channel] ?? 0) - (opaque.pixel[channel] ?? 0)),
      ).toBeLessThanOrEqual(2);
    // Falsifier: the same material refracts the red backdrop at the full limit.
    expect(dedicated.pixel[0], `dedicated center ${dedicated.pixel}`).toBeGreaterThan(
      exceeded.pixel[0] + 32,
    );
  }, 120_000);

  if (ROSTER_SMOKE) {
    it('emits the canonical 60-frame Dawn roster receipt', async () => {
      const result = await renderCase(
        {
          name: 'roster-stability',
          transmission: 1,
          ior: 1.5,
          thickness: 0.5,
          roughness: 0.4,
          attenuationColor: [0.7, 0.8, 0.9],
          attenuationDistance: 2,
          renderPath: 'forward',
        },
        ROSTER_SMOKE_FRAMES,
      );
      expect(result.framesObserved).toBeGreaterThanOrEqual(60);
      expect(result.observation).toBe(true);
      expect(result.errors).toEqual([]);
      process.stdout.write(`[smoke] frames observed=${result.framesObserved}\n`);
      process.stdout.write(
        `[smoke] PASS - transmission stability frames=${result.framesObserved}\n`,
      );
    }, 120_000);
  }
});
