import { type DynamicTextureDevice, DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  VIDEO_SOURCE_PROVIDER_KEY,
  type VideoSourceProvider,
} from '@forgeax/engine-graphics-extras';
import type { Result, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderSystemRuntime } from '../../render-system';
import { videoTextureView } from '../main-pass-material';

interface Probe {
  copies: number;
}

function makeStore(probe: Probe): DynamicTextureStore {
  let textureId = 0;
  const device: DynamicTextureDevice = {
    createTexture: () => ok({ id: `video-texture-${textureId++}` } as unknown as Texture),
    createTextureView: (texture) => ok({ texture } as unknown as TextureView),
    destroyTexture: () => ok(undefined) as Result<void, RhiError>,
    queue: {
      copyExternalImageToTexture: () => {
        probe.copies += 1;
        return ok(undefined) as Result<void, RhiError>;
      },
    },
  };
  const store = new DynamicTextureStore();
  store.configureGpuDevice(device);
  return store;
}

function runtimeWithErrors(fire: (error: { readonly code: string }) => void): RenderSystemRuntime {
  return { errorRegistry: { fire } } as unknown as RenderSystemRuntime;
}

const CLIP = toShared<'VideoAsset'>(7001) as Handle<'VideoAsset', 'shared'>;
const ENTITY = 17;
const VIDEO = {
  videoWidth: 8,
  videoHeight: 8,
  readyState: 2,
} as unknown as HTMLVideoElement;

describe('videoTextureView provider-loss recovery', () => {
  it('keeps the LKG view, bounds each loss episode, and clears it after upload recovery', () => {
    const world = new World();
    const probe: Probe = { copies: 0 };
    const store = makeStore(probe);
    const errors: { readonly code: string }[] = [];
    const runtime = runtimeWithErrors((error) => errors.push(error));
    const provider: VideoSourceProvider = {
      getSource: vi.fn(() => VIDEO),
    };
    world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);

    const lkg = videoTextureView(world, store, runtime, ENTITY, CLIP, false);
    expect(lkg).toBeDefined();
    expect(probe.copies).toBe(1);

    world.removeResource(VIDEO_SOURCE_PROVIDER_KEY);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('video-upload-unsupported');
    expect(probe.copies).toBe(1);

    world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(errors).toHaveLength(1);
    expect(probe.copies).toBe(3);

    world.removeResource(VIDEO_SOURCE_PROVIDER_KEY);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(errors).toHaveLength(2);
    expect(probe.copies).toBe(3);

    world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);
    expect(videoTextureView(world, store, runtime, ENTITY, CLIP, false)).toBe(lkg);
    expect(errors).toHaveLength(2);
    expect(probe.copies).toBe(4);
  });
});
