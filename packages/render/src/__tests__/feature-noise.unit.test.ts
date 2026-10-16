import type { RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createFeatureNoisePixels, createFeatureNoiseTexture } from '../features/noise-texture';

it('provides deterministic spatial and channel variation instead of a uniform fallback', () => {
  const pixels = createFeatureNoisePixels();
  expect(pixels).toEqual(createFeatureNoisePixels());
  expect(pixels).toHaveLength(64 * 64 * 4);
  for (let channel = 0; channel < 4; channel++) {
    const values = pixels.filter((_, index) => index % 4 === channel);
    expect(new Set(values).size).toBe(256);
    expect(values.reduce((sum, value) => sum + value, 0) / values.length).toBeGreaterThan(120);
    expect(values.reduce((sum, value) => sum + value, 0) / values.length).toBeLessThan(135);
  }
});

it('returns the generation-owned texture together with its view after upload', () => {
  const texture = { id: 'noise-texture' } as unknown as Texture;
  const view = { id: 'noise-view' } as unknown as TextureView;
  let writes = 0;
  const device = {
    createTexture: () => ok(texture),
    createTextureView: () => ok(view),
    destroyTexture: () => ok(undefined),
    queue: {
      writeTexture: () => {
        writes += 1;
        return ok(undefined);
      },
    },
  } as unknown as RhiDevice;

  const result = createFeatureNoiseTexture(device);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toEqual({ texture, view });
  expect(writes).toBe(1);
});
