// feat-20260623-world-space-video-asset M2 / w3 — AC-02: VideoAsset
// consumption-path type inference in a real unit test (not just test-d).
//
// AC-02 (requirements.md:76-78): `const v = await registry.loadByGuid<VideoAsset>(guid)`
// must return a VideoAsset where `v.url` is inferable as `string` without
// an `as` cast. `switch (asset.kind)` must narrow to VideoAsset on
// `case 'video'` with TypeScript exhaustiveness.
//
// Pattern: host-custom-kind-contract.test.ts:38-75 (loadByGuid<P> + no as cast).
// This is the TDD test for M2 — it verifies the consumption path works
// with catalogued payloads (dev path). The prod (pack-index) path is
// enabled by videoLoader in w4.
//
// Structural variant (b) from video-asset-union.test-d.ts moved into a real
// unit so the consumption path is exercised with a concrete AssetRegistry,
// not just a *.test-d.ts compile-only check.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Asset, VideoAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

describe('AC-02 — VideoAsset consumption path type inference (real unit)', () => {
  it('loadByGuid<VideoAsset> returns payload with .url inferable as string, no as cast', async () => {
    const reg = makeRegistry();

    const guid = parseGuid('c0000000-0000-4000-a000-00000000a001');
    const video: VideoAsset = { kind: 'video', url: 'test-clip.webm' };

    reg.catalog(guid, video);

    // loadByGuid<VideoAsset> returns Result<VideoAsset, ...>.
    // v.url is inferable as string without any `as VideoAsset` cast.
    const loadResult = await reg.loadByGuid<VideoAsset>(guid);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) throw new Error('unreachable');
    const v = loadResult.value;
    // Type inference: v.url is string; no `as` cast needed.
    expect(v.url).toBe('test-clip.webm');
    expect(v.kind).toBe('video');
  });

  it('switch(asset.kind) narrows to VideoAsset on case "video"', () => {
    // The Asset union (15 members) includes VideoAsset per M1/w2.
    // TS strict + exhaustive switch ensures this compiles only if
    // 'video' is a recognised discriminant that narrows to VideoAsset.
    const asset: Asset = { kind: 'video', url: 'switch-test.webm' };
    switch (asset.kind) {
      case 'video':
        // Narrowed to VideoAsset — .url is string, no `as`.
        expect(asset.url).toBe('switch-test.webm');
        break;
      default:
        // TS exhaustiveness: the 14 other Asset.kind discriminants
        // are covered by this branch; the switch would fail to compile
        // if 'video' were absent from the union.
        break;
    }
  });

  it('registry.lookup<VideoAsset> returns catalogued payload with .url accessible', () => {
    const reg = makeRegistry();

    const guid = parseGuid('c0000000-0000-4000-a000-00000000a002');
    const video: VideoAsset = { kind: 'video', url: 'lookup-test.webm' };

    reg.catalog(guid, video);
    const v = reg.lookup<VideoAsset>(guid);
    expect(v).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(v!.url).toBe('lookup-test.webm');
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(v!.kind).toBe('video');
  });
});
