// textures-pixel.dawn.test.ts -- vitest dawn project (AC-08f / AC-08g /
// AC-08h pixel-readback regression backstops migrated from
// textures.browser.test.ts on bug-20260519).
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts` glob).
// Environment: dawn-node native binding (vitest.setup-webgpu.ts injects
// globalThis.navigator.gpu); the test mounts a mock canvas + offscreen
// `RENDER_ATTACHMENT | COPY_SRC` GPUTexture so the engine's RenderSystem
// records into a texture the test can `copyTextureToBuffer` + `mapAsync`
// later -- no chromium composite, no xvfb. Mirrors
// apps/hello/gltf/src/__tests__/draw-indexed.dawn.test.ts patterning and
// the textures app's own scripts/smoke-dawn.mjs (60-frame harness;
// here we run the minimum viable 1-frame budget the assertions need).
//
// Why dawn, not browser: the browser project on Linux GHA runners drives
// chrome-beta + Mesa lavapipe softGPU + xvfb framebuffer. That stack
// reliably crushes the wood-container fragment to rgb(0,0,0) regardless
// of correct engine state (the sRGB swap-chain encode + 12F BUILTIN UV
// + depth + back-face cull fixes from 01e7b499 / c96a698e / 2ae3c066
// pass on macOS Chrome Beta but not on Linux Mesa lavapipe). dawn-node
// + lavapipe is the stable readback path on all three CI OSes.
//
// AC scope (1:1 with the deleted browser-project assertions):
//   AC-08f: center pixel after draw is wood-coloured. Pre-fix value
//           was rgb(22,6,1); the fix lifts it to roughly rgb(120,72,46)
//           on the sRGB-encoded readback. Asserts R > 70, G < R, B < G.
//   AC-08g: 4 sites across the cube face are NOT all identical. Pre-fix
//           the BUILTIN cube path bound a zero-stride dummy UV/tangent
//           VBO so every fragment's uv was (0,0); with proper 12F UVs,
//           sampling the wood-grain JPG varies across the face.
//   AC-08h: outer rim sites at xp/yp = 0.10 / 0.90 must read clear-color
//           (~rgb(124,149,149) for sRGB-encoded [0.2, 0.3, 0.3]). Without
//           depth + back-face cull the side / back faces over-paint past
//           the projected front-face footprint.
//
// Frame budget: AC-08f/g/h need a single rendered frame (the assertions
// inspect static pixels, not animation), keeping the test inside the
// dawn project default 5s vitest timeout.

import { shaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '@forgeax/engine-ecs';
import { decodeImageFromFile } from '@forgeax/engine-image/decode-image-from-file';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');
// tweak-20260521 D-1a: container.jpg is the LO 1.4 SSOT shipped in the
// forgeax-engine-assets/learn-opengl submodule subtree (CC BY-NC carve-
// out per AGENTS.md §Assets submodule). 4 monorepoRoot levels above APP_
// ROOT: apps/learn-render/1.getting-started/4.textures -> repo root.
const MONOREPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const CONTAINER_SRC_PATH = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
  'container.jpg',
);

const WIDTH = 256;
const HEIGHT = 256;

// sRGB-encoded clear color bytes. The render target uses
// `bgra8unorm-srgb` viewFormat (createRenderer.ts) so [0.2, 0.3, 0.3]
// linear stores as roughly (124, 149, 149). The test inspects bytes,
// not floats, so we hard-code the expected sRGB-encoded triplet here
// instead of reapplying the encode formula at every assertion site.
const CLEAR_RGB_SRGB: readonly [number, number, number] = [124, 149, 149];

function isClearColour(r: number, g: number, b: number, tolerance = 5): boolean {
  return (
    Math.abs(r - CLEAR_RGB_SRGB[0]) <= tolerance &&
    Math.abs(g - CLEAR_RGB_SRGB[1]) <= tolerance &&
    Math.abs(b - CLEAR_RGB_SRGB[2]) <= tolerance
  );
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

describe('learn-render section 1.4 textures pixel-readback (AC-08f / AC-08g / AC-08h)', () => {
  it('renders wood-container cube with sRGB encode + UV variation + outer rim clear (single dawn frame)', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    // Hook `requestDevice` so we capture the same GPUDevice the engine
    // ends up using -- we will schedule a follow-up `copyTextureToBuffer`
    // through that device for the readback.
    let sharedDevice: GPUDevice | undefined;
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

    let renderTarget: GPUTexture | undefined;
    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
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
      host = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

    // 1. Decode container.jpg -> mint a TextureAsset column via
    //    world.allocSharedRef (M8 D-17; the registry holds no handle map).
    //    Skips the pack-index fetch path -- the dawn harness has no vite
    //    middleware behind it, so we mint the column directly.
    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const decodeRes = await decodeImageFromFile(CONTAINER_SRC_PATH);
    expect(decodeRes.ok, `decodeImageFromFile failed: ${decodeRes.ok ? '' : decodeRes.error.code}`)
      .toBe(true);
    if (!decodeRes.ok) return;
    const { decoded: woodDecoded, meta: woodMeta } = decodeRes.value;
    const woodGuidRes = AssetGuid.parse(woodMeta.guid);
    expect(woodGuidRes.ok).toBe(true);
    if (!woodGuidRes.ok) return;
    const woodTexAsset: TextureAsset = {
      kind: 'texture',
      shape: {
        viewDimension: '2d',
        extent: { width: woodDecoded.width, height: woodDecoded.height },
      },
      format: woodDecoded.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
      data: woodDecoded.bytes,
      colorSpace: woodDecoded.colorSpace,
      mips: woodDecoded.mipmap ? { kind: 'generate' } : { kind: 'none' },
    };
    assets.catalog<TextureAsset>(woodMeta.guid, woodTexAsset);
    const woodHandle = world.allocSharedRef('TextureAsset', woodTexAsset);

    // 2. Build material referencing the wood handle.
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
      values: { baseColor: [1, 1, 1, 1], baseColorTexture: unwrapHandle(woodHandle) },
    });

    // 3. Spawn cube + camera (axis-aligned, no rotation -- AC-08f / g
    //    are about the front-face wood color + UV variation, AC-08h is
    //    the rim-clear backstop). The rotated-cube secondary backstop
    //    stays out of this dawn test for budget reasons; the front-face
    //    rim-clear assertion alone catches a regressed depth + cull
    //    state (a side / back face that bleeds past the front-face
    //    footprint will land wood pixels at the rim sample sites).
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          // feat-20260608 TASK-007: clearColor moved from createRenderer to
          // Camera component. Clear values must match CLEAR_RGB_SRGB
          // [124, 149, 149] bytes asserted at AC-08h rim sites (linear
          // [0.2, 0.3, 0.3]); see the LO 1.4 demo's apps/.../src/index.ts.
          clearColor: [0.2, 0.3, 0.3, 1],
        },
      },
    );

    world.update().unwrap();
    const drawn = renderer.draw({
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    });
    expect(drawn.ok).toBe(true);

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    // 4. Pixel readback (BGRA byte layout per WebGPU `bgra8unorm` color
    //    target; the readRgba helper unpacks to RGB the asserts care about).
    const bytesPerPixel = 4;
    const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
    const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
    const readbackBuffer = device.createBuffer({
      size: bytesPerRow * HEIGHT,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = readbackBuffer.getMappedRange();
    const bytes = new Uint8Array(mapped.slice(0));
    readbackBuffer.unmap();
    readbackBuffer.destroy();

    const readRgba = (px: number, py: number): [number, number, number] => {
      const off = py * bytesPerRow + px * bytesPerPixel;
      const r = bytes[off + 0] ?? 0;
      const g = bytes[off + 1] ?? 0;
      const b = bytes[off + 2] ?? 0;
      return [r, g, b];
    };

    // AC-08f: center pixel is wood-coloured (R > 70, G < R, B < G).
    // Pre-fix center value was rgb(22,6,1); the fix lifts it to roughly
    // rgb(120,72,46) on the sRGB-encoded readback.
    const cx = WIDTH >> 1;
    const cy = HEIGHT >> 1;
    const [centerR, centerG, centerB] = readRgba(cx, cy);
    expect(centerR, `center R, got rgb(${centerR},${centerG},${centerB})`).toBeGreaterThan(70);
    expect(centerG).toBeLessThan(centerR);
    expect(centerB).toBeLessThan(centerG);

    // AC-08g: 4 sites across the cube face must NOT all be identical.
    // Pre-fix the BUILTIN cube bound a zero-stride dummy UV/tangent VBO
    // so every fragment's uv was (0,0) -> single-texel sample -> uniform
    // colour. With proper 12F UVs the wood-grain JPG samples vary.
    const sites: ReadonlyArray<[number, number, number]> = [
      readRgba(Math.floor(WIDTH * 0.40), Math.floor(HEIGHT * 0.40)),
      readRgba(Math.floor(WIDTH * 0.60), Math.floor(HEIGHT * 0.40)),
      readRgba(Math.floor(WIDTH * 0.40), Math.floor(HEIGHT * 0.60)),
      readRgba(Math.floor(WIDTH * 0.60), Math.floor(HEIGHT * 0.60)),
    ];
    const allEqual = sites.every(
      (s) => s[0] === sites[0]![0] && s[1] === sites[0]![1] && s[2] === sites[0]![2],
    );
    expect(
      allEqual,
      `expected UV variation across cube face, got identical samples ${JSON.stringify(sites)}`,
    ).toBe(false);

    // AC-08h: outer rim sites must read clear-color. Without depth +
    // back-face cull the side / back faces over-paint past the projected
    // front-face footprint and the rim picks up wood pixels.
    const rimSites: ReadonlyArray<[number, number, number, string]> = [
      [...readRgba(Math.floor(WIDTH * 0.10), Math.floor(HEIGHT * 0.5)), 'left'],
      [...readRgba(Math.floor(WIDTH * 0.90), Math.floor(HEIGHT * 0.5)), 'right'],
      [...readRgba(Math.floor(WIDTH * 0.5), Math.floor(HEIGHT * 0.10)), 'top'],
      [...readRgba(Math.floor(WIDTH * 0.5), Math.floor(HEIGHT * 0.90)), 'bottom'],
    ];
    for (const [r, g, b, name] of rimSites) {
      expect(
        isClearColour(r, g, b),
        `rim site ${name}: expected clearColor (~${CLEAR_RGB_SRGB[0]},${CLEAR_RGB_SRGB[1]},${CLEAR_RGB_SRGB[2]}), got rgb(${r},${g},${b})`,
      ).toBe(true);
    }
  });
});
