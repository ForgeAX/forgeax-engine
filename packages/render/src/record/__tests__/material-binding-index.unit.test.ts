import { describe, expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { DispatchList } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { buildDispatchPlan, buildMaterialSlotPlan } from '../fold-buckets';
import type { ValidatedRenderable } from '../frame-snapshot';
import { MaterialBindingIndex, MaterialRelations } from '../material-binding-index';
import { drawMaterial } from '../material-pass-selection';

const scope = { identity: 'material-relation-test' } as RenderResourceScope;
const material = (handle: number) =>
  new MaterialResource({
    ...receiptRow().source.material.snapshot,
    materialHandle: handle,
    immutableValues: true,
  });
const a = material(11);
const b = material(12);
const c = material(13);
const ab = Object.freeze([a, b, a]);
const aa = Object.freeze([a]);
const cc = Object.freeze([c]);
const accepted = new MaterialFrame(undefined).with(a).with(b).with(c);
function row(entity: number, materials: readonly MaterialResource[] = aa): ValidatedRenderable {
  return {
    ...receiptRow(),
    mesh: {} as ValidatedRenderable['mesh'],
    renderState: undefined,
    stencilReference: undefined,
    world: scope,
    renderableIndex: entity,
    meshSlot: entity,
    source: { ...receiptRow().source, entityKey: entity, material: materials[0] ?? a, materials },
  };
}
function capture(owner: MaterialRelations, rows: readonly ValidatedRenderable[], frame = accepted) {
  owner.begin(frame);
  rows.forEach((row, index) => {
    owner.write(index, row);
  });
  return owner.finish(rows.length);
}
function expectOrdinary(
  table: ReturnType<MaterialBindingIndex['build']>,
  rows: readonly ValidatedRenderable[],
  frame = accepted,
) {
  const plan = buildMaterialSlotPlan(rows.map((row) => row.source.materials));
  expect(table.slotIndices.map((indices) => [...indices])).toEqual(plan.slotIndices);
  expect(table.slots).toEqual(plan.slots.map((resource) => frame.get(resource)?.snapshot));
  expect(table.bindings).toEqual(
    plan.slots.map((material, slot) => ({
      material,
      resourceClass: '',
      world: rows[plan.slotOwners[slot] ?? -1]?.world,
      entityKey: rows[plan.slotOwners[slot] ?? -1]?.source.entityKey,
    })),
  );
}

describe('persistent material reader membership', () => {
  it('rejects invalid row addresses rather than selecting another material row', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const table = index.build([capture(owner, [row(0)])], [], accepted, [row(0)]);
    const context = { materialSlots: table.slots, materialSlotIndices: table.slotIndices };
    for (const address of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => drawMaterial(context, address)).toThrow(
        'Draw has no fixed submitted material slot',
      );
  });
  it('retains quiet and pose-only relations without re-indexing their rows', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const rows = Array.from({ length: 4097 }, (_, id) => row(id, id % 2 ? ab : aa));
    const first = capture(owner, rows);
    const table = index.build([first], [], accepted, rows);
    expectOrdinary(table, rows);
    const work = { ...index.work };
    const storage = { ...owner.work };
    const moved = rows.map((row) => ({
      ...row,
      source: { ...row.source, transform: { world: new Float32Array(16) } },
    }));
    const next = capture(owner, moved);
    expect(next).toBe(first);
    expect(index.build([next], [], accepted, moved).slotIndices).toBe(table.slotIndices);
    expect(index.work).toEqual(work);
    expect(owner.work).toEqual(storage);
  });

  it('indexes only changed binding rows and retains older accepted tables', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const rows = Array.from({ length: 4097 }, (_, id) => row(id));
    const first = capture(owner, rows);
    const old = index.build([first], [], accepted, rows);
    const previous = index.work.changedRows;
    const backingBytes = owner.work.identityBytes;
    const updated = rows.slice();
    for (const id of [0, 63, 64, 65, 1024, 2048, 4095, 4096]) updated[id] = row(id, ab);
    const next = capture(owner, updated);
    const table = index.build([next], [], accepted, updated);
    expect(index.work.changedRows - previous).toBe(8);
    expect(owner.work.identityBytes - backingBytes).toBeLessThanOrEqual(8 * 64 * 2 * 8);
    expectOrdinary(table, updated);
    expectOrdinary(old, rows);
    expect(first.at(64)).toBe(aa);
    expect(next.at(64)).toBe(ab);
  });

  it('preserves first references, membership removal, page truncation and slot reuse', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const before = Array.from({ length: 130 }, (_, id) => row(id, id === 0 ? ab : cc));
    const old = index.build([capture(owner, before)], [], accepted, before);
    for (const after of [before.slice(1), [row(99, ab), row(100, cc)], [], [row(101, cc)]]) {
      const table = index.build([capture(owner, after)], [], accepted, after);
      expectOrdinary(table, after);
    }
    expectOrdinary(old, before);
  });

  it('joins shifted Pass ranges without retiring an overlapping new reader', () => {
    const left = new MaterialRelations();
    const right = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const tail = [row(3, ab), row(4, cc)];
    const rightFrame = capture(right, tail);
    index.build([capture(left, [row(1)]), rightFrame], [], accepted, [row(1), ...tail]);
    const grown = [row(1), row(2, ab), row(5, cc)];
    expectOrdinary(
      index.build([capture(left, grown), rightFrame], [], accepted, [...grown, ...tail]),
      [...grown, ...tail],
    );
    const shrunk = [row(6, cc)];
    expectOrdinary(
      index.build([capture(left, shrunk), rightFrame], [], accepted, [...shrunk, ...tail]),
      [...shrunk, ...tail],
    );
    expectOrdinary(index.build([rightFrame], [], accepted, tail), tail);
  });

  it('observes accepted material versions without changing binding relationships', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const rows = [row(1, ab)];
    const relations = capture(owner, rows);
    const old = index.build([relations], [], accepted, rows);
    const snapshot = { ...a.snapshot, roughness: 0.123 };
    const nextFrame = accepted.with(a, 1, snapshot);
    const next = index.build([relations], [], nextFrame, rows);
    expect(next.slotIndices).toBe(old.slotIndices);
    expect(next.slots[0]).toBe(snapshot);
    expect(old.slots[0]).toBe(accepted.get(a)?.snapshot);
  });

  it('keeps transient resource scopes outside persistent entity relationships', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const rows = Array.from({ length: 4097 }, (_, id) => row(id, id % 2 ? ab : aa));
    const first = capture(owner, rows);
    const old = index.build([first], [], accepted, rows);
    const storage = { ...owner.work };
    const work = { ...index.work };
    const nextScope = { identity: 'next-fixed-resource-frame' } as RenderResourceScope;
    const scoped = rows.map((entry) => ({ ...entry, world: nextScope }));
    const next = capture(owner, scoped);
    expect(next).toBe(first);
    const current = index.build([next], [], accepted, scoped);
    expect(current.slotIndices).toBe(old.slotIndices);
    expect(owner.work).toEqual(storage);
    expect(index.work).toEqual(work);
    expect(current.bindings.every((binding) => binding.world === nextScope)).toBe(true);
    expect(old.bindings.every((binding) => binding.world === scope)).toBe(true);
  });

  it('detaches mutable source tuples while preserving the fixed earlier relationship', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const tuple = [a, b];
    const rows = [row(0, tuple)];
    const first = capture(owner, rows);
    const old = index.build([first], [], accepted, rows);
    tuple[1] = c;
    const next = capture(owner, rows);
    expect(first.at(0)).toEqual([a, b]);
    expect(next.at(0)).toEqual([a, c]);
    expect(index.build([next], [], accepted, rows).slots).toEqual([a.snapshot, c.snapshot]);
    expect(old.slots).toEqual([a.snapshot, b.snapshot]);
  });

  it('captures actual shadow bindings and their own first resource scope', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const main = [row(1)];
    const shadow = [{ ...row(2, ab), world: { identity: 'shadow' } as RenderResourceScope }];
    const table = index.build([capture(owner, main)], shadow, accepted, main);
    expectOrdinary(table, [...main, ...shadow]);
    expectOrdinary(index.build([capture(owner, [])], shadow, accepted, []), shadow);
  });

  it('keeps the primary material of an empty authored tuple', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const empty = row(1, []);
    const frame = capture(owner, [empty]);
    expect(index.build([frame], [], accepted, [empty]).slotIndices.at(0)).toEqual([0]);
    expect(frame.at(0)).toEqual([a]);
  });

  it('uses the accepted Sprite program to select only the primary binding', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const sprite = {
      ...a.snapshot,
      passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' } }],
    };
    const frame = accepted.with(a, 1, sprite);
    const rows = [row(0, ab)];
    const table = index.build([capture(owner, rows, frame)], [], frame, rows);
    expect(table.slotIndices.at(0)).toEqual([0]);
    expect(table.slots).toEqual([sprite]);
    const mesh = index.build([capture(owner, rows)], [], accepted, rows);
    expect(mesh.slotIndices.at(0)).toEqual([0, 1, 0]);
    expect(table.slots).toEqual([sprite]);
  });

  it('preserves missing authored lanes without inventing material readers', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const tuple = [a];
    tuple[2] = b;
    const rows = [row(0, tuple)];
    const table = index.build([capture(owner, rows)], [], accepted, rows);
    const slots = table.slotIndices.at(0);
    const expected = [0];
    expected[2] = 1;
    expect(slots).toEqual(expected);
    expect(1 in (slots ?? [])).toBe(false);
    expect(table.slots).toEqual([a.snapshot, b.snapshot]);
  });
});

