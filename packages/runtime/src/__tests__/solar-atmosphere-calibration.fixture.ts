import { type EntityHandle, FixedTime, type World } from '@forgeax/engine-ecs';
import {
  Atmosphere,
  type Renderer,
  type RenderInspection,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import { propagateTransforms } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { page } from 'vitest/browser';
import { WAVE1_ATMOSPHERE_PRESET } from '../../../../scripts/dev-verify/wave1-rendering/recipe';

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface Roi {
  readonly centerX: number;
  readonly centerY: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

interface RoiStats {
  readonly finitePixels: number;
  readonly pixelCount: number;
  readonly nonBlackPixels: number;
  readonly meanLuma: number;
  readonly radialWidth: number;
}

export interface FrameSample {
  readonly pixels: ScreenshotPixels;
  readonly inspection: RenderInspection;
}

export const OUTPUT_WIDTH = 256;
export const OUTPUT_HEIGHT = 256;
export const DAYLIGHT: readonly [number, number, number] = [0, -0.25, 1];
export const FOG_ROI: Roi = { centerX: 0.5, centerY: 0.5, halfWidth: 0.24, halfHeight: 0.24 };
export const MAX_PAUSED_FOG_MEAN_LUMA_DELTA = 1;

export function createDensity(): TextureAsset {
  const size = 16;
  const data = new Uint8Array(size * size * size);
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const u = (x + 0.5) / size;
        const v = (z + 0.5) / size;
        const broad = 0.5 + 0.5 * Math.sin(u * Math.PI * 2) * Math.cos(v * Math.PI * 2);
        const detail = 0.5 + 0.5 * Math.sin((u + v) * Math.PI * 6);
        const value = 0.18 + 0.62 * (0.7 * broad + 0.3 * detail);
        data[(z * size + y) * size + x] = Math.round(value * 255);
      }
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: size, height: size, depth: size } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
}

function bounds(image: ScreenshotPixels, roi: Roi): readonly [number, number, number, number] {
  return [
    Math.max(0, Math.floor((roi.centerX - roi.halfWidth) * image.width)),
    Math.max(0, Math.floor((roi.centerY - roi.halfHeight) * image.height)),
    Math.min(image.width, Math.ceil((roi.centerX + roi.halfWidth) * image.width)),
    Math.min(image.height, Math.ceil((roi.centerY + roi.halfHeight) * image.height)),
  ];
}

function luma(pixels: Uint8Array, offset: number): number {
  return (
    0.2126 * (pixels[offset] ?? 0) +
    0.7152 * (pixels[offset + 1] ?? 0) +
    0.0722 * (pixels[offset + 2] ?? 0)
  );
}

export function roiStats(image: ScreenshotPixels, roi: Roi, excludeInnerRadius = 0): RoiStats {
  const [x0, y0, x1, y1] = bounds(image, roi);
  const values: Array<{ readonly x: number; readonly y: number; readonly value: number }> = [];
  const edge: number[] = [];
  let finitePixels = 0;
  let nonBlackPixels = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = luma(image.pixels, (y * image.width + x) * 4);
      values.push({ x, y, value });
      if (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1) edge.push(value);
      if (Number.isFinite(value)) finitePixels += 1;
      if (value > 2) nonBlackPixels += 1;
      total += value;
    }
  }
  edge.sort((left, right) => left - right);
  const baseline = edge[Math.floor(edge.length * 0.5)] ?? 0;
  let weight = 0;
  let radialMoment = 0;
  for (const sample of values) {
    const signal = Math.max(sample.value - baseline, 0);
    const dx = (sample.x + 0.5) / image.width - roi.centerX;
    const dy = (sample.y + 0.5) / image.height - roi.centerY;
    const radius = Math.hypot(dx, dy);
    // The authored disc is a separate source. Exclude its core and clipped
    // screenshot pixels so the measured width belongs to the circumsolar
    // excess rather than the disc or an LDR clamp.
    if (radius <= excludeInnerRadius || sample.value >= 254) continue;
    weight += signal;
    radialMoment += signal * (dx * dx + dy * dy);
  }
  return {
    finitePixels,
    pixelCount: values.length,
    nonBlackPixels,
    meanLuma: total / Math.max(1, values.length),
    radialWidth: weight > 0 ? Math.sqrt(radialMoment / weight) : 0,
  };
}

export function pixelDelta(left: ScreenshotPixels, right: ScreenshotPixels, roi?: Roi): number {
  const [x0, y0, x1, y1] = roi === undefined ? [0, 0, left.width, left.height] : bounds(left, roi);
  let changed = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * left.width + x) * 4;
      if (
        (left.pixels[offset] ?? 0) !== (right.pixels[offset] ?? 0) ||
        (left.pixels[offset + 1] ?? 0) !== (right.pixels[offset + 1] ?? 0) ||
        (left.pixels[offset + 2] ?? 0) !== (right.pixels[offset + 2] ?? 0)
      ) {
        changed += 1;
      }
    }
  }
  return changed;
}

export function roiMeanAbsoluteLumaDelta(
  left: ScreenshotPixels,
  right: ScreenshotPixels,
  roi: Roi,
): number {
  const [x0, y0, x1, y1] = bounds(left, roi);
  let total = 0;
  let samples = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * left.width + x) * 4;
      total += Math.abs(luma(left.pixels, offset) - luma(right.pixels, offset));
      samples += 1;
    }
  }
  return total / Math.max(1, samples);
}

