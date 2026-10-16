import { describe, expect, it } from 'vitest';
import {
  buildDispatchPlan,
  buildMaterialSlotPlan,
  findRenderablePrefixForSlotCapacity,
  materialSlotCountForPrefix,
} from '../frame';
import type { ValidatedRenderable } from '../frame-snapshot';

function validatedRow(renderableIndex: number): ValidatedRenderable {
  return {
    source: {
      material: { materialShaderId: 'forgeax::default-unlit' },
      materials: [{ materialShaderId: 'forgeax::default-unlit' }],
    },
    mesh: {},
    renderableIndex,
    renderState: undefined,
    stencilReference: undefined,
  } as never;
}

function ceilingInternals(meshSlotCount: number, materialSlotCount = meshSlotCount) {
  return {
    growMeshSsbo: () => ({
      ok: false as const,
      code: 'mesh-ssbo-ceiling-reached' as const,
      degradedTo: { meshSlotCount, materialSlotCount },
    }),
    meshSsboState: { meshSlotCount, materialSlotCount },
  } as never;
}

describe('material slot plan', () => {
  it('interns repeated snapshot identities across renderables', () => {
    const a = {};
    const b = {};
    const c = {};
    expect(
      buildMaterialSlotPlan([
        [a, b],
        [a, c],
        [b, a],
      ]),
    ).toEqual({
      slotIndices: [
        [0, 1],
        [0, 2],
        [1, 0],
      ],
      slots: [a, b, c],
      slotOwners: [0, 0, 1],
    });
  });

  it('separates per-object probe/pass bindings while interning the same resource class', () => {
    const material = {};
    expect(
      buildMaterialSlotPlan([[material], [material], [material]], (_, owner) =>
        owner === 1 ? 'probe:1' : 'probe:0',
      ),
    ).toEqual({ slotIndices: [[0], [1], [0]], slots: [material, material], slotOwners: [0, 1] });
  });

  it('preserves sparse groups and binding-class callback observations across fanout', () => {
    const material = {};
    const group: object[] = [material];
    group[2] = material;
    const groups: object[][] = [group];
    groups[2] = [material];
    groups[3] = [material];
    groups[4] = [material];
    const trace: number[] = [];
    const plan = buildMaterialSlotPlan(groups as readonly (readonly object[])[], (_, owner) => {
      trace.push(owner);
      return owner === 0 ? 'shared' : `owner:${owner}`;
    });
    expect(trace).toEqual([0, 0, 2, 3, 4]);
    expect(plan.slotIndices[0]?.[0]).toBe(0);
    expect(plan.slotIndices[0]?.[2]).toBe(0);
    expect(plan.slotIndices.slice(2)).toEqual([[1], [2], [3]]);
    expect(1 in plan.slotIndices).toBe(false);
    expect(1 in (plan.slotIndices[0] ?? [])).toBe(false);
    expect(plan.slotOwners).toEqual([0, 2, 3, 4]);
  });

  it('does not merge equal-looking snapshots with distinct identities', () => {
    expect(buildMaterialSlotPlan([[{}], [{}]])).toMatchObject({
      slotIndices: [[0], [1]],
      slots: [{}, {}],
      slotOwners: [0, 1],
    });
  });

  it('observes every owner binding in order and returns to the original class after splits', () => {
    const a = {};
    const b = {};
    const classes = ['base', 'probe', 'base', 'shadow', 'probe'];
    const reads: [object, number][] = [];
    const plan = buildMaterialSlotPlan([[a, b], [a], [a], [a, b], [a]], (material, owner) => {
      reads.push([material, owner]);
      return classes[owner] ?? '';
    });
    expect(reads).toEqual([
      [a, 0],
      [b, 0],
      [a, 1],
      [a, 2],
      [a, 3],
      [b, 3],
      [a, 4],
    ]);
    expect(plan).toEqual({
      slotIndices: [[0, 1], [2], [0], [3, 4], [2]],
      slots: [a, b, a, a, b],
      slotOwners: [0, 0, 1, 3, 3],
    });
  });

  it('truncates only at complete mesh and material prefixes', () => {
    const indices = [[0], [1, 2, 3], [0, 4], [5, 6, 7, 8]];
    expect(findRenderablePrefixForSlotCapacity(indices, 3)).toBe(1);
    expect(findRenderablePrefixForSlotCapacity(indices, 5)).toBe(3);
    expect(materialSlotCountForPrefix(indices, 3)).toBe(5);
  });

  it('keeps retained shadow rows inside the ceiling when the primary view is empty', () => {
    const shadowRows = [validatedRow(0), validatedRow(1), validatedRow(2)];
    const plan = buildDispatchPlan(ceilingInternals(2), [], [], [], shadowRows);

    expect(plan.validatedOrdered).toHaveLength(0);
    expect(plan.shadowValidatedOrdered).toEqual(shadowRows.slice(0, 2));
    expect(plan.validatedOrdered.length + plan.shadowValidatedOrdered.length).toBeLessThanOrEqual(
      2,
    );
  });

  it('reserves the primary rows before retained shadow rows on a mixed ceiling', () => {
    const primaryRows = [validatedRow(0), validatedRow(1)];
    const shadowRows = [validatedRow(2), validatedRow(3)];
    const plan = buildDispatchPlan(ceilingInternals(3), primaryRows, [], [], shadowRows);

    expect(plan.validatedOrdered).toEqual(primaryRows);
    expect(plan.shadowValidatedOrdered).toEqual(shadowRows.slice(0, 1));
    expect(plan.validatedOrdered.length + plan.shadowValidatedOrdered.length).toBeLessThanOrEqual(
      3,
    );
  });

  it('does not cap shared-material mesh rows by material capacity', () => {
    const material = {};
    const rows = Array.from({ length: 4 }, (_, index) => {
      const row = validatedRow(index);
      Object.assign(row.source, { material, materials: [material] });
      return row;
    });
    const plan = buildDispatchPlan(ceilingInternals(3, 1), rows.slice(0, 2), [], [], rows);
    expect(plan.validatedOrdered).toEqual(rows.slice(0, 2));
    expect(plan.shadowValidatedOrdered).toEqual(rows.slice(0, 1));
    expect(plan.materialSlotCount).toBe(1);
    expect(plan.materialSlotIndices).toEqual([[0], [0], [0]]);
  });

  it('stops at a complete material prefix when mesh capacity still has room', () => {
    const main = validatedRow(0);
    const shadows = [validatedRow(1), validatedRow(2)];
    const plan = buildDispatchPlan(ceilingInternals(16, 2), [main], [], [], shadows);
    expect(plan.validatedOrdered).toEqual([main]);
    expect(plan.shadowValidatedOrdered).toEqual(shadows.slice(0, 1));
    expect(plan.materialSlotIndices).toEqual([[0], [1]]);
    expect(plan.materialSlotOwners).toEqual([main, shadows[0]]);
  });

  it('keeps GPU shadow material indices after a mesh-limited primary prefix', () => {
    const main = [validatedRow(0), validatedRow(1), validatedRow(2)];
    const shadow = validatedRow(3);
    const plan = buildDispatchPlan(ceilingInternals(2, 4), main, [], [], [shadow], undefined, true);
    expect(plan.validatedOrdered).toEqual(main.slice(0, 2));
    expect(plan.shadowValidatedOrdered).toEqual([]);
    expect(plan.materialSlotIndices).toEqual([[0], [1], [3]]);
    expect(plan.materialSlots[3]).toBe(shadow.source.materials[0]);
    expect(plan.materialSlotOwners[3]).toBe(shadow);
  });
});

