import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { deviceOptionsForAdapter } from '../../../../render/src/assembly/device-feature-admission';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { testAssets } from '../helpers/runtime-assets';
import { shaderManifestUrl } from '../shader-manifest-url.fixture';

// Dawn/Metal writes (0,0,0,0) for a fragment discarded inside a nested WGSL
// callee instead of leaving the pixel. A fully clipped quad over a non-black
// clear colour must therefore leave the clear colour untouched on every path
// that clips (cutoff, alpha hash, alpha to coverage, shadow casting).
const SIZE = 64;
const CLEAR = [0.2, 0.4, 0.6, 1] as const;
const CLEAR_USAGE = 0x10 | 0x01;
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

interface Scene {
  readonly material: 'standard' | 'unlit' | 'skin';
  readonly alpha: number;
  readonly cutoff?: number;
  readonly hash?: boolean;
  readonly alphaToCoverage?: boolean;
  /** Clipped caster over a lit receiver; the caster is omitted for the baseline. */
  readonly shadow?: 'caster' | 'baseline';
  /** Temporal anti-aliasing: the scene-temporal target is the observed output. */
  readonly temporal?: boolean;
}

interface Probe<T> {
  readonly recorder?: RecorderAttachment;
  readonly frames: number;
  readonly finish: (context: {
    readonly device: GPUDevice;
    readonly target: GPUTexture;
    readonly recorder: RecorderAttachment | undefined;
    readonly capture: ReturnType<RecorderAttachment['captureFrame']> | undefined;
  }) => Promise<T>;
}

type Assets = ReturnType<typeof testAssets>;

function clippedMaterial(scene: Scene) {
  const clipOptions = {
    queue: 2450,
    renderState: {
      cullMode: 'none' as const,
      ...(scene.alphaToCoverage === true ? { alphaToCoverageEnabled: true } : {}),
    },
    ...(scene.cutoff === undefined ? {} : { alphaCutoff: scene.cutoff }),
    ...(scene.hash === true ? { alphaHash: true } : {}),
  };
  const clipped =
    scene.material === 'unlit'
      ? Materials.unlit([1, 1, 1, scene.alpha], clipOptions)
      : Materials.standard({
          baseColor: [1, 1, 1, scene.alpha],
          emissive: [1, 1, 1],
          emissiveIntensity: 1,
          ...clipOptions,
        });
  if (clipped.passes === undefined) throw new Error('material root passes are required');
  if (scene.material !== 'skin') return clipped;
  return {
    ...clipped,
    passes: clipped.passes.map((pass) => ({
      ...pass,
      program: { ...pass.program, module: 'forgeax::pbr-skin' },
    })) as unknown as NonNullable<typeof clipped.passes>,
  };
}

function skinnedPlane() {
  const plane = createPlaneGeometry(1.2, 1.2).unwrap();
  const positions = plane.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('Missing plane positions');
  const count = positions.length / 3;
  const attributes = {
    ...plane.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  };
  return {
    ...plane,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
  };
}

function skinObject(world: World, assets: Assets, object: Parameters<World['addComponent']>[0]) {
  const joint = world.spawn({ component: Transform, data: {} }).unwrap();
  const inverseBindMatrices = new Float32Array(16);
  for (const lane of [0, 5, 10, 15]) inverseBindMatrices[lane] = 1;
  const skeleton = assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices,
      bounds: new Float32Array([-2, -2, -0.1, 2, 2, 0.1]),
    })
    .unwrap();
  world
    .addComponent(object, { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } })
    .unwrap();
}

function spawnCaster(world: World, assets: Assets, scene: Scene): void {
  const plane = scene.material === 'skin' ? skinnedPlane() : createPlaneGeometry(1.2, 1.2).unwrap();
  const object = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: assets.create(plane).unwrap() } },
      {
        component: MeshRenderer,
        data: { materials: [assets.create(clippedMaterial(scene)).unwrap()] },
      },
    )
    .unwrap();
  if (scene.material === 'skin') skinObject(world, assets, object);
}

function spawnReceiver(world: World, assets: Assets): void {
  const ground = assets.create(createPlaneGeometry(6, 6).unwrap()).unwrap();
  const groundMaterial = assets
    .create(Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 1, metallic: 0 }))
    .unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, -1] } },
    { component: MeshFilter, data: { assetHandle: ground } },
    { component: MeshRenderer, data: { materials: [groundMaterial] } },
  );
}

