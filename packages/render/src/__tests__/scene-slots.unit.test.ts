import { assert, expect, test, vi } from 'vitest';
import { sceneSnapshot, setSceneRow } from '../scene/__tests__/scene-row-writes';
import { type Node, nodes, put, replaceOrdered, treeKind } from '../scene/frame-tree';
import { slotPoseColumn } from '../scene/mesh-draw';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { SceneRows } from '../scene/scene-rows';
import { SceneSlotFrame, SceneSlotPage, SceneSlots } from '../scene/scene-slots';

function record(slot: number, generation = 0): RenderSceneSlot {
  return {
    slot,
    generation,
    version: 0,
    entityKey: slot + generation * 100000,
    snapshot: sceneSnapshot(slot, new Float32Array(16)),
  };
}

test('tracks active WaterMesh owners across replacement, removal, and clear', () => {
  const slots = new SceneSlots();
  const ordinary = record(0);
  const owner: RenderSceneSlot = {
    ...ordinary,
    snapshot: {
      ...ordinary.snapshot,
      waterMeshSource: {
        guid: 'water',
        generation: 1,
        worldIdentity: 'scene',
        zoneGuid: 'zone',
        zoneGeneration: 1,
        targetFormat: 'rgba16float',
        materialStartIndex: 0,
        views: [],
      },
    },
  };
  expect(slots.hasSource('waterMeshSource')).toBe(false);
  setSceneRow(slots, 0, owner);
  expect(slots.hasSource('waterMeshSource')).toBe(true);
  setSceneRow(slots, 0, ordinary);
  expect(slots.hasSource('waterMeshSource')).toBe(false);
  setSceneRow(slots, 0, owner);
  slots.remove(0);
  expect(slots.hasSource('waterMeshSource')).toBe(false);
  setSceneRow(slots, 0, owner);
  slots.clear();
  expect(slots.hasSource('waterMeshSource')).toBe(false);
});

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

test('an issued row keeps its original eight-row pose chunk before anyone asks for its matrix', () => {
  const slots = new SceneSlots();
  const slot = 13;
  const held = setSceneRow(slots, slot, record(slot));
  assert(held);
  const pose = new Float32Array(16);
  pose[12] = 31;
  const second = slots.writePose(slot, pose);
  pose[12] = 77;
  const third = slots.writePose(slot, pose);
  expect(held.snapshot.transform.world[12]).toBe(0);
  expect(second.snapshot.transform.world[12]).toBe(31);
  expect(third.snapshot.transform.world[12]).toBe(77);
  expect(second.snapshot.transform.world).toHaveLength(16);
  expect(second.snapshot.transform.world).toBe(second.snapshot.transform.world);
});

