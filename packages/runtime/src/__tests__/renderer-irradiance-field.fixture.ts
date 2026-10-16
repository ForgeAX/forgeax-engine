import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type StandardDiffuseGi,
  type StandardIrradianceFieldGi,
  type StandardProbeClipmap,
} from '@forgeax/engine-render';
import { RhiError, type RhiInstance } from '@forgeax/engine-rhi';
import { halfToFloat } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { assert } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import {
  createProbeGlobalMesh,
  probeGlobalProfile,
} from '../../../render/src/__tests__/raytracing/probe-global.fixture';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

export const SIZE = 32;

/** Every probe and Card tile updates each frame so convergence is frame-exact
 * unless `cardBudget` slices the Card capture across frames. */
export const irradianceFieldGi = (
  overrides: {
    readonly environment?: readonly [number, number, number];
    readonly radiosity?: boolean;
    readonly resolution?: 'full' | 'half';
    readonly hysteresis?: number;
    readonly cardBudget?: number;
    readonly maxDistance?: number;
    readonly probeBudget?: number;
    readonly raysPerProbe?: number;
    readonly clipmap?: StandardProbeClipmap;
  } = {},
): StandardIrradianceFieldGi => ({
  gather: 'irradiance-field',
  maxDistance: 100,
  environment: overrides.environment ?? [0, 0, 0],
  field: {
    region: {
      grid: {
        ...probeGlobalProfile.grid,
        maxDistance: overrides.maxDistance ?? probeGlobalProfile.grid.maxDistance,
      },
      maxInstances: probeGlobalProfile.maxInstances,
      maxFieldBytes: probeGlobalProfile.maxFieldBytes,
    },
    probeSpacing: 1,
    raysPerProbe: overrides.raysPerProbe ?? testQuality.irradianceRaysPerProbe,
    probeBudget: overrides.probeBudget ?? 512,
    hysteresis: overrides.hysteresis ?? 0.5,
    cards: {
      resolution: testQuality.reflectionResolution,
      maxCaptureBytes: 4 * 1024 * 1024,
      budget: overrides.cardBudget ?? 4096,
    },
    resolution: overrides.resolution ?? 'half',
    radiosity: overrides.radiosity ?? true,
    ...(overrides.clipmap === undefined ? {} : { clipmap: overrides.clipmap }),
  },
});

export interface FieldImage {
  readonly bytes: Uint8Array;
  /** Linear HDR red per pixel, row-major. */
  readonly red: Float32Array;
  readonly mean: number;
  readonly center: number;
}

type DiffuseGiState = NonNullable<ReturnType<Renderer['inspect']>['diffuseGi']>;

/**
 * `FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1` (the native wgpu CI lane): every settled field must
 * trace with Ray Query, so a missing adapter feature or a Global SDF fallback fails instead of
 * passing the traversal-agnostic assertions.
 */
function requireNativeRayQuery(state: DiffuseGiState): void {
  if (process.env.FORGEAX_REQUIRE_NATIVE_RAY_QUERY !== '1') return;
  // The exact RayDiffuse reference lane has no traversal choice: it only runs on Ray Query.
  if (!('gather' in state)) return;
  const field =
    state.gather === 'screen-probe'
      ? state.field
      : state.gather === 'irradiance-field'
        ? state
        : undefined;
  if (field?.traversal !== 'ray-query')
    throw new Error(
      `FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1 requires traversal 'ray-query': ${JSON.stringify({
        gather: state.gather,
        traversal: field?.traversal,
        fallback: field?.traversalFallback,
      })}`,
    );
}

