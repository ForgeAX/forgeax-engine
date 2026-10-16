// rename API (in-memory) three classes + two error paths — AC-06 (feat-20260618 w14).
//
// Red-first: written before w13 implements rename.
//
// Coverage:
//   1. null-package asset rename -> resolveName returns the new name
//   2. multi-asset package rename -> resolveName returns the new name
//   3. single-asset package rename -> resolveName + packagePath leaf both sync
//   4. name collision inside the same package -> err(asset-invalid-value)
//   5. target guid not registered -> err(asset-not-found)

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SamplerAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const NULL_PKG = 'd0000000-0000-4000-d000-000000000001';
const MULTI_A = 'd0000000-0000-4000-d000-000000000002';
const MULTI_B = 'd0000000-0000-4000-d000-000000000003';
const SINGLE = 'd0000000-0000-4000-d000-000000000004';
const MISSING = 'd0000000-0000-4000-d000-0000000000ff';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler: SamplerAsset = { kind: 'sampler' };

describe('rename API (AC-06)', () => {
  it('null-package asset rename updates the stored name', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(NULL_PKG), sampler);
    reg._registerPackage(null, [NULL_PKG], new Map([[NULL_PKG, 'old']]));

    const r = reg.rename(NULL_PKG, 'fresh');
    expect(r.ok).toBe(true);
    expect(reg.resolveName(NULL_PKG)).toBe('fresh');
  });

  it('multi-asset package rename updates the entry stored name', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(MULTI_A), sampler);
    reg.catalog(parseGuid(MULTI_B), sampler);
    reg._registerPackage(
      'assets/char.glb',
      [MULTI_A, MULTI_B],
      new Map([
        [MULTI_A, 'Body'],
        [MULTI_B, 'Head'],
      ]),
    );

    const r = reg.rename(MULTI_A, 'Torso');
    expect(r.ok).toBe(true);
    expect(reg.resolveName(MULTI_A)).toBe('Torso');
    expect(reg.resolveName(MULTI_B)).toBe('Head');
  });

  it('single-asset package rename syncs resolveName and packagePath leaf', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(SINGLE), sampler);
    reg._registerPackage('assets/hero.glb', [SINGLE]);

    const r = reg.rename(SINGLE, 'villain');
    expect(r.ok).toBe(true);
    expect(reg.resolveName(SINGLE)).toBe('villain');
    const pkg = reg.packageOf(SINGLE);
    expect(pkg).not.toBeNull();
    expect(pkg?.path.endsWith('villain')).toBe(true);
  });

  it('name collision inside the same package returns asset-invalid-value', () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(MULTI_A), sampler);
    reg.catalog(parseGuid(MULTI_B), sampler);
    reg._registerPackage(
      'assets/char.glb',
      [MULTI_A, MULTI_B],
      new Map([
        [MULTI_A, 'Body'],
        [MULTI_B, 'Head'],
      ]),
    );

    const r = reg.rename(MULTI_A, 'Head');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('asset-invalid-value');
  });

  it('renaming a missing guid returns asset-not-found', () => {
    const reg = makeRegistry();
    const r = reg.rename(MISSING, 'whatever');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('asset-not-found');
  });
});
