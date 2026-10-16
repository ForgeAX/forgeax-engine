// @forgeax/engine-assets-runtime -- DynamicTextureStore coverage (fix issue #709).
// Transient per-frame video texture store: configureGpuDevice / uploadFrame
// (allocate-once + resize-realloc + copy) / getView / destroyAll, driven by a
// small in-memory device stub (no GPU).

import type { Result, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type CopyExternalImageSource,
  type DynamicTextureDevice,
  DynamicTextureStore,
} from '../dynamic-texture-store';

interface Counters {
  created: number;
  destroyed: number;
  copies: number;
}

function makeDevice(counters: Counters): DynamicTextureDevice {
  let nextTex = 0;
  return {
    createTexture: () => {
      counters.created++;
      return ok({ tag: `tex-${nextTex++}` } as unknown as Texture);
    },
    createTextureView: (tex: Texture) =>
      ok({ tag: `view-of-${(tex as unknown as { tag: string }).tag}` } as unknown as TextureView),
    destroyTexture: () => {
      counters.destroyed++;
      return ok(undefined) as Result<void, RhiError>;
    },
    queue: {
      copyExternalImageToTexture: () => {
        counters.copies++;
        return ok(undefined) as Result<void, RhiError>;
      },
    },
  };
}

const CLIP = toShared<'VideoAsset'>(2000) as Handle<'VideoAsset', 'shared'>;
const SOURCE = {} as CopyExternalImageSource;

describe('DynamicTextureStore', () => {
  it('returns undefined before a device is wired', () => {
    const store = new DynamicTextureStore();
    expect(store.uploadFrame(CLIP, SOURCE, 16, 16)).toBeUndefined();
  });

  it('returns undefined for a non-positive source size', () => {
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice({ created: 0, destroyed: 0, copies: 0 }));
    expect(store.uploadFrame(CLIP, SOURCE, 0, 16)).toBeUndefined();
    expect(store.uploadFrame(CLIP, SOURCE, 16, -1)).toBeUndefined();
  });

  it('allocates once, then re-uploads in place for a steady-size clip', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));

    const a = store.uploadFrame(CLIP, SOURCE, 32, 32);
    const b = store.uploadFrame(CLIP, SOURCE, 32, 32);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
    expect(counters.created).toBe(1); // allocate-once
    expect(counters.copies).toBe(2); // re-uploaded each frame
    if (a?.ok && b?.ok) expect(a.value).toBe(b.value); // same view reused
  });

  it('reallocates (destroys old, creates new) when the source size changes', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));
    store.uploadFrame(CLIP, SOURCE, 32, 32);
    store.uploadFrame(CLIP, SOURCE, 64, 64);
    expect(counters.created).toBe(2);
    expect(counters.destroyed).toBe(1);
  });

  it('getView returns the current view after an upload, undefined before', () => {
    const store = new DynamicTextureStore();
    expect(store.getView(CLIP)).toBeUndefined();
    store.configureGpuDevice(makeDevice({ created: 0, destroyed: 0, copies: 0 }));
    store.uploadFrame(CLIP, SOURCE, 8, 8);
    expect(store.getView(CLIP)).toBeDefined();
  });

  it('destroyAll destroys every transient texture and clears the map', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));
    store.uploadFrame(CLIP, SOURCE, 8, 8);
    store.uploadFrame(toShared<'VideoAsset'>(2001) as Handle<'VideoAsset', 'shared'>, SOURCE, 8, 8);
    store.destroyAll();
    expect(counters.destroyed).toBe(2);
    expect(store.getView(CLIP)).toBeUndefined();
  });

  it('surfaces a structured error when texture allocation fails', () => {
    const store = new DynamicTextureStore();
    store.configureGpuDevice({
      createTexture: () => ({ ok: false, error: { code: 'rhi-not-available' } }) as never,
      createTextureView: () => ok({} as unknown as TextureView),
      destroyTexture: () => ok(undefined) as Result<void, RhiError>,
      queue: { copyExternalImageToTexture: () => ok(undefined) as Result<void, RhiError> },
    });
    const res = store.uploadFrame(CLIP, SOURCE, 8, 8);
    expect(res?.ok).toBe(false);
  });
});

describe('versioned Canvas uploads', () => {
  it('uploads initially and when dirty, restores on replacement, and releases on disposal', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeDevice(counters));
    const key = {},
      lifetime = new AbortController();
    const upload = (version: number) =>
      store.uploadFrame(key, SOURCE, 8, 8, { version, signal: lifetime.signal });
    expect(upload(1)?.ok).toBe(true);
    expect(upload(1)?.ok).toBe(true);
    expect(counters.copies).toBe(1);
    expect(upload(2)?.ok).toBe(true);
    expect(counters).toEqual({ created: 1, destroyed: 0, copies: 2 });
    store.configureGpuDevice(makeDevice(counters));
    expect(upload(2)?.ok).toBe(true);
    expect(counters).toEqual({ created: 2, destroyed: 1, copies: 3 });
    lifetime.abort();
    expect(store.getView(key)).toBeUndefined();
    expect(upload(3)).toBeUndefined();
    expect(counters.destroyed).toBe(2);
    store.destroyAll();
    expect(counters.destroyed).toBe(2);
  });

  it.each([
    'allocation',
    'view',
    'copy',
  ])('keeps the old view when resized %s fails and retries the same version', (failure) => {
    const counters = { created: 0, destroyed: 0, copies: 0 };
    const device = makeDevice(counters);
    const create = device.createTexture.bind(device),
      view = device.createTextureView.bind(device),
      copy = device.queue.copyExternalImageToTexture.bind(device.queue);
    let reject = false;
    const failed = { ok: false, error: { code: 'rhi-not-available' } } as const;
    device.createTexture = (desc) =>
      reject && failure === 'allocation' ? (failed as never) : create(desc);
    device.createTextureView = (texture, desc) =>
      reject && failure === 'view' ? (failed as never) : view(texture, desc);
    device.queue.copyExternalImageToTexture = (source, target, size) =>
      reject && failure === 'copy' ? (failed as never) : copy(source, target, size);
    const store = new DynamicTextureStore(),
      key = {};
    store.configureGpuDevice(device);
    const first = store.uploadFrame(key, SOURCE, 8, 8, { version: 1 });
    if (!first?.ok) throw new Error('first upload failed');
    reject = true;
    expect(store.uploadFrame(key, SOURCE, 16, 16, { version: 2 })?.ok).toBe(false);
    expect(store.getView(key)).toBe(first.value);
    expect(counters.destroyed).toBe(failure === 'allocation' ? 0 : 1);
    reject = false;
    expect(store.uploadFrame(key, SOURCE, 16, 16, { version: 2 })?.ok).toBe(true);
    expect(store.getView(key)).not.toBe(first.value);
    store.destroyAll();
    expect(counters.created).toBe(counters.destroyed);
  });

  it('never publishes an uninitialized view after an initial copy failure', () => {
    const counters = { created: 0, destroyed: 0, copies: 0 },
      device = makeDevice(counters);
    device.queue.copyExternalImageToTexture = () =>
      ({ ok: false, error: { code: 'rhi-not-available' } }) as never;
    const store = new DynamicTextureStore(),
      key = {};
    store.configureGpuDevice(device);
    expect(store.uploadFrame(key, SOURCE, 8, 8, { version: 1 })?.ok).toBe(false);
    expect(store.getView(key)).toBeUndefined();
    expect(counters.created).toBe(counters.destroyed);
  });
});
