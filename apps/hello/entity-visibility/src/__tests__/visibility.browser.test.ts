import { createWorldContext } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { scenePlugin } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createVisibilityDemoWorld } from '../main';

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 360;

async function captureCanvas(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  if (typeof base64 !== 'string') throw new Error('canvas screenshot did not return base64 PNG');
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return bytes;
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface ReferenceRoi {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const TARGET_ROI: ReferenceRoi = { x0: 280, y0: 225, x1: 360, y1: 315 };
const SHADOW_ROI: ReferenceRoi = { x0: 220, y0: 310, x1: 320, y1: 355 };

class RetryableBrowserDeviceLoss extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableBrowserDeviceLoss';
  }
}

function describeStructuredError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const candidate = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
    readonly message?: unknown;
  };
  return JSON.stringify({
    code: candidate.code,
    expected: candidate.expected,
    hint: candidate.hint,
    detail: candidate.detail,
    message: candidate.message,
  });
}

async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const bitmap = await createImageBitmap(new Blob([copy.buffer], { type: 'image/png' }));
  const decoder = document.createElement('canvas');
  decoder.width = bitmap.width;
  decoder.height = bitmap.height;
  const context = decoder.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('PNG decoder could not acquire a 2D context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    width: decoder.width,
    height: decoder.height,
    data: context.getImageData(0, 0, decoder.width, decoder.height).data,
  };
}

function scaledRoi(frame: DecodedPng, roi: ReferenceRoi): ReferenceRoi {
  return {
    x0: Math.floor((roi.x0 / CANVAS_WIDTH) * frame.width),
    y0: Math.floor((roi.y0 / CANVAS_HEIGHT) * frame.height),
    x1: Math.ceil((roi.x1 / CANVAS_WIDTH) * frame.width),
    y1: Math.ceil((roi.y1 / CANVAS_HEIGHT) * frame.height),
  };
}

function colorCount(frame: DecodedPng, roi: ReferenceRoi, color: 'red' | 'blue' | 'gold'): number {
  const area = scaledRoi(frame, roi);
  let count = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const offset = (y * frame.width + x) * 4;
      const red = frame.data[offset] ?? 0;
      const green = frame.data[offset + 1] ?? 0;
      const blue = frame.data[offset + 2] ?? 0;
      if (color === 'red' && red > 80 && red > green * 1.5 && red > blue * 1.3) count += 1;
      if (color === 'blue' && blue > 70 && blue > red * 1.3 && blue > green * 1.2) count += 1;
      if (color === 'gold' && red > 80 && green > 45 && red > blue * 2 && green > blue * 1.5)
        count += 1;
    }
  }
  return count;
}

function roiDelta(
  first: DecodedPng,
  second: DecodedPng,
  roi: ReferenceRoi,
): { changedPixels: number; meanL1: number } {
  expect(second.width).toBe(first.width);
  expect(second.height).toBe(first.height);
  const area = scaledRoi(first, roi);
  let changedPixels = 0;
  let totalL1 = 0;
  let pixels = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const offset = (y * first.width + x) * 4;
      const l1 =
        Math.abs((first.data[offset] ?? 0) - (second.data[offset] ?? 0)) +
        Math.abs((first.data[offset + 1] ?? 0) - (second.data[offset + 1] ?? 0)) +
        Math.abs((first.data[offset + 2] ?? 0) - (second.data[offset + 2] ?? 0));
      if (l1 > 15) changedPixels += 1;
      totalL1 += l1;
      pixels += 1;
    }
  }
  return { changedPixels, meanL1: totalL1 / pixels };
}

