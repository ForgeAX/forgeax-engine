import { assert, expect, test, vi } from 'vitest';
import type { RenderableSnapshot } from '../render-system-extract';
import { setSceneRow } from '../scene/__tests__/scene-row-writes';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { SceneRows } from '../scene/scene-rows';
import { RowViews, SceneSlotFrame, SceneSlots } from '../scene/scene-slots';

function record(slot: number, generation = 0): RenderSceneSlot {
  return {
    slot,
    generation,
    version: 0,
    worldId: 0,
    entityKey: slot + generation * 100000,
    snapshot: { entityKey: slot, worldId: 0 } as RenderableSnapshot,
  };
}

test('keeps returned rows and matrix windows fixed across repeated pending writes and address reuse', () => {
  const slots = new SceneSlots();
  const first = setSceneRow(slots, 0, record(0));
  assert(first);
  const firstPose = first.snapshot.transform.world;
  const pose = new Float32Array(16);
  pose[12] = 17;
  const second = slots.writePose(0, pose);
  const secondPose = second.snapshot.transform.world;
  expect(firstPose[12]).toBe(0);
  pose[12] = 31;
  slots.writePose(0, pose);
  expect(secondPose[12]).toBe(17);
  const captured = slots.capture();
  expect(captured.slotAt(0)?.snapshot.transform.world[12]).toBe(31);
  expect(first.snapshot.transform.world).toBe(firstPose);
  expect(second.snapshot.transform.world).toBe(secondPose);
  slots.remove(0);
  const replacement = setSceneRow(slots, 0, record(0, 1));
  assert(replacement);
  const replacementPose = replacement.snapshot.transform.world;
  slots.remove(0);
  const next = setSceneRow(slots, 0, record(0, 2));
  assert(next);
  pose[12] = 53;
  slots.writePose(0, pose);
  expect(replacementPose[12]).toBe(0);
  expect(captured.slotAt(0)?.snapshot.transform.world[12]).toBe(31);
  expect(firstPose[12]).toBe(0);
  expect(secondPose[12]).toBe(17);
});

test('cycling pose edits keep current row observations within a bounded matrix backing budget', () => {
  const slots = new SceneSlots();
  const pose = new Float32Array(16);
  for (let slot = 0; slot < 64; slot++) setSceneRow(slots, slot, record(slot));
  const old = slots.capture();
  const held = old.slotAt(0)?.snapshot.transform.world;
  const retainedBytes = () => {
    const buffers = new Set<ArrayBufferLike>();
    for (const row of slots.capture()) buffers.add(row.snapshot.transform.world.buffer);
    return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  };
  expect(retainedBytes()).toBe(64 * 16 * 4);
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let slot = 0; slot < 64; slot++) {
      pose[12] = cycle * 64 + slot + 1;
      slots.writePose(slot, pose);
      slots.capture();
    }
    expect(retainedBytes()).toBeLessThanOrEqual(8 * 64 * 16 * 4);
  }
  expect(held?.[12]).toBe(0);
  for (let slot = 0; slot < 64; slot++)
    expect(slots.capture().slotAt(slot)?.snapshot.transform.world[12]).toBe(19 * 64 + slot + 1);
});

test('removal drops cached row references from the current page while preserving held roots', () => {
  const slots = new SceneSlots();
  setSceneRow(slots, 0, record(0));
  setSceneRow(slots, 1, record(1));
  const before = slots.capture();
  const held = before.slotAt(0);
  // Inspect the retaining edge directly; collection scheduling is not a memory contract.
  const owner = Reflect.get(slots, 'views') as RowViews;
  const cache = Reflect.get(owner, 'pages') as WeakMap<object, (RenderSceneSlot | undefined)[]>;
  slots.remove(0);
  const current = slots.capture();
  const page = current.pageAt(0);
  assert(page);
  expect(cache.get(page)?.[0]).toBeUndefined();
  expect(current.slotAt(0)).toBeUndefined();
  expect(current.slotAt(1)).toBe(before.slotAt(1));
  expect(before.slotAt(0)).toBe(held);
});

