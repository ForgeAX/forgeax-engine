// feat-20260623-world-space-video-asset M2 / w5 — AC-03: dawn structural
// smoke for the VideoAsset register + loadByGuid link.
//
// AC-03 (requirements.md): register a VideoAsset { url } via catalog,
// loadByGuid<VideoAsset> returns the payload successfully, process exit
// code 0. Structural-only — dawn-node has no HTMLVideoElement, so no
// pixel verification (plan-strategy S5.2).
//
// The default loader set (wireDefaultLoaders) already includes videoLoader
// (w4), so the AssetRegistry's built-in loaders field dispatches 'video'
// kind through videoLoader without manual registration.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { VideoAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_SMOKE_A = '00000000-0000-7000-8000-00000000a010';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

describe('AC-03 — VideoAsset register + loadByGuid dawn structural smoke', () => {
  it('catalog + loadByGuid<VideoAsset> round-trips payload in dawn context', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());

    const guid = parseGuid(GUID_SMOKE_A);
    const video: VideoAsset = { kind: 'video', url: 'test-clip.webm' };

    reg.catalog(guid, video);

    const result = await reg.loadByGuid<VideoAsset>(guid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.url).toBe('test-clip.webm');
    expect(result.value.kind).toBe('video');
  });

  it('loadByGuid succeeds when videoLoader dispatches through default loader set', async () => {
    // The AssetRegistry constructor wires the default loader set via
    // createDefaultLoaderRegistry(), which includes videoLoader (w4).
    // This test verifies the dispatch path works without manual
    // registry.loaders.register(videoLoader).
    const reg = new AssetRegistry(makeMockShaderRegistry());

    // Confirm 'video' is in the registered kinds.
    expect(reg.loaders.registeredKinds()).toContain('video');
    expect(reg.loaders.get('video')).toBeDefined();

    const guid = parseGuid('00000000-0000-7000-8000-00000000a011');
    reg.catalog(guid, { kind: 'video', url: 'loader-dispatch.webm' } as VideoAsset);

    const result = await reg.loadByGuid<VideoAsset>(guid);
    expect(result.ok).toBe(true);
  });
});
