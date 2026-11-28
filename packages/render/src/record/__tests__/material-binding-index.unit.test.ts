import { describe, expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { DispatchList } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { buildDispatchPlan, buildMaterialSlotPlan } from '../fold-buckets';
import type { ValidatedRenderable } from '../frame-snapshot';
import { MaterialBindingIndex, MaterialRelations } from '../material-binding-index';
import { materialFromSubmittedSlots, submittedMaterialRow } from '../material-pass-selection';

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
    for (const address of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        materialFromSubmittedSlots(table.slots, submittedMaterialRow(table.slotIndices, address)),
      ).toThrow('Draw has no fixed submitted material slot');
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
    const current = index.build([next], [], accepted, moved);
    expect(current.slotIndices).toBe(table.slotIndices);
    expect(current.bindings).toBe(table.bindings);
    expect(current.slots).toBe(table.slots);
    expect(index.work).toEqual(work);
    expect(owner.work).toEqual(storage);
  });

  it('pins accepted versions to physical material slots through rebinding and frame replacement', () => {
    const rows = [row(81, ab), row(82, cc)];
    const main = capture(new MaterialRelations(), rows);
    const index = new MaterialBindingIndex();
    const old = index.build([main], [], accepted, rows);
    expect(old.slots[1]).toBe(accepted.get(b)?.snapshot);
    const replacement = accepted.with(b, 1, { ...b.snapshot, roughness: 0.7 });
    const current = index.build([main], [], replacement, rows);
    expect(current.slots[1]).toBe(replacement.get(b)?.snapshot);
    expect(old.slots[1]).toBe(b.snapshot);
    const borrowed = new Proxy(replacement, {});
    expect(index.build([main], [], borrowed, rows).slots).toEqual(current.slots);
  });

  it('consumes issued caster relations once and re-reads projected fallback rows', () => {
    const primary = [row(2, ab)];
    const shadows = Array.from({ length: 130 }, (_, i) => row(i + 3, cc));
    const main = capture(new MaterialRelations(), primary);
    const owner = new MaterialRelations();
    const caster = capture(owner, shadows);
    const index = new MaterialBindingIndex();
    const writes = vi.spyOn(MaterialRelations.prototype, 'write');
    try {
      const plan = index.build([main], shadows, accepted, primary, caster);
      expect(writes).not.toHaveBeenCalled();
      expectOrdinary(plan, [...primary, ...shadows]);
      shadows[74] = row(77, ab);
      owner.begin(accepted);
      owner.write(74, shadows[74]);
      const next = owner.finish(shadows.length);
      writes.mockClear();
      const moved = index.build([main], shadows, accepted, primary, next);
      expect(writes).not.toHaveBeenCalled();
      expectOrdinary(moved, [...primary, ...shadows]);
      expect(plan.slotIndices.at(75)).not.toEqual(moved.slotIndices.at(75));
      const projected = shadows.slice(31, 80);
      expectOrdinary(index.build([main], projected, accepted, primary), [...primary, ...projected]);
      expect(writes).toHaveBeenCalledTimes(projected.length);
    } finally {
      writes.mockRestore();
    }
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
    expect(next.bindings).toBe(old.bindings);
    expect(next.slots[0]).toBe(snapshot);
    expect(old.slots[0]).toBe(accepted.get(a)?.snapshot);
  });

  it('shares singleton rows and detaches additional GPU material classes from the CPU layout', () => {
    const owner = new MaterialRelations();
    const index = new MaterialBindingIndex();
    const rows = Array.from({ length: 256 }, (_, id) => row(id, Object.freeze([a])));
    const first = capture(owner, rows);
    const cpu = index.build([first], [], accepted, rows);
    expect(cpu.slotIndices.at(255)).toBe(cpu.slotIndices.at(0));
    const gpu = buildDispatchPlan(
      { meshSsboState: { meshSlotCount: 512, materialSlotCount: 8 } } as never,
      rows,
      [],
      [],
      [],
      undefined,
      false,
      { bindings: [{ material: a, resourceClass: 'extra' }], sourceScope: scope, frame: accepted },
      undefined,
      true,
      { owner: index, renderables: rows, rows: [first] },
    );
    expect(gpu.materialBindingSlots.get(a)?.get('extra')).toBe(1);
    expect(cpu.bindingSlots.get(a)?.has('extra')).toBe(false);
    expect(cpu.bindings).toHaveLength(1);
    expect(cpu.slots).toHaveLength(1);
    expect(gpu.materialBindings[0]).toBe(cpu.bindings[0]);
    const moved = rows.map((entry, i) => ({
      ...entry,
      source: { ...entry.source, entityKey: i + 1 },
    }));
    const next = index.build([capture(owner, moved)], [], accepted, moved);
    expect(next.bindingSlots).toBe(cpu.bindingSlots);
    expect(next.bindings[0]?.entityKey).toBe(1);
    expect(cpu.bindings[0]?.entityKey).toBe(0);
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
    const shadowRow = { ...row(2, ab), world: { identity: 'shadow' } as RenderResourceScope };
    const shadow = [shadowRow];
    const mainFrame = capture(owner, main);
    const table = index.build([mainFrame], shadow, accepted, main);
    expectOrdinary(table, [...main, ...shadow]);
    const shifted = [{ ...shadowRow, world: scope }];
    const current = index.build([mainFrame], shifted, accepted, main);
    expectOrdinary(current, [...main, ...shifted]);
    expect(current.bindings[0]).toBe(table.bindings[0]);
    expect(current.bindings[1]).not.toBe(table.bindings[1]);
    expect(table.bindings[1]?.world).toBe(shadow[0]?.world);
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

  it('reconciles moving rows against sealed bindings through mutation, sprite selection and entity replacement', () => {
    const owner = new MaterialRelations();
    const authored = [a, b];
    const moving = row(7, authored);
    const first = capture(owner, [moving]);
    const move = (frame: MaterialFrame, value: ValidatedRenderable) => {
      owner.begin(frame);
      owner.move(0, value);
      return owner.finish(1);
    };
    authored[1] = c;
    const changed = move(accepted, moving);
    expect(first.at(0)).toEqual([a, b]);
    expect(changed.at(0)).toEqual([a, c]);
    const sprite = accepted.with(a, 1, {
      ...a.snapshot,
      passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' } }],
    });
    const one = move(sprite, moving);
    expect(one.at(0)).toEqual([a]);
    expect(move(sprite, row(8, authored))).not.toBe(one);
    expect(move(accepted, moving).at(0)).toEqual([a, c]);
    owner.begin(new MaterialFrame(undefined));
    expect(() => owner.move(0, moving)).toThrow();
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
  const shared = { bindings: [], sourceScope: scope, frame: accepted };
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
    ['0', 'probe:0'],
    ['1', 'probe:1'],
  ]);
  const plan = buildDispatchPlan(
    internals,
    rows,
    [],
    [],
    [],
    classes,
    false,
    { bindings: [], sourceScope: scope, frame: accepted },
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
    { bindings: [], sourceScope: scope, frame: borrowed },
    undefined,
    true,
    retained,
  );
  expect(plan.materialSlotIndices.at(0)).toEqual([0]);
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(index.work.rebuilt).toBe(0);
});
