import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { CapturedSceneTransform, ScenePoseWriter } from '../captured-transform';
import { SceneDrawSlot, slotPoseColumn, slotPoseOffset } from '../mesh-draw';
import { RenderScene } from '../render-scene-view';
import { SceneRows, type WorldTransformSpan } from '../scene-rows';
import { PublishedPoseRows, SceneSlotPage, SceneSlots } from '../scene-slots';

function fixture(count = 128) {
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const entities = Uint32Array.from({ length: count }, (_, index) => index);
  const worlds = new Float32Array(count * 16);
  const rows = new SceneRows();
  rows.apply(
    [...entities].map((entityKey) => {
      worlds.set(pose, entityKey * 16);
      const snapshot: RenderableSnapshot = {
        entityKey,
        transform: { world: pose },
        material,
        materials: [material],
        materialBindingSources: ['engine-default'],
      };
      return { kind: 'update', entityKey, snapshot };
    }),
    [],
    true,
  );
  return { rows, entities, worlds };
}

it('keeps instance-only publications on their accepted pose storage', () => {
  const { rows, entities } = fixture(64);
  const first = rows.capture();
  const old = first.slotAt(0);
  assert(old);
  const inspected = old.snapshot.transform.world;
  const before = rows.inspectPages();
  const read = vi.spyOn(SceneDrawSlot.prototype, 'authoredSnapshot');
  const transforms = new Float32Array(16);
  try {
    for (let revision = 1; revision <= 32; revision++) {
      transforms[12] = revision;
      const changed = rows.apply(
        Array.from(entities, (entityKey) => ({
          kind: 'update' as const,
          entityKey,
          instances: { transforms, instanceCount: 1, cacheKey: entityKey, archVersion: revision },
        })),
      );
      expect(changed.updated).toBe(64);
      expect(changed.instanceUpdatedSlots).toEqual(changed.updatedSlots);
      expect(changed.previous.size).toBe(0);
      const current = changed.updatedSlots.at(0);
      assert(current);
      expect(slotPoseColumn(current)).toBe(slotPoseColumn(old));
      expect(slotPoseOffset(current)).toBe(slotPoseOffset(old));
    }
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
  const latest = rows.capture().slotAt(0);
  assert(latest);
  inspected[12] = 230;
  expect(latest.snapshot.transform.world[12]).toBe(0);
  expect(rows.inspectPages().posePageAllocations).toBe(before.posePageAllocations);
});

it('adopts captured columns while keeping detached numerical observations and borrowed input', () => {
  const { rows, worlds } = fixture(1);
  const authored = rows.lookup(0)?.snapshot;
  assert(authored);
  const writer = new ScenePoseWriter(1);
  const captured = writer.capture(worlds);
  const column = CapturedSceneTransform.column(captured);
  const admitted = rows.apply([
    { kind: 'update', entityKey: 1, snapshot: { ...authored, entityKey: 1, transform: captured } },
  ]).createdSlots[0];
  assert(admitted);
  expect(slotPoseColumn(admitted)).toBe(column);
  captured.world[12] = 45;
  worlds[12] = 78;
  expect(admitted.snapshot.transform.world[12]).toBe(0);
  const hold = rows.prepareRow({ ...authored, entityKey: 2, transform: { world: worlds } });
  const reserved = hold.row.snapshot.transform;
  const moved = CapturedSceneTransform.storage(reserved);
  worlds[12] = 100;
  reserved.world[12] = 90;
  const published = hold.publish().createdSlots[0];
  assert(published);
  expect(slotPoseColumn(published)).toBe(CapturedSceneTransform.column(moved));
  expect(published.snapshot.transform.world[12]).toBe(78);
});

it('matches ordinary merging for offsets, duplicates, parity, missing rows and held frames', () => {
  const actual = fixture();
  const oracle = fixture();
  const world = new World();
  const held = actual.rows.capture();
  const old = held.slotAt(2);
  assert(old);
  const first = actual.worlds.slice();
  first[2 * 16] = -1;
  first[2 * 16 + 12] = 9;
  first[65 * 16 + 12] = 3;
  const last = actual.worlds.slice();
  last[65 * 16 + 12] = 7;
  const spans: WorldTransformSpan[] = [
    {
      entities: actual.entities,
      worlds: first,
      rows: [...Array<number>(65).fill(2), 65, 2],
    },
    { entities: actual.entities, worlds: last, rows: [2, 65] },
    { entities: Uint32Array.of(999, 999), worlds: new Float32Array(32) },
  ];
  const result = actual.rows.apply([], spans, true, world);
  const expected = oracle.rows.apply([], spans, true);
  expect(result.updated).toBe(expected.updated);
  expect(result.ignoredLateUpdates).toBe(2);
  expect(result.updatedSlots.map((row) => row.entityKey)).toEqual([2, 65]);
  expect(result.contentUpdatedSlots.map((row) => row.entityKey)).toEqual([2]);
  expect(result.updatedSlots.map((row) => [...row.snapshot.transform.world])).toEqual(
    expected.updatedSlots.map((row) => [...row.snapshot.transform.world]),
  );
  expect([...old.snapshot.transform.world]).toEqual([...last.subarray(32, 48)]);
  const after = actual.rows.capture();
  first.fill(23);
  last.fill(31);
  expect(after.slotAt(65)?.snapshot.transform.world[12]).toBe(7);
  const updated = result.updatedSlots.at(0);
  assert(updated);
  expect(held.slotAt(updated.slot)).toBe(old);
  expect(result.previous.size).toBe(0);
  expect(world.memoryStats().arena.active).toBe(false);
});

it('publishes disjoint local presentation runs with previous poses and exact winding changes', () => {
  const initial = fixture(192);
  const local = new RenderScene();
  local.apply(
    [...initial.entities].map((entityKey) => ({
      kind: 'update',
      entityKey,
      snapshot: initial.rows.lookup(entityKey)?.snapshot as RenderableSnapshot,
    })),
  );
  const held = local.slot(64);
  const spans = [
    { entities: initial.entities.subarray(64), worlds: initial.worlds.subarray(64 * 16) },
    { entities: initial.entities.subarray(0, 64), worlds: initial.worlds.subarray(0, 64 * 16) },
    { entities: Uint32Array.of(999), worlds: new Float32Array(16) },
  ];
  for (const entity of initial.entities) {
    if (entity % 3 !== 0) initial.worlds[entity * 16 + 12] = 2;
    if (entity % 17 === 0) initial.worlds[entity * 16] = -1;
  }
  const direct = local.applyPresentationSpans(spans);
  const merged = initial.rows.apply([], spans, true);
  expect(direct.updatedSlots.map((row) => row.entityKey)).toEqual(
    merged.updatedSlots.map((row) => row.entityKey),
  );
  expect(direct.contentUpdatedSlots.map((row) => row.entityKey)).toEqual(
    merged.contentUpdatedSlots.map((row) => row.entityKey),
  );
  expect(direct.ignoredLateUpdates).toBe(1);
  const moved = local.slot(64);
  assert(moved);
  expect(held?.slot).toBe(moved.slot);
  expect(held?.snapshot.transform.world[12]).toBe(0);
  expect(direct.previous.size).toBe(0);
  expect(local.applyPresentationSpans(spans).updated).toBe(0);
  initial.worlds.fill(9);
  expect(local.slot(64)?.snapshot.transform.world[12]).toBe(2);
  expect(held?.snapshot.transform.world[12]).toBe(0);
});

it('writes scattered poses in source order and leaves prior poses in the held root', () => {
  const { rows, worlds, entities } = fixture();
  const held = rows.capture();
  const order = Array.from(entities, (entity) => (entity * 47) % entities.length);
  for (const entity of entities) worlds[entity * 16 + 12] = 7;
  const result = rows.apply([], [{ entities, worlds, rows: order }], true, new World());
  expect(result.updatedSlots.map((row) => row.slot)).toEqual(order);
  expect(result.previous.size).toBe(0);
  const accepted = rows.capture();
  const priorRows = order.map((slot) => held.slotAt(slot));
  worlds.fill(0);
  rows.apply([], [{ entities, worlds }], true, new World());
  result.updatedSlots.forEach((row, index) => {
    const before = held.slotAt(row.slot);
    expect(before).toBe(priorRows[index]);
    expect(before?.snapshot.transform.world[12]).toBe(0);
    expect(accepted.slotAt(row.slot)).toBe(row);
    expect(row.snapshot.transform.world[12]).toBe(7);
  });
});

it('keeps the issued pose order when a reader outlives the row journal', () => {
  const { rows, entities, worlds } = fixture(32);
  const order = [20, 3, 29, 0];
  for (const entity of entities) worlds[entity * 16 + 12] = entity + 1;
  const delta = rows.commitDistinctTransformSpans([{ entities, worlds, rows: order }]);
  const issued = rows.capture();
  expect(delta.updatedSlots.length).toBe(order.length);
  expect(Array.isArray(delta.updatedSlots)).toBe(false);
  const observed: number[] = [];
  delta.updatedSlots.forEach((row, index) => {
    if (index === 0) {
      const span = [{ entities, worlds }];
      for (let frame = 1; frame <= 40; frame++) {
        for (const entity of entities) worlds[entity * 16 + 12] = frame * 100 + entity;
        rows.commitDistinctTransformSpans(span);
      }
      expect(rows.capture().slotAt(0)?.snapshot.transform.world[12]).toBe(4000);
    }
    expect(row).toBe(issued.slotAt(order[index] as number));
    observed.push(row.snapshot.transform.world[12] as number);
  });
  expect(observed).toEqual([21, 4, 30, 1]);
  expect(delta.updatedSlots.at(-1)).toBe(issued.slotAt(0));
  rows.reconcile([]);
  expect(delta.updatedSlots.map((row) => row.entityKey)).toEqual(order);
});

it('consumes accepted pose versions as numbers until a row is requested', () => {
  const { rows, entities, worlds } = fixture(128);
  const read = vi.spyOn(SceneSlotPage.prototype, 'read');
  try {
    const initial = rows.capture();
    const order = [1, 63, 65, 127];
    for (const slot of order) worlds[slot * 16 + 12] = slot + 1;
    const delta = rows.commitDistinctTransformSpans([{ entities, worlds, rows: order }]);
    assert(delta.updatedSlots instanceof PublishedPoseRows);
    const held = rows.capture();
    const versions = order.map((slot) => held.versionAt(slot));
    const values: number[] = [];
    delta.updatedSlots.visitWrites(vi.fn(), (slot, version, _content, column, offset, ordinal) => {
      expect(slot).toBe(order[ordinal]);
      expect(version).toBe(versions[ordinal]);
      expect(version).toBeGreaterThan(initial.versionAt(slot));
      values.push(column[offset + 12] as number);
    });
    expect(values).toEqual([2, 64, 66, 128]);
    worlds[16 + 12] = 5;
    rows.commitDistinctTransformSpans([{ entities, worlds, rows: [1] }]);
    const current = rows.capture();
    expect(read).not.toHaveBeenCalled();

    // Adjacent captures share the same revision even when neither has observed it yet.
    const fromRank = held.at(65);
    expect(fromRank?.slot).toBe(65);
    expect(fromRank).toBe(current.slotAt(65));
    expect(current.slotAt(63)).toBe(held.slotAt(63));
    expect(held.slotAt(1)?.snapshot.transform.world[12]).toBe(2);
    expect(current.slotAt(1)?.snapshot.transform.world[12]).toBe(5);
  } finally {
    read.mockRestore();
  }
});

it('keeps independent pose edits numeric while a material-facing row changes in the same commit', () => {
  const { rows, entities, worlds } = fixture(128);
  const row = rows.capture().slotAt(64);
  assert(row);
  const snapshot = row.snapshot;
  const order = [65, 64, 1, 127];
  let first: PublishedPoseRows | undefined;
  const read = vi.spyOn(SceneSlotPage.prototype, 'read');
  try {
    for (let round = 1; round <= 60; round++) {
      for (const slot of order) worlds[slot * 16 + 12] = round * 128 + slot;
      const delta = rows.apply(
        [
          {
            kind: 'update',
            entityKey: 64,
            snapshot: { ...snapshot, authorVisible: round % 2 === 0 },
          },
        ],
        [{ entities, worlds, rows: order }],
        true,
      );
      const updated = delta.updatedSlots;
      assert(updated instanceof PublishedPoseRows);
      first ??= updated;
      expect(delta.updated).toBe(4);
      expect(delta.contentUpdatedSlots).toEqual([updated.at(0)]);
      read.mockClear();
      const actual: number[] = [];
      updated.visitWrites(
        (row, ordinal) => {
          expect(ordinal).toBe(0);
          expect(row.slot).toBe(64);
          actual.push(row.snapshot.transform.world[12] as number);
        },
        (slot, _version, _content, column, offset, ordinal) => {
          expect(ordinal).toBe(actual.length);
          expect(slot).toBe([64, 65, 1, 127][ordinal]);
          actual.push(column[offset + 12] as number);
        },
      );
      expect(actual).toEqual([64, 65, 1, 127].map((slot) => round * 128 + slot));
      expect(read).not.toHaveBeenCalled();
    }
    // Hold the initial mixed publication beyond the live journal's retention.
    for (let round = 61; round < 82; round++) {
      for (const entity of entities) worlds[entity * 16 + 12] = round * 128 + entity;
      rows.commitDistinctTransformSpans([{ entities, worlds }]);
    }
    expect(first?.map((row) => row.slot)).toEqual([64, 65, 1, 127]);
    expect(first?.at(-1)?.snapshot.transform.world[12]).toBe(255);
  } finally {
    read.mockRestore();
    rows.dispose();
  }
});

it('denies a later chunk before any write and retries a smaller update on the same healthy World', () => {
  const f = fixture();
  const world = new World({ memory: { arena: { maxScopeBytes: 1536 } } });
  const before = f.rows.capture();
  const revision = f.rows.revision;
  for (let row = 0; row < 65; row++) f.worlds[row * 16 + 12] = 8;
  f.worlds[0] = -1;
  expect(() =>
    f.rows.apply([], [{ entities: f.entities, worlds: f.worlds }], true, world),
  ).toThrow();
  expect(world.withFrameArena(() => ok(true)).unwrap()).toBe(true);
  expect(f.rows.capture()).toBe(before);
  expect(f.rows.revision).toBe(revision);
  expect(world.memoryStats().arena.active).toBe(false);
  const delta = f.rows.apply(
    [],
    [{ entities: f.entities, worlds: f.worlds, rows: [0, 64] }],
    true,
    world,
  );
  expect(delta.updated).toBe(2);
  expect(delta.updatedSlots.map((row) => row.snapshot.transform.world[12])).toEqual([8, 8]);
  expect(delta.contentUpdatedSlots.map((row) => row.slot)).toEqual([0]);
  expect(f.rows.capture().slotAt(1)?.snapshot.transform.world[12]).toBe(0);
});

it('reuses arena backing through twenty dense and smaller-demand cycles without retaining its windows', () => {
  const f = fixture(1024);
  const world = new World();
  let backing = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let row = 0; row < 1024; row++) f.worlds[row * 16 + 12] = cycle + 1;
    const delta = f.rows.apply([], [{ entities: f.entities, worlds: f.worlds }], true, world);
    expect(delta.updated).toBe(1024);
    const held = delta.updatedSlots.at(0);
    assert(held);
    if (cycle === 0) backing = world.memoryStats().arena.backingAllocations;
    expect(world.memoryStats().arena.backingAllocations).toBe(backing);
    f.worlds[12] = cycle + 101;
    f.rows.apply([], [{ entities: f.entities, worlds: f.worlds, rows: [0] }], true, world);
    expect(held.snapshot.transform.world[12]).toBe(cycle + 1);
    expect(world.memoryStats().arena.usedBytes).toBe(0);
  }
  const root = f.rows.capture();
  const requests = world.memoryStats().arena.requests;
  expect(f.rows.apply([], [{ entities: f.entities, worlds: f.worlds }], true, world).updated).toBe(
    0,
  );
  expect(f.rows.capture()).toBe(root);
  expect(world.memoryStats().arena.requests).toBe(requests);
});