describe('capable Shadow legacy mesh consumption', () => {
  it('reduces only geometry capacity while retaining the complete material slot projection', () => {
    const material = { materialShaderId: 'forgeax::default-standard-pbr' };
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const row = validatedRow(index);
      Object.assign(row.source, { material, materials: [material] });
      return row;
    });
    const requested: number[][] = [];
    const internals = () => {
      const state = { meshSlotCount: 0, materialSlotCount: 0 };
      return {
        growMeshSsbo: (meshSlotCount: number, materialSlotCount: number) => {
          requested.push([meshSlotCount, materialSlotCount]);
          Object.assign(state, { meshSlotCount, materialSlotCount });
          return { ok: true };
        },
        meshSsboState: state,
      } as never;
    };
    const legacy = buildDispatchPlan(internals(), rows.slice(0, 2), [], [], rows);
    const owned = buildDispatchPlan(internals(), rows.slice(0, 2), [], [], rows, undefined, true);
    expect(requested).toEqual([
      [1002, 1],
      [2, 1],
    ]);
    expect(owned.validatedOrdered).toEqual(legacy.validatedOrdered);
    expect(owned.shadowValidatedOrdered).toEqual([]);
    expect(owned.materialSlots).toEqual(legacy.materialSlots);
    expect(owned.materialSlotOwners).toEqual(legacy.materialSlotOwners);
    expect(owned.materialSlotIndices).toEqual(legacy.materialSlotIndices);
  });

  it('retains all Shadow-only custom material slots and their authored observation order', () => {
    const trace: string[] = [];
    const rows = Array.from({ length: 4 }, (_, index) => {
      const row = validatedRow(index);
      Object.assign(row.source, {
        material: {
          get materialShaderId() {
            trace.push(`shader:${index}`);
            return 'custom';
          },
        },
      });
      return row;
    });
    const control = buildDispatchPlan(ceilingInternals(8), [], [], [], rows);
    const controlTrace = trace.splice(0);
    expect(controlTrace.length).toBeGreaterThan(0);
    const candidate = buildDispatchPlan(ceilingInternals(8), [], [], [], rows, undefined, true);
    expect(trace).toEqual(controlTrace);
    expect(candidate.materialSlots).toEqual(control.materialSlots);
    expect(candidate.materialSlotOwners).toEqual(control.materialSlotOwners);
    expect(candidate.materialSlotCount).toBe(4);
    expect(candidate.shadowValidatedOrdered).toEqual([]);
  });

  it('keeps material-only capacity and graceful prefix truncation', () => {
    const rows = Array.from({ length: 4 }, (_, index) => validatedRow(index));
    const legacy = buildDispatchPlan(ceilingInternals(2), [], [], [], rows);
    const owned = buildDispatchPlan(ceilingInternals(2), [], [], [], rows, undefined, true);
    expect(owned.materialSlots).toEqual(legacy.materialSlots);
    expect(owned.materialSlotOwners).toEqual(legacy.materialSlotOwners);
    expect(owned.materialSlotIndices).toEqual(legacy.materialSlotIndices);
    expect(owned.materialSlotCount).toBe(2);
    expect(owned.shadowValidatedOrdered).toEqual([]);
  });

  it('preserves material getter failure before capacity admission', () => {
    const reason = new Error('material unavailable');
    const row = validatedRow(0);
    Object.assign(row.source, {
      material: {
        get materialShaderId() {
          throw reason;
        },
      },
    });
    for (const owned of [false, true]) {
      expect(() =>
        buildDispatchPlan(ceilingInternals(2), [], [], [], [row], undefined, owned),
      ).toThrow(reason);
    }
  });
});

