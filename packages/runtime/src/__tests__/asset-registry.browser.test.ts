// w12 - AssetRegistry browser path (loadByGuid + GUID-keyed catalog API)
//
// Migration from load(url) to loadByGuid (feat-20260513-guid-asset-package-system w13).
// feat-20260614 M8 (D-17): the registry catalogues GUID -> payload and
// `loadByGuid` returns the PAYLOAD (no handle). Column minting moved to
// `world.allocSharedRef`. Covers catalog + loadByGuid ok path + payload
// idempotency + AC-11 inspect() shape for a GUID-catalogued asset.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_BROWSER_A = '00000000-0000-7000-8000-000000000021';

function makeMesh(): TypesMeshAsset {
  return {
    kind: 'mesh',
    // 1 vertex * 12F canonical layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)
    vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 1,
        vertexCount: 12,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

describe('w12 - AssetRegistry browser loadByGuid happy path', () => {
  it('loadByGuid() returns Ok(payload) for a catalogued GUID', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_BROWSER_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    const mesh = makeMesh();
    reg.catalog<TypesMeshAsset>(guid, mesh);
    const res = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe('mesh');
  });

  it('two loadByGuid(sameGuid) calls return the same payload', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const parseResult = AssetGuid.parse(GUID_BROWSER_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    reg.catalog<TypesMeshAsset>(guid, makeMesh());
    const a = await reg.loadByGuid<TypesMeshAsset>(guid);
    const b = await reg.loadByGuid<TypesMeshAsset>(guid);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).toBe(b.value);
    }
  });

  it('AC-11: inspect() reports MeshAsset brand after catalog()', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const before = reg.inspect().assets.length;
    const parseResult = AssetGuid.parse(GUID_BROWSER_A);
    if (!parseResult.ok) throw new Error('expected ok');
    const guid = parseResult.value;
    reg.catalog<TypesMeshAsset>(guid, makeMesh());
    const snap = reg.inspect();
    expect(snap.assets.length).toBe(before + 1);
    const last = snap.assets[snap.assets.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(last.kind).toBe('mesh');
  });
});