it('rejects overlapping admission before overwriting shared staging and keeps ordinary retry valid', () => {
  const f = fixture();
  const world = new World();
  let attempts = 0;
  const spans: WorldTransformSpan[] = [
    {
      entities: f.entities,
      get worlds() {
        attempts++;
        expect(() =>
          f.rows.apply([], [{ entities: f.entities, worlds: f.worlds }], true, world),
        ).toThrow('reenter');
        return f.worlds;
      },
    },
  ];
  f.worlds[12] = 9;
  expect(f.rows.apply([], spans, true).updated).toBe(1);
  expect(attempts).toBe(128);
  f.worlds[12] = 11;
  expect(f.rows.apply([], [{ entities: f.entities, worlds: f.worlds }], true, world).updated).toBe(
    1,
  );
  expect(f.rows.capture().slotAt(0)?.snapshot.transform.world[12]).toBe(11);
});

it('preserves strict NaN changes and tiny admission without requesting arena capacity', () => {
  const f = fixture();
  const world = new World();
  f.worlds[12] = Number.NaN;
  const span = { entities: f.entities, worlds: f.worlds };
  expect(f.rows.apply([], [span], true, world).updated).toBe(1);
  expect(f.rows.apply([], [span], true, world).updated).toBe(1);
  const requests = world.memoryStats().arena.requests;
  f.worlds[16 + 12] = 3;
  expect(f.rows.apply([], [{ ...span, rows: [1] }], true, world).updated).toBe(1);
  expect(world.memoryStats().arena.requests).toBe(requests);
});

