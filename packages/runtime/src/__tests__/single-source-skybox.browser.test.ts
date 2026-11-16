import { createPrimitiveMesh, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { AssetHandle } from '@forgeax/engine-types';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { testAssets } from './helpers/runtime-assets';
// Real WebGPU regression for a single source's skybox, tonemap and user mesh.
// Retains the existing non-black readback, asset-resolution and completed-frame checks.

import { World } from '@forgeax/engine-ecs';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { EquirectAsset, MeshAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';

type EngineRenderer = import('@forgeax/engine-render').Renderer;

// Suppress the known chromium teardown race (device GC'd while a shader
// getCompilationInfo is in flight) — same guard the 9-light browser test uses.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof DOMException && e.reason.message.includes('Instance dropped')) {
      e.preventDefault();
    }
  });
}

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

// This gate checks world ownership and non-black presentation, not detail.
// Keep all completed frames while reducing software rasterization in CI.
const CANVAS_W = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 128 : 256;
const CANVAS_H = CANVAS_W;
const FRAMES = 8;

// Build a bright, uniform equirect (all channels = 0.8 linear) so the projected
// cubemap renders a clearly non-black sky. rgba16float / linear is the only
// equirect delivery format (see equirect-bc6h.integration.test.ts).
function brightEquirect(width = 8, height = 4): EquirectAsset {
  const f32 = new Float32Array(width * height * 4);
  for (let i = 0; i < f32.length; i += 4) {
    f32[i] = 0.8;
    f32[i + 1] = 0.8;
    f32[i + 2] = 0.85;
    f32[i + 3] = 1;
  }
  const data = halfFloat.f32ToF16Bytes(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
  return { kind: 'equirect', width, height, format: 'rgba16float', data, colorSpace: 'linear' };
}

// A small user-tier triangle mesh, canonical 12-float vertex layout
// (position vec3 + normal vec3 + uv vec2 + tangent vec4).
function customMesh(): MeshAsset {
  const positions = new Float32Array([-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.4, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  const tangents = new Float32Array([0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
  return {
    kind: 'mesh',
    vertices: packInterleavedVertexAttributes(
      { position: positions, normal: normals, uv: uvs, tangent: tangents },
      3,
    ).unwrap().vertices,
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: positions, normal: normals, uv: uvs, tangent: tangents },
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

function litBox(
  world: World,
  color: readonly [number, number, number, number],
  x: number,
  y: number,
): void {
  const matHandle = testAssets(world)
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [color[0], color[1], color[2]], metallic: 0, roughness: 0.5 },
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [x, y, 0], scale: [1.2, 1.2, 1.2] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    )
    .unwrap();
}

interface Diag {
  readonly code: string;
  readonly hint?: string;
  readonly detail?: unknown;
}

interface SceneReadbackTimings {
  attachMs: number;
  frames: {
    worldUpdateMs: number;
    drawCallMs: number;
    receiptMs: number;
    animationFrameMs: number;
  }[];
  postFrameRafMs: number;
  compositorDelayMs: number;
  finalRafMs: number;
  screenshotMs?: number;
  pngDecodeMs?: number;
  fallbackReadbackMs?: number;
}

// Decode a base64 PNG to a top-left RGBA Uint8Array via createImageBitmap +
// OffscreenCanvas 2D. Used by the screenshot readback path.
async function decodePngBase64(b64: string): Promise<Uint8Array> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const off = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    bmp.close();
    throw new Error('OffscreenCanvas 2D context unavailable for PNG decode');
  }
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

// Compositor-independent readback: drive N frames, then capture the actual
// presented canvas via the CDP-backed page.screenshot (locator scoped to the
// canvas). The createImageBitmap(canvas) path is owned by this test harness and depends on
// the chromium compositor having consumed the WebGPU swap-chain before the
// bounce, which is unreliable headless/local (documented in
// light-casters-9-light.browser.test.ts). The screenshot path reads the
// composited surface directly, so it yields real opaque pixels regardless.
async function readbackAfterScene(
  renderer: EngineRenderer,
  world: World,
  canvas: HTMLCanvasElement,
  canvasId: string,
): Promise<{ pixels: Uint8Array; timings: SceneReadbackTimings }> {
  const attachStartedAt = performance.now();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const timings: SceneReadbackTimings = {
    attachMs: performance.now() - attachStartedAt,
    frames: [],
    postFrameRafMs: 0,
    compositorDelayMs: 0,
    finalRafMs: 0,
  };
  for (let i = 0; i < FRAMES; i++) {
    const updateStartedAt = performance.now();
    world.update(1 / 60).unwrap();
    const worldUpdateMs = performance.now() - updateStartedAt;
    const drawStartedAt = performance.now();
    const r = renderer.draw({ source: lease });
    const drawCallMs = performance.now() - drawStartedAt;
    if (!r.ok) throw new Error(`renderer.draw frame ${i} failed: ${r.error.code}`);
    const receiptStartedAt = performance.now();
    const completed = await r.value.completed;
    const receiptMs = performance.now() - receiptStartedAt;
    expect(completed.ok).toBe(true);
    const animationFrameStartedAt = performance.now();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const animationFrameMs = performance.now() - animationFrameStartedAt;
    timings.frames.push({ worldUpdateMs, drawCallMs, receiptMs, animationFrameMs });
  }
  let settleStartedAt = performance.now();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  timings.postFrameRafMs = performance.now() - settleStartedAt;
  settleStartedAt = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  timings.compositorDelayMs = performance.now() - settleStartedAt;
  settleStartedAt = performance.now();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  timings.finalRafMs = performance.now() - settleStartedAt;

  console.warn('[single-source-skybox] phase=completed-frames-readback');
  // Primary: CDP screenshot of the canvas element (compositor-independent).
  try {
    const screenshotStartedAt = performance.now();
    const shot = await page
      .elementLocator(document.getElementById(canvasId) as HTMLElement)
      .screenshot({ base64: true, save: false });
    timings.screenshotMs = performance.now() - screenshotStartedAt;
    const b64 = typeof shot === 'string' ? shot : shot.base64;
    const decodeStartedAt = performance.now();
    const decoded = await decodePngBase64(b64);
    timings.pngDecodeMs = performance.now() - decodeStartedAt;
    return { pixels: decoded, timings };
  } catch (cause) {
    console.warn('[single-source-skybox] screenshot-readback-failed', cause);
    // Fallback: createImageBitmap(canvas) bounce (may read all-zero if the
    // compositor has not consumed the swap-chain — handled by the alpha gate).
    const fallbackStartedAt = performance.now();
    const bitmap = await createImageBitmap(canvas);
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = offscreen.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      bitmap.close();
      throw new Error('OffscreenCanvas 2D context unavailable for canvas readback');
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    timings.fallbackReadbackMs = performance.now() - fallbackStartedAt;
    return {
      pixels: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      timings,
    };
  }
}

// Mean luminance over the whole frame, 0..1. A uniformly-black frame reads ~0.
function meanLuma(pixels: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const rr = (pixels[i] ?? 0) / 255;
    const gg = (pixels[i + 1] ?? 0) / 255;
    const bb = (pixels[i + 2] ?? 0) / 255;
    sum += 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

// Fraction of opaque (alpha > 0.5) pixels — the presentation-consumed signal.
function alphaFraction(pixels: Uint8Array): number {
  let opaque = 0;
  let n = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 127) opaque += 1;
    n += 1;
  }
  return n > 0 ? opaque / n : 0;
}

describe.skipIf(!browserReady)('single-source skybox and user mesh', () => {
  let renderer: EngineRenderer | undefined;
  let canvas: HTMLCanvasElement | undefined;

  afterEach(async () => {
    try {
      if (renderer !== undefined) {
        const disposed = await renderer.dispose();
        if (!disposed.ok) throw disposed.error;
      }
    } finally {
      renderer = undefined;
      canvas?.remove();
      canvas = undefined;
    }
  });

  // Keep the original 30-second budget and all eight completed frames.
  it('renders source skybox and geometry without asset-resolution errors', async () => {
    const testStartedAt = performance.now();
    canvas = document.createElement('canvas');
    canvas.id = 'single-source-skybox-canvas';
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${CANVAS_H}px`;
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    console.warn('[single-source-skybox] phase=construct-renderer');
    const rendererStartedAt = performance.now();
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      {
        shaderManifestUrl: '/shaders/manifest.json',
      },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    const rendererConstructMs = performance.now() - rendererStartedAt;
    expect(renderer.inspect().state).toBe('alive');

    const diagnostics: Diag[] = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const error = event.error;
      diagnostics.push({
        code: error.code,
        hint: error.hint,
        detail: (error as unknown as { detail?: unknown }).detail,
      });
    });

    // The source owns camera, lighting, skybox and user-tier geometry.
    const worldSetupStartedAt = performance.now();
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 6] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: CANVAS_W / CANVAS_H,
            near: 0.1,
            far: 100,
            tonemap: TONEMAP_REINHARD_EXTENDED,
            clearColor: [0.02, 0.02, 0.03, 1],
          },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [-0.4, -0.7, -1],
          color: [1, 1, 1],
          intensity: 1.4,
        },
      })
      .unwrap();
    // A user-tier mesh exercises ordinary source asset resolution.
    const customHandle: AssetHandle<'mesh'> = testAssets(world).create(customMesh()).unwrap();
    const customMaterial = testAssets(world)
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [0.95, 0.85, 0.1], metallic: 0, roughness: 0.6 },
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [-1.8, 1.4, 0] } },
        { component: MeshFilter, data: { assetHandle: customHandle } },
        { component: MeshRenderer, data: { materials: [customMaterial] } },
      )
      .unwrap();

    // The same source provides the environment and lit boxes.
    const equirect = testAssets(world).create(brightEquirect()).unwrap();
    world.spawn({ component: Skylight, data: { equirect, intensity: 1.0 } });
    world.spawn({
      component: SkyboxBackground,
      data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
    });
    litBox(world, [0.15, 0.8, 0.2, 1], 0, 0);
    litBox(world, [0.85, 0.15, 0.15, 1], 1.8, 0);
    const worldSetupMs = performance.now() - worldSetupStartedAt;

    console.warn('[single-source-skybox] phase=scene-frames-and-readback');
    const readback = await readbackAfterScene(renderer, world, canvas, canvas.id);
    const pixels = readback.pixels;
    // The screenshot path returns the canvas element's composited surface
    // (clipped to its layout box, so its size is source-dependent); the
    // fallback createImageBitmap path returns exactly CANVAS_W*CANVAS_H*4.
    // Assert a non-empty RGBA buffer (length a positive multiple of 4) rather
    // than a fixed size so both readback sources are accepted.
    expect(pixels.length).toBeGreaterThan(0);
    expect(pixels.length % 4).toBe(0);

    // Evidence: log the diagnostics + measured luma so a failure prints the
    // discriminating signal (defect signature) rather than a bare boolean.
    const pixelOracleStartedAt = performance.now();
    const luma = meanLuma(pixels);
    const alpha = alphaFraction(pixels);
    const pixelOracleMs = performance.now() - pixelOracleStartedAt;
    console.warn(
      `[single-source-skybox] diagnostics=${JSON.stringify(diagnostics)} meanLuma=${luma.toFixed(4)} alphaFraction=${alpha.toFixed(3)}`,
    );
    console.warn(
      `[single-source-skybox] timings=${JSON.stringify({
        rendererConstructMs,
        worldSetupMs,
        ...readback.timings,
        pixelOracleMs,
        totalMs: performance.now() - testStartedAt,
      })}`,
    );

    // User meshes and environment assets resolve in the accepted source resource scope.
    const recordResolutionErrors = diagnostics.filter(
      (d) => d.code === 'asset-not-registered' || d.code === 'webgpu-runtime-error',
    );
    expect(
      recordResolutionErrors,
      `source record-stage resolution error: ${JSON.stringify(recordResolutionErrors)}`,
    ).toEqual([]);
    expect(diagnostics.filter((d) => d.code === 'render-system-no-camera')).toEqual([]);

    // The frame must not be uniformly black. Gate on the
    // presentation-consumed signal (alpha) so an unconsumed canvas cannot
    // bypass the pixel oracle. Both screenshot and fallback must supply pixels.
    expect(
      alpha,
      `skybox readback is not opaque (alphaFraction=${alpha.toFixed(3)})`,
    ).toBeGreaterThan(0.5);
    expect(luma, `skybox frame is black (meanLuma=${luma.toFixed(4)})`).toBeGreaterThan(0.05);
  }, 30_000);
});
