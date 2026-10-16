import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';
import { afterEach, describe, expect, it } from 'vitest';

const GATE_TIMEOUT_MS = 30_000;
// Teardown margin kept inside the Vitest timeout, as in the shared onerror gate.
const GATE_SETTLE_MARGIN_MS = 5_000;

describe('learn-render 1.2 hello-triangle onerror-gate', () => {
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    if (canvas !== undefined && canvas.parentNode !== null) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = undefined;
    delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
    delete (globalThis as unknown as { __learnRenderTriangleClearOnly?: unknown })
      .__learnRenderTriangleClearOnly;
    delete (globalThis as unknown as { __learnRenderTriangleDrawCalls?: unknown })
      .__learnRenderTriangleDrawCalls;
    delete (globalThis as unknown as { __learnRenderBootstrapComplete?: unknown })
      .__learnRenderBootstrapComplete;
    delete (globalThis as unknown as { __captureHelloTriangle?: unknown }).__captureHelloTriangle;
  });

  // Match the shared onerror gate's budget model: the bootstrap window is the
  // test budget minus a settle margin, measured from test start. A fixed window
  // after the import timed out while the renderer was still preparing shaders
  // on a loaded host, even though the test budget had time left.
  it('bootstraps a non-clear-only triangle and draws', async () => {
    const bootstrapDeadline = performance.now() + GATE_TIMEOUT_MS - GATE_SETTLE_MARGIN_MS;
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[learn-render 1.2 hello-triangle.onerror-gate] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags",
      );
    }
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    const errors: Array<{ code: string; hint?: string }> = [];
    (globalThis as unknown as { __learnRenderErrors: typeof errors }).__learnRenderErrors = errors;

    await import('../index.ts');

    const bootstrapComplete = (): boolean =>
      (globalThis as unknown as { __learnRenderBootstrapComplete?: boolean })
        .__learnRenderBootstrapComplete === true;
    const hasSutError = (): boolean => errors.some((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    while (performance.now() < bootstrapDeadline && !hasSutError() && !bootstrapComplete()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const sutErrors = errors.filter((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    if (sutErrors.length === 0 && !bootstrapComplete()) {
      throw new Error(
        `[learn-render 1.2 hello-triangle.onerror-gate] bootstrap inconclusive within ${(GATE_TIMEOUT_MS - GATE_SETTLE_MARGIN_MS) / 1000}s ` +
          `(no SUT error, not complete); captured codes=[${errors.map((e) => e.code).join(', ')}] ` +
          '-> inspect import/bootstrap timing and captured errors',
      );
    }

    expect(sutErrors).toEqual([]);
    expect(Reflect.get(globalThis, '__learnRenderBootstrapComplete')).toBe(true);
    expect(Reflect.get(globalThis, '__learnRenderTriangleClearOnly')).toBe(false);
    const drawCalls = Reflect.get(globalThis, '__learnRenderTriangleDrawCalls');
    expect(typeof drawCalls).toBe('function');
    if (typeof drawCalls === 'function') expect(drawCalls()).toBeGreaterThan(0);
  }, GATE_TIMEOUT_MS);
});