it('uses the source World arena for local view movement and reconciles overlapping row replacements', () => {
  const f = fixture(256),
    world = new World();
  const view = new RenderScene(f.rows, f.rows);
  const floor = world.memoryStats().arena.requests;
  for (let frame = 1; frame <= 100; frame++) {
    for (let i = 0; i < f.entities.length; i++) f.worlds[i * 16 + 12] = frame + i;
    const delta = view.apply([], [{ entities: f.entities, worlds: f.worlds }], world);
    expect(delta.updated).toBe(256);
    expect(delta.previous.size).toBe(0);
    expect(world.memoryStats().arena.usedBytes).toBe(0);
  }
  expect(world.memoryStats().arena.requests).toBeGreaterThan(floor);
  const held = view.slot(7);
  assert(held);
  const replacement = { ...held.snapshot, assetHandle: 17 };
  f.worlds[7 * 16 + 12] = 45;
  view.apply(
    [{ kind: 'update', entityKey: 7, snapshot: replacement }],
    [{ entities: f.entities, worlds: f.worlds, rows: [7] }],
    world,
  );
  expect(view.slot(7)?.snapshot.assetHandle).toBe(17);
  expect(view.slot(7)?.snapshot.transform.world[12]).toBe(45);
  expect(held.snapshot.transform.world[12]).toBe(107);
});

