import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { PublishedAssetClosure } from '../asset-closure';
import { publicationDependencies, renderableAssetRoots } from '../dependencies';

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
  it('keeps inline owners assetless while retaining their material dependency closure', () => {
    const assets = new AssetRegistry();
    const textureHandle = assets.create(texture()).unwrap();
    const materialHandle = assets
      .create({
        kind: 'material',
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: { albedo: { texture: textureHandle } },
      } as const)
      .unwrap();
    const material = MaterialResource.from({
      ...defaultMaterialSnapshot(materialHandle),
      baseColorTexture: textureHandle,
      textureHandles: new Map([['baseColorTexture', textureHandle]]),
    });
    const owner = {
      assetHandle: undefined,
      materials: [material],
      materialOverrides: [],
    } as unknown as RenderableSnapshot;

    expect(publicationDependencies(owner)).toEqual(
      expect.arrayContaining([materialHandle, textureHandle]),
    );
    expect(publicationDependencies(owner)).not.toContain(undefined);
    const roots = renderableAssetRoots(owner);
    expect(roots).toEqual([materialHandle]);

    const closure = new PublishedAssetClosure();
    const transaction = closure.begin(assets);
    for (const handle of roots) transaction.acquire(handle);
    expect(
      transaction
        .rows()
        .map(([handle]) => handle)
        .sort(),
    ).toEqual([materialHandle, textureHandle].sort());
  });

  it('visits a changed exact source once and preserves live dependencies from other materials', () => {
    const root = 257;
    const textures = new Map<string, AssetHandle<'texture'>>();
    let reads = 0;
    const assets = Array.from({ length: root }, (_, index) => {
      const value = index + 1;
      if (value !== root) textures.set(String(value), value as AssetHandle<'texture'>);
      return {
        get handle() {
          reads++;
          return value;
        },
        revision: value,
      };
    });
    const source = {
      snapshot: {
        ...defaultMaterialSnapshot(root),
        textureHandles: textures,
        sourceAssets: { root, revision: root, assets },
      },
    };
    const row = {
      assetHandle: 1,
      materials: [source],
      materialOverrides: [undefined, { snapshot: defaultMaterialSnapshot(3) }],
    } as unknown as RenderableSnapshot;
    expect(
      publicationDependencies(row, (handle, revision) => handle === revision && handle !== 2),
    ).toEqual([1, 2, 3]);
    expect(reads).toBeLessThanOrEqual(root * 4);
    reads = 0;
    expect(publicationDependencies(row).length).toBe(root);
    expect(reads).toBe(0);
  });

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