test('pose writes share cold identity/content columns and copy them only for actual content changes', () => {
  const slots = new SceneSlots();
  for (let slot = 0; slot < 64; slot++) setSceneRow(slots, slot, record(slot));
  const before = slots.capture();
  const oldPage = before.pageAt(0);
  assert(oldPage);
  const pose = new Float32Array(16);
  pose[12] = 17;
  slots.writePose(0, pose);
  const moved = slots.capture();
  const page = moved.pageAt(0);
  assert(page);
  expect(page.contents).toBe(oldPage.contents);
  expect(page.ids).toBe(oldPage.ids);
  expect(page.poses).not.toBe(oldPage.poses);
  expect(page.poses[0]).not.toBe(oldPage.poses[0]);
  for (let chunk = 1; chunk < page.poses.length; chunk++)
    expect(page.poses[chunk]).toBe(oldPage.poses[chunk]);
  expect(slots.inspect().estimatedCopiedPagePointerBytes).toBe(64 * 8 + 8 * 8 + 8 * 16 * 4);
  pose[12] = 31;
  slots.writePose(1, pose);
  setSceneRow(slots, 2, record(2, 1));
  const content = slots.capture().pageAt(0);
  expect(content?.contents).not.toBe(page.contents);
  expect(content?.ids).not.toBe(page.ids);
  expect(moved.slotAt(1)?.snapshot.transform.world[12]).toBe(0);
  expect(moved.slotAt(2)?.generation).toBe(0);
  expect(before.slotAt(0)?.snapshot.transform.world[12]).toBe(0);
});

test('coalesces known writes per page and preserves captured roots through deletion/reuse', () => {
  const slots = new SceneSlots();
  for (let slot = 0; slot < 1000; slot++) setSceneRow(slots, slot, record(slot));
  const before = slots.capture();
  expect(slots.capture()).toBe(before);
  expect(before.length).toBe(1000);
  expect(slots.inspect()).toMatchObject({ newPages: 16, copiedPages: 0 });
  for (let slot = 128; slot < 192; slot++) setSceneRow(slots, slot, record(slot, 1));
  const changed = slots.capture();
  expect(slots.inspect()).toMatchObject({ newPages: 16, copiedPages: 1 });
  expect(changed.pageAt(0)).toBe(before.pageAt(0));
  expect(changed.pageAt(2)).not.toBe(before.pageAt(2));
  expect(changed.slotAt(130)?.generation).toBe(1);
  expect(before.slotAt(130)?.generation).toBe(0);
  setSceneRow(slots, 130, undefined);
  const removed = slots.capture();
  expect(removed.slotAt(130)).toBeUndefined();
  expect(removed.slotAt(131)).toBe(changed.slotAt(131));
  expect(removed.indexOfSlot(131)).toBe(130);
  setSceneRow(slots, 130, record(130, 2));
  const reused = slots.capture();
  expect(reused.slotAt(130)?.generation).toBe(2);
  expect(before.slotAt(130)?.generation).toBe(0);
  expect(changed.slotAt(130)?.generation).toBe(1);
  expect(removed.slotAt(130)).toBeUndefined();
  expect(reused.at(-1)?.slot).toBe(999);
  expect(reused.at(Number.NaN)?.slot).toBe(0);
  expect(reused.slice(2.8, 5.9).map((row) => row.slot)).toEqual([2, 3, 4]);
});

test('randomized fragmented roots agree with current membership and retain old input', () => {
  const slots = new SceneSlots(),
    model = new Map<number, RenderSceneSlot>();
  let seed = 0x5ab1e;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const saved: { frame: ReturnType<SceneSlots['capture']>; rows: RenderSceneSlot[] }[] = [];
  for (let iteration = 0; iteration < 2000; iteration++) {
    const key = random() % 10000;
    const value = setSceneRow(slots, key, random() % 4 === 0 ? undefined : record(key, iteration));
    if (value === undefined) model.delete(key);
    else model.set(key, value);
    expect(slots.get(key)).toBe(value);
    if (iteration % 17 !== 0) continue;
    const frame = slots.capture(),
      rows = [...model.values()].sort((a, b) => a.slot - b.slot);
    expect([...frame]).toEqual(rows);
    expect(frame.length).toBe(rows.length);
    expect(slots.size).toBe(rows.length);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      assert(row);
      expect(frame.at(index)).toBe(row);
      expect(frame.indexOfSlot(row.slot)).toBe(index);
    }
    if (iteration % 85 === 0) saved.push({ frame, rows });
  }
  for (const { frame, rows } of saved) expect([...frame]).toEqual(rows);
  for (const key of model.keys()) setSceneRow(slots, key, undefined);
  const empty = slots.capture();
  expect(empty.length).toBe(0);
  expect(empty.root).toBeUndefined();
  expect(slots.size).toBe(0);
  expect(slots.capacity).toBeGreaterThan(0);
});