it('routes a mixed pose span only to live or newly admitted draws', () => {
  const f = fixture(2);
  const original = f.rows.lookup(0);
  assert(original);
  const entities = Uint32Array.from([4001, 4002, 0, 1, 2, 4001]);
  const worlds = new Float32Array(entities.length * 16);
  for (let i = 0; i < entities.length; i++) {
    worlds.set(original.snapshot.transform.world, i * 16);
    worlds[i * 16 + 12] = i + 1;
  }
  const locate = vi.spyOn(SceneSlots.prototype, 'slotOf');
  try {
    const delta = f.rows.apply(
      [
        { kind: 'remove', entityKey: 1 },
        { kind: 'update', entityKey: 2, snapshot: { ...original.snapshot, entityKey: 2 } },
      ],
      [{ entities, worlds }],
    );
    expect(delta).toMatchObject({ created: 1, updated: 1, removed: 1, ignoredLateUpdates: 4 });
    expect(delta.createdSlots[0]?.snapshot.transform.world[12]).toBe(5);
    expect(delta.updatedSlots.at(0)?.snapshot.transform.world[12]).toBe(3);
    expect(locate.mock.calls.filter(([id]) => id >= 4000)).toEqual([[4001], [4002], [4001]]);
  } finally {
    locate.mockRestore();
  }
});

