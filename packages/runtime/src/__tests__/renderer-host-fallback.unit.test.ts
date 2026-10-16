import { EngineEnvironmentError } from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  constructRendererHost: vi.fn(),
  loadBackendPack: vi.fn(),
}));

vi.mock('@forgeax/engine-render/internal/construct-renderer', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@forgeax/engine-render/internal/construct-renderer')>();
  return { ...actual, constructRendererHost: mocks.constructRendererHost };
});

vi.mock('../backend-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend-selection')>();
  return { ...actual, loadBackendPack: mocks.loadBackendPack };
});

import { constructRuntimeRendererHost } from '../renderer-host';

function environmentError(code: 'adapter-unavailable' | 'limit-exceeded') {
  return new EngineEnvironmentError('no usable rendering backend', {
    webgpuError: new RhiError({
      code,
      expected: 'a usable WebGPU backend',
      hint: 'select another backend',
    }),
  });
}

function canvas() {
  return { getContext: vi.fn((_kind?: string) => null) };
}

describe('runtime renderer backend fallback boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('preserves ordinary construction errors and does not enter Channel 3', async () => {
    const firstPack = { name: 'webgpu' };
    const fallbackPack = { name: 'wgpu' };
    const target = canvas();
    const ordinaryError = new Error('shader compile failed');
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, value: firstPack })
      .mockResolvedValueOnce({ ok: true, value: fallbackPack });
    mocks.constructRendererHost.mockImplementation(
      async (hostCanvas: typeof target, _options: unknown, _bundler: unknown, pack: unknown) => {
        if (pack === fallbackPack) hostCanvas.getContext('webgl2');
        return { ok: false, error: ordinaryError };
      },
    );

    const result = await constructRuntimeRendererHost(target);

    expect(result).toEqual({ ok: false, error: ordinaryError });
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(1);
    expect(mocks.constructRendererHost).toHaveBeenCalledTimes(1);
    expect(target.getContext).not.toHaveBeenCalled();
  });

  it('uses one Channel 3 attempt for an environment-class WebGPU failure', async () => {
    const firstPack = { name: 'webgpu' };
    const fallbackPack = { name: 'wgpu' };
    const target = canvas();
    const environmentFailure = environmentError('adapter-unavailable');
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, value: firstPack })
      .mockResolvedValueOnce({ ok: true, value: fallbackPack });
    mocks.constructRendererHost
      .mockResolvedValueOnce({ ok: false, error: environmentFailure })
      .mockImplementationOnce(async (hostCanvas: typeof target, _options, _bundler, pack) => {
        if (pack === fallbackPack) hostCanvas.getContext('webgl2');
        return { ok: true, value: {} };
      });

    const result = await constructRuntimeRendererHost(target);

    expect(result.ok).toBe(true);
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(2);
    expect(mocks.loadBackendPack).toHaveBeenNthCalledWith(2, undefined, true);
    expect(mocks.constructRendererHost).toHaveBeenNthCalledWith(
      2,
      target,
      undefined,
      undefined,
      fallbackPack,
    );
    expect(target.getContext).toHaveBeenCalledOnce();
  });

  it('never falls back for an explicitly injected RHI and retains structured detail', async () => {
    const firstPack = { name: 'explicit' };
    const target = canvas();
    const environmentFailure = environmentError('limit-exceeded');
    const explicitRhi = {};
    mocks.loadBackendPack.mockResolvedValueOnce({ ok: true, value: firstPack });
    mocks.constructRendererHost.mockResolvedValueOnce({ ok: false, error: environmentFailure });

    const result = await constructRuntimeRendererHost(target, { rhi: explicitRhi as never });

    expect(result).toEqual({ ok: false, error: environmentFailure });
    expect(result.ok ? undefined : result.error).toBe(environmentFailure);
    expect(environmentFailure.detail.webgpuError).toMatchObject({ code: 'limit-exceeded' });
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(1);
    expect(mocks.constructRendererHost).toHaveBeenCalledTimes(1);
    expect(target.getContext).not.toHaveBeenCalled();
  });
});
