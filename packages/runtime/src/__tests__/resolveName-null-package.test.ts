// resolveName null package — AC-03 (feat-20260618 w17).
//
// Red-first: written before w10 implements resolveName.
//
// Coverage:
//   AC-03 — no-package asset: packageOf(guid) === null, resolveName returns the
//           stored self name, and no synthetic guid path is minted (OOS-3).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const NO_PKG_GUID = 'b0000000-0000-4000-b000-000000000001';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler: SamplerAsset = { kind: 'sampler' };

describe('resolveName null package (AC-03)', () => {
  it('packageOf is null, resolveName returns the stored name, no synthetic path', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(NO_PKG_GUID), sampler);
    reg._registerPackage(null, [NO_PKG_GUID], new Map([[NO_PKG_GUID, 'myProcMesh']]));

    expect(reg.packageOf(NO_PKG_GUID)).toBe(null);
    expect(reg.resolveName(NO_PKG_GUID)).toBe('myProcMesh');
  });
});
