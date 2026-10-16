// AC-15 deterministic name fallback — runtime integration (feat-20260618 w19).
//
// deriveAssetName's branch logic is unit-tested in @forgeax/engine-pack (w8);
// this test exercises the runtime wiring (resolveName passing the right args).
//
// Coverage:
//   AC-15.1 — multi-asset package entry with no stored name -> basename(path),
//             no throw (old add-only packs are a reachable state).
//   AC-15.2 — null package with no stored name -> '' (the detectable
//             "genuinely no name" signal), no throw.
//   D-5     — builtin meshes resolve to '' (null package, no name).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const MULTI_A = 'e0000000-0000-4000-e000-000000000001';
const MULTI_B = 'e0000000-0000-4000-e000-000000000002';
const NO_PKG = 'e0000000-0000-4000-e000-000000000003';
// Builtin cube GUID -- the constructor registers it with a null package (D-5).
const BUILTIN_CUBE_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler: SamplerAsset = { kind: 'sampler' };

describe('resolveName deterministic fallback (AC-15)', () => {
  it('AC-15.1 multi-asset entry with no stored name falls back to basename', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(MULTI_A), sampler);
    reg.catalog(parseGuid(MULTI_B), sampler);
    // Only MULTI_A carries a name; MULTI_B has none (old add-only pack).
    reg._registerPackage('assets/world.glb', [MULTI_A, MULTI_B], new Map([[MULTI_A, 'Ground']]));

    expect(() => reg.resolveName(MULTI_B)).not.toThrow();
    expect(reg.resolveName(MULTI_B)).toBe('world.glb');
    expect(reg.resolveName(MULTI_A)).toBe('Ground');
  });

  it('AC-15.2 null package with no name resolves to empty string', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(NO_PKG), sampler);
    reg._registerPackage(null, [NO_PKG]);

    expect(() => reg.resolveName(NO_PKG)).not.toThrow();
    expect(reg.resolveName(NO_PKG)).toBe('');
  });

  it('D-5 builtin mesh resolves to empty string (null package, no name)', () => {
    const reg = makeRegistry();
    expect(reg.packageOf(BUILTIN_CUBE_GUID)).toBe(null);
    expect(reg.resolveName(BUILTIN_CUBE_GUID)).toBe('');
  });
});
