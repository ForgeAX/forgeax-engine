import { shaderManifestUrl as createShaderManifestUrl } from '../shader-manifest-url.fixture';
// World-authored Instances render through storage and uniform bindings on Dawn.
// The restricted RHI advertises no storage buffers while retaining the real
// WebGPU device, shader compiler, validation and pixel readback. This proves
// the uniform lane and its 128-instance chunks, not WebGL2 backend parity.

import type { MaterialAsset } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { drawPublished } from '../draw-published';

// Source-level structural check: common.wgsl must carry both the storage
// and uniform declarations of the instances binding under #ifdef / #else
// STORAGE_BUFFER_AVAILABLE.

interface NodeFsW6 {
  readFileSync: (p: string, enc: string) => string;
}
interface NodePathW6 {
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
}
interface NodeModuleW6 {
  createRequire: (filename: string | URL) => { resolve: (id: string) => string };
}

const STORAGE_PATTERN =
  /@group\(3\)\s+@binding\(0\)\s+var<storage,\s*read>\s+instances\s*:\s*array<InstanceData>/;
const UNIFORM_PATTERN =
  /@group\(3\)\s+@binding\(0\)\s+var<uniform>\s+instances\s*:\s*array<InstanceData,\s*128>/;

describe('World Instances storage and uniform submission', () => {
  let ENGINE_MANIFEST_URL_W6: string;
  beforeAll(async () => {
    // Shader production is fixture setup; keep the render assertion's 30s
    // deadline independent of a cold compiler/manifest build.
    const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
    const manifest = await buildEngineShaderManifest();
    ENGINE_MANIFEST_URL_W6 = createShaderManifestUrl(manifest);
  }, 180_000);

  it('(a) common.wgsl declares uniform-fallback array<InstanceData,128> under #else', async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const moduleId = 'node:module';
    const fs = (await import(/* @vite-ignore */ fsId)) as NodeFsW6;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePathW6;
    const mod = (await import(/* @vite-ignore */ moduleId)) as NodeModuleW6;
    const req = mod.createRequire(import.meta.url);
    const pkg = req.resolve('@forgeax/engine-shader/package.json');
    const srcDir = path.resolve(path.dirname(pkg), 'src');
    const commonSrc = fs.readFileSync(path.resolve(srcDir, 'common.wgsl'), 'utf8');

    // Both forms must be present
    expect(commonSrc).toMatch(STORAGE_PATTERN);
    expect(commonSrc).toMatch(UNIFORM_PATTERN);

    // The #if/#else must wrap the instances declaration.
    // bug-20260610: switched `#ifdef X` → `#if X == true` (naga_oil's
    // `#ifdef` only checks key presence, not the value; ==/!= is needed
    // to make the false branch actually live).
    expect(commonSrc).toMatch(/#if\s+STORAGE_BUFFER_AVAILABLE\s*==\s*true[\s\S]*@group\(3\)/);
    expect(commonSrc).toMatch(/#else[\s\S]*@group\(3\)/);
    expect(commonSrc).toMatch(/@group\(3\)[\s\S]*#endif/);
  });

  it('(a) common.wgsl InstanceData struct is declared', async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const moduleId = 'node:module';
    const fs = (await import(/* @vite-ignore */ fsId)) as NodeFsW6;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePathW6;
    const mod = (await import(/* @vite-ignore */ moduleId)) as NodeModuleW6;
    const req = mod.createRequire(import.meta.url);
    const pkg = req.resolve('@forgeax/engine-shader/package.json');
    const srcDir = path.resolve(path.dirname(pkg), 'src');
    const commonSrc = fs.readFileSync(path.resolve(srcDir, 'common.wgsl'), 'utf8');

    // InstanceData struct has localFromInstance mat4 field
    expect(commonSrc).toMatch(/struct\s+InstanceData\s*\{/);
    expect(commonSrc).toMatch(/localFromInstance\s*:\s*mat4x4<f32>/);
  });

  it.each([
    { storage: true, grid: 8 },
    { storage: false, grid: 8 },
    { storage: false, grid: 12 },
  ])('renders $grid x $grid instances with storage=$storage', async ({ storage, grid }) => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    const { World } = await import('@forgeax/engine-ecs');
    const { rhi } = await import('@forgeax/engine-rhi-webgpu');
    const restrictedRhi: typeof rhi = {
      ...rhi,
      async requestAdapter(...args) {
        const adapter = await rhi.requestAdapter(...args);
        if (!adapter.ok) return adapter;
        const requestDevice = adapter.value.requestDevice.bind(adapter.value);
        adapter.value.requestDevice = async (options) => {
          const result = await requestDevice(options);
          if (result.ok && !storage)
            Object.defineProperty(result.value, 'caps', {
              value: { ...result.value.caps, storageBuffer: false, compute: false },
            });
          return result;
        };
        return adapter;
      },
    };
    const { AssetRegistry, HANDLE_CUBE } = await import('@forgeax/engine-assets-runtime');
    const { Camera, MeshRenderer } = await import('@forgeax/engine-render');
    const { Instances } = await import('@forgeax/engine-render');
    const { constructRuntimeRendererHost } = await import('../../renderer-host');
    const { MeshFilter } = await import('@forgeax/engine-render');
    const { Transform } = await import('@forgeax/engine-scene');
    const W6_WIDTH = 256;
    const W6_HEIGHT = 256;

    let sharedDevice: GPUDevice | undefined;
    const origReq = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await origReq(opts);
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc) => {
        const dev = await originalRequestDevice(desc);
        if (sharedDevice === undefined) {
          sharedDevice = dev;
          dev.pushErrorScope('validation');
        }
        return dev;
      };
      return rawAdapter;
    };

    let renderTarget: GPUTexture | undefined;
    let targetFormat: GPUTextureFormat = 'rgba8unorm';
    const ensureTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      targetFormat = format;
      renderTarget = device.createTexture({
        size: { width: W6_WIDTH, height: W6_HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: 0x10 | 0x01,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: W6_WIDTH,
      height: W6_HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureTarget(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
              return ensureTarget(sharedDevice, 'rgba8unorm');
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
        { rhi: restrictedRhi },
        { shaderManifestUrl: ENGINE_MANIFEST_URL_W6 },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = origReq;
    }
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    const errors: string[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(JSON.stringify(event.error));
    });
    expect(renderer.inspect().state).toBe('alive');
    expect(assets).toBeInstanceOf(AssetRegistry);

    const matAsset: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [0.9, 0.2, 0.2, 1], metallic: 0, roughness: 0.5 },
    } as MaterialAsset;

    const GRID = grid;
    const COUNT = GRID * GRID;
    const SP = 3.0;
    const transforms = new Float32Array(COUNT * 16);
    let idx = 0;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const base = idx * 16;
        transforms[base + 0] = 1;
        transforms[base + 5] = 1;
        transforms[base + 10] = 1;
        transforms[base + 12] = (x - (GRID - 1) / 2) * SP;
        transforms[base + 13] = (y - (GRID - 1) / 2) * SP;
        transforms[base + 14] = 0;
        transforms[base + 15] = 1;
        idx++;
      }
    }

    const world = new World();
    const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      matAsset,
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.3, 0.3, 0.3],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      { component: Instances, data: { transforms } },
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 25],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          fov: (45 * Math.PI) / 180,
          aspect: 1,
          near: 0.1,
          far: 200,
          // feat-20260608 TASK-007: clearColor moved from createRenderer to
          // the Camera component (one inline array<f32,4> column as of
          // feat-20260709 M3). Clear values must match the (13, 13, 20) sRGB
          // bytes referenced at line ~316-318 (linear [0.05, 0.05, 0.08]).
          clearColor: [0.05, 0.05, 0.08, 1],
        },
      },
    );

    for (let i = 0; i < 5; i++) {
      const r = drawPublished(renderer, world);
      if (!r.ok) throw new Error(`draw frame ${i} error: ${r.error.code}`);
    }
    await sharedDevice?.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    if (sharedDevice === undefined) return;
    const device = sharedDevice;
    const bytesPerRow = Math.ceil((W6_WIDTH * 4) / 256) * 256;
    const readbackBuf = device.createBuffer({
      size: bytesPerRow * W6_HEIGHT,
      usage: 0x01 | 0x08,
    });
    {
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: renderTarget },
        { buffer: readbackBuf, bytesPerRow, rowsPerImage: W6_HEIGHT },
        { width: W6_WIDTH, height: W6_HEIGHT, depthOrArrayLayers: 1 },
      );
      device.queue.submit([enc.finish()]);
    }
    await readbackBuf.mapAsync(0x01);
    const mapped = readbackBuf.getMappedRange();
    const bytes = new Uint8Array(mapped.slice(0));
    readbackBuf.unmap();
    readbackBuf.destroy();

    expect(errors).toEqual([]);
    expect((await device.popErrorScope())?.message).toBeUndefined();

    // Count actual red material pixels; comparing against guessed clear bytes
    // could pass an empty frame because the target applies sRGB conversion.
    let redPixels = 0;
    for (let y = 0; y < W6_HEIGHT; y++) {
      for (let x = 0; x < W6_WIDTH; x++) {
        const offset = y * bytesPerRow + x * 4;
        const r = bytes[offset + (targetFormat.startsWith('bgra') ? 2 : 0)] ?? 0;
        const g = bytes[offset + 1] ?? 0;
        const b = bytes[offset + (targetFormat.startsWith('bgra') ? 0 : 2)] ?? 0;
        if (r > g + 30 && r > b + 30) redPixels++;
      }
    }
    expect(redPixels).toBeGreaterThan(COUNT * 2);
    // The last row crosses the 128-instance boundary for the 12x12 case.
    // Verify its last matrix reaches a distinct screen location, not a
    // duplicate of the first chunk or merely some non-clear geometry.
    const edge = ((GRID - 1) / 2) * SP * 0.3;
    const ndcEdge = edge / (25 * Math.tan(Math.PI / 8));
    const lastX = Math.round(((1 + ndcEdge) * W6_WIDTH) / 2);
    const lastY = Math.round(((1 - ndcEdge) * W6_HEIGHT) / 2);
    let lastInstancePixels = 0;
    for (let y = lastY - 3; y <= lastY + 3; y++) {
      for (let x = lastX - 3; x <= lastX + 3; x++) {
        const offset = y * bytesPerRow + x * 4;
        const r = bytes[offset + (targetFormat.startsWith('bgra') ? 2 : 0)] ?? 0;
        const g = bytes[offset + 1] ?? 0;
        const b = bytes[offset + (targetFormat.startsWith('bgra') ? 0 : 2)] ?? 0;
        if (r > g + 30 && r > b + 30) lastInstancePixels++;
      }
    }
    expect(lastInstancePixels).toBeGreaterThan(0);
    if (!storage) {
      const residency = renderer.inspect().instanceCollections[0];
      expect(residency?.lane).toBe(COUNT > 128 ? 'chunked-uniform' : 'direct-uniform');
      expect(residency?.uploadedBytes).toBe(0);
    }
    await renderer.dispose();
  });
});
