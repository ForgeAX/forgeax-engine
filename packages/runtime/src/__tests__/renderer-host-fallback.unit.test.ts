import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { EngineEnvironmentError } from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import { requestAdapterFrom } from '@forgeax/engine-rhi-webgpu';
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
      .mockResolvedValueOnce({ ok: true, kind: 'webgpu', value: firstPack })
      .mockResolvedValueOnce({ ok: true, kind: 'wgpu-webgl2', value: fallbackPack });
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
    const assets = new AssetRegistry();
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, kind: 'webgpu', value: firstPack })
      .mockResolvedValueOnce({ ok: true, kind: 'wgpu-webgl2', value: fallbackPack });
    mocks.constructRendererHost
      .mockResolvedValueOnce({ ok: false, error: environmentFailure })
      .mockImplementationOnce(async (hostCanvas: typeof target, _options, _bundler, pack) => {
        if (pack === fallbackPack) hostCanvas.getContext('webgl2');
        return { ok: true, value: { assets } };
      });

    const result = await constructRuntimeRendererHost(target);

    expect(result.ok).toBe(true);
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(2);
    expect(mocks.loadBackendPack).toHaveBeenNthCalledWith(2, undefined, 'wgpu-webgl2');
    expect(mocks.constructRendererHost).toHaveBeenNthCalledWith(
      2,
      target,
      undefined,
      undefined,
      fallbackPack,
    );
    expect(target.getContext).toHaveBeenCalledOnce();
    assets.dispose();
  });

  it('never falls back for an explicitly injected RHI and retains structured detail', async () => {
    const firstPack = { name: 'explicit' };
    const target = canvas();
    const environmentFailure = environmentError('limit-exceeded');
    const explicitRhi = {};
    mocks.loadBackendPack.mockResolvedValueOnce({ ok: true, kind: 'injected', value: firstPack });
    mocks.constructRendererHost.mockResolvedValueOnce({ ok: false, error: environmentFailure });

    const result = await constructRuntimeRendererHost(target, { rhi: explicitRhi as never });

    expect(result).toEqual({ ok: false, error: environmentFailure });
    expect(result.ok ? undefined : result.error).toBe(environmentFailure);
    expect(environmentFailure.detail.webgpuError).toMatchObject({ code: 'limit-exceeded' });
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(1);
    expect(mocks.constructRendererHost).toHaveBeenCalledTimes(1);
    expect(target.getContext).not.toHaveBeenCalled();
  });

  it('falls back for the real RHI requestAdapter rejection shape', async () => {
    const requested = await requestAdapterFrom({
      requestAdapter: async () => {
        throw new Error('adapter acquisition rejected');
      },
    });
    if (requested.ok) throw new Error('Expected rejected adapter');
    const failure = new EngineEnvironmentError('no usable rendering backend', {
      webgpuError: requested.error,
    });
    const assets = new AssetRegistry();
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, kind: 'webgpu', value: {} })
      .mockResolvedValueOnce({ ok: true, kind: 'wgpu-webgl2', value: {} });
    mocks.constructRendererHost
      .mockResolvedValueOnce({ ok: false, error: failure })
      .mockResolvedValueOnce({ ok: true, value: { assets } });
    try {
      const result = await constructRuntimeRendererHost(canvas());
      expect(result.ok).toBe(true);
      expect(mocks.constructRendererHost).toHaveBeenCalledTimes(2);
    } finally {
      assets.dispose();
    }
  });

  it('retains both channel causes when fallback initialization fails', async () => {
    const primary = environmentError('adapter-unavailable');
    const fallback = new RhiError({
      code: 'rhi-not-available',
      expected: 'wgpu WASM',
      hint: 'WASM HTTP 404',
    });
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, kind: 'webgpu', value: {} })
      .mockResolvedValueOnce({ ok: false, kind: 'wgpu-webgl2', error: fallback });
    mocks.constructRendererHost.mockResolvedValueOnce({ ok: false, error: primary });
    const result = await constructRuntimeRendererHost(canvas());
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof EngineEnvironmentError))
      throw new Error('Expected environment failure');
    expect(result.error.detail.webgpuError).toBe(primary.detail.webgpuError);
    expect(result.error.detail.wgpuError).toBe(fallback);
    expect(result.error.message).toContain('WASM HTTP 404');
  });

  it('does not retry an already selected wgpu backend', async () => {
    const failure = environmentError('adapter-unavailable');
    mocks.loadBackendPack.mockResolvedValue({ ok: true, kind: 'wgpu-webgl2', value: {} });
    mocks.constructRendererHost.mockResolvedValue({ ok: false, error: failure });
    const result = await constructRuntimeRendererHost(canvas());
    expect(result.ok).toBe(false);
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(1);
    expect(mocks.constructRendererHost).toHaveBeenCalledTimes(1);
  });

  it('retains native and GL construction causes under their actual channels', async () => {
    const primary = environmentError('adapter-unavailable');
    const fallback = environmentError('limit-exceeded');
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, kind: 'webgpu', value: {} })
      .mockResolvedValueOnce({ ok: true, kind: 'wgpu-webgl2', value: {} });
    mocks.constructRendererHost
      .mockResolvedValueOnce({ ok: false, error: primary })
      .mockResolvedValueOnce({ ok: false, error: fallback });
    const result = await constructRuntimeRendererHost(canvas());
    if (result.ok || !(result.error instanceof EngineEnvironmentError))
      throw new Error('Expected environment failure');
    expect(result.error.detail.webgpuError).toBe(primary.detail.webgpuError);
    expect(result.error.detail.wgpuError).toBe(fallback.detail.webgpuError);
  });

  it('does not treat unrelated WebGPU runtime errors as adapter rejection', async () => {
    const failure = new EngineEnvironmentError('native runtime failed', {
      webgpuError: new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'a valid native operation',
        hint: 'repair the operation owner',
        detail: { error: { code: 'pipeline-validation-failed' } },
      }),
    });
    mocks.loadBackendPack.mockResolvedValue({ ok: true, kind: 'webgpu', value: {} });
    mocks.constructRendererHost.mockResolvedValue({ ok: false, error: failure });
    const result = await constructRuntimeRendererHost(canvas());
    expect(result).toEqual({ ok: false, error: failure });
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(1);
  });

  it('reports initial WebGL2 load failure once under its own channel', async () => {
    const failure = new RhiError({
      code: 'rhi-not-available',
      expected: 'wgpu WASM',
      hint: 'WASM HTTP 404',
    });
    mocks.loadBackendPack.mockResolvedValue({ ok: false, kind: 'wgpu-webgl2', error: failure });
    const result = await constructRuntimeRendererHost(canvas());
    if (result.ok || !(result.error instanceof EngineEnvironmentError))
      throw new Error('Expected environment failure');
    expect(result.error.detail).toEqual({ wgpuError: failure });
    expect(mocks.loadBackendPack).toHaveBeenCalledTimes(1);
    expect(mocks.constructRendererHost).not.toHaveBeenCalled();
  });

  it('preserves an ordinary fallback construction failure at its owner', async () => {
    const failure = new Error('fallback shader manifest is invalid');
    mocks.loadBackendPack
      .mockResolvedValueOnce({ ok: true, kind: 'webgpu', value: {} })
      .mockResolvedValueOnce({ ok: true, kind: 'wgpu-webgl2', value: {} });
    mocks.constructRendererHost
      .mockResolvedValueOnce({ ok: false, error: environmentError('adapter-unavailable') })
      .mockResolvedValueOnce({ ok: false, error: failure });
    const result = await constructRuntimeRendererHost(canvas());
    expect(result).toEqual({ ok: false, error: failure });
    expect(mocks.constructRendererHost).toHaveBeenCalledTimes(2);
  });
});
