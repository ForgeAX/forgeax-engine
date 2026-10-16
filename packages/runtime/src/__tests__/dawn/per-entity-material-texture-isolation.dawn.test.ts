import testQuality from '../../../../../scripts/test/render-quality.json' with { type: 'json' };
import { shaderManifestUrl } from '../shader-manifest-url.fixture';
// per-entity-material-texture-isolation.dawn.test.ts
// bug-20260522-per-entity-material-texture-binding AC-01 regression lock.
//
// Root cause: the opaque bucket's record stage read `validatedOrdered[0]
//   ?.source.material.baseColorTexture` and baked one shared `materialBindGroup`
//   for the entire bucket. Entity A's texture leaked onto every subsequent
//   entity B, C, ... in the same bucket regardless of B's own material.
//
// This dawn test asserts the post-fix invariant: spawn two opaque entities,
// A (standard + baseColorTexture = non-white green chequer) and B (unlit +
// baseColor = (1,1,1) + baseColorTexture = undefined). After N frames of
// draw, read back the pixels covering entity B and assert every sampled pixel
// is pure white (255,255,255) within epsilon 0.05. The test runs BOTH spawn
// orders (A first then B first) to prove no order-dependence (charter P4).
//
// AC-01 anchor: engine-level per-entity isolation invariant (requirements
// section 4). Two-backend coverage: pnpm test:dawn exercises wgpu-wasm native
// binding; browser path is covered by the browser test tier (M2 regressions).

import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { drawPublished } from '../draw-published';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

// Epsilon for per-pixel readback comparison (0.05 normalised; ~12 in byte
// space). Charter P4: the same epsilon anchors every pixel-parity assertion
// across engine smoke gates so AI users can grep a single constant.
const EPSILON_BYTE = 12;

function rgbCloseTo(r: number, target: number): boolean {
  return Math.abs(r - target) <= EPSILON_BYTE;
}

function makeChequerTexture(primaryR: number, primaryG: number, primaryB: number): TextureAsset {
  const side = 16;
  const bytes = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const off = (y * side + x) * 4;
      const isPrimary = x < side / 2 !== y < side / 2;
      bytes[off + 0] = isPrimary ? primaryR : 0;
      bytes[off + 1] = isPrimary ? primaryG : 0;
      bytes[off + 2] = isPrimary ? primaryB : 0;
      bytes[off + 3] = 255;
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: side, height: side } },
    format: 'rgba8unorm',
    data: bytes,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

async function readbackPixels(
  device: GPUDevice,
  renderTarget: GPUTexture,
): Promise<{ bytes: Uint8Array; bytesPerRow: number }> {
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const readbackBuffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(MAP_MODE_READ);
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  return { bytes, bytesPerRow };
}

interface ReadbackView {
  rgbaAt: (px: number, py: number) => [number, number, number, number];
  sampleBlock: (
    xStart: number,
    yStart: number,
    blockW: number,
    blockH: number,
  ) => Array<[number, number, number, number]>;
}

function makeReadbackView(bytes: Uint8Array, bytesPerRow: number): ReadbackView {
  const rgbAt = (px: number, py: number): [number, number, number, number] => {
    const off = py * bytesPerRow + px * 4;
    const r = bytes[off + 0] ?? 0;
    const g = bytes[off + 1] ?? 0;
    const b = bytes[off + 2] ?? 0;
    const a = bytes[off + 3] ?? 0;
    return [r, g, b, a];
  };
  return {
    rgbaAt: rgbAt,
    sampleBlock(
      xStart: number,
      yStart: number,
      blockW: number,
      blockH: number,
    ): Array<[number, number, number, number]> {
      const out: Array<[number, number, number, number]> = [];
      for (let y = yStart; y < yStart + blockH; y++) {
        for (let x = xStart; x < xStart + blockW; x++) {
          out.push(rgbAt(x, y));
        }
      }
      return out;
    },
  };
}