test('quiet publication reads keep row identity without rebuilding a per-row map', () => {
  const rows = new SceneRows();
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  rows.apply(
    Array.from({ length: 1000 }, (_, entityKey) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey,
      snapshot: { worldId: 0, entityKey, transform: { world: pose } } as RenderableSnapshot,
    })),
  );
  const frame = rows.capture();
  const original = [...frame];
  const register = vi.spyOn(Map.prototype, 'set');
  try {
    for (let repeat = 0; repeat < 4; repeat++) {
      rows.apply([]);
      for (const row of rows.capture()) expect(row).toBe(original[row.slot]);
    }
    expect(register).not.toHaveBeenCalled();
  } finally {
    register.mockRestore();
    rows.dispose();
  }
});

test('resolves a captured page once across adjacent reads and keeps cached misses historical', () => {
  const slots = new SceneSlots();
  for (let slot = 0; slot < 2048; slot++) setSceneRow(slots, slot, record(slot));
  const original = slots.capture();
  assert(original.root);
  let rootReads = 0;
  const root = new Proxy(original.root, {
    get(target, key, receiver) {
      if (key === 'key') rootReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const frame = new SceneSlotFrame(root, original.capacity);
  for (let slot = 0; slot < 64; slot++) expect(frame.slotAt(slot)?.entityKey).toBe(slot);
  expect(rootReads).toBeLessThanOrEqual(2);

  const missing = 77 * 64;
  rootReads = 0;
  for (let read = 0; read < 64; read++) expect(frame.slotAt(missing)).toBeUndefined();
  expect(rootReads).toBeLessThanOrEqual(2);
  setSceneRow(slots, missing, record(missing, 2));
  setSceneRow(slots, 1, undefined);
  const changed = slots.capture();
  expect(changed.slotAt(missing)?.generation).toBe(2);
  expect(changed.slotAt(1)).toBeUndefined();
  expect(frame.slotAt(missing)).toBeUndefined();
  expect(frame.slotAt(1)?.generation).toBe(0);
  setSceneRow(slots, 1, record(1, 3));
  const reused = slots.capture();
  expect(reused.slotAt(1)?.generation).toBe(3);
  expect(changed.slotAt(1)).toBeUndefined();
  expect(frame.slotAt(1)?.generation).toBe(0);
});

test('unchanged transform columns do not hydrate rows or stage per-identity work', () => {
  const rows = new SceneRows();
  const pose = new Float32Array(16);
  pose[0] = pose[5] = pose[10] = pose[15] = 1;
  const entities = Uint32Array.from({ length: 128 }, (_, index) => index);
  const worlds = new Float32Array(entities.length * 16);
  const operations = Array.from(entities, (entityKey) => {
    worlds.set(pose, entityKey * 16);
    return {
      kind: 'update' as const,
      worldId: 0,
      entityKey,
      snapshot: {
        worldId: 0,
        entityKey,
        transform: { world: pose },
      } as RenderableSnapshot,
    };
  });
  rows.apply(operations, [], true);
  const before = rows.capture();
  const read = vi.spyOn(RowViews.prototype, 'read');
  try {
    const unchanged = rows.apply([], [{ worldId: 0, entities, worlds }], true);
    expect(unchanged.updated).toBe(0);
    expect(unchanged.ignoredLateUpdates).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(rows.capture()).toBe(before);
    const old = before.slotAt(64);
    read.mockClear();
    worlds[64 * 16 + 12] = 7;
    const changed = rows.apply([], [{ worldId: 0, entities, worlds }], true);
    expect(changed.updated).toBe(1);
    expect(changed.updatedSlots[0]?.entityKey).toBe(64);
    expect(changed.contentUpdatedSlots).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(old?.snapshot.transform.world[12]).toBe(0);
    expect(rows.capture().slotAt(64)?.snapshot.transform.world[12]).toBe(7);
  } finally {
    read.mockRestore();
    rows.dispose();
  }
});

test('numeric pose admission respects prior staged edits, selected offsets and late identities', () => {
  const rows = new SceneRows();
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const snapshot = { worldId: 0, entityKey: 5, transform: { world: pose } } as RenderableSnapshot;
  rows.apply([{ kind: 'update', worldId: 0, entityKey: 5, snapshot }], [], true);
  const old = rows.capture().slotAt(0);
  const moved = pose.slice();
  moved[12] = 9;
  const worlds = new Float32Array(48);
  worlds.set(moved, 0);
  worlds.set(pose, 16);
  worlds.set(moved, 32);
  const selected = [{ worldId: 0, entities: Uint32Array.of(5, 5, 999), worlds, rows: [1, 2] }];
  try {
    const staged = rows.apply(
      [{ kind: 'update', worldId: 0, entityKey: 5, world: moved }],
      selected,
      true,
    );
    expect(staged).toMatchObject({ updated: 1, ignoredLateUpdates: 1 });
    expect(staged.updatedSlots[0]?.snapshot.transform.world[12]).toBe(0);
    const repeated = rows.apply(
      [],
      [
        { worldId: 0, entities: Uint32Array.of(5), worlds: moved },
        { worldId: 0, entities: Uint32Array.of(5), worlds: pose },
      ],
      true,
    );
    expect(repeated.updated).toBe(1);
    expect(repeated.updatedSlots[0]?.snapshot.transform.world[12]).toBe(0);
    const recreated = rows.apply(
      [
        { kind: 'remove', worldId: 0, entityKey: 5 },
        {
          kind: 'update',
          worldId: 0,
          entityKey: 5,
          snapshot: { ...snapshot, transform: { world: moved } },
        },
      ],
      selected,
      true,
    );
    expect(recreated).toMatchObject({ recreated: 1, ignoredLateUpdates: 1 });
    expect(recreated.recreatedSlots[0]?.generation).toBe(1);
    expect(recreated.recreatedSlots[0]?.snapshot.transform.world[12]).toBe(0);
    expect(old?.snapshot.transform.world[12]).toBe(0);
  } finally {
    rows.dispose();
  }
});

test('numeric pose admission reports parity changes and preserves strict NaN comparisons', () => {
  const rows = new SceneRows();
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const snapshot = { worldId: 0, entityKey: 1, transform: { world: pose } } as RenderableSnapshot;
  rows.apply([{ kind: 'update', worldId: 0, entityKey: 1, snapshot }], [], true);
  const before = rows.capture();
  const mirrored = pose.slice();
  mirrored[0] = -1;
  const entities = Uint32Array.of(1);
  try {
    const parity = rows.apply([], [{ worldId: 0, entities, worlds: mirrored }], true);
    expect(parity.updated).toBe(1);
    expect(parity.contentUpdatedSlots).toHaveLength(1);
    expect(before.slotAt(0)?.snapshot.transform.world[0]).toBe(1);
    mirrored[0] = Number.NaN;
    rows.apply([], [{ worldId: 0, entities, worlds: mirrored }], true);
    expect(rows.apply([], [{ worldId: 0, entities, worlds: mirrored }], true).updated).toBe(1);
  } finally {
    rows.dispose();
  }
});

test('numeric pose admission consumes a borrowed source window once and leaves absent rows unread', () => {
  const rows = new SceneRows();
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  rows.apply(
    [
      {
        kind: 'update',
        worldId: 0,
        entityKey: 1,
        snapshot: {
          worldId: 0,
          entityKey: 1,
          transform: { world: pose },
        } as RenderableSnapshot,
      },
    ],
    [],
    true,
  );
  rows.capture();
  const moved = pose.slice();
  moved[12] = 9;
  let reads = 0;
  try {
    const changed = rows.apply(
      [],
      [
        {
          worldId: 0,
          entities: Uint32Array.of(1),
          get worlds() {
            reads++;
            return reads === 1 ? moved : pose;
          },
        },
      ],
      true,
    );
    expect(reads).toBe(1);
    expect(changed.updatedSlots[0]?.snapshot.transform.world[12]).toBe(9);
    const missing = rows.apply(
      [],
      [
        {
          worldId: 0,
          entities: Uint32Array.of(999),
          get worlds(): Float32Array {
            throw new Error('absent rows have no pose reader');
          },
        },
      ],
      true,
    );
    expect(missing.ignoredLateUpdates).toBe(1);
  } finally {
    rows.dispose();
  }
});
