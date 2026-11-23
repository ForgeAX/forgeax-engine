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

it('reuses all pass leases until an output boundary and then sweeps unused sources', () => {
  const assets = new AssetRegistry();
  const cache = new SharedAssets<DataTexture, TextureAsset>(assets);
  const a = new DataTexture(new Uint8Array(4), 1, 1);
  const b = new DataTexture(new Uint8Array(4), 1, 1);
  try {
    cache.begin();
    const first = cache.write(a, [0], projectTexture(a).unwrap());
    cache.commit(false);
    cache.begin();
    const second = cache.write(b, [0], projectTexture(b).unwrap());
    cache.commit();
    for (let frame = 0; frame < 10; frame++) {
      cache.begin();
      expect(cache.read(a, [0])?.handle).toBe(first.handle);
      cache.commit(false);
      cache.begin();
      cache.abort(true); // An async texture import interrupts the next pass before commit.
      cache.begin();
      expect(cache.read(b, [0])?.handle).toBe(second.handle);
      cache.commit();
    }
    cache.begin();
    cache.read(b, [0]);
    cache.commit();
    expect(runtimeAssets(assets).borrow(first.handle).ok).toBe(false);
    expect(runtimeAssets(assets).borrow(second.handle).ok).toBe(true);
    b.dispose();
    cache.begin();
    cache.commit(false);
    expect(runtimeAssets(assets).borrow(second.handle).ok).toBe(false);
  } finally {
    cache.dispose();
    assets.dispose();
  }
});

it('keeps a revised shared asset until both mounted consumers release their pins', () => {
  const assets = new AssetRegistry();
  const cache = new SharedAssets<DataTexture, TextureAsset>(assets);
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  try {
    cache.begin();
    cache.write(texture, [0], projectTexture(texture).unwrap());
    cache.commit();
    const first = cache.pin(texture, '');
    const second = cache.pin(texture, '');
    if (!first || !second) throw new Error('Missing shared asset pins');
    texture.dispose();
    cache.begin();
    const revised = cache.write(texture, [1], projectTexture(texture).unwrap());
    cache.commit();
    first();
    cache.begin();
    cache.commit();
    expect(runtimeAssets(assets).borrow(revised.handle).ok).toBe(true);
    second();
    cache.begin();
    cache.commit();
    expect(runtimeAssets(assets).borrow(revised.handle).ok).toBe(false);
  } finally {
    cache.dispose();
    assets.dispose();
  }
});

it('isolates a fresh lease from late unmounts after the original address was retired', () => {
  const assets = new AssetRegistry();
  const cache = new SharedAssets<DataTexture, TextureAsset>(assets);
  const texture = new DataTexture(new Uint8Array(4), 1, 1);
  try {
    cache.begin();
    cache.write(texture, [0], projectTexture(texture).unwrap());
    cache.commit();
    const old = cache.pin(texture, '');
    texture.dispose();
    cache.begin();
    cache.commit();
    cache.begin();
    const fresh = cache.write(texture, [1], projectTexture(texture).unwrap());
    cache.commit();
    const current = cache.pin(texture, '');
    if (!old || !current) throw new Error('Missing asset pins');
    old();
    cache.begin();
    cache.commit();
    expect(runtimeAssets(assets).borrow(fresh.handle).ok).toBe(true);
    current();
    cache.begin();
    cache.commit();
    expect(runtimeAssets(assets).borrow(fresh.handle).ok).toBe(false);
  } finally {
    cache.dispose();
    assets.dispose();
  }
});