it('uses phase relationships in the real dispatch plan and preserves the ordinary table', () => {
  const owner = new MaterialRelations();
  const index = new MaterialBindingIndex();
  const rows = [row(0, ab), row(1, cc)];
  const dispatch = rows.map((entry) => ({
    renderableIndex: entry.renderableIndex,
    tags: { LightMode: 'Forward' },
  })) as unknown as DispatchList;
  const internals = {
    growMeshSsbo: () => ({ ok: true }),
    meshSsboState: { meshSlotCount: 8, materialSlotCount: 8 },
  } as never;
  const shared = { bindings: [], worlds: [scope], frame: accepted };
  const ordinary = buildDispatchPlan(internals, rows, dispatch, [], [], undefined, false, shared);
  const retained = buildDispatchPlan(
    internals,
    rows,
    dispatch,
    [],
    [],
    undefined,
    false,
    shared,
    undefined,
    true,
    { owner: index, renderables: rows, rows: [capture(owner, rows)] },
  );
  expect(Array.isArray(retained.materialSlotIndices)).toBe(false);
  expect(retained.materialSlotIndices.map((row) => [...row])).toEqual(ordinary.materialSlotIndices);
  expect(retained.materialSlots).toEqual(ordinary.materialSlots);
  expect(retained.materialBindings).toEqual(ordinary.materialBindings);
  expect(retained.materialBindingSlots).toEqual(ordinary.materialBindingSlots);
  expect(index.work.changedRows).toBe(rows.length);
});

