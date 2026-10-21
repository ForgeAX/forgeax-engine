import { describe, expect, it } from 'vitest';
import { reconcileMeshLodMeta } from '../mesh-lod.js';

describe('mesh LOD reimport identity', () => {
  it('keeps coverage attached to sourceKey instead of array position', () => {
    const result = reconcileMeshLodMeta(
      [{ sourceKey: 'root/lod1', meshGuid: 'guid-1', screenCoverage: 0.5 }],
      [{ sourceKey: 'root/lod1', meshGuid: 'guid-1', screenCoverage: 0.5 }],
    );
    expect(result).toMatchObject({
      ok: true,
      value: { lods: [{ meshGuid: 'guid-1', screenCoverage: 0.5 }] },
    });
  });
});

// glTF and FBX submit raw retained sidecar values to the same reconciliation owner.
it('admits legacy retained entries before preserving coverage and checking identity', () => {
  const next = [{ sourceKey: 'root/lod1', meshGuid: 'guid-1' }];
  for (const absent of [undefined, null, {}, false]) {
    expect(reconcileMeshLodMeta(absent, next)).toMatchObject({ ok: true });
  }
  const retained = [
    null,
    4,
    {},
    { sourceKey: 'incomplete' },
    { sourceKey: 'root/lod1', meshGuid: 'guid-1', screenCoverage: 0.3 },
  ];
  expect(reconcileMeshLodMeta(retained, next)).toMatchObject({
    ok: true,
    value: { lods: [{ ...next[0], screenCoverage: 0.3 }] },
  });
  expect(
    reconcileMeshLodMeta(retained, [{ sourceKey: 'root/lod1', meshGuid: 'changed' }]),
  ).toMatchObject({ ok: false, error: { code: 'mesh-lod-authority-conflict' } });
  expect(reconcileMeshLodMeta([{ ...next[0], screenCoverage: NaN }], next)).toMatchObject({
    ok: false,
    error: { code: 'mesh-lod-contract-invalid' },
  });
});
