// lit-pixels.browser.test.ts — LO 5.1 advanced-lighting (Blinn-Phong)
// pixel-readback gate.
//
// The structural-only onerror-gate (onerror-gate.browser.test.ts) and the
// dawn smoke (>=60 frames, onError=0, no readback) both stayed green while
// the demo rendered an all-black frame: the custom Blinn-Phong shader lit a
// cube from a light placed at the cube's own center, so every visible face
// was back-lit (dot(N,L) <= 0) and only the 0.05*tex ambient term survived
// (maxLuma ~34/255 -- black to the eye). LO 5.1 is a wood FLOOR plane lit
// from above; the floor normal faces the light and the surface is brightly
// lit. This test drives the real demo bootstrap (import ../index.ts) and
// asserts the painted canvas carries genuinely lit pixels, not just ambient.
//
// Readback path mirrors packages/runtime/src/__tests__/
// light-casters-9-light.browser.test.ts: rAF-pump several frames so the
// chromium compositor consumes the WebGPU swap chain, then
// createImageBitmap -> OffscreenCanvas 2D -> getImageData (the same chain
// renderer.readPixels() uses internally).
//
// Compositor-stall degradation (same rationale as light-casters): under
// headless chromium the compositor can sample the swap chain before
// consuming the painted frame, returning all-zero bytes (alpha=0). When
// that happens the pixel-content assert cannot distinguish a stall from a
// black render, so the test degrades to its structural anchors (error-free
// bootstrap + readback-shape) and the deterministic dawn smoke (offscreen
// target, no compositor, maxLuma>40) owns the black-render gate.

import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';
import { afterEach, describe, expect, it } from 'vitest';

const CANVAS_W = 256;
const CANVAS_H = 256;

// A lit surface must exceed pure ambient (0.05 * texColor). Wood texColor
// peaks well below 1.0, so ambient alone caps at ~0.05*200 ~= 10/255. A
// diffuse-lit floor reads in the 60..130 range (see probe: floorNear
// [113,71,43]). Threshold 40/255 sits comfortably above the ambient-only
// ceiling and below the lit-floor floor, so it falsifies the back-lit-cube
// regression without being brittle to compositor jitter.
const LIT_LUMA_THRESHOLD = 40;

let canvas: HTMLCanvasElement | undefined;

// chromium fires an unhandled OperationError ("Instance dropped") when a
// shader compile is in-flight as the device is GC'd post-test. Known
// headless timing artifact, not a test failure (same suppression as
// light-casters-9-light.browser.test.ts).
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof DOMException && e.reason.message.includes('Instance dropped')) {
      e.preventDefault();
    }
  });
}

afterEach(() => {
  if (canvas !== undefined && canvas.parentNode !== null) {
    canvas.parentNode.removeChild(canvas);
  }
  canvas = undefined;
  delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
});

function maxLuma(pixels: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i + 0] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const l = Math.max(r, g, b);
    if (l > m) m = l;
  }
  return m;
}

async function readCanvas(target: HTMLCanvasElement): Promise<ImageData> {
  const bmp = await createImageBitmap(target);
  const off = new OffscreenCanvas(target.width, target.height);
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, target.width, target.height);
  bmp.close();
  return data;
}

describe('learn-render 5.1 advanced-lighting pixel-readback gate', () => {
  it('renders a lit (non-black) surface, not just ambient', async () => {
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[5.1.lit-pixels] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags",
      );
    }

    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    document.body.appendChild(canvas);

    const errors: Array<{ code: string; hint?: string }> = [];
    (globalThis as unknown as { __learnRenderErrors: typeof errors }).__learnRenderErrors = errors;

    // Drive the real demo bootstrap; it spawns the scene and starts its own
    // rAF render loop via app.start().
    await import('../index.ts');

    // Pump rAF + setTimeout fences so the demo's loop draws several frames,
    // the custom material shader's async pipeline compile resolves, and the
    // chromium compositor consumes the swap chain before readback.
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    // Two-shot readback: the first createImageBitmap can kick the compositor
    // into consuming the WebGPU swap chain; the second samples the consumed
    // canvas (same idiom as light-casters-9-light.browser.test.ts).
    await readCanvas(canvas);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const img = await readCanvas(canvas);

    // Unconditional anchors: the bootstrap drives the SUT through a real
    // createApp + draw chain with zero SUT-attributable errors, and the
    // readback returns a contract-shaped RGBA buffer. These run regardless
    // of compositor timing.
    //
    // Filter to SUT_ATTRIBUTABLE_CODES (same allow-list as
    // apps/shared/onerror-gate.ts + preview.browser.test.ts) so the gate fires
    // on real validation/render faults but NOT on `device-lost` -- which in the
    // batched vitest browser runner is an environmental teardown artifact: a
    // sibling test's device destruction ("reason: destroyed") fans out through
    // the shared GPUDevice to every live app's onError. Asserting the raw array
    // here made this test flake red on unrelated merges (issue #466, merge
    // 5f804c7a, a docs-only commit).
    const sutErrors = errors.filter((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    expect(sutErrors, `SUT renderer errors: ${sutErrors.map((e) => e.code).join(', ')}`).toEqual([]);
    expect(img.data.length).toBe(CANVAS_W * CANVAS_H * 4);

    // alphaMode 'opaque' -> a consumed frame returns alpha 255 somewhere; a
    // headless-chromium compositor stall returns all-zero bytes (alpha
    // included) even though the canvas was painted. This is the documented
    // swap-chain-vs-compositor race (see packages/runtime/src/__tests__/
    // light-casters-9-light.browser.test.ts header + ~line 623). When the
    // compositor did NOT consume the frame, the pixel-content assert cannot
    // distinguish a stall from a black render, so we degrade to the
    // structural anchors above (exactly the repo precedent) and let the
    // deterministic dawn smoke (offscreen target, no compositor, maxLuma>40)
    // own the black-render gate. When the compositor DID consume the frame,
    // the luma assert below falsifies the back-lit regression.
    let maxAlpha = 0;
    for (let i = 3; i < img.data.length; i += 4) maxAlpha = Math.max(maxAlpha, img.data[i] ?? 0);
    if (maxAlpha <= 200) {
      console.warn(
        '[5.1.lit-pixels] chromium compositor did not consume the WebGPU swap-chain before readback (alpha=0); pixel-content assert skipped this run. The error-free bootstrap + readback-shape anchors above remain the chain-integrity gate; the dawn smoke (maxLuma>40) is the deterministic black-render gate. See file header rationale.',
      );
      return;
    }

    const luma = maxLuma(img.data);
    expect(
      luma,
      `frame max luma ${luma}/255 <= ${LIT_LUMA_THRESHOLD}: surface is unlit (only ambient survives — light back-facing all visible geometry)`,
    ).toBeGreaterThan(LIT_LUMA_THRESHOLD);
  }, 30_000);
});
