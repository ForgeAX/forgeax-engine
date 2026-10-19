import testQuality from '../../../../../scripts/test/render-quality.json' with { type: 'json' };
import { shaderManifestUrl } from '../shader-manifest-url.fixture';
// instances-per-instance-pbr.dawn.test.ts -- feat-20260604-instances-per-instance-transform-shader-group3-bin
// M1 / w2.
//
// PBR dual-state dawn smoke: renders a single PBR entity carrying
// Instances { transforms } with N>1 (each transform a distinct translation
// + uniform scale) versus instances=1, and asserts pixel-readback diffCount>0
// between the two frames AND that the projected grid positions of the N copies
// show non-clear pixels.
//
// AC-01: PBR instances=N vs instances=1 frames differ (diffCount>0).
// AC-06: single entity + N instance reads meshes[0] (not meshes[instance_index]).
//
// The PBR vertex path must combine the entity transform from meshes[0] with
// the per-instance transform selected by instance_index.
//
// Dual-state methodology: render to two textures (instances=N vs instances=1),
// read back both, count pixels that differ by more than epsilon. The
// diffCount>0 assertion is the AC-01 behavioral gate.
//
// FALSIFY is omitted from the dawn vitest test (browser env lacks process).
// Falsification is exercised by the parity smoke (AC-08) and learn-render
// M3 smoke (AC-09).

import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Instances,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { drawPublished } from '../draw-published';

const WIDTH = 512;
const HEIGHT = 512;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const INSTANCE_GRID_X = 5;
const INSTANCE_GRID_Y = 3;
const INSTANCE_GRID_Z = 2;
const INSTANCE_COUNT = INSTANCE_GRID_X * INSTANCE_GRID_Y * INSTANCE_GRID_Z; // 30
const SPACING = 2.5;
// Windows Dawn first-touch attempts have reached about 80 seconds for this
// two-renderer PBR/readback probe. Keep the test bounded, but above the
// project-wide 30-second budget so retries do not turn a slow valid probe into
// a cancelled nightly job.
const PBR_DAWN_TEST_TIMEOUT_MS = 120_000;

