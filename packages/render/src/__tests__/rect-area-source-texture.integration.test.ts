import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RectAreaLight } from '../components/rect-area-light';
import { SpotLight } from '../components/spot-light';
import { DIRECT_LIGHT_SLOT_METADATA_SENTINEL, packDirectLightSlot } from '../light-buffer-layout';
import { COOKIE_SLICE_MIP_CHAIN_BYTES } from '../prepare/extended-lighting/resources';
import { extractFrames } from '../render-system-extract-tail';

function texture(
  format: 'rgba8unorm-srgb' | 'bc7-rgba-unorm-srgb' = 'rgba8unorm-srgb',
): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data: new Uint8Array(16).fill(200),
  };
}

function metadataCookie(light: Parameters<typeof packDirectLightSlot>[0] | undefined): number {
  if (light === undefined) throw new Error('missing extracted rect light');
  return new Uint32Array(packDirectLightSlot(light).buffer)[19] ?? -1;
}

afterEach(() => vi.restoreAllMocks());

describe('RectAreaLight source texture extraction', () => {
  it('shares one light-texture slice with a Spot Cookie of the same asset', () => {
    const world = new World();
    const shared = world.allocSharedRef('TextureAsset', texture());
    const own = world.allocSharedRef('TextureAsset', texture());
    world
      .spawn(
        { component: Transform, data: { pos: [0, 3, 0] } },
        { component: SpotLight, data: { direction: [0, -1, 0], cookie: shared } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [1, 1, 0] } },
        { component: RectAreaLight, data: { width: 2, height: 1, sourceTexture: shared } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [-1, 1, 0] } },
        { component: RectAreaLight, data: { width: 1, height: 1, sourceTexture: own } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 2] } },
        { component: RectAreaLight, data: { width: 1, height: 1 } },
      )
      .unwrap();
    world.update(0);

    const { lights } = extractFrames([world], 0);
    const spot = lights.spot[0];
    expect(spot?.cookieSlice).toBe(0);
    expect(lights.rect).toHaveLength(3);
    const [sharedRect, ownRect, plainRect] = lights.rect;
    expect(sharedRect?.cookieSlice).toBe(spot?.cookieSlice);
    expect(sharedRect?.cookieSource).toBe(spot?.cookieSource);
    expect(sharedRect?.cookieSource?.kind).toBe('mip-chain');
    if (sharedRect?.cookieSource?.kind === 'mip-chain') {
      expect(sharedRect.cookieSource.data.byteLength).toBe(COOKIE_SLICE_MIP_CHAIN_BYTES);
    }
    expect(ownRect?.cookieSlice).toBe(1);
    expect(plainRect?.cookieSlice).toBeUndefined();
    expect(plainRect?.sourceTextureHandle).toBeUndefined();

    expect(metadataCookie(sharedRect)).toBe(0);
    expect(metadataCookie(ownRect)).toBe(1);
    expect(metadataCookie(plainRect)).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
  });

  it('routes a block-compressed source to the GPU resample on its own slice', () => {
    const world = new World();
    const asset = texture('bc7-rgba-unorm-srgb');
    const compressed = world.allocSharedRef('TextureAsset', asset);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: RectAreaLight, data: { width: 1, height: 1, sourceTexture: compressed } },
      )
      .unwrap();
    world.update(0);

    const rect = extractFrames([world], 0).lights.rect[0];
    expect(rect?.cookieSlice).toBe(0);
    expect(rect?.cookieSource).toEqual({ kind: 'gpu-resample', asset });
    expect(metadataCookie(rect)).toBe(0);
  });

  it('routes a structured error and renders untextured for an unusable source', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = new World();
    const bad = world.allocSharedRef('TextureAsset', {
      ...texture('bc7-rgba-unorm-srgb'),
      colorSpace: 'linear',
    });
    world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: RectAreaLight, data: { width: 1, height: 1, sourceTexture: bad } },
      )
      .unwrap();
    world.update(0);

    const rect = extractFrames([world], 0).lights.rect[0];
    expect(rect?.cookieSlice).toBeUndefined();
    expect(metadataCookie(rect)).toBe(DIRECT_LIGHT_SLOT_METADATA_SENTINEL);
    expect(errors).toHaveBeenCalledWith(
      '[RenderSystem.extract (rect-source-texture)]',
      expect.objectContaining({ code: 'asset-not-registered' }),
    );
  });
});