describe('entity visibility browser visual red test', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;

  afterEach(() => {
    // Browser Mode files share Chromium's GPU process. Do not dispose the
    // renderer here: that destroys the shared device for the next file.
    renderer = undefined;
    canvas?.remove();
    canvas = undefined;
  });

  it('records hidden, restored, and visible-child PNG evidence for one target entity', async () => {
    let retries = 0;
    const run = async (): Promise<void> => {
      let lostReason: string | undefined;
      let lostMessage = '';
      let unsubscribeLost: (() => void) | undefined;
      try {
        if (navigator.gpu === undefined) {
          throw new Error(
            JSON.stringify({
              code: 'webgpu-unavailable',
              expected: 'navigator.gpu is available',
              hint: 'launch headed Chrome with unsafe WebGPU',
            }),
          );
        }
        await page.viewport(800, 600);
        canvas = document.createElement('canvas');
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        canvas.style.width = `${CANVAS_WIDTH}px`;
        canvas.style.height = `${CANVAS_HEIGHT}px`;
        document.body.append(canvas);

        const created = await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' });
        if (!created.ok) {
          throw new Error(`createRenderer failed: ${describeStructuredError(created.error)}`);
        }
        renderer = created.value;
        unsubscribeLost = renderer.subscribe((event) => {
          if (event.kind === 'state-changed' && event.current === 'device-lost') {
            lostReason = 'device-lost';
            lostMessage = 'renderer entered device-lost state';
          } else if (event.kind === 'error') {
            lostReason = event.error.code;
            lostMessage = describeStructuredError(event.error);
          }
        });
        const scene = createVisibilityDemoWorld();
        const attached = renderer.attach(scene.world);
        if (!attached.ok)
          throw new Error(`renderer.attach failed: ${describeStructuredError(attached.error)}`);
        await createWorldContext(scene.world, [scenePlugin()]);

        const draw = async () => {
          const updateResult = scene.world.update(1 / 60);
          if (!updateResult.ok)
            throw new Error(`world.update failed: ${describeStructuredError(updateResult.error)}`);
          const result = renderer?.draw({
            leases: [attached.value],
            camera: { lease: attached.value },
            environment: { lease: attached.value },
          });
          if (result === undefined || !result.ok) {
            throw new Error(
              `renderer.draw failed: ${result?.ok === false ? describeStructuredError(result.error) : 'missing-result'}`,
            );
          }
          const completed = await result.value.completed;
          if (!completed.ok)
            throw new Error(
              `renderer submission failed: ${describeStructuredError(completed.error)}`,
            );
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
          if (lostReason !== undefined) {
            if (lostReason === 'destroyed') {
              throw new RetryableBrowserDeviceLoss(
                `shared Chromium GPU device was destroyed: ${lostMessage}`,
              );
            }
            throw new Error(`renderer lost device: ${lostReason}: ${lostMessage}`);
          }
        };

    await draw();
    const baselinePng = await captureCanvas(canvas);
    scene.setTargetHidden();
    await draw();
    const hiddenPng = await captureCanvas(canvas);
    const hiddenEvidence = scene.evidence();

    scene.setTargetVisible();
    await draw();
    const restoredPng = await captureCanvas(canvas);
    scene.setAncestorHiddenWithVisibleChild();
    await draw();
    const childOverridePng = await captureCanvas(canvas);
    const restoredEvidence = scene.evidence();

    const [baseline, hidden, restored, childOverride] = await Promise.all([
      decodePng(baselinePng),
      decodePng(hiddenPng),
      decodePng(restoredPng),
      decodePng(childOverridePng),
    ]);
    expect([baseline.width, baseline.height]).toEqual([CANVAS_WIDTH, CANVAS_HEIGHT]);
    const targetRed = {
      baseline: colorCount(baseline, TARGET_ROI, 'red'),
      hidden: colorCount(hidden, TARGET_ROI, 'red'),
      restored: colorCount(restored, TARGET_ROI, 'red'),
    };
    const hiddenShadowDelta = roiDelta(baseline, hidden, SHADOW_ROI);
    const restoredShadowDelta = roiDelta(restored, hidden, SHADOW_ROI);
    const childFrameColors = {
      red: colorCount(childOverride, { x0: 0, y0: 0, x1: CANVAS_WIDTH, y1: CANVAS_HEIGHT }, 'red'),
      blue: colorCount(childOverride, { x0: 0, y0: 0, x1: CANVAS_WIDTH, y1: CANVAS_HEIGHT }, 'blue'),
      gold: colorCount(childOverride, { x0: 0, y0: 0, x1: CANVAS_WIDTH, y1: CANVAS_HEIGHT }, 'gold'),
    };

    console.log(
      JSON.stringify({
        dimensions: [childOverride.width, childOverride.height],
        targetRed,
        childFrameColors,
        hiddenShadowDelta,
        restoredShadowDelta,
      }),
    );

    expect(targetRed.baseline).toBeGreaterThan(1_000);
    expect(targetRed.hidden).toBeLessThan(targetRed.baseline * 0.05);
    expect(targetRed.restored).toBeGreaterThan(targetRed.baseline * 0.8);
    expect(childFrameColors.blue).toBeGreaterThan(1_000);
    expect(hiddenShadowDelta.changedPixels).toBeGreaterThan(500);
    expect(hiddenShadowDelta.meanL1).toBeGreaterThan(20);
    expect(restoredShadowDelta.changedPixels).toBeGreaterThan(500);
    expect(restoredShadowDelta.meanL1).toBeGreaterThan(20);
    expect(hiddenEvidence.targetEffective).toBe('hidden');
    expect(hiddenEvidence.explicitlyHidden).toBeGreaterThan(0);
    expect(restoredEvidence.targetEffective).toBe('visible');
    expect(restoredEvidence.visibleChildEffective).toBe('visible');
    expect(scene.evidence().inheritedDescendantEffective).toBe('visible');
        console.log(
          JSON.stringify({
            target: 'entity-visibility-visual',
            expectations: [
              'hidden-render-output',
              'hidden-shadow-output',
              'restored-render-output',
              'visible-child-override-state',
            ],
            observed: {
              targetRed,
              childFrameColors,
              hiddenShadowDelta,
              restoredShadowDelta,
            },
            verdict: 'pass',
            confidence: 'high',
          }),
        );
      } catch (error) {
        if (!(error instanceof RetryableBrowserDeviceLoss) || retries >= 2) throw error;
        retries += 1;
        unsubscribeLost?.();
        unsubscribeLost = undefined;
        renderer = undefined;
        canvas?.remove();
        canvas = undefined;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return run();
      } finally {
        unsubscribeLost?.();
      }
    };
    await run();
  }, 60_000);
});
