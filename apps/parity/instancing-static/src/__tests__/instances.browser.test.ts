import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, Instances, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';

const WIDTH = 1280;
const HEIGHT = 720;
const LIGHTWEIGHT = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const FRAME_COUNT = LIGHTWEIGHT ? 24 : 600;
// Sampling coordinates retain their reference extent; CI rasterizes one
// quarter of each dimension while preserving every instance population.
// Repeated steady frames only check unchanged residency; keep endurance local.
const RENDER_SCALE = LIGHTWEIGHT ? 0.25 : 1;
const COUNTS = [1500, 10000, 20000] as const;
const SAMPLE_POINTS = [
  { label: 'front-right-bottom', x: 300, y: 568 },
  { label: 'front-mid-near', x: 320, y: 568 },
  { label: 'front-mid-far', x: 350, y: 568 },
  { label: 'front-left', x: 370, y: 568 },
] as const;

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface SampleEvidence {
  readonly label: string;
  readonly foregroundPixels: number;
  readonly peakDistance: number;
}

function gridDimensions(count: number): readonly [number, number, number] {
  if (count === 1500) return [10, 10, 15];
  if (count === 10000) return [20, 20, 25];
  if (count === 20000) return [25, 20, 40];
  throw new Error(`unsupported browser instance population: ${count}`);
}

function translationGrid(count: number): Float32Array {
  const [gridX, gridY, gridZ] = gridDimensions(count);
  const spacing = 2;
  const halfX = ((gridX - 1) * spacing) / 2;
  const halfY = ((gridY - 1) * spacing) / 2;
  const halfZ = ((gridZ - 1) * spacing) / 2;
  const transforms = new Float32Array(count * 16);
  for (let i = 0; i < count; i += 1) {
    const x = i % gridX;
    const y = Math.floor(i / gridX) % gridY;
    const z = Math.floor(i / (gridX * gridY));
    const base = i * 16;
    transforms[base] = 1;
    transforms[base + 5] = 1;
    transforms[base + 10] = 1;
    transforms[base + 12] = x * spacing - halfX;
    transforms[base + 13] = y * spacing - halfY;
    transforms[base + 14] = z * spacing - halfZ;
    transforms[base + 15] = 1;
  }
  return transforms;
}

async function captureCanvas(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  if (typeof base64 !== 'string') throw new Error('browser canvas screenshot did not return base64 PNG');
  const encoded = base64.replace(/^data:image\/png;base64,/, '');
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const bitmap = await createImageBitmap(new Blob([copy.buffer], { type: 'image/png' }));
  const decoder = document.createElement('canvas');
  decoder.width = bitmap.width;
  decoder.height = bitmap.height;
  const context = decoder.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('browser PNG decoder could not acquire a 2D context');
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    width: decoder.width,
    height: decoder.height,
    data: context.getImageData(0, 0, decoder.width, decoder.height).data,
  };
}

function pixel(image: RgbaImage, x: number, y: number): readonly [number, number, number] {
  const scaledX = Math.min(image.width - 1, Math.max(0, Math.floor((x / WIDTH) * image.width)));
  const scaledY = Math.min(image.height - 1, Math.max(0, Math.floor((y / HEIGHT) * image.height)));
  const offset = (scaledY * image.width + scaledX) * 4;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 255;
}

function sampleSpread(image: RgbaImage): readonly SampleEvidence[] {
  const background = pixel(image, WIDTH / 2, HEIGHT / 2);
  const radius = 14;
  return SAMPLE_POINTS.map(({ label, x, y }) => {
    const x0 = Math.floor(((x - radius) / WIDTH) * image.width);
    const y0 = Math.floor(((y - radius) / HEIGHT) * image.height);
    const x1 = Math.ceil(((x + radius) / WIDTH) * image.width);
    const y1 = Math.ceil(((y + radius) / HEIGHT) * image.height);
    let foregroundPixels = 0;
    let peakDistance = 0;
    for (let py = y0; py <= y1; py += 1) {
      for (let px = x0; px <= x1; px += 1) {
        const d = distance(pixel(image, (px / image.width) * WIDTH, (py / image.height) * HEIGHT), background);
        peakDistance = Math.max(peakDistance, d);
        if (d > 0.1) foregroundPixels += 1;
      }
    }
    return { label, foregroundPixels, peakDistance: Number(peakDistance.toFixed(4)) };
  });
}

