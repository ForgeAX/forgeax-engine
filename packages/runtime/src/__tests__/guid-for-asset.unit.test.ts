// M1 test — guidForAsset SSOT (AC-13).
//
// Verifies the new AssetRegistry.guidForAsset @internal method:
//   (a) catalogued asset returns correct GUID string
//   (b) uncatalogued asset returns undefined
//   (c) multiple distinct assets each return their correct GUID
//
// TDD phase "red": guidForAsset does not exist yet.

import { type Asset, AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

// Minimal payloads keyed by GUID to build the catalog.
// Use kinds that bypass catalog() validation (skeleton / scene / equirect
// have no mandatory fields like mesh vertices).
function makePayload(kind: Asset['kind']): Asset {
  return { kind } as Asset;
}

describe('guidForAsset — AC-13 SSOT', () => {
  it('returns the correct GUID string for a single catalogued asset', () => {
    const reg = makeRegistry();
    const asset = makePayload('skeleton');
    const guid = AssetGuid.parse('a0000000-a000-0000-0000-000000000001');
    if (!guid.ok) throw new Error('guid parse failed');
    reg.catalog(guid.value, asset);

    const result = reg._guidForAsset(asset);
    expect(result).toBe(AssetGuid.format(guid.value));
  });

  it('returns undefined for an uncatalogued asset', () => {
    const reg = makeRegistry();
    const asset = makePayload('equirect');

    const result = reg._guidForAsset(asset);
    expect(result).toBeUndefined();
  });

  it('returns the correct GUID for each of multiple distinct assets', () => {
    const reg = makeRegistry();
    const assetA = makePayload('skeleton');
    const assetB = makePayload('scene');
    const assetC = makePayload('equirect');

    const guidA = AssetGuid.parse('a0000000-a000-0000-0000-000000000001');
    const guidB = AssetGuid.parse('b0000000-b000-0000-0000-000000000002');
    const guidC = AssetGuid.parse('c0000000-c000-0000-0000-000000000003');
    if (!guidA.ok || !guidB.ok || !guidC.ok) throw new Error('guid parse failed');

    reg.catalog(guidA.value, assetA);
    reg.catalog(guidB.value, assetB);
    reg.catalog(guidC.value, assetC);

    expect(reg._guidForAsset(assetA)).toBe(AssetGuid.format(guidA.value));
    expect(reg._guidForAsset(assetB)).toBe(AssetGuid.format(guidB.value));
    expect(reg._guidForAsset(assetC)).toBe(AssetGuid.format(guidC.value));
  });

  it('returns undefined when the registry is empty', () => {
    const reg = makeRegistry();
    const asset = makePayload('skeleton');
    expect(reg._guidForAsset(asset)).toBeUndefined();
  });

  it('uses payload identity (===), not structural equality', () => {
    const reg = makeRegistry();
    // Two distinct objects with the same shape — only the catalogued one matches
    const catalogued = makePayload('skeleton');
    const lookalike = makePayload('skeleton');

    const guid = AssetGuid.parse('a0000000-a000-0000-0000-000000000001');
    if (!guid.ok) throw new Error('guid parse failed');
    reg.catalog(guid.value, catalogued);

    expect(reg._guidForAsset(catalogued)).toBe(AssetGuid.format(guid.value));
    // lookalike is a different object — should not match
    expect(reg._guidForAsset(lookalike)).toBeUndefined();
  });

  it('finds the correct GUID when multiple assets of the same kind are catalogued', () => {
    const reg = makeRegistry();
    const asset1 = makePayload('skeleton');
    const asset2 = makePayload('skeleton');

    const guid1 = AssetGuid.parse('a0000000-a000-0000-0000-000000000001');
    const guid2 = AssetGuid.parse('b0000000-b000-0000-0000-000000000002');
    if (!guid1.ok || !guid2.ok) throw new Error('guid parse failed');

    reg.catalog(guid1.value, asset1);
    reg.catalog(guid2.value, asset2);

    expect(reg._guidForAsset(asset1)).toBe(AssetGuid.format(guid1.value));
    expect(reg._guidForAsset(asset2)).toBe(AssetGuid.format(guid2.value));
  });
});
