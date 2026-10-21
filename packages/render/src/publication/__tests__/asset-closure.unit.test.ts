import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';
import { PublishedAssetClosure } from '../asset-closure';

const texture = () =>
  ({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(4),
  }) as const;

describe('published asset closure', () => {
  it('replaces a shared dependency once, with atomic discard and retirement', () => {
    const assets = new AssetRegistry();
    const oldTexture = assets.create(texture()).unwrap();
    const nextTexture = assets.create(texture()).unwrap();
    const material = assets
      .create({
        kind: 'material',
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: { albedo: { texture: oldTexture } },
      } as const)
      .unwrap();
    const closure = new PublishedAssetClosure();
    const initial = closure.begin(assets);
    for (let i = 0; i < 4096; i++) initial.acquire(material);
    expect(
      initial
        .rows()
        .map(([handle]) => handle)
        .sort(),
    ).toEqual([material, oldTexture].sort());
    initial.commit();
    expect(closure.size).toBe(2);
    assets.update(material, { values: { albedo: { texture: nextTexture } } }).unwrap();
    const discarded = closure.begin(assets);
    discarded.update(material);
    expect(discarded.retired()).toEqual([oldTexture]);
    expect(closure.size).toBe(2);
    const change = closure.begin(assets);
    change.update(material);
    expect(
      change
        .rows()
        .map(([handle]) => handle)
        .sort(),
    ).toEqual([material, nextTexture].sort());
    expect(change.retired()).toEqual([oldTexture]);
    change.commit();
    const partial = closure.begin(assets);
    partial.release(material);
    expect(partial.retired()).toEqual([]);
    partial.commit();
    const remove = closure.begin(assets);
    for (let i = 1; i < 4096; i++) remove.release(material);
    expect([...remove.retired()].sort()).toEqual([material, nextTexture].sort());
    remove.commit();
    expect(closure.size).toBe(0);
  });
});