test('cycling pose edits keep current row observations within a bounded matrix backing budget', () => {
  const slots = new SceneSlots();
  const pose = new Float32Array(16);
  for (let slot = 0; slot < 64; slot++) setSceneRow(slots, slot, record(slot));
  const old = slots.capture();
  const held = old.slotAt(0)?.snapshot.transform.world;
  const retainedBytes = () => {
    const buffers = new Set<ArrayBufferLike>();
    for (const row of slots.capture()) buffers.add(slotPoseColumn(row).buffer);
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

test('eight edits at scattered addresses issue one packed pose backing and leave all prior frames readable', () => {
  const slots = new SceneSlots();
  const pose = new Float32Array(16);
  const addresses = Array.from({ length: 8 }, (_, index) => index * 64 + 5);
  for (const slot of addresses) setSceneRow(slots, slot, record(slot));
  const original = slots.capture();
  const held: Float32Array[] = [];
  for (let frame = 1; frame <= 16; frame++) {
    const columns = new Set<ArrayBufferLike>();
    for (const slot of addresses) {
      pose[12] = frame * 1024 + slot;
      const row = slots.writePose(slot, pose);
      const column = slotPoseColumn(row);
      columns.add(column.buffer);
      const matrix = row.snapshot.transform.world;
      expect(matrix.buffer).not.toBe(column.buffer);
      expect(matrix.buffer.byteLength).toBe(16 * Float32Array.BYTES_PER_ELEMENT);
      if (frame === 1) held.push(matrix);
    }
    expect(columns.size).toBe(1);
    expect([...columns][0]?.byteLength).toBe(8 * 16 * Float32Array.BYTES_PER_ELEMENT);
    const captured = slots.capture();
    for (const slot of addresses)
      expect(captured.slotAt(slot)?.snapshot.transform.world[12]).toBe(frame * 1024 + slot);
  }
  slots.clear();
  expect(held.map((matrix) => matrix[12])).toEqual(addresses.map((slot) => 1024 + slot));
  for (const slot of addresses) expect(original.slotAt(slot)?.snapshot.transform.world[12]).toBe(0);
});

test('dense admissions share native pages and retain a compact matrix across subsequent edits', () => {
  const rows = new SceneRows();
  const entities = Uint32Array.from({ length: 128 }, (_, index) => index + 1);
  const worlds = new Float32Array(entities.length * 16);
  rows.apply(
    Array.from(entities, (entityKey) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: sceneSnapshot(entityKey, new Float32Array(16)),
    })),
  );
  const before = rows.capture();
  const start = rows.inspectPages().posePageAllocations;
  for (let index = 0; index < entities.length; index++) worlds[index * 16 + 12] = index + 1;
  const first = rows.commitDistinctTransformSpans([{ worlds, entities }]);
  expect(first.updated).toBe(128);
  expect(rows.inspectPages().posePageAllocations - start).toBe(2);
  const heldRow = rows.capture().slotAt(65);
  assert(heldRow);
  const matrix = heldRow.snapshot.transform.world;
  expect(matrix.buffer.byteLength).toBe(16 * 4);
  expect(matrix[12]).toBe(66);
  expect(before.slotAt(65)?.snapshot.transform.world[12]).toBe(0);
  expect(first.previous.size).toBe(0);

  for (let index = 0; index < entities.length; index++) worlds[index * 16 + 12] = 129 + index;
  rows.commitDistinctTransformSpans([{ worlds, entities }]);
  expect(rows.capture().slotAt(65)?.snapshot.transform.world[12]).toBe(194);
  expect(heldRow.snapshot.transform.world).toBe(matrix);
  expect(matrix[12]).toBe(66);
  expect(before.slotAt(65)?.snapshot.transform.world[12]).toBe(0);
});

test('one ordered replacement copies only the union of dirty paths', () => {
  const Base = treeKind();
  let allocated = 0;
  class Counted<T> extends Base<T> {
    constructor(
      value: T,
      queue: number,
      key: number,
      weight: number,
      left?: Node<T>,
      right?: Node<T>,
    ) {
      super(value, queue, key, weight, left, right);
      allocated++;
    }
  }
  let root: Node<number> | undefined;
  for (let key = 0; key < 128; key++) root = put(root, 1, 0, key, 1, Counted);
  const keys = Float64Array.from({ length: 64 }, (_, i) => i * 2);
  const replacements = new Map(Array.from(keys, (key) => [key, 2]));
  allocated = 0;
  let individual = root;
  for (const key of keys) individual = put(individual, 2, 0, key, 2);
  const individualCount = allocated;
  allocated = 0;
  const batch = replaceOrdered(root, keys, 0, keys.length, replacements, (value) => value);
  expect(allocated).toBeLessThan(individualCount / 2);
  expect(batch?.count).toBe(192);
  expect(root?.count).toBe(128);
  const baselineNodes = Array.from(nodes(root));
  const publishedNodes = Array.from(nodes(batch));
  const controlNodes = Array.from(nodes(individual));
  expect(publishedNodes.map(({ key, value }) => [key, value])).toEqual(
    controlNodes.map(({ key, value }) => [key, value]),
  );
  expect(publishedNodes.filter((node, i) => node !== baselineNodes[i])).toHaveLength(allocated);
});

test('publishes shuffled moved pages alongside insertion and removal without changing retained rows', () => {
  const slots = new SceneSlots();
  for (let page = 0; page < 24; page++) setSceneRow(slots, page * 64, record(page * 64));
  const previous = slots.capture();
  const pose = new Float32Array(16);
  for (let page = 22; page >= 0; page -= 2) {
    pose[12] = page + 1;
    slots.writePose(page * 64, pose);
  }
  slots.remove(23 * 64);
  setSceneRow(slots, 100 * 64, record(100 * 64));
  const next = slots.capture();
  expect(next.length).toBe(previous.length);
  expect(next.at(-1)?.slot).toBe(100 * 64);
  expect(next.slotAt(23 * 64)).toBeUndefined();
  expect(next.slotAt(7 * 64)).toBe(previous.slotAt(7 * 64));
  expect(next.slotAt(22 * 64)?.snapshot.transform.world[12]).toBe(23);
  expect(previous.slotAt(22 * 64)?.snapshot.transform.world[12]).toBe(0);
  expect(previous.slotAt(23 * 64)?.slot).toBe(23 * 64);
  const touched: number[] = [];
  expect(next.visitChangedVersions(previous, (slot) => touched.push(slot))).toBe(true);
  expect(touched).toEqual([
    ...Array.from({ length: 12 }, (_, i) => (22 - 2 * i) * 64),
    23 * 64,
    100 * 64,
  ]);
  const reserved = slots.inspect();
  expect(reserved.replacementKeyBackingBytes).toBeGreaterThanOrEqual(12 * 8);
  expect(reserved.pendingPageCapacity).toBeGreaterThanOrEqual(24);
  expect(reserved.pendingPageGrowths).toBeGreaterThan(0);
  for (let frame = 1; frame <= 48; frame++) {
    for (let i = 0; i < 12; i++) {
      const page = ((i * 7 + frame) % 12) * 2;
      pose[12] = 1000 * frame + page;
      slots.writePose(page * 64, pose);
    }
    const published = slots.capture();
    expect(published.slotAt(22 * 64)?.snapshot.transform.world[12]).toBe(1000 * frame + 22);
  }
  expect(slots.inspect().replacementKeyAllocations).toBe(reserved.replacementKeyAllocations);
  expect(slots.inspect().replacementKeyBackingBytes).toBe(reserved.replacementKeyBackingBytes);
  expect(slots.inspect()).toMatchObject({
    pendingPageCapacity: reserved.pendingPageCapacity,
    pendingPageGrowths: reserved.pendingPageGrowths,
  });
  for (const row of slots.capture()) slots.remove(row.slot);
  expect(slots.capture()).toHaveLength(0);
  expect(slots.inspect().pendingPageCapacity).toBe(0);
  expect(previous.slotAt(22 * 64)?.snapshot.transform.world[12]).toBe(0);
});

test('removal drops the issued row from the current page while preserving held roots', () => {
  const slots = new SceneSlots();
  setSceneRow(slots, 0, record(0));
  setSceneRow(slots, 1, record(1));
  const before = slots.capture();
  const held = before.slotAt(0);
  // Inspect the retaining edge directly; collection scheduling is not a memory contract.
  slots.remove(0);
  const current = slots.capture();
  const page = current.pageAt(0);
  assert(page);
  expect(page.rows[0]).toBeUndefined();
  expect(page.contents[0]).toBeUndefined();
  expect(current.slotAt(0)).toBeUndefined();
  expect(current.slotAt(1)).toBe(before.slotAt(1));
  expect(before.slotAt(0)).toBe(held);
});

test('pose and content edits replace only their issued rows and share all other rows with the held page', () => {
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
  expect(page.rows).not.toBe(oldPage.rows);
  expect(page.rows[0]).not.toBe(oldPage.rows[0]);
  expect(page.contents).toBe(oldPage.contents);
  expect(page.entities).toBe(oldPage.entities);
  expect(page.rows[0]?.content).toBe(oldPage.rows[0]?.content);
  for (let lane = 1; lane < page.rows.length; lane++)
    expect(page.rows[lane]).toBe(oldPage.rows[lane]);
  expect(slots.inspect().estimatedCopiedPagePointerBytes).toBe(64 * 8);
  pose[12] = 31;
  slots.writePose(1, pose);
  setSceneRow(slots, 2, record(2, 1));
  const content = slots.capture().pageAt(0);
  assert(content);
  for (let lane = 0; lane < page.rows.length; lane++) {
    if (lane === 1 || lane === 2) expect(content.rows[lane]).not.toBe(page.rows[lane]);
    else expect(content.rows[lane]).toBe(page.rows[lane]);
  }
  expect(content.contents).not.toBe(page.contents);
  expect(content.entities).not.toBe(page.entities);
  expect(slots.inspect().estimatedCopiedPagePointerBytes).toBe(2 * 64 * 8 + 64 * 16);
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
      entityKey,
      snapshot: sceneSnapshot(entityKey, pose),
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
      entityKey,
      snapshot: sceneSnapshot(entityKey, pose),
    };
  });
  rows.apply(operations, [], true);
  const before = rows.capture();
  const read = vi.spyOn(SceneSlotPage.prototype, 'read');
  try {
    const unchanged = rows.apply([], [{ entities, worlds }], true);
    expect(unchanged.updated).toBe(0);
    expect(unchanged.ignoredLateUpdates).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(rows.capture()).toBe(before);
    const old = before.slotAt(64);
    read.mockClear();
    worlds[64 * 16 + 12] = 7;
    const changed = rows.apply([], [{ entities, worlds }], true);
    expect(changed.updated).toBe(1);
    expect(changed.contentUpdatedSlots).toHaveLength(0);
    // Admission and publication keep coordinates until an explicit row read.
    expect(read).not.toHaveBeenCalled();
    expect(changed.updatedSlots.at(0)?.entityKey).toBe(64);
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
  const snapshot = sceneSnapshot(5, pose);
  rows.apply([{ kind: 'update', entityKey: 5, snapshot }], [], true);
  const old = rows.capture().slotAt(0);
  const moved = pose.slice();
  moved[12] = 9;
  const worlds = new Float32Array(48);
  worlds.set(moved, 0);
  worlds.set(pose, 16);
  worlds.set(moved, 32);
  const selected = [{ entities: Uint32Array.of(5, 5, 999), worlds, rows: [1, 2] }];
  try {
    const staged = rows.apply([{ kind: 'update', entityKey: 5, world: moved }], selected, true);
    expect(staged).toMatchObject({ updated: 1, ignoredLateUpdates: 1 });
    expect(staged.updatedSlots.at(0)?.snapshot.transform.world[12]).toBe(0);
    const repeated = rows.apply(
      [],
      [
        { entities: Uint32Array.of(5), worlds: moved },
        { entities: Uint32Array.of(5), worlds: pose },
      ],
      true,
    );
    expect(repeated.updated).toBe(1);
    expect(repeated.updatedSlots.at(0)?.snapshot.transform.world[12]).toBe(0);
    const recreated = rows.apply(
      [
        { kind: 'remove', entityKey: 5 },
        {
          kind: 'update',
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
  const snapshot = sceneSnapshot(1, pose);
  rows.apply([{ kind: 'update', entityKey: 1, snapshot }], [], true);
  const before = rows.capture();
  const mirrored = pose.slice();
  mirrored[0] = -1;
  const entities = Uint32Array.of(1);
  try {
    const parity = rows.apply([], [{ entities, worlds: mirrored }], true);
    expect(parity.updated).toBe(1);
    expect(parity.contentUpdatedSlots).toHaveLength(1);
    expect(before.slotAt(0)?.snapshot.transform.world[0]).toBe(1);
    mirrored[0] = Number.NaN;
    rows.apply([], [{ entities, worlds: mirrored }], true);
    expect(rows.apply([], [{ entities, worlds: mirrored }], true).updated).toBe(1);
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
        entityKey: 1,
        snapshot: sceneSnapshot(1, pose),
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
    expect(changed.updatedSlots.at(0)?.snapshot.transform.world[12]).toBe(9);
    const missing = rows.apply(
      [],
      [
        {
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
