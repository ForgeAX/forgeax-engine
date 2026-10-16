import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/browser';
import { AppError } from '../src/errors';

function dataBootstrapUrl(): string {
  return `data:text/javascript,${encodeURIComponent('export default () => ({})')}`;
}

function expectPrepareBootstrapUrlError(result: Awaited<ReturnType<typeof createApp>>, url: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AppError);
  if (!(result.error instanceof AppError)) return;
  expect(result.error.code).toBe('app-execution-bootstrap-failed');
  if (result.error.code !== 'app-execution-bootstrap-failed') return;
  expect(result.error.detail.phase).toBe('prepare');
  expect(result.error.detail.moduleUrl).toBe(url);
  expect(result.error.detail.cause).toBeInstanceOf(TypeError);
  expect(result.error.detail.cause).not.toBe(result.error);
  expect(String((result.error.detail.cause as TypeError).message)).toContain('Invalid URL');
}

describe('createApp execution bootstrap URL normalization', () => {
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    canvas.remove();
  });

  // The repaired retry creates a real WebGPU renderer. Headed lavapipe can
  // spend tens of seconds creating a fresh device after another browser group
  // exits, so retain the bounded assertion while avoiding Vitest's 15s default.
  it(
    'returns a structured parse failure before probing and retries on the same canvas',
    async () => {
      const invalidBootstrap = 'http://[::1';
      const probeSpy = vi.spyOn(URL, 'createObjectURL');

      try {
        const refused = await createApp(canvas, {
          execution: { workers: {}, bootstrap: invalidBootstrap },
        });

        expectPrepareBootstrapUrlError(refused, invalidBootstrap);
        expect(canvas.isConnected).toBe(true);
        expect(probeSpy).not.toHaveBeenCalled();
      } finally {
        probeSpy.mockRestore();
      }

      const channel = new MessageChannel();
      const close = vi.spyOn(channel.port2, 'close');
      const repaired = await createApp(canvas, {
        execution: { workers: { engine: false }, bootstrap: dataBootstrapUrl(), bootstrapPort: channel.port2 },
      });

      expect(repaired.ok).toBe(true);
      expect(canvas.isConnected).toBe(true);
      if (!repaired.ok) return;
      expect(repaired.value.world).toBeDefined();
      const disposed = await repaired.value.dispose();
      expect(disposed.ok).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      channel.port1.close();
    },
    60_000,
  );

  it(
    'normalizes before realm-bound-option refusal and preserves the valid conflict',
    async () => {
      const invalidBootstrap = 'http://[::1';
      const refused = await createApp(canvas, {
        features: [],
        execution: { workers: { engine: false }, bootstrap: invalidBootstrap },
      });

      expectPrepareBootstrapUrlError(refused, invalidBootstrap);

      const conflict = await createApp(canvas, {
        features: [],
        execution: { workers: { engine: false }, bootstrap: dataBootstrapUrl() },
      });

      expect(conflict.ok).toBe(false);
      if (conflict.ok) return;
      expect(conflict.error).toBeInstanceOf(AppError);
      if (!(conflict.error instanceof AppError)) return;
      expect(conflict.error.code).toBe('app-execution-bootstrap-failed');
      if (conflict.error.code !== 'app-execution-bootstrap-failed') return;
      expect(conflict.error.detail.phase).toBe('prepare');
      expect(conflict.error.detail.moduleUrl).toContain('data:text/javascript');
      expect(conflict.error.detail.cause).toBeInstanceOf(TypeError);
      expect(String((conflict.error.detail.cause as TypeError).message)).toContain('features');
    },
    60_000,
  );
});
