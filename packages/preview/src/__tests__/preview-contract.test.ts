import { describe, expect, it } from 'vitest';
import { resourcePreviewArgsSchema } from '../domains/subject.js';
import {
  createCanonicalPreviewRecipe,
  RESOURCE_PREVIEW_DEFAULT_SIZE,
  RESOURCE_PREVIEW_MAX_SIZE,
  RESOURCE_PREVIEW_MIN_SIZE,
} from '../index.js';

describe('resource preview capture contract', () => {
  it('defaults to one square power-of-two size and accepts an override', () => {
    expect(resourcePreviewArgsSchema.parse({ guid: 'mesh' })).toEqual({
      ok: true,
      value: { guid: 'mesh' },
    });
    expect(resourcePreviewArgsSchema.parse({ guid: 'mesh', size: 1024 })).toEqual({
      ok: true,
      value: { guid: 'mesh', size: 1024 },
    });
    expect(RESOURCE_PREVIEW_DEFAULT_SIZE).toBe(512);
    expect(RESOURCE_PREVIEW_MIN_SIZE).toBe(64);
    expect(RESOURCE_PREVIEW_MAX_SIZE).toBe(4096);
  });

  it.each([0, 63, 100, 5000, 1.5])('rejects non power-of-two size %s', (size) => {
    expect(resourcePreviewArgsSchema.parse({ guid: 'mesh', size })).toMatchObject({ ok: false });
  });

  it('publishes the texture presentation without a lighting environment', () => {
    expect(createCanonicalPreviewRecipe('texture')).toMatchObject({
      rig: 'asset-quad',
      environment: 'black',
      skybox: 'none',
      skylight: 'none',
      directionalLight: 'none',
      stage: 'texture-unlit-black',
      camera: 'texture-orthographic',
    });
  });
});
