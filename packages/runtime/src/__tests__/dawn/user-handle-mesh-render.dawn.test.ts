import { shaderManifestUrl } from '../shader-manifest-url.fixture';
// user-handle-mesh-render.dawn.test.ts -- T-M2-1 V-3 punt regression lock.
//
// Background (plan-decisions.md D-3 / requirements §10 V-3 / AC-10 / AC-11):
//   The 4 learn-render examples (4.textures / 5.transformations /
//   6.coordinate-systems / 7.camera) historically bound `MeshFilter.assetHandle`
//   to the engine-builtin `HANDLE_CUBE` literal even after staging a
//   user-tier cube MeshAsset alias --
//   user-handle ids (>= BUILTIN_BASE=1024 minted by the SharedRefStore) used to
//   miss the `pipelineState.meshes` map (legacy `[HANDLE_CUBE, HANDLE_TRIANGLE]`-only
//   loop in `createRenderer` step 3) so the render-system fired
//   `asset-not-registered` RhiError once per renderable per frame and the
//   cube was silently culled (charter P3 explicit failure: the structured
//   error fired, but the frame still composited pure clearColor).
//
//   feat-20260601-device/gpu-residency-extraction M1 closed the engine path via
//   the pull model (the prior register-time auto-upload push was severed):
//     - render-system-record.ts: a user-handle mesh (id >= 1024) misses the
//       builtin `pipelineState.meshes` alias map, so the record stage pulls it
//       through `gpuStore.ensureResident(handle, pod)` on first draw access and
//       resolves the GPU buffers via `gpuStore.getMeshGpuHandles(handle)` (D-1
//       keeps builtins on the direct path; user meshes pull through the store).
//   This test exercises that end-to-end through `renderer.draw` -- it never
//   calls the store directly; the pull happens inside the record stage.
//
//   This dawn test is the regression lock for that engine surface (D-3
//   "engine path already works"). M-2 of feat-20260519 retracts the V-3
//   punt at the demo layer: the 4 examples switch their `MeshFilter.assetHandle`
//   from `HANDLE_CUBE` to a user-tier handle minted via `world.allocSharedRef`.
//   If anything in the engine regresses the user-handle
//   render path, this test fires before the demo smoke does.
//
// AC scope:
//   AC-10 / AC-11 (V-3 punt retraction): a user-tier MeshAsset minted via
//   `world.allocSharedRef` produces a non-empty rendered frame. The test asserts
//   the center pixel is NOT clear-color (i.e. the cube actually drew).
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts` glob).
// Environment: dawn-node native binding (vitest.setup-webgpu.ts injects
// globalThis.navigator.gpu); same mock-canvas + offscreen `RENDER_ATTACHMENT |
// COPY_SRC` GPUTexture pattern as
// apps/learn-render/.../4.textures/src/__tests__/textures-pixel.dawn.test.ts.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { drawPublished } from '../draw-published';

const WIDTH = 256;
const HEIGHT = 256;
// sRGB-encoded clear-color bytes (`bgra8unorm-srgb` swap-chain). Pre-fix
// pixel was clear-color; post-fix the cube fragment overwrites the center.
const CLEAR_RGB_SRGB: readonly [number, number, number] = [124, 149, 149];

// WebGPU spec numeric flags -- inlined to keep this dawn test self-contained
// (packages/runtime/tsconfig.json does not pull `@webgpu/types` value-level
// globals, only the structural `lib.dom.d.ts` interface types). Spec-aligned
// per WebGPU §3 (texture / buffer / map-mode usage flags). AGENTS.md "RHI
// form rules: spec-aligned" anchors the byte-level values.
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

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

describe('T-M2-1 user-handle mesh render regression (AC-10 / AC-11, dawn)', () => {
  it('allocSharedRef user-handle (>=1024) renders non-clear-color center pixel', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    // Capture the GPUDevice the engine uses so we can schedule
    // `copyTextureToBuffer` for the readback after `renderer.draw`.
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
    expect(assets).toBeInstanceOf(AssetRegistry);
    expect(renderer.inspect().state).toBe('alive');

    // 1. Mint a procedural cube MeshAsset, catalogue it under a fresh UUIDv7
    //    GUID in the AssetRegistry (GUID->payload SSOT, no handle), then mint a
    //    user-tier column handle via `world.allocSharedRef`. The minted slot id
    //    is >= BUILTIN_BASE (1024), so the builtin `pipelineState.meshes` alias
    //    map (HANDLE_CUBE / HANDLE_TRIANGLE only) misses; the engine path under
    //    test pulls the user mesh through `gpuStore.ensureResident(handle, pod)`
    //    + `gpuStore.getMeshGpuHandles(handle)` on first draw access.
    const meshRes = createBoxGeometry(1, 1, 1);
    expect(meshRes.ok).toBe(true);
    if (!meshRes.ok) return;
    const cubeAsset: MeshAsset = meshRes.value;

    const world = new World();

    const cubeGuid = AssetGuid.random();
    assets.catalog(cubeGuid, cubeAsset);
    const cubeHandle = world.allocSharedRef('MeshAsset', cubeAsset);

    // The handle MUST be a user-tier handle (>= 1024 = BUILTIN_BASE). If this
    // assertion fails the SharedRefStore base shifted; the regression lock is
    // moot until the BUILTIN_BASE invariant is re-established.
    expect(unwrapHandle(cubeHandle)).toBeGreaterThanOrEqual(1024);

    // 2. Build a solid-color unlit material so the assertion is purely
    //    about "did the cube draw" -- no texture decode, no mip path,
    //    no UV variance. Bright red baseColor (visible against the
    //    clear-color teal).
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 0, 0, 1] },
    });

    // 3. Spawn cube + camera (axis-aligned, camera 3 units in front).
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
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

    const drawn = drawPublished(renderer, world);
    expect(drawn.ok).toBe(true);

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    // 4. Pixel readback (`bgra8unorm` byte layout; helper unpacks to RGB).
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

    const readRgba = (px: number, py: number): [number, number, number] => {
      const off = py * bytesPerRow + px * bytesPerPixel;
      const r = bytes[off + 0] ?? 0;
      const g = bytes[off + 1] ?? 0;
      const b = bytes[off + 2] ?? 0;
      return [r, g, b];
    };

    // Center pixel must NOT be clear-color (i.e. the cube actually drew
    // through the user-handle path). Pre-fix this would be teal
    // (~rgb(124,149,149)); post-fix the unlit red baseColor crushes it
    // through the sRGB swap-chain encode to roughly rgb(255,0,0).
    const cx = WIDTH >> 1;
    const cy = HEIGHT >> 1;
    const [centerR, centerG, centerB] = readRgba(cx, cy);
    expect(
      isClearColour(centerR, centerG, centerB),
      `center pixel should NOT be clear-color (~${CLEAR_RGB_SRGB[0]},${CLEAR_RGB_SRGB[1]},${CLEAR_RGB_SRGB[2]}); got rgb(${centerR},${centerG},${centerB}). If this fails, the user-handle render path regressed -- check render-system-record.ts:304-306 + gpuStore.ensureResident pull on the user-tier (allocSharedRef) handle.`,
    ).toBe(false);
    // Sanity: center pixel must also not be all-zero (transparent /
    // pre-clear black) -- charter P3 explicit failure: silent skip
    // would emit (0,0,0) on the COPY_SRC texture.
    expect(centerR + centerG + centerB).toBeGreaterThan(0);
  });
});