describe('bug-20260522 AC-01 per-entity material texture isolation (dawn)', () => {
  it('A-first spawn: A (standard + green texture) then B (unlit + white) -> B render area pure white', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

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

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;

    const world = new World();

    // Entity A: schema-driven (PBR) material with bright-green chequer
    // texture. If the texture leaks onto B, B's white pixels turn
    // greenish. feat-20260614 M8: values.baseColorTexture carries the
    // GUID; the extract stage resolves it via assets.lookup(guid) then mints a
    // user-tier column handle via world.allocSharedRef.
    const texGreenGuid = AssetGuid.random();
    assets.catalog(texGreenGuid, makeChequerTexture(0, 200, 0));
    const matA = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: {
        baseColor: [1, 1, 1],
        metallic: 0,
        roughness: 0.5,
        baseColorTexture: { texture: AssetGuid.format(texGreenGuid) as never },
      },
    });

    // Entity B: unlit solid white, no texture.
    const matB = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 1, 1, 1] },
    });

    const cubeRes = createBoxGeometry(1, 1, 1);
    expect(cubeRes.ok).toBe(true);
    if (!cubeRes.ok) return;
    const cubeAsset: MeshAsset = cubeRes.value;
    const cubeHandleA = world.allocSharedRef('MeshAsset', cubeAsset);
    const cubeHandleB = world.allocSharedRef('MeshAsset', cubeAsset);

    // A left, B right. Both half-scale so they don't overlap.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [-0.6, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandleA } },
      { component: MeshRenderer, data: { materials: [matA] } },
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0.6, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandleB } },
      { component: MeshRenderer, data: { materials: [matB] } },
    );

    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    );
    world.spawn({
      component: DirectionalLight,
      data: {
        mapSize: testQuality.shadowMapSize,
        cascadeCount: testQuality.cascadeCount,
        direction: [0, 0, -1],
        color: [1, 1, 1],
        intensity: 1,
      },
    });

    for (let f = 0; f < 5; f++) {
      const drawn = drawPublished(renderer, world);
      expect(drawn.ok).toBe(true);
    }
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    const rbi = await readbackPixels(device, renderTarget);
    const view = makeReadbackView(rbi.bytes, rbi.bytesPerRow);

    // Sample B's render area: center-right of the framebuffer.
    // B is at posX=0.6, half-scale cube — the center of B projects
    // roughly to the right half of the 256x256 canvas.
    // Sample a 16x16 block around the expected B center (x=200, y=128).
    const blockBX = 185;
    const blockBY = 113;
    const blockW = 30;
    const blockH = 30;

    const blockB = view.sampleBlock(blockBX, blockBY, blockW, blockH);
    const totalSamples = blockB.length;
    let whiteCount = 0;
    for (const [r, g, b] of blockB) {
      if (rgbCloseTo(r, 255) && rgbCloseTo(g, 255) && rgbCloseTo(b, 255)) {
        whiteCount++;
      }
    }
    // At least 60% of the sampled region should be pure white (accounting
    // for cube edges that may sample background/clear color). Pre-fix,
    // B's pixels would be green-tinted from A's leaked texture.
    const whiteRatio = whiteCount / totalSamples;
    expect(whiteRatio).toBeGreaterThanOrEqual(0.6);
  }, 30000);

  it('B-first spawn: B (unlit + white) then A (standard + green texture) -> B render area pure white', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

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

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;

    const world = new World();

    // feat-20260614 M8: schema-driven material with GUID texture ref; the
    // texture POD is catalogued (GUID->payload SSOT) and the extract stage
    // resolves it to a user-tier column handle via world.allocSharedRef.
    const texGreenGuid2 = AssetGuid.random();
    assets.catalog(texGreenGuid2, makeChequerTexture(0, 200, 0));
    const matA = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: {
        baseColor: [1, 1, 1],
        metallic: 0,
        roughness: 0.5,
        baseColorTexture: { texture: AssetGuid.format(texGreenGuid2) as never },
      },
    });

    const matB = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 1, 1, 1] },
    });

    const cubeRes = createBoxGeometry(1, 1, 1);
    expect(cubeRes.ok).toBe(true);
    if (!cubeRes.ok) return;
    const cubeAsset: MeshAsset = cubeRes.value;
    const cubeHandleA = world.allocSharedRef('MeshAsset', cubeAsset);
    const cubeHandleB = world.allocSharedRef('MeshAsset', cubeAsset);

    // B first (swap order). B right, A left.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0.6, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandleB } },
      { component: MeshRenderer, data: { materials: [matB] } },
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [-0.6, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.5, 0.5, 0.5],
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandleA } },
      { component: MeshRenderer, data: { materials: [matA] } },
    );

    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
      },
    );
    world.spawn({
      component: DirectionalLight,
      data: {
        mapSize: testQuality.shadowMapSize,
        cascadeCount: testQuality.cascadeCount,
        direction: [0, 0, -1],
        color: [1, 1, 1],
        intensity: 1,
      },
    });

    for (let f = 0; f < 5; f++) {
      const drawn = drawPublished(renderer, world);
      expect(drawn.ok).toBe(true);
    }
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    const rbi = await readbackPixels(device, renderTarget);
    const view = makeReadbackView(rbi.bytes, rbi.bytesPerRow);

    const blockBX = 185;
    const blockBY = 113;
    const blockW = 30;
    const blockH = 30;

    const blockB = view.sampleBlock(blockBX, blockBY, blockW, blockH);
    let whiteCount = 0;
    for (const [r, g, b] of blockB) {
      if (rgbCloseTo(r, 255) && rgbCloseTo(g, 255) && rgbCloseTo(b, 255)) {
        whiteCount++;
      }
    }
    const whiteRatio = whiteCount / blockB.length;
    expect(whiteRatio).toBeGreaterThanOrEqual(0.6);
  }, 30000);
});
