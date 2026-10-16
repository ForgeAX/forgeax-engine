import { shaderManifestUrl } from './shader-manifest-url.fixture';
// fxaa-pixel-diff.dawn.test.ts - feat-20260528-fxaa-post-processing / M3 / w16.
// Dawn integration tests: (a) AC-03 — render with antialias='fxaa' produces
// measurable pixel difference vs antialias='none'; (b) AC-04 — tonemap='none' +
// antialias='fxaa' combination works without crash and produces valid output.
//
// Follows the user-handle-mesh-render.dawn.test.ts pattern for canvas mock,
// device capture, and pixel readback.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  Camera,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

async function doReadPixels(device: GPUDevice, renderTarget: GPUTexture): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(MAP_MODE_READ);
  const mapped = buf.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  return bytes;
}

function spawnCubeScene(world: World, antialias: number, tonemap?: number): void {
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
  );
  const cameraData: Record<string, number> = {
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 100,
    antialias,
  };
  if (tonemap !== undefined) cameraData.tonemap = tonemap;
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
      data: cameraData as Record<string, unknown> as never,
    },
  );
}

describe('feat-20260528-fxaa-post-processing M3 w16: AC-03 pixel diff + AC-04 tonemap=none FXAA test (dawn)', () => {
  it('AC-03: antialias=fxaa produces measurable pixel difference vs antialias=none', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable)
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');

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
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const device = sharedDevice;
    if (device === undefined) throw new Error('GPUDevice not captured');

    // Render with antialias='none' — baseline.
    const worldNone = new World();
    spawnCubeScene(worldNone, ANTIALIAS_NONE);
    const drawnNone = drawPublished(renderer, worldNone);
    expect(drawnNone.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixelsNone = await doReadPixels(device, renderTarget);
    expect(pixelsNone.length).toBeGreaterThan(0);

    // Render with antialias='fxaa' — FXAA active.
    const worldFxaa = new World();
    spawnCubeScene(worldFxaa, ANTIALIAS_FXAA);
    const drawnFxaa = drawPublished(renderer, worldFxaa);
    expect(drawnFxaa.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixelsFxaa = await doReadPixels(device, renderTarget);
    expect(pixelsFxaa.length).toBeGreaterThan(0);

    // AC-03: Verify measurable pixel differences between FXAA and no-AA frames.
    // The FXAA shader modifies edge pixels, producing different pixel values.
    expect(pixelsNone.length).toBe(pixelsFxaa.length);
    let diffCount = 0;
    for (let i = 0; i < pixelsNone.length; i++) {
      if (pixelsNone[i] !== pixelsFxaa[i]) diffCount++;
    }
    expect(diffCount, 'expected pixel diff > 0 between FXAA and no-AA frames').toBeGreaterThan(0);
  });

  it('AC-04: tonemap=none + antialias=fxaa combination works without crash', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable)
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');

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
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const device = sharedDevice;
    if (device === undefined) throw new Error('GPUDevice not captured');

    // Build hello-cube scene with tonemap='none' + antialias='fxaa'.
    const world = new World();
    spawnCubeScene(world, ANTIALIAS_FXAA, TONEMAP_NONE);

    const drawn = drawPublished(renderer, world);
    expect(drawn.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    // Read back pixels and verify the frame is non-empty (cube drew).
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixels = await doReadPixels(device, renderTarget);
    const cx = WIDTH >> 1;
    const cy = HEIGHT >> 1;
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const off = cy * bytesPerRow + cx * 4;
    const r = pixels[off + 2] ?? 0;
    const g = pixels[off + 1] ?? 0;
    const b = pixels[off + 0] ?? 0;
    expect(r + g + b, 'center pixel must not be black — cube should render').toBeGreaterThan(0);
  });
});