it('keeps resource-class inputs on their current live path', () => {
  const owner = new MaterialRelations();
  const index = new MaterialBindingIndex();
  const rows = [row(0), row(1)];
  const retained = { owner: index, renderables: rows, rows: [capture(owner, rows)] };
  const internals = {
    growMeshSsbo: () => ({ ok: true }),
    meshSsboState: { meshSlotCount: 8, materialSlotCount: 8 },
  } as never;
  const classes = new Map([
    ['0:0', 'probe:0'],
    ['0:1', 'probe:1'],
  ]);
  const plan = buildDispatchPlan(
    internals,
    rows,
    [],
    [],
    [],
    classes,
    false,
    { bindings: [], worlds: [scope], frame: accepted },
    undefined,
    true,
    retained,
  );
  expect(plan.materialSlotIndices.map((row) => [...row])).toEqual([[0], [1]]);
  expect(plan.materialBindings.map((binding) => binding.resourceClass)).toEqual([
    'probe:0',
    'probe:1',
  ]);
  expect(index.work.rebuilt).toBe(0);
});

it('observes borrowed custom material mapping without reading retained relationships', () => {
  const owner = new MaterialRelations();
  const index = new MaterialBindingIndex();
  const tuple = [a];
  const mapping = vi.spyOn(tuple, 'map');
  const rows = [row(0, tuple)];
  const retained = { owner: index, renderables: rows, rows: [capture(owner, rows)] };
  const { immutableValues: _owned, ...snapshot } = a.snapshot;
  const borrowed = accepted.with(a, 1, snapshot);
  const internals = {
    growMeshSsbo: () => ({ ok: true }),
    meshSsboState: { meshSlotCount: 8, materialSlotCount: 8 },
  } as never;
  const plan = buildDispatchPlan(
    internals,
    rows,
    [],
    [],
    [],
    undefined,
    false,
    { bindings: [], worlds: [scope], frame: borrowed },
    undefined,
    true,
    retained,
  );
  expect(plan.materialSlotIndices.at(0)).toEqual([0]);
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(index.work.rebuilt).toBe(0);
});
