// AC-12 inspector snapshot name (feat-20260618 w25).
//
// Verify that inspect().assets carries resolved names for single-package,
// multi-package, and null-package assets. Each entry.name must match
// resolveName(guid), confirming the inspect() wiring from M1/w3 placeholder
// to resolveName (D-9).
//
// Plan-targeted console unit test, but inspect() runs inside AssetRegistry
// (runtime). A real AssetRegistry is needed to exercise the inspect() ->
// resolveName wiring.
//
// The AssetRegistry constructor pre-registers 5 builtin meshes with null
// packages (D-5). Builtins have resolveName === ''.
//
// catalog() puts the asset into the assetCatalog; _registerPackage sets up
// the Package mapping for name resolution. Both are needed before inspect()
// can surface resolved names.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeReg() {
  return new AssetRegistry(makeMockShaderRegistry());
}

const stubSampler = { kind: 'sampler' as const };

function register(reg: AssetRegistry, guid: string, path: string | null, name?: string) {
  reg.catalog(guid, stubSampler);
  reg._registerPackage(path, [guid], name ? new Map([[guid, name]]) : undefined);
}

describe('inspect InspectEntry.name (AC-12)', () => {
  const BUILTIN_COUNT = 5;

  it('single-asset package -> inspect entry carries basename derived name', () => {
    const reg = makeReg();
    register(reg, '01890000-0000-7000-8000-000000000001', '/tmp/hero.pack.json');
    const snap = reg.inspect();
    expect(snap.assets.length).toBeGreaterThanOrEqual(BUILTIN_COUNT + 1);
    const entry = snap.assets.find((e) => e.guid === '01890000-0000-7000-8000-000000000001');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.name).toBe(reg.resolveName('01890000-0000-7000-8000-000000000001'));
    expect(entry.name).toBe('hero.pack.json');
  });

  it('multi-asset package with stored names -> each entry carries distinct name', () => {
    const reg = makeReg();
    const g1 = '01890000-0000-7000-8000-000000000002';
    const g2 = '01890000-0000-7000-8000-000000000003';
    reg.catalog(g1, stubSampler);
    reg.catalog(g2, stubSampler);
    reg._registerPackage(
      '/tmp/multi.pack.json',
      [g1, g2],
      new Map([
        [g1, 'Body'],
        [g2, 'Head'],
      ]),
    );
    const snap = reg.inspect();
    const e1 = snap.assets.find((e) => e.guid === g1);
    const e2 = snap.assets.find((e) => e.guid === g2);
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();
    if (!e1 || !e2) return;
    expect(e1.name).toBe('Body');
    expect(e2.name).toBe('Head');
    expect(e1.name).toBe(reg.resolveName(g1));
    expect(e2.name).toBe(reg.resolveName(g2));
  });

  it('null-package asset with stored name -> entry carries stored name', () => {
    const reg = makeReg();
    register(reg, '01890000-0000-7000-8000-000000000004', null, 'myProcMesh');
    const snap = reg.inspect();
    const entry = snap.assets.find((e) => e.guid === '01890000-0000-7000-8000-000000000004');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.name).toBe(reg.resolveName('01890000-0000-7000-8000-000000000004'));
    expect(entry.name).toBe('myProcMesh');
  });

  it('null-package asset without name -> entry.name is empty string', () => {
    const reg = makeReg();
    register(reg, '01890000-0000-7000-8000-000000000005', null);
    const snap = reg.inspect();
    const entry = snap.assets.find((e) => e.guid === '01890000-0000-7000-8000-000000000005');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.name).toBe(reg.resolveName('01890000-0000-7000-8000-000000000005'));
    expect(entry.name).toBe('');
  });

  it('mixed multi/single/null packages -> all entries carry resolveName value', () => {
    const reg = makeReg();
    const ga = '01890000-0000-7000-8000-000000000006';
    const gb = '01890000-0000-7000-8000-000000000007';
    const gc = '01890000-0000-7000-8000-000000000008';
    const gd = '01890000-0000-7000-8000-000000000009';

    register(reg, ga, '/tmp/hero.pack.json');
    reg.catalog(gb, stubSampler);
    reg.catalog(gc, stubSampler);
    reg._registerPackage(
      '/tmp/multi.pack.json',
      [gb, gc],
      new Map([
        [gb, 'Body'],
        [gc, 'Head'],
      ]),
    );
    register(reg, gd, null);

    const snap = reg.inspect();
    const ours = snap.assets.filter((e) => [ga, gb, gc, gd].includes(e.guid));
    expect(ours).toHaveLength(4);

    for (const entry of ours) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name).toBe(reg.resolveName(entry.guid));
    }
  });

  it('builtin assets have empty string names (D-5 null package)', () => {
    const reg = makeReg();
    const snap = reg.inspect();
    // First entries are the 5 builtin meshes.
    expect(snap.assets.length).toBeGreaterThanOrEqual(BUILTIN_COUNT);
    for (const entry of snap.assets) {
      expect(typeof entry.name).toBe('string');
    }
    // Builtins resolve to empty string.
    const builtinNames = snap.assets.slice(0, BUILTIN_COUNT).map((e) => e.name);
    expect(builtinNames).toEqual(['', '', '', '', '']);
  });
});
