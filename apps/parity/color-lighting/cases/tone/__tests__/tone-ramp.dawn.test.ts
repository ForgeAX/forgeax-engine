import { shaderManifestUrl as createShaderManifestUrl } from '../../../../../../packages/runtime/src/__tests__/shader-manifest-url.fixture';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_REINHARD,
} from '@forgeax/engine-render';
import type { Renderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { inspectToneFinalCapture } from '../../../src/report/tone-report';
import { TONE_REQUIRED_CASES, TONE_REQUIRED_MODES, TONE_REQUIRED_SAMPLE_COUNT } from '../../../src/report/tone-required';

const WIDTH = 64;
const HEIGHT = 16;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const LIGHTWEIGHT_DAWN = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';

function tonemapToU32(mode: string): number {
  switch (mode) {
    case 'linear':
      return TONEMAP_LINEAR;
    case 'reinhard':
      return TONEMAP_REINHARD;
    case 'cineon':
      return TONEMAP_CINEON;
    case 'aces-filmic':
      return TONEMAP_ACES_FILMIC;
    case 'agx':
      return TONEMAP_AGX;
    case 'neutral':
      return TONEMAP_NEUTRAL;
    default:
      throw new Error(`unknown tone mode: ${mode}`);
  }
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = createShaderManifestUrl(ENGINE_MANIFEST);

async function readPixels(device: GPUDevice, target: GPUTexture): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: MAP_READ | COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return bytes;
}

function pixelAt(bytes: Uint8Array, x: number, y: number): [number, number, number, number] {
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const offset = y * bytesPerRow + x * 4;
  return [bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0];
}

async function captureMode(mode: (typeof TONE_REQUIRED_MODES)[number]): Promise<Uint8Array> {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const next = await originalRequestDevice(descriptor);
      device ??= next;
      return next;
    };
    return adapter;
  };

  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          target ??= desc.device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (target === undefined) throw new Error('tone ramp target was not configured');
          return target;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let renderer: Renderer;
  try {
    const created = await createRenderer(canvas, {}, { shaderManifestUrl: ENGINE_MANIFEST_URL });
    if (!created.ok) throw created.error;
    renderer = created.value;
  } finally {
    navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  if (device === undefined) throw new Error('runtime Dawn renderer did not expose a device');

  const plane = createPlaneGeometry(0.75, 0.75);
  expect(plane.ok).toBe(true);
  if (!plane.ok) throw new Error(`tone ramp plane failed: ${plane.error.code}`);
  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const cases = TONE_REQUIRED_CASES.filter((entry) => entry.tone.mode === mode);
  expect(cases).toHaveLength(TONE_REQUIRED_SAMPLE_COUNT);
  const xPositions = [-1.5, -0.5, 0.5, 1.5];
  for (const [index, sceneCase] of cases.entries()) {
    const material = Materials.unlit(
      [sceneCase.tone.color[0], sceneCase.tone.color[1], sceneCase.tone.color[2], 1],
      { renderState: { cullMode: 'none' } },
    );
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: { pos: [xPositions[index] ?? 0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    ).unwrap();
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3] } },
    {
      component: Camera,
      data: {
        ...orthographic({ left: -2, right: 2, bottom: -0.5, top: 0.5, near: 0.1, far: 10 }),
        clearColor: [0, 0, 0, 1],
        tonemap: tonemapToU32(mode),
        exposure: 1,
      },
    },
  ).unwrap();

  world.update().unwrap();
  const drawn = renderer.draw(frameRequest);
  expect(drawn.ok).toBe(true);
  if (!drawn.ok) throw new Error(`tone ramp draw failed: ${drawn.error.code}`);
  const completed = await drawn.value.completed;
  expect(completed.ok).toBe(true);
  if (!completed.ok) throw completed.error;
  if (target === undefined) throw new Error('tone ramp target was not created');
  const bytes = await readPixels(device, target);
  for (const [index, sceneCase] of cases.entries()) {
    const actual = pixelAt(bytes, Math.round(((xPositions[index] ?? 0) + 2) * WIDTH / 4), HEIGHT / 2);
    const divergence = inspectToneFinalCapture(sceneCase, actual);
    expect(actual[3], `${sceneCase.caseId} alpha`).toBe(255);
    // Keep the one-byte budget while allowing the exact 1/255 endpoint to survive float round-trip.
    expect(divergence.maxDelta, `${sceneCase.caseId} RGB`).toBeLessThanOrEqual(
      1 / 255 + Number.EPSILON,
    );
  }
  await renderer.dispose();
  return bytes;
}

describe('tone ramp Dawn gate', () => {
  // The browser parity matrix validates every public mode and all four
  // samples. Keep three shader-family representatives in the overloaded PR
  // Dawn lane; local/nightly runs retain the complete six-mode roster.
  const dawnModes = LIGHTWEIGHT_DAWN
    ? (['linear', 'aces-filmic', 'neutral'] as const)
    : TONE_REQUIRED_MODES;
  for (const mode of dawnModes) {
    it.skipIf(!dawnReady)(`executes ${mode} through the ForgeaX renderer`, async () => {
      const bytes = await captureMode(mode);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }, 60_000);
  }
});