function antialiasOf(scene: Scene): number {
  if (scene.temporal === true) return 3;
  return scene.alphaToCoverage === true ? ANTIALIAS_MSAA : ANTIALIAS_NONE;
}

function spawnScene(world: World, assets: Assets, scene: Scene): void {
  if (scene.shadow !== undefined) spawnReceiver(world, assets);
  if (scene.shadow !== 'baseline') spawnCaster(world, assets, scene);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 20,
        clearColor: CLEAR,
        antialias: antialiasOf(scene),
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [0, 0, -1],
      color: [1, 1, 1],
      intensity: 3,
      castShadow: scene.shadow !== undefined,
    },
  });
}

async function withScene<T>(scene: Scene, probe: Probe<T>): Promise<T> {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function')
    throw new Error('dawn-node WebGPU unavailable');
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const original = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await original(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const next = await requestDevice(descriptor);
      device ??= next;
      return next;
    };
    return adapter;
  };
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          target ??= desc.device.createTexture({
            size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: CLEAR_USAGE,
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
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(
      canvas,
      probe.recorder === undefined ? {} : { rhi: probe.recorder.backend.rhi },
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = original;
  }
  if (!host.ok || device === undefined) throw new Error('runtime Dawn renderer not ready');
  const { renderer } = host.value;
  try {
    const world = new World();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    spawnScene(world, testAssets(world), scene);
    world.update().unwrap();
    propagateTransforms(world).unwrap();
    if (scene.temporal === true) {
      const profile = renderer.inspect().profile;
      const set = renderer.setProfile({ ...profile, renderPath: 'forward', ssao: false });
      if (!set.ok) throw set.error;
    }
    let capture: ReturnType<RecorderAttachment['captureFrame']> | undefined;
    for (let frame = 0; frame < probe.frames; frame++) {
      const last = frame === probe.frames - 1;
      const pending = last ? probe.recorder?.captureFrame() : undefined;
      if (pending !== undefined && probe.recorder !== undefined)
        (await probe.recorder.frameBoundary()).unwrap();
      await drawReadyFrame(renderer, {
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      });
      if (pending !== undefined && probe.recorder !== undefined)
        (await probe.recorder.frameBoundary()).unwrap();
      capture = pending ?? capture;
    }
    await device.queue.onSubmittedWorkDone();
    if (target === undefined) throw new Error('runtime Dawn render target not configured');
    return await probe.finish({ device, target, recorder: probe.recorder, capture });
  } finally {
    const disposed = await renderer.dispose();
    target?.destroy();
    expect(disposed.ok).toBe(true);
  }
}

async function readColor(device: GPUDevice, target: GPUTexture): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * SIZE, usage: MAP_READ | COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer, bytesPerRow, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const packed = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    packed.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + SIZE * 4), y * SIZE * 4);
  return packed;
}

const render = (scene: Scene): Promise<Uint8Array> =>
  withScene(scene, { frames: 1, finish: ({ device, target }) => readColor(device, target) });

/** Fraction of the central region the scene-temporal target marks as uncovered (z < 0). */
async function uncoveredTemporalFraction(scene: Scene): Promise<number> {
  const recorder = attachRecorder(webgpu).unwrap();
  try {
    return await withScene(
      { ...scene, temporal: true },
      {
        recorder,
        frames: 4,
        async finish({ capture }) {
          if (capture === undefined) throw new Error('missing frame capture');
          const tape = decodeTape((await capture).unwrap().bytes).unwrap();
          const model = buildFrameModel(tape);
          const producer = model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_temporal'),
          );
          if (producer?.attachments === undefined) throw new Error('missing fs_temporal work');
          const id = producer.attachments.colorViewHandleIds[0];
          if (id === undefined) throw new Error('missing temporal attachment');
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
          const replay = (
            await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
          ).unwrap();
          try {
            const temporal = (await replay.readResourceAtWork(id, producer.workIndex)).unwrap();
            expect(temporal.format).toBe('rgba16float');
            const view = new DataView(
              temporal.bytes.buffer,
              temporal.bytes.byteOffset,
              temporal.bytes.byteLength,
            );
            const width = temporal.width ?? SIZE;
            const height = temporal.height ?? SIZE;
            let uncovered = 0;
            let total = 0;
            for (let y = Math.floor(height * 0.375); y < Math.floor(height * 0.625); y++)
              for (let x = Math.floor(width * 0.375); x < Math.floor(width * 0.625); x++) {
                total++;
                if (halfFloat.f16ToF32(view.getUint16((y * width + x) * 8 + 4, true)) < 0)
                  uncovered++;
              }
            return uncovered / total;
          } finally {
            (await replay.dispose()).unwrap();
          }
        },
      },
    );
  } finally {
    (await recorder.dispose()).unwrap();
  }
}