/** Ordinary Renderer over a white wall facing the camera plus a white floor. */
export async function createIrradianceFieldHarness(options: {
  readonly rhi: RhiInstance;
  readonly manifest: string;
  readonly host?: Record<string, unknown>;
  readonly instrumentation?: Record<string, unknown>;
}) {
  const errors: unknown[] = [];
  let native: GPUDevice | undefined;
  let surface: GPUTexture | undefined;
  let format: GPUTextureFormat = 'rgba8unorm';
  let rejectSubmit = false;
  let loseDevice: (() => void) | undefined;
  const buffers = new Map<string, GPUBuffer>();
  const destroyed = new Set<GPUBuffer>();
  /** Every per-instance Card buffer ever created: residency streaming must destroy them. */
  const cardBuffers: GPUBuffer[] = [];
  const makeSurface = () => {
    assert(native);
    surface?.destroy();
    surface = native.createTexture({
      size: [canvas.width, canvas.height],
      format,
      viewFormats: [format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
      usage: 0x11,
    });
    return surface;
  };
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        native = config.device;
        format = config.format;
        native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const create = native.createBuffer.bind(native);
        native.createBuffer = (descriptor) => {
          const buffer = create(descriptor);
          const label = descriptor.label ?? '';
          const card = label.startsWith('cards.');
          if (card) cardBuffers.push(buffer);
          if (card || label.startsWith('irradiance-field.')) {
            if (!card) buffers.set(label, buffer);
            const destroy = buffer.destroy.bind(buffer);
            buffer.destroy = () => {
              destroyed.add(buffer);
              destroy();
            };
          }
          return buffer;
        };
        makeSurface();
      },
      unconfigure() {},
      getCurrentTexture: () =>
        surface?.width === canvas.width && surface.height === canvas.height
          ? surface
          : makeSurface(),
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: options.rhi,
        ...options.host,
        rhiInstrumentation: {
          ...options.instrumentation,
          deviceLost: () =>
            new Promise((resolve) => {
              loseDevice = () =>
                resolve({ reason: 'unknown', message: 'host-injected irradiance field loss' });
            }),
          beforeSubmit: () => {
            if (!rejectSubmit) return undefined;
            rejectSubmit = false;
            return new RhiError({
              code: 'queue-submit-failed',
              expected: 'injected irradiance field submission failure',
              hint: 'retry the frame',
            });
          },
        },
      },
      { shaderManifestUrl: options.manifest },
    ),
  );
  const { renderer } = host;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const publish = async (guid: string, source: MaterialAsset) => {
    const cooked = await createMaterialPackCooker().cook({ guid, source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid, record, artifacts: cooked.artifacts }),
      loadReference: async () => true,
    }).load({ guid, specializationKey: record.specializationKey ?? '' });
    assert(ready.status === 'Ready');
    host.assets.catalog(guid, source).unwrap();
    host.assets.recordMaterialReadiness(guid, ready);
    return world.allocSharedRef('MaterialAsset', source);
  };
  const white = await publish(
    'irradiance-field-white',
    Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 1, specular: 0 }),
  );
  const emissive = await publish(
    'irradiance-field-emitter',
    Materials.standard({
      baseColor: [0, 0, 0, 1],
      roughness: 1,
      specular: 0,
      emissive: [1, 1, 1],
      emissiveIntensity: 4,
    }),
  );
  const slab = async (width: number, height: number, depth: number) =>
    world.allocSharedRef('MeshAsset', await createProbeGlobalMesh(width, height, depth));
  const spawn = (
    mesh: Awaited<ReturnType<typeof slab>>,
    material: typeof white,
    pos: readonly [number, number, number],
  ) =>
    world
      .spawn(
        { component: Transform, data: { pos: [...pos] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  // The wall spans the whole region, so nothing behind it is visible around its edge.
  const wall = spawn(await slab(8, 8, 0.25), white, [0, 0, -3]);
  const floorMesh = await slab(8, 0.25, 8);
  const emitterMesh = await slab(4, 4, 0.25);
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 50,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 0, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const base = {
    ...renderer.inspect().profile,
    renderPath: 'deferred' as const,
    ibl: false,
    ssao: false,
    visibleSurface: true,
  };
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: 'direct',
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const result = submit();
    if (!result.ok)
      throw new Error(JSON.stringify({ result, gi: renderer.inspect().diffuseGi, errors }));
    renderValue(await result.value.completed);
    return result.value;
  };
  const inspection = (): DiffuseGiState => {
    const gi = renderer.inspect().diffuseGi;
    assert(gi, 'Renderer exposes its GI preparation state');
    return gi;
  };
  /** Ready, submitted, then `frames` further full-field updates. */
  const settle = async (frames = 12) => {
    const started = performance.now();
    for (;;) {
      await draw();
      const state = renderer.inspect().diffuseGi;
      if (state?.state === 'failed') throw new Error(JSON.stringify({ state, errors }));
      if (state?.state === 'ready' && state.submittedFrames > 0) {
        requireNativeRayQuery(state);
        break;
      }
      if (performance.now() - started > 120000)
        throw new Error(`irradiance field did not settle: ${JSON.stringify({ state, errors })}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < frames; i++) await draw();
  };
  const image = async (): Promise<FieldImage> => {
    assert(renderer.requestObservation);
    renderValue(renderer.requestObservation(['linear-hdr']));
    const receipt = await draw();
    const item = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((entry) => entry.domain === 'linear-hdr');
    assert(item);
    const data = new DataView(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength);
    const { width, height } = canvas;
    const red = new Float32Array(width * height);
    let sum = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const value = halfToFloat(data.getUint16(y * item.metadata.bytesPerRow + x * 8, true));
        red[y * width + x] = value;
        sum += value;
      }
    return {
      bytes: item.bytes,
      red,
      mean: sum / red.length,
      center: red[(height / 2) * width + width / 2] ?? Number.NaN,
    };
  };
  /**
   * The presented surface after one more frame, sRGB-decoded red. Unlike `image()`
   * it also covers CameraView composition, which has no linear-HDR observation.
   */
  const surfaceImage = async (): Promise<FieldImage> => {
    await draw();
    assert(native && surface);
    const { width, height } = canvas;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const target = native.createBuffer({ size: bytesPerRow * height, usage: 9 });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: surface }, { buffer: target, bytesPerRow }, [
        width,
        height,
      ]);
      native.queue.submit([encoder.finish()]);
      await target.mapAsync(1);
      const bytes = new Uint8Array(target.getMappedRange().slice(0));
      const channel = format === 'bgra8unorm' ? 2 : 0;
      const red = new Float32Array(width * height);
      let sum = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const c = (bytes[y * bytesPerRow + x * 4 + channel] ?? 0) / 255;
          const value = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          red[y * width + x] = value;
          sum += value;
        }
      return {
        bytes,
        red,
        mean: sum / red.length,
        center: red[(height / 2) * width + width / 2] ?? Number.NaN,
      };
    } finally {
      target.destroy();
    }
  };
  const read = async (label: string) => {
    const source = buffers.get(`irradiance-field.${label}`);
    assert(native && source, `missing irradiance-field.${label}`);
    const target = native.createBuffer({ size: source.size, usage: 9 });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, target, 0, source.size);
      native.queue.submit([encoder.finish()]);
      await target.mapAsync(1);
      return new Float32Array(target.getMappedRange().slice(0));
    } finally {
      target.destroy();
    }
  };
  return {
    renderer,
    assets: host.assets,
    world,
    canvas,
    errors,
    base,
    wall,
    camera,
    publish,
    white,
    emissive,
    floorMesh,
    emitterMesh,
    slab,
    sun,
    spawn,
    submit,
    draw,
    settle,
    image,
    surfaceImage,
    read,
    inspection,
    // Pass presence needs consecutive completed frames, not a benchmark's
    // repeated median sampling. Preserve structured timestamp unavailability.
    async steadyPasses() {
      const frames: string[][] = [];
      for (let i = 0; i < 2; i++) {
        const timings = renderValue(
          await renderer.observe(await draw(), { include: ['timings'] }),
        ).timings;
        assert(timings);
        if (timings.status !== 'complete' && timings.status !== 'partial') return timings;
        frames.push(
          timings.frame.passes
            .filter((pass) => pass.status === 'measured')
            .map((pass) => pass.passName),
        );
      }
      return frames;
    },
    setSun: (intensity: number) => world.set(sun, DirectionalLight, { intensity }).unwrap(),
    setGi: (gi: StandardDiffuseGi | undefined) =>
      renderValue(renderer.setProfile(gi === undefined ? base : { ...base, diffuseGi: gi })),
    rejectNextSubmit: () => {
      rejectSubmit = true;
    },
    loseDevice: () => {
      assert(loseDevice);
      loseDevice();
    },
    native: () => native,
    liveBuffers: () => [...buffers.values()].filter((buffer) => !destroyed.has(buffer)),
    destroyed,
    liveCardBuffers: () => cardBuffers.filter((buffer) => !destroyed.has(buffer)),
    createdCardBuffers: () => cardBuffers.length,
    async dispose() {
      unsubscribe();
      lease.dispose();
      renderValue(await renderer.dispose());
      surface?.destroy();
      native?.destroy();
    },
  };
}