async function screenshotPixels(
  canvas: HTMLCanvasElement,
  label: string,
): Promise<ScreenshotPixels> {
  const shot = await page.elementLocator(canvas).screenshot({
    path: `../../../../artifacts/sun-atmosphere-calibration/${label}.png`,
    base64: true,
  });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('sun-atmosphere: screenshot pixel context unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: image.width, height: image.height, pixels: new Uint8Array(image.data) };
}

export async function submitFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
): Promise<void> {
  propagateTransforms(world).unwrap();
  const drawn = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!drawn.ok) throw drawn.error;
  const completed = await drawn.value.completed;
  if (!completed.ok) throw completed.error;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export async function captureFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  canvas: HTMLCanvasElement,
  label: string,
): Promise<FrameSample> {
  await submitFrame(world, renderer, lease);
  const pixels = await screenshotPixels(canvas, label);
  const inspection = renderer.inspect();
  return { pixels, inspection };
}

export function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  canvas.style.width = `${OUTPUT_WIDTH}px`;
  canvas.style.height = `${OUTPUT_HEIGHT}px`;
  document.body.append(canvas);
  return canvas;
}

export function attachRenderer(renderer: Renderer, world: World): RenderWorldLease {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  return attached.value;
}

export const DISC_RADIUS = 0.03;

export const LOW_SUN: readonly [number, number, number] = [0, -0.01, 1];

export interface CameraProjectionConfig {
  readonly position: readonly [number, number, number];
  readonly fov: number;
  readonly near: number;
  readonly far: number;
}

interface CameraBoundsReceipt {
  readonly minNdcX: number;
  readonly maxNdcX: number;
  readonly minNdcY: number;
  readonly maxNdcY: number;
  readonly roiMinNdcY: number;
  readonly roiMaxNdcY: number;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly intersects: boolean;
  readonly containsRoi: boolean;
}

export function projectCameraBounds(
  position: readonly [number, number, number],
  halfExtents: readonly [number, number, number],
  roi: Roi,
  camera: CameraProjectionConfig,
): CameraBoundsReceipt {
  const tanHalfFov = Math.tan(camera.fov / 2);
  const depths = [
    camera.position[2] - (position[2] - halfExtents[2]),
    camera.position[2] - (position[2] + halfExtents[2]),
  ];
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const ndcX = [
    (position[0] - halfExtents[0] - camera.position[0]) / (minDepth * tanHalfFov),
    (position[0] + halfExtents[0] - camera.position[0]) / (minDepth * tanHalfFov),
    (position[0] - halfExtents[0] - camera.position[0]) / (maxDepth * tanHalfFov),
    (position[0] + halfExtents[0] - camera.position[0]) / (maxDepth * tanHalfFov),
  ];
  const ndcY = [
    (position[1] - halfExtents[1] - camera.position[1]) / (minDepth * tanHalfFov),
    (position[1] + halfExtents[1] - camera.position[1]) / (minDepth * tanHalfFov),
    (position[1] - halfExtents[1] - camera.position[1]) / (maxDepth * tanHalfFov),
    (position[1] + halfExtents[1] - camera.position[1]) / (maxDepth * tanHalfFov),
  ];
  const minNdcX = Math.min(...ndcX);
  const maxNdcX = Math.max(...ndcX);
  const minNdcY = Math.min(...ndcY);
  const maxNdcY = Math.max(...ndcY);
  // Screenshot Y grows downward, while camera NDC Y grows upward. Keep the
  // conversion explicit so an asymmetric ROI cannot silently use the wrong
  // interval orientation.
  const roiMinNdcY = 1 - 2 * (roi.centerY + roi.halfHeight);
  const roiMaxNdcY = 1 - 2 * (roi.centerY - roi.halfHeight);
  const roiMinNdcX = (roi.centerX - roi.halfWidth) * 2 - 1;
  const roiMaxNdcX = (roi.centerX + roi.halfWidth) * 2 - 1;
  return {
    minNdcX,
    maxNdcX,
    minNdcY,
    maxNdcY,
    roiMinNdcY,
    roiMaxNdcY,
    minDepth,
    maxDepth,
    intersects:
      maxNdcX >= roiMinNdcX &&
      minNdcX <= roiMaxNdcX &&
      maxNdcY >= roiMinNdcY &&
      minNdcY <= roiMaxNdcY,
    containsRoi:
      minNdcX <= roiMinNdcX &&
      maxNdcX >= roiMaxNdcX &&
      minNdcY <= roiMinNdcY &&
      maxNdcY >= roiMaxNdcY,
  };
}

export function setAtmosphere(
  world: World,
  entity: EntityHandle,
  strength: number,
  width: number,
  sunAngularRadius = DISC_RADIUS,
): void {
  world
    .set(entity, Atmosphere, {
      ...WAVE1_ATMOSPHERE_PRESET,
      mieScattering: strength * 3.996e-6,
      mieAnisotropy: 1 - width * 0.2,
      sunAngularRadius,
    })
    .unwrap();
}
