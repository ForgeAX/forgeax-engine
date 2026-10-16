import { describe, expect, it } from 'vitest';
import {
  deriveDefaultLodScreenCoverages,
  reconcileMeshLodMeta,
  validateMeshLodContract,
} from '../mesh-lod.js';

describe('mesh LOD contract', () => {
  it.each([
    [1, []],
    [2, [0.5]],
    [3, [0.5, 0.2]],
    [4, [0.5, 0.2, 0.08]],
    [5, [0.5, 0.2, 0.08, 0.032]],
    [8, [0.5, 0.2, 0.08, 0.032, 0.0128, 0.00512, 0.002048]],
  ])('derives stable defaults for %i levels', (levelCount, expected) => {
    expect(deriveDefaultLodScreenCoverages(levelCount)).toEqual(expected);
  });

  it('rejects zero, non-finite, and non-decreasing coverage', () => {
    expect(validateMeshLodContract({ lods: [{ meshGuid: 'a', screenCoverage: 0 }] })).toMatchObject(
      {
        ok: false,
        error: { code: 'mesh-lod-contract-invalid' },
      },
    );
    expect(
      validateMeshLodContract({
        lods: [
          { meshGuid: 'a', screenCoverage: 0.5 },
          { meshGuid: 'b', screenCoverage: 0.6 },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'mesh-lod-contract-invalid' },
    });
  });

  it('preserves existing author facts and only appends levels', () => {
    const previous = [
      { sourceKey: 'mesh/lod1', meshGuid: 'guid-1', screenCoverage: 0.5 },
      { sourceKey: 'mesh/lod2', meshGuid: 'guid-2', screenCoverage: 0.2 },
    ];
    expect(
      reconcileMeshLodMeta(previous, [...previous, { sourceKey: 'mesh/lod3', meshGuid: 'guid-3' }]),
    ).toMatchObject({
      ok: true,
      value: {
        lods: [...previous, { sourceKey: 'mesh/lod3', meshGuid: 'guid-3', screenCoverage: 0.08 }],
      },
    });
    expect(reconcileMeshLodMeta(previous, previous.slice().reverse())).toMatchObject({
      ok: false,
      error: { code: 'mesh-lod-topology-change' },
    });
  });

  it('rejects incomplete refs, non-enclosing bounds, slot drift, and cycles', () => {
    const base = {
      lods: [{ meshGuid: 'lod-1', screenCoverage: 0.5 }],
      rootMeshGuid: 'root',
      refs: ['root'],
      rootBounds: { min: [-1, -1, -1] as const, max: [1, 1, 1] as const },
      lodBounds: [{ min: [-2, -1, -1] as const, max: [1, 1, 1] as const }],
      rootMaterialSlots: [{ sourceKey: 'body' }],
      lodMaterialSlots: [[{ sourceKey: 'body' }]],
      relations: [{ from: 'root', to: 'lod-1' }],
    };
    expect(validateMeshLodContract(base).ok).toBe(false);
    const cycle = validateMeshLodContract({
      ...base,
      refs: ['root', 'lod-1'],
      lodBounds: [{ min: [-1, -1, -1], max: [1, 1, 1] }],
      relations: [
        { from: 'root', to: 'lod-1' },
        { from: 'lod-1', to: 'root' },
      ],
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.reason).toContain('acyclic');
    const slotDrift = validateMeshLodContract({
      ...base,
      refs: ['root', 'lod-1'],
      lodBounds: [{ min: [-1, -1, -1], max: [1, 1, 1] }],
      relations: [{ from: 'root', to: 'lod-1' }],
      lodMaterialSlots: [[{ sourceKey: 'head' }]],
    });
    expect(slotDrift.ok).toBe(false);
    if (!slotDrift.ok) expect(slotDrift.error.reason).toContain('material slots');
  });
});
