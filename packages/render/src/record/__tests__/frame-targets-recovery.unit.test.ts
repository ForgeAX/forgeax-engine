import type { RhiCanvasContext, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { acquireSwapChainTarget } from '../frame-targets';
import type { PipelineState, RenderSystemInternals } from '../render-context';

function device(): RhiDevice {
  return {
    caps: { backendKind: 'webgpu', storageBuffer: true },
    limits: {},
    createTextureView: vi.fn(() => ok({} as TextureView)),
  } as unknown as RhiDevice;
}

function unavailableSurfaceError(): RhiError {
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'the surface has a current texture',
    hint: 'configure the surface and retry',
  });
}

describe('acquireSwapChainTarget recovery', () => {
  it('resolves the recorder device before reconfiguring a recovered surface', () => {
    const recorderDevice = device();
    const configuredDevice = device();
    const texture = {} as Texture;
    const getCurrentTexture = vi
      .fn()
      .mockReturnValueOnce(err(unavailableSurfaceError()))
      .mockReturnValueOnce(ok(texture));
    const configure = vi.fn(() => ok(undefined));
    const context = { configure, getCurrentTexture } as unknown as RhiCanvasContext;
    const resolveSurfaceDevice = vi.fn(() => ok(configuredDevice));
    const internals = {
      context,
      device: recorderDevice,
      canvas: { width: 800, height: 600 },
      resolveSurfaceDevice,
      errorRegistry: { fire: vi.fn() },
      healthRegistry: { fire: vi.fn() },
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      device: recorderDevice,
      format: 'bgra8unorm',
      colorAttachmentFormat: 'bgra8unorm',
      perPassResources: { configured: false },
    } as unknown as PipelineState;

    const result = acquireSwapChainTarget(internals, pipelineState);

    expect(result).toMatchObject({ currentTexture: texture, targetW: 800, targetH: 600 });
    expect(resolveSurfaceDevice).toHaveBeenCalledWith(recorderDevice);
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ device: configuredDevice, format: 'bgra8unorm' }),
    );
    expect(getCurrentTexture).toHaveBeenCalledTimes(2);
    expect(pipelineState.perPassResources.configured).toBe(true);
  });
});
