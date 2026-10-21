import { deriveTextureLayout, type TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';
import type { TextureRegion } from '../runtime-texture';

function texture(overrides: Partial<TextureAsset> = {}): TextureAsset {
  const value: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(256),
    ...overrides,
  };
  return { ...value, data: new Uint8Array(deriveTextureLayout(value).unwrap().byteLength) };
}

it('writes a narrow texture rectangle with stride evidence and fixed old content', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(texture()).unwrap();
  const observer = assets.observe().unwrap();
  const fixed = assets.snapshot(handle).unwrap();
  const bytes = runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap().data;
  const data = new Uint8Array(16).fill(17);
  assets
    .writeRange(handle, { origin: { x: 2, y: 3 }, size: { width: 2, height: 2 }, data })
    .unwrap();
  data.fill(99);
  expect(runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap().data).toBe(bytes);
  expect(bytes.slice(104, 112)).toEqual(new Uint8Array(8).fill(17));
  expect(bytes.slice(136, 144)).toEqual(new Uint8Array(8).fill(17));
  expect(bytes.slice(112, 136)).toEqual(new Uint8Array(24));
  expect(fixed.read<TextureAsset>(handle).unwrap().data).toEqual(new Uint8Array(256));
  expect(observer.read().unwrap().changes[0]?.ranges).toEqual([
    { path: ['data'], byteOffset: 104, byteLength: 40, rowBytes: 8, byteStride: 32 },
  ]);
  observer.dispose();
  fixed.dispose();
  assets.dispose();
});

it('updates only the selected packed mip and array layers in one commit', () => {
  const assets = new AssetRegistry();
  const source = texture({
    shape: { viewDimension: '2d-array', extent: { width: 8, height: 8, layers: 3 } },
    mips: { kind: 'packed', levelCount: 3 },
  });
  const layout = deriveTextureLayout(source).unwrap();
  const level = layout.levels[1];
  if (level === undefined) throw new Error('missing mip');
  const handle = assets.create(source).unwrap();
  const observer = assets.observe().unwrap();
  assets
    .writeRange(handle, {
      mipLevel: 1,
      origin: { x: 1, y: 2, z: 1 },
      size: { width: 1, height: 1, depthOrArrayLayers: 2 },
      data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    })
    .unwrap();
  const actual = assets.read(handle).unwrap().data;
  const expected = source.data.slice();
  expected.set([1, 2, 3, 4], level.byteOffset + 64 + 32 + 4);
  expected.set([5, 6, 7, 8], level.byteOffset + 128 + 32 + 4);
  expect(actual).toEqual(expected);
  expect(observer.read().unwrap().changes).toHaveLength(1);
  expect(observer.read().unwrap().changes[0]?.ranges).toHaveLength(2);
  observer.dispose();
  assets.dispose();
});

it('accepts edge compression blocks and rejects misaligned or malformed regions atomically', () => {
  const assets = new AssetRegistry();
  const source = texture({
    format: 'bc1-rgba-unorm',
    shape: { viewDimension: '2d', extent: { width: 7, height: 5 } },
  });
  const handle = assets.create(source).unwrap();
  assets
    .writeRange(handle, {
      origin: { x: 4, y: 4 },
      size: { width: 3, height: 1 },
      data: new Uint8Array(8).fill(8),
    })
    .unwrap();
  const before = assets.read(handle).unwrap();
  expect(before.data.slice(24)).toEqual(new Uint8Array(8).fill(8));
  const revision = runtimeAssets(assets).version(handle).unwrap();
  for (const region of [
    { origin: { x: 1, y: 0 }, size: { width: 4, height: 4 }, data: new Uint8Array(8) },
    { origin: { x: 0, y: 0 }, size: { width: 3, height: 4 }, data: new Uint8Array(8) },
    { origin: { x: 0, y: 0 }, size: { width: 4, height: 4 }, data: new Uint8Array(9) },
    { origin: { x: 0, y: 0 }, size: { width: 8, height: 4 }, data: new Uint8Array(16) },
    { mipLevel: 2, origin: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: new Uint8Array(8) },
    null,
  ]) {
    expect(assets.writeRange(handle, region as TextureRegion).ok).toBe(false);
    expect(assets.read(handle).unwrap()).toEqual(before);
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(revision);
  }
  assets.dispose();
});

it('bounds slice preparation and rejects invalid full texture content before publication', () => {
  const assets = new AssetRegistry({ limits: { maxRanges: 1 } });
  const source = texture({
    shape: { viewDimension: '3d', extent: { width: 4, height: 4, depth: 2 } },
  });
  const handle = assets.create(source).unwrap();
  expect(
    assets.writeRange(handle, {
      origin: { x: 0, y: 0 },
      size: { width: 1, height: 1, depthOrArrayLayers: 2 },
      data: new Uint8Array(8),
    }),
  ).toMatchObject({ ok: false, error: { code: 'asset-budget-exceeded' } });
  expect(assets.update(handle, { data: new Uint8Array(1) }).ok).toBe(false);
  expect(assets.create({ ...source, data: new Uint8Array(1) }).ok).toBe(false);
  expect(assets.read(handle).unwrap()).toEqual(source);
  assets.dispose();
});
