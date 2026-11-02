// Browser coverage for WebGPU swap-chain format selection and configuration.

import { World } from '@forgeax/engine-ecs';
import type { Renderer, RendererEvent, RenderWorldLease } from '@forgeax/engine-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../src/createRenderer';

const CHROMIUM_FORMAT_MISMATCH_WARNING = 'different format than is preferred';

type StructuredError = Error & {
  readonly code?: unknown;
  readonly expected?: unknown;
  readonly hint?: unknown;
  readonly detail?: unknown;
  readonly cause?: unknown;
};

function errorRecord(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const structured = error as StructuredError;
  return {
    name: error.name,
    message: error.message,
    code: structured.code,
    expected: structured.expected,
    hint: structured.hint,
    detail: structured.detail,
    cause: structured.cause instanceof Error ? errorRecord(structured.cause) : structured.cause,
  };
}

function resetSwapChainProbe(): void {
  delete (globalThis as typeof globalThis & { __forgeaxSwapChainFormat?: GPUTextureFormat })
    .__forgeaxSwapChainFormat;
}

describe('swap-chain-format.browser - AC-01 + AC-02 integration guards', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;
  let lease: RenderWorldLease | undefined;
  let unsubscribe: (() => void) | undefined;
  let rendererEvents: RendererEvent[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    resetSwapChainProbe();
    rendererEvents = [];
    // Spy before createRenderer so context configuration warnings are captured.
    warnSpy = vi.spyOn(console, 'warn');
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      try {
        lease?.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
      lease = undefined;

      if (renderer !== undefined) {
        try {
          const disposed = await renderer.dispose();
          if (!disposed.ok) cleanupErrors.push(disposed.error);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      try {
        unsubscribe?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unsubscribe = undefined;
      }

      try {
        canvas?.remove();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        canvas = undefined;
      }

      try {
        warnSpy?.mockRestore();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        warnSpy = undefined;
      }

      renderer = undefined;
      lease = undefined;
      rendererEvents = [];
      try {
        resetSwapChainProbe();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Swap-chain fixture cleanup failed');
    }
  });

  async function attachClearOnlyWorld(): Promise<void> {
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[swap-chain-format.browser] code: 'webgpu-unavailable'; hint: Chromium WebGPU is required",
      );
    }

    const created = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!created.ok) throw new Error(JSON.stringify(errorRecord(created.error)));
    renderer = created.value;
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');
    unsubscribe = renderer.subscribe((event) => rendererEvents.push(event));

    // The World intentionally has no Camera or renderable entities: this is a clear-only frame.
    const world = new World();
    const attached = renderer.attach(world);
    if (!attached.ok) throw new Error(JSON.stringify(errorRecord(attached.error)));
    lease = attached.value;
    world.update(1 / 60).unwrap();
  }

  async function drawAndCompleteClearFrame(label: string): Promise<void> {
    if (renderer === undefined || lease === undefined) {
      throw new Error(`${label}: renderer and World lease must be attached before draw`);
    }
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) {
      throw new Error(
        `${label}: renderer.draw failed ${JSON.stringify({
          error: errorRecord(drawn.error),
          rendererErrors: rendererEvents
            .filter((event) => event.kind === 'error')
            .map((event) => errorRecord(event.error)),
        })}`,
      );
    }
    expect(drawn.value.presentation).toBe('ready');
    const completed = await drawn.value.completed;
    if (!completed.ok) {
      throw new Error(
        `${label}: frame completion failed ${JSON.stringify(errorRecord(completed.error))}`,
      );
    }
    expect(
      rendererEvents
        .filter((event) => event.kind === 'error')
        .map((event) => errorRecord(event.error)),
    ).toEqual([]);
  }

  it('AC-01: Chromium WebGPU does not emit a format-mismatch warning for the preferred format', async () => {
    await attachClearOnlyWorld();
    await drawAndCompleteClearFrame('AC-01');

    const matchingCalls = warnSpy?.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes(CHROMIUM_FORMAT_MISMATCH_WARNING)),
    );
    expect(matchingCalls).toEqual([]);
  });

  it('AC-02: the configured-format probe matches Chromium preferred canvas format', async () => {
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[swap-chain-format.browser AC-02] code: 'webgpu-unavailable'; hint: Chromium WebGPU is required",
      );
    }
    const expectedFormat = navigator.gpu.getPreferredCanvasFormat();

    await attachClearOnlyWorld();
    await drawAndCompleteClearFrame('AC-02');

    const probe = (
      globalThis as typeof globalThis & {
        __forgeaxSwapChainFormat?: GPUTextureFormat;
      }
    ).__forgeaxSwapChainFormat;
    expect(probe).toBe(expectedFormat);
  });

  it('I-8 falsification: the AC-01 warning spy observes the canonical WebGPU warning channel', () => {
    console.warn('GPUCanvasContext was configured with a different format than is preferred');
    const matchingCalls = warnSpy?.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes(CHROMIUM_FORMAT_MISMATCH_WARNING)),
    );
    expect(matchingCalls).toBeDefined();
    expect(matchingCalls?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});
