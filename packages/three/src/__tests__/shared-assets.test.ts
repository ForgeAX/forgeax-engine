import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { err, ok, type TextureAsset } from '@forgeax/engine-types';
import { DataTexture } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { SharedAssets } from '../shared-assets';
import { projectTexture } from '../texture';

it('retains shared variants across aborts and retires only no-longer-observed leases', () => {
  const assets = new AssetRegistry();
  const cache = new SharedAssets<DataTexture, TextureAsset>(assets);
  const a = new DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1);
  const b = new DataTexture(new Uint8Array([4, 5, 6, 255]), 1, 1);
  try {
    cache.begin();
    const first = cache.write(a, [0], projectTexture(a).unwrap());
    const second = cache.write(b, [0], projectTexture(b).unwrap());
    cache.commit();
    cache.begin();
    expect(cache.read(a, [0])?.handle).toBe(first.handle);
    cache.abort();
    cache.begin();
    expect(cache.read(b, [0])?.handle).toBe(second.handle);
    cache.commit();
    expect(runtimeAssets(assets).borrow(first.handle).ok).toBe(false);
    expect(runtimeAssets(assets).borrow(second.handle).ok).toBe(true);
    cache.begin();
    b.dispose();
    expect(cache.read(b, [0])).toBeUndefined();
    const replacement = cache.write(b, [1], projectTexture(b).unwrap());
    cache.commit();
    expect(replacement.handle).not.toBe(second.handle);
    expect(runtimeAssets(assets).borrow(second.handle).ok).toBe(false);
  } finally {
    cache.dispose();
    assets.dispose();
  }
});

it('does not accept an aborted resource replacement', () => {
  const assets = new AssetRegistry();
  const cache = new SharedAssets<DataTexture, TextureAsset>(assets);
  const texture = new DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1);
  try {
    cache.begin();
    const first = cache.write(texture, [0], projectTexture(texture).unwrap());
    cache.commit();
    cache.begin();
    const failed = runtimeAssets(assets).adoptClosure(() => {
      cache.write(texture, [1], projectTexture(texture).unwrap());
      return err(new Error('preparation failed'));
    });
    // The owning adoption returns structured failure instead of leaking provisional content.
    expect(failed.ok).toBe(false);
    cache.abort();
    cache.begin();
    expect(cache.read(texture, [0])?.handle).toBe(first.handle);
    expect(cache.read(texture, [1])).toBeUndefined();
    cache.commit();
  } finally {
    cache.dispose();
    assets.dispose();
  }
});

it('keeps accepted comparison values independent of invocation scratch', () => {
  const assets = new AssetRegistry();
  const cache = new SharedAssets<DataTexture, TextureAsset>(assets);
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  const scratch = [0];
  try {
    runtimeAssets(assets)
      .adoptClosure(() => {
        cache.begin();
        cache.write(texture, scratch, projectTexture(texture).unwrap());
        cache.commit();
        return ok(undefined);
      })
      .unwrap();
    scratch[0] = 1;
    cache.begin();
    expect(cache.read(texture, scratch)).toBeUndefined();
    expect(cache.read(texture, [0])).toBeDefined();
    cache.commit();
  } finally {
    cache.dispose();
    assets.dispose();
  }
});
