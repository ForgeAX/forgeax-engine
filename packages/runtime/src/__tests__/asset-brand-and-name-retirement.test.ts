// feat-20260622 M6 / w22 — regression guards for the two side-table retirements.
//
//   AC-05: storedNameOf retired; per-GUID stored name lives on the envelope and
//          feeds resolveName's `storedName` argument. resolveName's three-arg
//          display-name derivation (stored-name precedence / package basename
//          fallback / no-package '' fallback / promotion freeze) must remain
//          coherent.
//   AC-06: the 14-arm assetBrand switch retired for the ASSET_BRAND Record
//          table. The table maps every Asset.kind to its brand, and the two
//          consumption points (instantiate -> allocSharedRef brand arg;
//          inspect().assets[].brand) return the correct brand per kind.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const sampler = { kind: 'sampler' as const };

// ── AC-05: resolveName remains coherent after storedNameOf retirement ──

describe('AC-05 resolveName regression (storedNameOf retired, name on envelope)', () => {
  it('single-asset package -> basename(path), no stored name needed', () => {
    const reg = makeReg();
    const g = '01890000-0000-7000-8000-000000000101';
    reg.catalog(g, sampler);
    reg._registerPackage('assets/hero.glb', [g]);
    expect(reg.resolveName(g)).toBe('hero.glb');
    // The payload never carries the name (it lives on the envelope only).
    const stored = reg.lookup(g);
    expect(stored).toBeDefined();
    expect(Object.hasOwn(stored as object, 'name')).toBe(false);
  });

  it('multi-asset package -> each entry stored name read from envelope', () => {
    const reg = makeReg();
    const a = '01890000-0000-7000-8000-000000000102';
    const b = '01890000-0000-7000-8000-000000000103';
    reg.catalog(a, sampler);
    reg.catalog(b, sampler);
    reg._registerPackage(
      'assets/char.glb',
      [a, b],
      new Map([
        [a, 'Body'],
        [b, 'Head'],
      ]),
    );
    expect(reg.resolveName(a)).toBe('Body');
    expect(reg.resolveName(b)).toBe('Head');
  });

  it('no-package asset with self name -> stored name; without -> empty string', () => {
    const reg = makeReg();
    const named = '01890000-0000-7000-8000-000000000104';
    const anon = '01890000-0000-7000-8000-000000000105';
    reg.catalog(named, sampler);
    reg.catalog(anon, sampler);
    reg._registerPackage(null, [named], new Map([[named, 'myProcMesh']]));
    reg._registerPackage(null, [anon]);
    expect(reg.resolveName(named)).toBe('myProcMesh');
    expect(reg.resolveName(anon)).toBe('');
  });

  it('1->N promotion -> original asset basename frozen as stored name', () => {
    const reg = makeReg();
    const g1 = '01890000-0000-7000-8000-000000000106';
    const g2 = '01890000-0000-7000-8000-000000000107';
    reg.catalog(g1, sampler);
    reg.catalog(g2, sampler);
    // Single-asset package first: resolveName == basename.
    reg._registerPackage('assets/world.glb', [g1]);
    expect(reg.resolveName(g1)).toBe('world.glb');
    // A second member arrives: the original's derived basename freezes as its
    // stored name so it keeps a stable name on the multi-asset branch.
    reg._registerPackage('assets/world.glb', [g2], new Map([[g2, 'Ground']]));
    expect(reg.resolveName(g1)).toBe('world.glb');
    expect(reg.resolveName(g2)).toBe('Ground');
  });

  it('rename writes the stored name through the envelope', () => {
    const reg = makeReg();
    const a = '01890000-0000-7000-8000-000000000108';
    const b = '01890000-0000-7000-8000-000000000109';
    reg.catalog(a, sampler);
    reg.catalog(b, sampler);
    reg._registerPackage(
      'assets/pair.glb',
      [a, b],
      new Map([
        [a, 'First'],
        [b, 'Second'],
      ]),
    );
    const r = reg.rename(a, 'Renamed');
    expect(r.ok).toBe(true);
    expect(reg.resolveName(a)).toBe('Renamed');
    expect(reg.resolveName(b)).toBe('Second');
  });
});
