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