describe('stock frame sparse material binding index', () => {
  it('preserves complete slot indices, owners and probe/pass splits across worlds and handles', () => {
    const materials = [0, -1, 0xffffffff, Number.NaN, Number.POSITIVE_INFINITY].map(
      (materialHandle) => ({
        materialHandle,
        materialShaderId: 'forgeax::default-standard-pbr',
      }),
    );
    const rows = [0, 1, 65536, 1048576].map((worldId, index) => {
      const row = validatedRow(index);
      Object.assign(row.source, {
        worldId,
        entityKey: 0xffffffff - index,
        material: materials[0],
        materials,
      });
      return row;
    });
    const classes = new Map<string, string>();
    for (const row of rows)
      for (const material of materials)
        if (material.materialHandle !== 0xffffffff)
          classes.set(
            `${row.source.worldId}:${row.source.entityKey}:${material.materialHandle}`,
            row.source.worldId === 1 ? 'forward|probe:2' : '|probe:0',
          );
    const control = buildDispatchPlan(ceilingInternals(32), rows, [], [], rows, classes);
    const candidate = buildDispatchPlan(
      ceilingInternals(32),
      rows,
      [],
      [],
      rows,
      classes,
      false,
      true,
    );
    expect(candidate).toEqual(control);
    expect(classes.size).toBe(16);
  });

  it('observes changes on the next frame without retaining an index or stale empty domain', () => {
    const row = validatedRow(0);
    const material = { materialHandle: 17, materialShaderId: 'forgeax::default-standard-pbr' };
    Object.assign(row.source, { worldId: 3, entityKey: 5, material, materials: [material] });
    const other = validatedRow(1);
    Object.assign(other.source, { worldId: 3, entityKey: 6, material, materials: [material] });
    const classes = new Map<string, string>();
    const resolve = (owned: boolean) =>
      buildDispatchPlan(ceilingInternals(8), [row, other], [], [], [], classes, false, owned);
    expect(resolve(true)).toEqual(resolve(false));
    classes.set('3:5:17', 'probe:1');
    expect(resolve(true)).toEqual(resolve(false));
    expect(resolve(true).materialSlotCount).toBe(2);
    classes.set('3:6:17', 'probe:1');
    expect(resolve(true).materialSlotCount).toBe(1);
    classes.clear();
    expect(resolve(true)).toEqual(resolve(false));
  });

  it('keeps custom get observations and errors on the raw default path', () => {
    const row = validatedRow(0);
    Object.assign(row.source, { worldId: 1, entityKey: 2 });
    const reads: string[] = [];
    class BorrowedClasses extends Map<string, string> {
      override get(key: string) {
        reads.push(key);
        return 'borrowed';
      }
      override [Symbol.iterator](): MapIterator<[string, string]> {
        throw new Error('do not enumerate borrowed bindings');
      }
    }
    buildDispatchPlan(ceilingInternals(8), [row], [], [], [row], new BorrowedClasses());
    expect(reads).toEqual(['1:2:-1', '1:2:-1']);
    const reason = new Error('binding unavailable');
    const broken = new Map<string, string>();
    broken.get = () => {
      throw reason;
    };
    expect(() => buildDispatchPlan(ceilingInternals(8), [row], [], [], [], broken)).toThrow(reason);
  });
});
