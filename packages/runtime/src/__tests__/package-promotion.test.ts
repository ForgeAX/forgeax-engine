// 1->N package promotion idempotence — AC-05 (feat-20260618 w12).
//
// Red-first: written before w11 adds the promotion branch to registerPackage.
//
// Coverage:
//   AC-05 — when a single-asset package gains a second asset, the original
//           asset's derived basename is frozen as its stored name so it keeps
//           the same resolveName (now via the multi-asset branch), with no error
//           and no caller awareness. Promotion is idempotent: re-registering the
//           same path does not overwrite an already-frozen name. An explicitly
//           authored name is already stable and is preserved through promotion.
//
// The promotion must not emit a violation for an explicitly named first asset.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createEngineMetrics } from '../../../render/src/engine-metrics';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const G1 = 'c0000000-0000-4000-c000-000000000001';
const G2 = 'c0000000-0000-4000-c000-000000000002';
const PATH = 'assets/scene.glb';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler: SamplerAsset = { kind: 'sampler' };

describe('1->N package promotion (AC-05)', () => {
  it('single asset derives basename', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1]);
    expect(reg.resolveName(G1)).toBe('scene.glb');
  });

  it('adding a second asset keeps the original name unchanged, no error', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1]);
    reg.catalog(parseGuid(G2), sampler);
    reg._registerPackage(PATH, [G2], new Map([[G2, 'SecondAsset']]));

    expect(reg.resolveName(G1)).toBe('scene.glb');
    expect(reg.resolveName(G2)).toBe('SecondAsset');
    expect(reg.packageOf(G1)?.assetCount).toBe(2);
  });

  it('re-registering the same path is idempotent (does not overwrite frozen name)', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1]);
    reg.catalog(parseGuid(G2), sampler);
    reg._registerPackage(PATH, [G2], new Map([[G2, 'SecondAsset']]));
    reg._registerPackage(PATH, [G1, G2], new Map([[G2, 'SecondAsset']]));

    expect(reg.resolveName(G1)).toBe('scene.glb');
    expect(reg.resolveName(G2)).toBe('SecondAsset');
  });

  it('preserves an explicitly authored first-asset name without a false violation', () => {
    const reg = makeRegistry();
    const metrics = createEngineMetrics();
    reg.setMetrics(metrics);
    reg.catalog(parseGuid(G1), sampler);
    reg._registerPackage(PATH, [G1], new Map([[G1, 'PreNamed']]));
    reg.catalog(parseGuid(G2), sampler);
    // Promotion preserves the authored name rather than replacing it with the
    // package basename.
    reg._registerPackage(PATH, [G2], new Map([[G2, 'SecondAsset']]));

    expect(reg.resolveName(G1)).toBe('PreNamed');
    expect(metrics.snapshot()['package.xor-invariant-violated'] ?? 0).toBe(0);
  });
});
