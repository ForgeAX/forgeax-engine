import type { RhiAdapter, RhiError, RhiInstance } from '@forgeax/engine-rhi';
import { RhiError as BackendError } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { err, ok, type Result } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';

const { probeAdapter, requestAdapter, constructRuntimeRendererHost } = vi.hoisted(() => ({
  probeAdapter: vi.fn(),
  requestAdapter: vi.fn(),
  constructRuntimeRendererHost: vi.fn(),
}));

vi.mock('@forgeax/engine-rhi-webgpu', async (importOriginal) => {
  const backend = await importOriginal<typeof import('@forgeax/engine-rhi-webgpu')>();
  return {
    ...backend,
    instrumentation: undefined,
    requestAdapter: probeAdapter,
    rhi: { ...backend.rhi, requestAdapter },
  };
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-runtime/internal/renderer-host')>()),
  constructRuntimeRendererHost,
}));

import { createApp } from '../browser';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('consumes the debug startup adapter once and requests each recovery adapter from the backend', async () => {
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubEnv('FORGEAX_ENGINE_RHI_DEBUG', '1');
  const initial = new RhiNullAdapter();
  const replacement = new RhiNullAdapter();
  const unavailable = new BackendError({
    code: 'adapter-unavailable',
    expected: 'a live recovery adapter',
    hint: 'retry after the host observes adapter availability',
  });
  probeAdapter.mockResolvedValue(ok(initial));
  requestAdapter.mockResolvedValueOnce(ok(replacement)).mockResolvedValueOnce(err(unavailable));
  const observed: Result<RhiAdapter, RhiError>[] = [];
  const canvas = { tagName: 'canvas', isConnected: true } as HTMLCanvasElement;
  const options = { powerPreference: 'low-power' } as const;
  const stopped = new EngineEnvironmentError('adapter assembly inspection complete');
  constructRuntimeRendererHost.mockImplementation(
    async (_canvas, rendererOptions: { rhi: RhiInstance }) => {
      observed.push(await rendererOptions.rhi.requestAdapter());
      observed.push(await rendererOptions.rhi.requestAdapter(options, canvas));
      observed.push(await rendererOptions.rhi.requestAdapter(options, canvas));
      return err(stopped);
    },
  );

  const result = await createApp(canvas);

  expect(result).toEqual(err(stopped));
  expect(probeAdapter).toHaveBeenCalledTimes(1);
  expect(requestAdapter).toHaveBeenCalledTimes(2);
  expect(requestAdapter).toHaveBeenNthCalledWith(1, options, canvas);
  expect(requestAdapter).toHaveBeenNthCalledWith(2, options, canvas);
  expect(observed.map((result) => result.ok)).toEqual([true, true, false]);
  expect(observed[2]).toEqual(err(unavailable));
});