const near = (a: Uint8Array, ai: number, b: Uint8Array, bi: number, tolerance = 3): boolean =>
  [0, 1, 2, 3].every((c) => Math.abs((a[ai + c] ?? 0) - (b[bi + c] ?? 0)) <= tolerance);

/** Fraction of the central quad region whose pixel equals the corner (clear) pixel. */
function clearFraction(pixels: Uint8Array): number {
  let same = 0;
  let total = 0;
  for (let y = 24; y < 40; y++)
    for (let x = 24; x < 40; x++) {
      total++;
      if (near(pixels, (y * SIZE + x) * 4, pixels, (2 * SIZE + 2) * 4)) same++;
    }
  return same / total;
}

function expectClipped(pixels: Uint8Array): void {
  const corner = [0, 1, 2, 3].map((c) => pixels[(2 * SIZE + 2) * 4 + c]);
  // A guard against a vacuous pass: the clear colour is not black.
  expect(Math.max(...corner.slice(0, 3).map((v) => v ?? 0))).toBeGreaterThan(40);
  expect(clearFraction(pixels), `corner=${corner.join(',')}`).toBeGreaterThan(0.97);
}

const TIMEOUT = 120_000;

describe('nested discard keeps clipped pixels on Dawn', () => {
  for (const material of ['standard', 'unlit', 'skin'] as const) {
    it(
      `${material} alpha clip leaves the clear colour`,
      async () => {
        expectClipped(await render({ material, alpha: 0.2, cutoff: 0.5 }));
      },
      TIMEOUT,
    );
    it(
      `${material} alpha hash leaves the clear colour`,
      async () => {
        expectClipped(await render({ material, alpha: 0.001, hash: true }));
      },
      TIMEOUT,
    );
    it(
      `${material} alpha to coverage clips below the cutoff and keeps opaque coverage`,
      async () => {
        expectClipped(await render({ material, alpha: 0.2, cutoff: 0.5, alphaToCoverage: true }));
        const opaque = await render({ material, alpha: 0.95, cutoff: 0.5, alphaToCoverage: true });
        expect(clearFraction(opaque)).toBeLessThan(0.05);
      },
      TIMEOUT,
    );
    it(
      `${material} clipped caster leaves the receiver unshadowed`,
      async () => {
        const baseline = await render({ material, alpha: 0.2, cutoff: 0.5, shadow: 'baseline' });
        const caster = await render({ material, alpha: 0.2, cutoff: 0.5, shadow: 'caster' });
        let same = 0;
        let total = 0;
        for (let y = 24; y < 40; y++)
          for (let x = 24; x < 40; x++) {
            total++;
            if (near(baseline, (y * SIZE + x) * 4, caster, (y * SIZE + x) * 4, 3)) same++;
          }
        expect(same / total).toBeGreaterThan(0.97);
      },
      TIMEOUT,
    );
  }
  for (const material of ['standard', 'unlit', 'skin'] as const) {
    it(
      `${material} clipped fragments stay uncovered in the scene-temporal target`,
      async () => {
        // Positive control: an opaque fragment is covered, so the probe is not vacuous.
        expect(
          await uncoveredTemporalFraction({ material, alpha: 0.95, cutoff: 0.5 }),
        ).toBeLessThan(0.03);
        expect(
          await uncoveredTemporalFraction({ material, alpha: 0.2, cutoff: 0.5 }),
        ).toBeGreaterThan(0.97);
        expect(
          await uncoveredTemporalFraction({ material, alpha: 0.001, hash: true }),
        ).toBeGreaterThan(0.97);
      },
      TIMEOUT,
    );
  }
});