it('publishes mixed structural edits and dense pose changes in first-admission order', () => {
  const { rows, worlds, entities } = fixture(140);
  const held = rows.capture();
  const original = rows.lookup(2)?.snapshot;
  assert(original);
  for (const entity of entities) worlds[entity * 16 + 12] = entity + 1;
  const replacement = { ...original, layer: 4 };
  const flipped = worlds.slice(48, 64);
  flipped[0] = -1;
  const delta = rows.apply(
    [
      { kind: 'remove', entityKey: 5 },
      { kind: 'remove', entityKey: 2 },
      { kind: 'update', entityKey: 2, snapshot: replacement },
      { kind: 'update', entityKey: 7, snapshot: { ...original, entityKey: 7 } },
      { kind: 'update', entityKey: 200, snapshot: { ...original, entityKey: 200 } },
    ],
    [
      { entities: Uint32Array.of(3), worlds: flipped },
      { entities, worlds },
      { entities: Uint32Array.of(200, 500), worlds: worlds.subarray(0, 32) },
    ],
  );
  expect(delta).toMatchObject({
    created: 1,
    recreated: 1,
    removed: 1,
    updated: 138,
    ignoredLateUpdates: 2,
  });
  expect(delta.recreatedSlots[0]?.snapshot.transform.world[12]).toBe(3);
  expect(delta.createdSlots[0]?.snapshot.transform.world[12]).toBe(1);
  expect(delta.contentUpdatedSlots.map((row) => row.entityKey)).toEqual([7, 3]);
  const changed = [7, 3, ...Array.from(entities).filter((e) => ![2, 3, 5, 7].includes(e))];
  expect(delta.updatedSlots.map((row) => row.entityKey)).toEqual(changed);
  for (const row of delta.updatedSlots)
    expect(held.slotAt(row.slot)?.snapshot.transform.world[12]).toBe(0);
  const expected = [2, 7];
  const history = delta.previous;
  expect(history.size).toBe(expected.length);
  expect([...history.keys()].map((row) => row.entityKey)).toEqual(expected);
  expect([...history.values()].map((row) => row.entityKey)).toEqual(expected);
  const pairs = [...history];
  let index = 0;
  history.forEach((before, after, owner) => {
    expect(owner).toBe(history);
    expect(after.entityKey).toBe(expected[index]);
    expect(pairs[index]?.[0]).toBe(after);
    expect(pairs[index++]?.[1]).toBe(before);
    expect(before).toBe(held.slotAt(before.slot));
    expect(history.get(after)).toBe(before);
    expect(history.has({ ...after })).toBe(false);
  });
  expect(index).toBe(expected.length);
});