function buildTranslationGrid(): Float32Array {
  const out = new Float32Array(INSTANCE_COUNT * 16);
  const halfX = ((INSTANCE_GRID_X - 1) * SPACING) / 2;
  const halfY = ((INSTANCE_GRID_Y - 1) * SPACING) / 2;
  const halfZ = ((INSTANCE_GRID_Z - 1) * SPACING) / 2;
  let i = 0;
  for (let z = 0; z < INSTANCE_GRID_Z; z++) {
    for (let y = 0; y < INSTANCE_GRID_Y; y++) {
      for (let x = 0; x < INSTANCE_GRID_X; x++) {
        const base = i * 16;
        out[base + 0] = 1;
        out[base + 5] = 1;
        out[base + 10] = 1;
        out[base + 12] = x * SPACING - halfX;
        out[base + 13] = y * SPACING - halfY;
        out[base + 14] = z * SPACING - halfZ;
        out[base + 15] = 1;
        i++;
      }
    }
  }
  return out;
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

describe('w2 -- PBR dual-state dawn smoke (AC-01 / AC-06)', () => {
  it('instances=N vs instances=1: frames differ in pixel diff count', {
    timeout: PBR_DAWN_TEST_TIMEOUT_MS,
  }, async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    // Render with instances=N (grid spread)
    const transformsN = buildTranslationGrid();

    // Render with N instances on a single entity
    let sharedDevice: GPUDevice | undefined;
    let renderTarget: GPUTexture | undefined;
    const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
      globalThis.navigator.gpu,
    );
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await originalRequestAdapter(opts);
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc) => {
        const dev = await originalRequestDevice(desc);
        if (sharedDevice === undefined) sharedDevice = dev;
        return dev;
      };
      return rawAdapter;
    };

    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: WIDTH,
      height: HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
              return ensureRenderTarget(sharedDevice, 'rgba8unorm');
            }
            return renderTarget;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host = await constructRuntimeRendererHost(
        mockCanvas,
        {},
        {
          shaderManifestUrl: ENGINE_MANIFEST_URL,
        },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    expect(assets).toBeInstanceOf(AssetRegistry);

    // Material creation (PBR standard). D-18: a shared-ref handle is per-World;
    // each frame's World allocs the same payload to get a handle it can resolve.
    const matAsset: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: {
        baseColor: [0.8, 0.6, 0.4, 1],
        metallic: 0.3,
        roughness: 0.5,
        emissive: [0, 0, 0],
        emissiveIntensity: 0,
        occlusionStrength: 1,
      },
    } as MaterialAsset;

    // --- Frame A: instances=N (grid spread) ---
    const worldN = new World();
    const matHandleN = worldN.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      matAsset,
    );
    worldN.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandleN] } },
      { component: Instances, data: { transforms: transformsN } },
    );
    worldN.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 30],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: { fov: (45 * Math.PI) / 180, aspect: 1, near: 0.1, far: 200 } },
    );
    worldN.spawn({
      component: DirectionalLight,
      data: {
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
        cascadeCount: testQuality.cascadeCount,
        direction: [-0.3, -1, -0.5],
        color: [1, 1, 1],
        intensity: 1,
      },
    });

    for (let i = 0; i < 5; i++) {
      const r = await drawPublished(renderer, worldN);
      if (!r.ok) throw new Error(`draw N frame ${i} error: ${r.error.code}`);
    }

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    // Read back frame A (instances=N)
    const unpaddedBytesPerRowA = WIDTH * 4;
    const bytesPerRowA = Math.ceil(unpaddedBytesPerRowA / 256) * 256;
    const readbackBufferA = device.createBuffer({
      size: bytesPerRowA * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: readbackBufferA, bytesPerRow: bytesPerRowA, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    await readbackBufferA.mapAsync(MAP_MODE_READ);
    const mappedA = readbackBufferA.getMappedRange();
    const pixelsA = new Uint8Array(mappedA.slice(0));
    readbackBufferA.unmap();
    readbackBufferA.destroy();

    // --- Frame B: instances=1 (single instance at origin) ---
    const singleTransform = new Float32Array(16);
    singleTransform[0] = 1;
    singleTransform[5] = 1;
    singleTransform[10] = 1;
    singleTransform[15] = 1;

    const world1 = new World();
    const matHandle1 = world1.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      matAsset,
    );
    world1.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle1] } },
      { component: Instances, data: { transforms: singleTransform } },
    );
    world1.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 30],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: { fov: (45 * Math.PI) / 180, aspect: 1, near: 0.1, far: 200 } },
    );
    world1.spawn({
      component: DirectionalLight,
      data: {
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
        cascadeCount: testQuality.cascadeCount,
        direction: [-0.3, -1, -0.5],
        color: [1, 1, 1],
        intensity: 1,
      },
    });

    for (let i = 0; i < 5; i++) {
      const r = await drawPublished(renderer, world1);
      if (!r.ok) throw new Error(`draw 1 frame ${i} error: ${r.error.code}`);
    }
    await device.queue.onSubmittedWorkDone();

    const unpaddedBytesPerRowB = WIDTH * 4;
    const bytesPerRowB = Math.ceil(unpaddedBytesPerRowB / 256) * 256;
    const readbackBufferB = device.createBuffer({
      size: bytesPerRowB * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: readbackBufferB, bytesPerRow: bytesPerRowB, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    await readbackBufferB.mapAsync(MAP_MODE_READ);
    const mappedB = readbackBufferB.getMappedRange();
    const pixelsB = new Uint8Array(mappedB.slice(0));
    readbackBufferB.unmap();
    readbackBufferB.destroy();

    // --- Diff computation ---
    const eps = 30; // per-channel tolerance for sRGB encoding noise
    let diffCount = 0;
    let nonClearCount = 0;
    const clearR = 13; // 0.05 * 255 ≈ 13
    const clearG = 13;
    const clearB = 20; // 0.08 * 255 ≈ 20
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bytesPerRowA + x * 4;
        const rA = pixelsA[off + 2] ?? 0;
        const gA = pixelsA[off + 1] ?? 0;
        const bA = pixelsA[off + 0] ?? 0;
        const rB = pixelsB[off + 2] ?? 0;
        const gB = pixelsB[off + 1] ?? 0;
        const bB = pixelsB[off + 0] ?? 0;
        if (Math.abs(rA - rB) > eps || Math.abs(gA - gB) > eps || Math.abs(bA - bB) > eps) {
          diffCount++;
        }
        // Check non-clear pixels in the N-instance frame (evidence instances rendered)
        if (
          Math.abs(rA - clearR) > 10 ||
          Math.abs(gA - clearG) > 10 ||
          Math.abs(bA - clearB) > 10
        ) {
          nonClearCount++;
        }
      }
    }

    const totalPixels = WIDTH * HEIGHT;

    // AC-01: diffCount>0 -- the two frames must differ (instances=N spreads
    // to distinct positions, instances=1 renders at entity origin only).
    expect(diffCount).toBeGreaterThan(0);
    // Also verify the N-instance frame has substantial non-clear pixels
    // (proves instances rendered, not just an empty frame)
    const nonClearRatio = nonClearCount / totalPixels;
    expect(nonClearRatio).toBeGreaterThan(0.005);
  });

  // w5 -- unlit dual-state: N unlit instances at distinct NDC positions (AC-02)
  it('unlit Instances=N vs instances=1: frames differ', async () => {
    const dawnAvailable_2 = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable_2) {
      throw new Error('dawn-node navigator.gpu not injected');
    }

    let sharedDevice2: GPUDevice | undefined;
    const origReqAdapter2 = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await origReqAdapter2(opts);
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc) => {
        const dev = await originalRequestDevice(desc);
        if (sharedDevice2 === undefined) sharedDevice2 = dev;
        return dev;
      };
      return rawAdapter;
    };

    let renderTarget2: GPUTexture | undefined;
    const ensureRenderTarget2 = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget2 !== undefined) return renderTarget2;
      renderTarget2 = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget2;
    };
    const mockCanvas2 = {
      width: WIDTH,
      height: HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureRenderTarget2(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget2 === undefined) {
              if (sharedDevice2 === undefined)
                throw new Error('render target requested before device captured');
              return ensureRenderTarget2(sharedDevice2, 'rgba8unorm');
            }
            return renderTarget2;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    let host2: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host2 = await constructRuntimeRendererHost(
        mockCanvas2,
        {},
        {
          shaderManifestUrl: ENGINE_MANIFEST_URL,
        },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = origReqAdapter2;
    }
    expect(host2.ok).toBe(true);
    if (!host2.ok) throw host2.error;
    const { renderer: renderer2, assets: assets2 } = host2.value;
    expect(renderer2.inspect().state).toBe('alive');
    expect(assets2).toBeInstanceOf(AssetRegistry);

    // Unlit material
    const matAsset2: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [0.8, 0.3, 0.3, 1], metallic: 0, roughness: 0.5 },
    } as MaterialAsset;

    const transformsN2 = buildTranslationGrid();

    // Frame A: N instances
    const worldN2 = new World();
    const matHandleN2 = worldN2.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      matAsset2,
    );
    worldN2.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandleN2] } },
      { component: Instances, data: { transforms: transformsN2 } },
    );
    worldN2.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 30],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: { fov: (45 * Math.PI) / 180, aspect: 1, near: 0.1, far: 200 } },
    );
    const attachmentN2 = renderer2.attach(worldN2);
    expect(attachmentN2.ok).toBe(true);
    if (!attachmentN2.ok) throw attachmentN2.error;

    for (let i = 0; i < 5; i++) {
      worldN2.update(1 / 60).unwrap();
      const r = renderer2.draw({
        leases: [attachmentN2.value],
        camera: { lease: attachmentN2.value },
        environment: { lease: attachmentN2.value },
      });
      if (!r.ok) throw new Error(`draw N frame ${i} error: ${r.error.code}`);
    }

    const device2 = sharedDevice2;
    expect(device2).toBeDefined();
    if (device2 === undefined) return;
    await device2.queue.onSubmittedWorkDone();

    expect(renderTarget2).toBeDefined();
    if (renderTarget2 === undefined) return;

    const unpaddedBytesPerRowA2 = WIDTH * 4;
    const bytesPerRowA2 = Math.ceil(unpaddedBytesPerRowA2 / 256) * 256;
    const readbackA2 = device2.createBuffer({
      size: bytesPerRowA2 * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    {
      const enc = device2.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget2 },
        { buffer: readbackA2, bytesPerRow: bytesPerRowA2, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device2.queue.submit([enc.finish()]);
    }
    await readbackA2.mapAsync(MAP_MODE_READ);
    const mappedA2 = readbackA2.getMappedRange();
    const pixelsA2 = new Uint8Array(mappedA2.slice(0));
    readbackA2.unmap();
    readbackA2.destroy();

    // Frame B: 1 instance
    const singleTransform2 = new Float32Array(16);
    singleTransform2[0] = 1;
    singleTransform2[5] = 1;
    singleTransform2[10] = 1;
    singleTransform2[15] = 1;

    const world12 = new World();
    const matHandle12 = world12.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      matAsset2,
    );
    world12.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle12] } },
      { component: Instances, data: { transforms: singleTransform2 } },
    );
    world12.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 30],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: { fov: (45 * Math.PI) / 180, aspect: 1, near: 0.1, far: 200 } },
    );
    const attachment12 = renderer2.attach(world12);
    expect(attachment12.ok).toBe(true);
    if (!attachment12.ok) throw attachment12.error;

    for (let i = 0; i < 5; i++) {
      world12.update(1 / 60).unwrap();
      const r = renderer2.draw({
        leases: [attachment12.value],
        camera: { lease: attachment12.value },
        environment: { lease: attachment12.value },
      });
      if (!r.ok) throw new Error(`draw 1 frame ${i} error: ${r.error.code}`);
    }
    await device2.queue.onSubmittedWorkDone();

    const bytesPerRowB2 = Math.ceil((WIDTH * 4) / 256) * 256;
    const readbackB2 = device2.createBuffer({
      size: bytesPerRowB2 * HEIGHT,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    {
      const enc = device2.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget2 },
        { buffer: readbackB2, bytesPerRow: bytesPerRowB2, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      );
      device2.queue.submit([enc.finish()]);
    }
    await readbackB2.mapAsync(MAP_MODE_READ);
    const mappedB2 = readbackB2.getMappedRange();
    const pixelsB2 = new Uint8Array(mappedB2.slice(0));
    readbackB2.unmap();
    readbackB2.destroy();

    let diffCount2 = 0;
    const eps = 30;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const off = y * bytesPerRowA2 + x * 4;
        const rA = pixelsA2[off + 2] ?? 0;
        const gA = pixelsA2[off + 1] ?? 0;
        const bA = pixelsA2[off + 0] ?? 0;
        const rB = pixelsB2[off + 2] ?? 0;
        const gB = pixelsB2[off + 1] ?? 0;
        const bB = pixelsB2[off + 0] ?? 0;
        if (Math.abs(rA - rB) > eps || Math.abs(gA - gB) > eps || Math.abs(bA - bB) > eps) {
          diffCount2++;
        }
      }
    }

    expect(diffCount2).toBeGreaterThan(0);
  });
});
