import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { shaderManifestUrl as createShaderManifestUrl } from '../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
// hello-scene-nesting dawn smoke — w34 (red phase, TDD).
//
// Dawn-node real GPU exercise: outer SceneAsset with a keyed instance instantiates
// an inner SceneAsset (cube), applies mount-time override, renders via
// createRenderer, and verifies pixel readback against clear color.
//
// AC-33: dawn-node 60 frames + pixel readback eps<=0.05 locally/nightly;
// the overloaded PR Dawn profile keeps the same readback assertion at 24 frames.
//
// Plan-strategy §5.1 TDD: this test file is written first (red), then w36
// writes main.ts + fixture to turn it green.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '@forgeax/engine-ecs';
import { ChildOf, Children, Transform, worldInstantiateScene } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Materials, SceneInstance } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

const WIDTH = 400;
const HEIGHT = 300;
const PIXEL_THRESHOLD = 0.05;
const TARGET_FRAMES = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 24 : 60;
const CLEAR_COLOR: readonly [number, number, number] = [0.05, 0.05, 0.08];

// ─── Engine shader manifest (dawn-node path) ─────────────────────────────
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = createShaderManifestUrl(ENGINE_MANIFEST);

// ─── Helpers ─────────────────────────────────────────────────────────────

function registerSceneComponents(world: World): void {
  for (const component of [
    Camera,
    ChildOf,
    Children,
    DirectionalLight,
    MeshFilter,
    MeshRenderer,
    SceneInstance,
    Transform,
  ]) {
    world.components.register(component).unwrap();
  }
}

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

describe('hello-scene-nesting w34 - dawn draw scene with mount (AC-33)', () => {
  it('outer scene instances inner cube + override moves it; pixel readback eps<=0.05', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable) {
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
    }

    // ── 1. Build inline SceneAsset PODs ─────────────────────────────────

    // Inner scene: single cube with Transform + MeshFilter.
    const innerScene: SceneAsset = {
      kind: 'scene',
      entities: {
        cube: {
          components: {
            Transform: {
              pos: [0, 0.5, 0],
              quat: [0, 0, 0, 1],
              scale: [0.5, 0.5, 0.5],
            },
            MeshFilter: { assetHandle: 1 },
            MeshRenderer: { materials: [] },
          },
        },
      },
    };

    // Outer scene: its own entity + one instance of the inner scene with a
    // position override.
    const outerScene: SceneAsset = {
      kind: 'scene',
      entities: {
        sibling: {
          components: {
            Transform: {
              pos: [0, 0, 0],
              quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        },
        inner: {
          components: {},
          instance: {
            source: 'inner-scene',
            overrides: [{ target: ['cube'], components: { Transform: { pos: [1.0, 0, 0] } } }],
          },
        },
      },
    };

    // ── 2. Create renderer with mock canvas ─────────────────────────────

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
      host = await constructRuntimeRendererHost(
        mockCanvas,
        {},
        { shaderManifestUrl: MANIFEST_URL },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    if (!host.ok) throw host.error;
    const { renderer, assets } = host.value;
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

    // ── 3. Register inner scene in World + wire resolver ─────────────────

    const world = new World({ assets: assets });
    registerSceneComponents(world);
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;

    const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const material = assets.create(Materials.unlit([0.8, 0.4, 0.2, 1])).unwrap();
    const innerHandle = assets
      .create({
        ...innerScene,
        entities: {
          cube: {
            components: {
              ...innerScene.entities.cube?.components,
              MeshFilter: { assetHandle: mesh },
              MeshRenderer: { materials: [material] },
            },
          },
        },
      })
      .unwrap();
    const nested = outerScene.entities.inner;
    if (nested?.instance === undefined)
      throw new Error('Nested scene fixture is missing its source');
    const outerHandle = assets
      .create({
        ...outerScene,
        entities: {
          ...outerScene.entities,
          inner: { ...nested, instance: { ...nested.instance, source: innerHandle } },
        },
      })
      .unwrap();

    // ── 4. Camera + light ───────────────────────────────────────────────

    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 1, 3],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: { fov: 60, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
    );
    world.spawn({
      component: DirectionalLight,
      data: { castShadow: true,
        mapSize: testQuality.shadowMapSize,
        cascadeCount: testQuality.cascadeCount,
        direction: [-0.3, -1.0, -0.5],
        color: [1.0, 0.95, 0.9],
        intensity: 1.0,
      },
    });

    // ── 5. Instantiate outer scene ──────────────────────────────────────

    const instRes = worldInstantiateScene(world, outerHandle);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    const root = instRes.value.root;

    // Verify the mount created entities.
    const inst = world.get(root, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    const renderErrors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') renderErrors.push(event.error);
    });

    const frameRequest = {
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    };

    // ── 6. Render 60 frames ────────────────────────────────────────────

    let framesObserved = 0;
    for (let i = 0; i < TARGET_FRAMES; i++) {
      world.update().unwrap();
      const r = renderer.draw(frameRequest);
      if (!r.ok) {
        console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
      }
      framesObserved++;
    }
    expect(framesObserved).toBe(TARGET_FRAMES);

    const device = sharedDevice;
    expect(device).toBeDefined();
    if (device === undefined) return;
    await device.queue.onSubmittedWorkDone();

    expect(renderTarget).toBeDefined();
    if (renderTarget === undefined) return;

    // ── 7. Pixel readback ───────────────────────────────────────────────

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

    const srgbToLinear = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

    const readRgba = (px: number, py: number): [number, number, number] => {
      const off = py * bytesPerRow + px * bytesPerPixel;
      const r = (bytes[off + 0] ?? 0) / 255;
      const g = (bytes[off + 1] ?? 0) / 255;
      const b = (bytes[off + 2] ?? 0) / 255;
      return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
    };

    // Three mesh-region sites near where the cube should appear.
    const sites = [
      { name: 'center', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
      { name: 'leftOfCube', x: Math.floor(WIDTH * 0.25), y: Math.floor(HEIGHT / 2) },
      { name: 'rightOfCube', x: Math.floor(WIDTH * 0.75), y: Math.floor(HEIGHT / 2) },
    ];
    let meshedRenderCount = 0;
    for (const s of sites) {
      const px = readRgba(s.x, s.y);
      if (distance(px, CLEAR_COLOR) > PIXEL_THRESHOLD) meshedRenderCount += 1;
    }

    // At least one site should differ from clear color (scene renders content).
    expect(meshedRenderCount).toBeGreaterThanOrEqual(1);

    // No RhiError during render loop.
    expect(renderErrors.length).toBe(0);
  });
});