it('packs recurring mixed edits into dense pose pages', () => {
  const { rows, worlds, entities } = fixture(256);
  const before = rows.capture();
  const original = before.lookup(0);
  assert(original);
  const start = rows.inspectPages();
  const spans = [{ entities, worlds }];
  let capacity = 0;
  let first: ReturnType<SceneRows['apply']> | undefined;
  for (let frame = 1; frame <= 32; frame++) {
    for (const entity of entities) worlds[entity * 16 + 12] = frame + entity;
    const delta = rows.apply(
      [{ kind: 'update', entityKey: 0, snapshot: { ...original.snapshot, layer: frame } }],
      spans,
      true,
    );
    expect(delta.updated).toBe(256);
    expect(delta.contentUpdatedSlots).toEqual([delta.updatedSlots.at(0)]);
    first ??= delta;
    rows.capture();
    if (frame === 1) capacity = rows.inspectPages().poseAdmissionBackingBytes;
    expect(rows.inspectPages().poseAdmissionBackingBytes).toBe(capacity);
  }
  expect(capacity).toBe(256 * 3 * Float64Array.BYTES_PER_ELEMENT);
  expect(rows.inspectPages().posePageAllocations - start.posePageAllocations).toBeLessThanOrEqual(
    32 * 4 + 1,
  );
  expect(before.lookup(255)?.snapshot.transform.world[12]).toBe(0);
  expect(first?.updatedSlots.at(255)?.snapshot.transform.world[12]).toBe(256);
  expect(rows.capture().lookup(255)?.snapshot.transform.world[12]).toBe(287);
  rows.reconcile([]);
  expect(rows.inspectPages().poseAdmissionBackingBytes).toBe(0);
  expect(first?.updatedSlots.at(255)?.snapshot.transform.world[12]).toBe(256);
});