describe('parity-instancing-static Browser WebGPU population acceptance', () => {
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    // Browser Mode files share Chromium's GPU process. Do not dispose the
    // renderer here: disposal destroys the shared device for later cases.
    canvas?.remove();
    canvas = undefined;
  });

  it.each(COUNTS)(
    `renders %s instances for ${FRAME_COUNT} frames with stable residency and visible spread`,
    async (count) => {
      expect(navigator.gpu, 'Browser WebGPU is required for this acceptance path').toBeDefined();

      canvas = document.createElement('canvas');
      canvas.id = `instancing-static-browser-${count}`;
      canvas.width = WIDTH * RENDER_SCALE;
      canvas.height = HEIGHT * RENDER_SCALE;
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
      canvas.style.display = 'block';
      document.body.append(canvas);

      const created = await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const renderer = created.value;
      expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

      const world = new World();
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      const lease = attached.value;

      world.spawn(
        {
          component: Transform,
          data: { pos: [30, 30, 60], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: Camera,
          data: {
            fov: (60 * Math.PI) / 180,
            aspect: WIDTH / HEIGHT,
            near: 0.1,
            far: 1000,
            clearColor: [0.05, 0.05, 0.08, 1],
          },
        },
      );
      world.spawn({
        component: DirectionalLight,
        data: { direction: [-0.3, -1, -0.5], color: [1, 1, 1], intensity: 1 },
      });

      world.spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
        { component: Instances, data: { transforms: translationGrid(count) } },
      );

      const errors: Array<{ readonly code: string; readonly hint: string }> = [];
      renderer.subscribe((event) => {
        if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
      });

      const frameInput = {
        leases: [lease],
        camera: { lease },
        environment: { lease },
      };
      let firstInspection;
      for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
        expect(world.update(1 / 60).ok).toBe(true);
        const drawn = renderer.draw(frameInput);
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) return;
        const completed = await drawn.value.completed;
        expect(completed.ok).toBe(true);
        if (frame === 0) {
          firstInspection = renderer
            .inspect()
            .instanceCollections[0];
        }
      }

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const stableInspection = renderer
        .inspect()
        .instanceCollections[0];
      expect(firstInspection?.uploadedBytes ?? 0).toBeGreaterThan(0);
      expect(stableInspection).toMatchObject({ count, uploadedBytes: 0 });
      expect(stableInspection?.lane).toMatch(/storage|uniform/);
      expect(errors, `Browser RhiError/renderer errors for ${count}: ${JSON.stringify(errors)}`).toEqual([]);

      const image = await decodePng(await captureCanvas(canvas));
      const spread = sampleSpread(image);
      const visibleSamples = spread.filter((sample) => sample.foregroundPixels > 4).length;
      console.log(
        `[instancing-static-browser] ${JSON.stringify({
          count,
          dimensions: [image.width, image.height],
          frames: FRAME_COUNT,
          backend: renderer.inspect().capabilities.backendKind,
          firstUploadBytes: firstInspection?.uploadedBytes ?? 0,
          stableUploadBytes: stableInspection?.uploadedBytes ?? 0,
          lane: stableInspection?.lane,
          residentGeneration: stableInspection?.residentGeneration,
          visibleSamples,
          spread,
          rhiErrorCount: errors.length,
        })}`,
      );
      expect(visibleSamples, `visible spread evidence for ${count}: ${JSON.stringify(spread)}`).toBeGreaterThanOrEqual(3);
    },
    900_000,
  );
});
