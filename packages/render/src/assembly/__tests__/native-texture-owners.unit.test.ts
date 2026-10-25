import { afterEach, expect, it, vi } from 'vitest';
import { CanvasTexture, canvasTextureState } from '../../textures/canvas-texture';
import { createExternalTextureHost } from '../external-texture-host';
import { createRenderTargetHost } from '../render-target-host';

afterEach(() => vi.unstubAllGlobals());

it('constructs native texture owners without Web Crypto and preserves copyable source identity', () => {
  vi.stubGlobal('crypto', undefined);
  const targets = createRenderTargetHost();
  const external = createExternalTextureHost({
    getDevice: () => {
      throw new Error('construction must not acquire a device');
    },
    getGeneration: () => 0,
    isDeviceLost: () => false,
    getDynamicTextureStore: () => {
      throw new Error('construction must not acquire a store');
    },
    onError: (error) => {
      throw error;
    },
  });
  const canvas = {} as OffscreenCanvas;
  const first = new CanvasTexture(canvas);
  const second = new CanvasTexture(canvas);
  try {
    expect(first.source.owner).not.toBe(second.source.owner);
    expect(canvasTextureState(structuredClone(first.source))).toBe(
      canvasTextureState(first.source),
    );
    first.dispose();
    expect(canvasTextureState(first.source)).toBeUndefined();
    expect(canvasTextureState(second.source)).toBeDefined();
  } finally {
    first.dispose();
    second.dispose();
    external.dispose();
    targets.dispose();
  }
});
