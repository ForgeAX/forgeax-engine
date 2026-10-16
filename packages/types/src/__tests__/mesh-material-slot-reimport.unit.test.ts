import { describe, expect, it } from 'vitest';
import {
  migrateLegacyMeshMaterialOverrides,
  reconcileMeshMaterialSlotTopology,
  resolveMeshMaterialSlotDefaultGuid,
} from '../index.js';

describe('Mesh material slot reimport topology', () => {
  it('keeps matched indices, appends additions, and leaves removed slots as tombstones', () => {
    const previous = [
      { slotName: 'Body', sourceKey: 'material:Body', defaultMaterialGuid: 'old-body' },
      { slotName: 'Trim', sourceKey: 'material:Trim', defaultMaterialGuid: 'old-trim' },
    ];
    const result = reconcileMeshMaterialSlotTopology(
      [
        { slotName: 'Accent', sourceKey: 'material:Accent', defaultMaterialGuid: 'new-accent' },
        { slotName: 'Body', sourceKey: 'material:Body', defaultMaterialGuid: 'new-body' },
      ],
      previous,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.currentToStableSlot).toEqual([2, 0]);
    expect(result.slots).toEqual([
      { slotName: 'Body', sourceKey: 'material:Body', defaultMaterialGuid: 'new-body' },
      { slotName: 'Trim', sourceKey: 'material:Trim', tombstone: true },
      { slotName: 'Accent', sourceKey: 'material:Accent', defaultMaterialGuid: 'new-accent' },
    ]);
  });

  it('fails closed when multiple old and new slots cannot be matched unambiguously', () => {
    const result = reconcileMeshMaterialSlotTopology(
      [{ slotName: 'NewA' }, { slotName: 'NewB' }],
      [{ slotName: 'OldA' }, { slotName: 'OldB' }],
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'mesh-material-slot-topology-change',
        previousIndices: [0, 1],
        nextIndices: [0, 1],
        hint: 'name source materials uniquely or provide stable sourceKey values before reimport',
      },
    });
  });

  it('resolves authored material, explicit Engine default, then producer default', () => {
    expect(
      resolveMeshMaterialSlotDefaultGuid(
        {
          slotName: 'Body',
          defaultMaterialGuid: 'producer',
        },
        'authored',
      ),
    ).toBe('authored');
    expect(
      resolveMeshMaterialSlotDefaultGuid(
        {
          slotName: 'Body',
          defaultMaterialGuid: 'producer',
        },
        null,
      ),
    ).toBeUndefined();
    expect(
      resolveMeshMaterialSlotDefaultGuid({
        slotName: 'Body',
        defaultMaterialGuid: 'producer',
      }),
    ).toBe('producer');
  });
});

describe('v2 per-section override migration', () => {
  const context = { meshGuid: 'mesh-a', sceneGuid: 'scene-a', entityId: 17 };
  const submeshes = [{ materialSlot: 0 }, { materialSlot: 0 }, { materialSlot: 1 }];

  it('folds equal section overrides into one slot override', () => {
    expect(migrateLegacyMeshMaterialOverrides([7, 7, 9], submeshes, 2, context)).toEqual({
      ok: true,
      overrides: [7, 9],
    });
  });

  it('stops with Mesh, Scene, entity, slot, and conflicting section evidence', () => {
    expect(migrateLegacyMeshMaterialOverrides([7, 8, 9], submeshes, 2, context)).toEqual({
      ok: false,
      error: {
        code: 'mesh-material-slot-override-conflict',
        ...context,
        materialSlot: 0,
        submeshIndices: [0, 1],
        overrideHandles: [7, 8],
        hint: 'split the source slot or choose one override explicitly before v2 to v3 recook',
      },
    });
  });
});
