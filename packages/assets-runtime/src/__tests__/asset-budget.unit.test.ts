import { describe, expect, test } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { DEFAULT_ASSET_BUDGET_BYTES, validateAssetBudgetBytes } from '../index';
import { AssetRecords } from '../internal/asset-records';

const GIB = 1024 * 1024 * 1024;

describe('public AssetRegistry content budget', () => {
  test('defaults to 4 GiB so real scenes above 1 GiB of meshes fit', () => {
    expect(DEFAULT_ASSET_BUDGET_BYTES).toBe(4 * GIB);
    const records = new AssetRecords();
    expect((records as unknown as { limits: { maxBytes: number } }).limits.maxBytes).toBe(
      DEFAULT_ASSET_BUDGET_BYTES,
    );
  });

  test('admits finite positive safe integers only', () => {
    for (const bytes of [1, GIB, 6 * GIB, Number.MAX_SAFE_INTEGER])
      expect(() => validateAssetBudgetBytes(bytes)).not.toThrow();
    for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null])
      expect(() => validateAssetBudgetBytes(bytes)).toThrow(
        'assetBudgetBytes must be a positive safe integer',
      );
  });

  test('a registry limit bounds adopted content bytes', () => {
    const count = 10_000;
    const mesh = () => ({
      kind: 'mesh' as const,
      vertices: new Float32Array(count * 3),
      attributes: { position: new Float32Array(count * 3) },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: count,
          topology: 'point-list' as const,
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
    });
    const bounded = new AssetRegistry({ limits: { maxBytes: 4096 } });
    expect(bounded.create(mesh())).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded', expected: 'available content bytes' },
    });
    bounded.dispose();
    const admitted = new AssetRegistry({ limits: { maxBytes: count * 64 } });
    expect(admitted.create(mesh()).ok).toBe(true);
    admitted.dispose();
  });
});
