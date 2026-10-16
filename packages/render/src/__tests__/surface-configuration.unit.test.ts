import type { RhiCanvasContext, RhiDevice } from '@forgeax/engine-rhi';
import { ok, RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { createRenderSurfaceError, type RenderSurfaceFailureDetail } from '../errors/render';
import {
  configureSurface,
  resolveSurfaceFormatPair,
  resolveSurfaceProfile,
  selectSwapChainFormat,
} from '../render-system';

function device(backendKind: 'webgpu' | 'wgpu-webgl2', storageBuffer = false): RhiDevice {
  return {
    limits: { maxStorageBuffersPerShaderStage: 0 },
    caps: { backendKind, storageBuffer },
  } as unknown as RhiDevice;
}

const webGlPresentationProof = {
  descriptor: true,
  acquisition: true,
  validation: true,
  surfaceIdentity: 'wgpu-surface:1',
  requested: {
    format: 'Rgba8Unorm',
    usage: 0x10,
    width: 800,
    height: 600,
    alphaMode: 'Auto',
    presentMode: 'Fifo',
  },
  validated: {
    format: 'Rgba8Unorm',
    usage: 0x10,
    width: 800,
    height: 600,
    alphaMode: 'Auto',
    presentMode: 'Fifo',
  },
} as const;

describe('configureSurface', () => {
  it('exposes every surface failure with the four-field structured contract', () => {
    const detail: RenderSurfaceFailureDetail = {
      lane: 'direct',
      stage: 'output-transform',
      target: 'standard-output-color',
      format: 'rgba16float',
      domain: 'display-encoded',
      endpoint: 'surface.storage',
      capability: 'float-render-attachment',
    };
    for (const kind of [
      'allocation',
      'attachment',
      'sampled-read',
      'view-domain',
      'raw-endpoint',
    ] as const) {
      const error = createRenderSurfaceError(kind, detail);
      expect(error.code).toBe(`surface-${kind}-failed`);
      expect(error.expected).toBeTruthy();
      expect(error.hint).toBeTruthy();
      expect(error.detail).toEqual(detail);
    }
  });

  it('projects the configured surface format into graph topology without reinterpretation drift', () => {
    expect(resolveSurfaceFormatPair('webgpu', 'bgra8unorm', 'bgra8unorm-srgb')).toEqual({
      storage: 'bgra8unorm',
      view: 'bgra8unorm-srgb',
    });
    expect(resolveSurfaceFormatPair('wgpu-webgl2', 'rgba8unorm', 'rgba8unorm-srgb')).toEqual({
      storage: 'rgba8unorm',
      view: 'rgba8unorm-srgb',
    });
  });

  it('keeps native WebGPU sRGB view support when texture binding is available', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      presentationProof: { descriptor: true, acquisition: true, validation: true },
    } as unknown as RhiCanvasContext;
    const webGpuDevice = device('webgpu', true);
    const result = configureSurface(context, webGpuDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGpuDevice,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
      usage: 0x10 | 0x04 | 0x01,
      viewFormats: ['bgra8unorm-srgb'],
    });
  });

  it('selects an explicitly advertised opaque native surface without changing browser defaults', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure, supportedAlphaModes: ['opaque'] } as unknown as RhiCanvasContext;
    expect(
      configureSurface(context, device('webgpu', true), 'bgra8unorm', 'bgra8unorm-srgb').ok,
    ).toBe(true);
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ alphaMode: 'opaque' }));
  });

  it('rejects an explicit empty surface alpha capability before configuration', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure, supportedAlphaModes: [] } as unknown as RhiCanvasContext;
    const result = configureSurface(
      context,
      device('webgpu', true),
      'bgra8unorm',
      'bgra8unorm-srgb',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('webgpu-runtime-error');
    expect(configure).not.toHaveBeenCalled();
  });

  it('keeps COPY_SRC on a low-capability WebGPU surface', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      presentationProof: { descriptor: true, acquisition: true, validation: true },
    } as unknown as RhiCanvasContext;
    const webGpuDevice = device('webgpu');
    const result = configureSurface(context, webGpuDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGpuDevice,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
      usage: 0x10 | 0x01,
      viewFormats: ['bgra8unorm-srgb'],
    });
  });

  it('requests only guaranteed render attachment usage for WebGL2', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      presentationProof: webGlPresentationProof,
    } as unknown as RhiCanvasContext;
    const webGlDevice = device('wgpu-webgl2');
    const result = configureSurface(context, webGlDevice, 'rgba8unorm', 'rgba8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGlDevice,
      format: 'rgba8unorm',
      alphaMode: 'opaque',
      usage: 0x10,
      viewFormats: [],
    });
    const descriptor = (configure.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(descriptor.viewFormats).toEqual([]);
  });

  it('configures a proof-less WebGL2 candidate before failing raw endpoint validation', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const result = configureSurface(
      context,
      device('wgpu-webgl2'),
      'rgba8unorm',
      'rgba8unorm-srgb',
    );

    expect(configure).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('webgpu-runtime-error');
      expect(result.error.expected).toContain('proof');
    }
  });

  it.each([
    ['descriptor', { descriptor: false, acquisition: true, validation: true }],
    ['acquisition', { descriptor: true, acquisition: false, validation: true }],
    ['validation', { descriptor: true, acquisition: true, validation: false }],
  ] as const)('rejects a WebGL2 candidate with incomplete %s proof', (_missing, proof) => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure, presentationProof: proof } as unknown as RhiCanvasContext;
    const result = configureSurface(
      context,
      device('wgpu-webgl2'),
      'rgba8unorm',
      'rgba8unorm-srgb',
    );

    expect(configure).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({ error: { code: 'surface-raw-endpoint-failed' } });
  });

  it('keeps configure failures explicit without attempting to treat the surface as ready', () => {
    const configure = vi.fn(() => ({
      ok: false as const,
      error: new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'candidate configure succeeds',
        hint: 'inspect the concrete configure failure',
      }),
    }));
    const context = { configure } as unknown as RhiCanvasContext;
    const result = configureSurface(
      context,
      device('wgpu-webgl2'),
      'rgba8unorm',
      'rgba8unorm-srgb',
    );

    expect(configure).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
  });

  it('uses the capability gate when WebGL2 reports a translated storage limit', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      presentationProof: webGlPresentationProof,
    } as unknown as RhiCanvasContext;
    const webGlDevice = {
      limits: { maxStorageBuffersPerShaderStage: 8 },
      caps: { backendKind: 'wgpu-webgl2', storageBuffer: false },
    } as unknown as RhiDevice;

    const result = configureSurface(context, webGlDevice, 'rgba8unorm', 'rgba8unorm-srgb');

    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGlDevice,
      format: 'rgba8unorm',
      alphaMode: 'opaque',
      usage: 0x10,
      viewFormats: [],
    });
    const descriptor = (configure.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(descriptor.viewFormats).toEqual([]);
  });

  it('selects dual-view only when the concrete surface flag is present', () => {
    const result = resolveSurfaceProfile('rgba8unorm', 'rgba8unorm-srgb', {
      surfaceViewFormats: true,
      rawAttachment: true,
      floatRenderAttachment: true,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'dual-view',
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm-srgb',
        viewFormats: ['rgba8unorm-srgb'],
        hasDisplayEndpoint: true,
      },
    });
  });

  it('selects raw-only without an alternate view when the flag is absent', () => {
    const result = resolveSurfaceProfile('rgba8unorm', 'rgba8unorm-srgb', {
      surfaceViewFormats: false,
      rawAttachment: true,
      floatRenderAttachment: true,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'raw-only',
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        viewFormats: [],
        hasDisplayEndpoint: false,
      },
    });
  });

  it('fails closed when raw-only has no float attachment capability', () => {
    const result = resolveSurfaceProfile('rgba8unorm', 'rgba8unorm-srgb', {
      surfaceViewFormats: false,
      rawAttachment: true,
      floatRenderAttachment: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('webgpu-runtime-error');
      expect(result.error.detail).toMatchObject({
        error: { code: 'surface-raw-endpoint-failed' },
      });
    }
  });

  it('keeps the raw storage format when the preferred format API is present but views are unsupported', () => {
    vi.stubGlobal('navigator', {
      gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' },
    });
    expect(selectSwapChainFormat(true, false)).toEqual({
      storage: 'bgra8unorm',
      view: 'bgra8unorm',
    });
    vi.unstubAllGlobals();
  });

  it('keeps the raw storage format when the preferred format API is absent and views are unsupported', () => {
    vi.stubGlobal('navigator', {});
    expect(selectSwapChainFormat(true, false)).toEqual({
      storage: 'rgba8unorm',
      view: 'rgba8unorm',
      fallbackReason: 'preferred-canvas-format-missing',
    });
    vi.unstubAllGlobals();
  });
});