it('reuses structural admission drafts during sustained mixed edits and releases them on unload', () => {
  const { rows, entities, worlds } = fixture(256);
  const before = rows.capture();
  const edits = [...entities].reverse().map((entityKey) => ({
    kind: 'update' as const,
    entityKey,
    snapshot: { ...rows.lookup(entityKey)?.snapshot, layer: 1 } as RenderableSnapshot,
  }));
  const warmed = rows.inspectPages();
  expect(warmed.pendingIdentityCapacity).toBe(256);
  let first: ReturnType<SceneRows['apply']> | undefined;
  const span = { entities, worlds };
  for (let frame = 1; frame <= 32; frame++) {
    for (const edit of edits) worlds[edit.entityKey * 16 + 12] = edit.entityKey + frame;
    // A publisher transfers ownership of detached payloads per commit.
    const delta = rows.apply(
      edits.map((edit) => ({ ...edit, snapshot: { ...edit.snapshot, layer: frame } })),
      [span],
      true,
    );
    expect(delta.updated).toBe(256);
    expect(delta.updatedSlots.at(0)?.entityKey).toBe(255);
    expect(delta.contentUpdatedSlots).toEqual(delta.updatedSlots);
    first ??= delta;
    rows.capture();
    expect(rows.inspectPages().pendingIdentityAllocations).toBe(warmed.pendingIdentityAllocations);
  }
  expect(before.lookup(255)?.snapshot.transform.world[12]).toBe(0);
  expect(first?.updatedSlots.at(0)?.snapshot.transform.world[12]).toBe(256);
  expect(rows.capture().lookup(255)?.snapshot.transform.world[12]).toBe(287);
  expect(rows.inspectPages().posePageAllocations - warmed.posePageAllocations).toBeLessThanOrEqual(
    32 * 4 + 1,
  );
  rows.reconcile([]);
  expect(rows.inspectPages().pendingIdentityCapacity).toBe(0);
  expect(first?.updatedSlots.at(0)?.snapshot.transform.world[12]).toBe(256);
});

it('resets live and new identity drafts when staged source reads throw', () => {
  const { rows, entities } = fixture(2);
  const before = rows.capture();
  const held = before.lookup(0);
  assert(held);
  expect(() =>
    rows.apply(
      [
        { kind: 'remove', entityKey: 0 },
        { kind: 'update', entityKey: 20, snapshot: { ...held.snapshot, entityKey: 20 } },
      ],
      [
        {
          entities,
          get worlds() {
            throw new Error('source read failed');
          },
        },
      ],
      true,
    ),
  ).toThrow('source read failed');
  expect(rows.capture()).toBe(before);
  const next = rows.apply(
    [{ kind: 'update', entityKey: 0, snapshot: { ...held.snapshot, layer: 4 } }],
    [],
    true,
  );
  const changed = next.updatedSlots.at(0);
  assert(changed);
  expect(next.previous.get(changed)).toBe(held);
  expect(next.recreated).toBe(0);
  expect(rows.lookup(20)).toBeUndefined();
  expect(rows.inspectPages().pendingIdentityAllocations).toBe(2);
});

it('merges only the final instance edit over the last full row in source order', () => {
  const { rows, worlds } = fixture(1);
  const first = rows.capture().lookup(0);
  assert(first);
  const instance = (version: number) => ({
    transforms: worlds,
    instanceCount: 1,
    cacheKey: 0,
    archVersion: version,
  });
  const delta = rows.apply(
    [
      { kind: 'update', entityKey: 0, instances: instance(1) },
      { kind: 'update', entityKey: 0, snapshot: { ...first.snapshot, instances: instance(2) } },
      { kind: 'update', entityKey: 0, instances: instance(3) },
      { kind: 'update', entityKey: 0, instances: instance(4) },
      { kind: 'update', entityKey: 0, snapshot: { ...first.snapshot, instances: instance(5) } },
    ],
    [],
  );
  expect(delta.contentUpdatedSlots[0]?.snapshot.instances?.archVersion).toBe(5);
  const after = rows.capture().lookup(0);
  assert(after);
  const partial = rows.apply([
    { kind: 'update', entityKey: 0, instances: instance(6) },
    { kind: 'update', entityKey: 0, instances: instance(7) },
  ]);
  expect(partial.instanceUpdatedSlots[0]?.snapshot.instances?.archVersion).toBe(7);
  expect(after.snapshot.instances?.archVersion).toBe(5);
  expect(first.snapshot.instances).toBeUndefined();
});
