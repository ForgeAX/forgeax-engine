import { describe, expect, it } from 'vitest';
import { validatePack } from '../src/schema-compiled.js';

// AC-07: .pack.json schema assets[] accepts optional name?.
// validatePack must accept entries with name, entries without name (add-only
// backward compat), and mixed packs. Extra unknown fields must still be rejected.

describe('pack-schema-name (AC-07)', () => {
  const mkPack = (assets: Array<Record<string, unknown>>) => ({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets,
  });

  const baseAsset = () => ({
    guid: '00000000-0000-0000-0000-000000000001',
    kind: 'MeshAsset',
    payload: {},
    refs: [],
  });

  it('accepts an entry with name', () => {
    const pack = mkPack([{ ...baseAsset(), name: 'MyAsset' }]);
    expect(validatePack(pack)).toBe(true);
  });

  it('accepts an entry without name (old pack add-only compat)', () => {
    const pack = mkPack([baseAsset()]);
    expect(validatePack(pack)).toBe(true);
  });

  it('accepts a mixed pack: some entries with name, some without', () => {
    const pack = mkPack([
      { ...baseAsset(), name: 'NamedAsset', guid: '00000000-0000-0000-0000-000000000001' },
      { ...baseAsset(), guid: '00000000-0000-0000-0000-000000000002' },
      { ...baseAsset(), name: 'AnotherNamed', guid: '00000000-0000-0000-0000-000000000003' },
    ]);
    expect(validatePack(pack)).toBe(true);
  });

  it('rejects an entry with an unknown extra field', () => {
    const pack = mkPack([{ ...baseAsset(), extraField: 42 }]);
    expect(validatePack(pack)).toBe(false);
  });
});