import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { SceneRows, type WorldTransformSpan } from '../scene-rows';

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
        worldId: 0,
        entityKey,
        transform: { world: pose },
        material,
        materials: [material],
        materialBindingSources: ['engine-default'],
      };
      return { kind: 'update', worldId: 0, entityKey, snapshot };
    }),
    [],
    true,
  );
  return { rows, entities, worlds };
}

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
      worldId: 0,
      entities: actual.entities,
      worlds: first,
      rows: [...Array<number>(65).fill(2), 65, 2],
    },
    { worldId: 0, entities: actual.entities, worlds: last, rows: [2, 65] },
    { worldId: 0, entities: Uint32Array.of(999, 999), worlds: new Float32Array(32) },
  ];
  const result = actual.rows.applyOwnedTransforms(spans, world);
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
  const updated = result.updatedSlots[0];
  assert(updated);
  expect(result.previous.get(updated)).toBe(old);
  expect(world.memoryStats().arena.active).toBe(false);
});

it('denies a later chunk before any write and retries a smaller update on the same healthy World', () => {
  const f = fixture();
  const world = new World({ memory: { arena: { maxScopeBytes: 1536 } } });
  const before = f.rows.capture();
  const revision = f.rows.revision;
  for (let row = 0; row < 65; row++) f.worlds[row * 16 + 12] = 8;
  expect(() =>
    f.rows.applyOwnedTransforms([{ worldId: 0, entities: f.entities, worlds: f.worlds }], world),
  ).toThrow();
  expect(world.withFrameArena(() => ok(true)).unwrap()).toBe(true);
  expect(f.rows.capture()).toBe(before);
  expect(f.rows.revision).toBe(revision);
  expect(world.memoryStats().arena.active).toBe(false);
  const delta = f.rows.applyOwnedTransforms(
    [{ worldId: 0, entities: f.entities, worlds: f.worlds, rows: [0, 64] }],
    world,
  );
  expect(delta.updated).toBe(2);
  expect(delta.updatedSlots.map((row) => row.snapshot.transform.world[12])).toEqual([8, 8]);
  expect(f.rows.capture().slotAt(1)?.snapshot.transform.world[12]).toBe(0);
});

it('reuses arena backing through twenty dense and smaller-demand cycles without retaining its windows', () => {
  const f = fixture(1024);
  const world = new World();
  let backing = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let row = 0; row < 1024; row++) f.worlds[row * 16 + 12] = cycle + 1;
    const delta = f.rows.applyOwnedTransforms(
      [{ worldId: 0, entities: f.entities, worlds: f.worlds }],
      world,
    );
    expect(delta.updated).toBe(1024);
    const held = delta.updatedSlots[0];
    assert(held);
    if (cycle === 0) backing = world.memoryStats().arena.backingAllocations;
    expect(world.memoryStats().arena.backingAllocations).toBe(backing);
    f.worlds[12] = cycle + 101;
    f.rows.applyOwnedTransforms(
      [{ worldId: 0, entities: f.entities, worlds: f.worlds, rows: [0] }],
      world,
    );
    expect(held.snapshot.transform.world[12]).toBe(cycle + 1);
    expect(world.memoryStats().arena.usedBytes).toBe(0);
  }
  const root = f.rows.capture();
  const requests = world.memoryStats().arena.requests;
  expect(
    f.rows.applyOwnedTransforms([{ worldId: 0, entities: f.entities, worlds: f.worlds }], world)
      .updated,
  ).toBe(0);
  expect(f.rows.capture()).toBe(root);
  expect(world.memoryStats().arena.requests).toBe(requests);
});

it('rejects overlapping admission before overwriting shared staging and keeps ordinary retry valid', () => {
  const f = fixture();
  const world = new World();
  let attempts = 0;
  const spans: WorldTransformSpan[] = [
    {
      worldId: 0,
      entities: f.entities,
      get worlds() {
        attempts++;
        expect(() =>
          f.rows.applyOwnedTransforms(
            [{ worldId: 0, entities: f.entities, worlds: f.worlds }],
            world,
          ),
        ).toThrow('reenter');
        return f.worlds;
      },
    },
  ];
  f.worlds[12] = 9;
  expect(f.rows.apply([], spans, true).updated).toBe(1);
  expect(attempts).toBe(128);
  f.worlds[12] = 11;
  expect(
    f.rows.applyOwnedTransforms([{ worldId: 0, entities: f.entities, worlds: f.worlds }], world)
      .updated,
  ).toBe(1);
  expect(f.rows.capture().slotAt(0)?.snapshot.transform.world[12]).toBe(11);
});

it('preserves strict NaN changes and tiny admission without requesting arena capacity', () => {
  const f = fixture();
  const world = new World();
  f.worlds[12] = Number.NaN;
  const span = { worldId: 0, entities: f.entities, worlds: f.worlds };
  expect(f.rows.applyOwnedTransforms([span], world).updated).toBe(1);
  expect(f.rows.applyOwnedTransforms([span], world).updated).toBe(1);
  const requests = world.memoryStats().arena.requests;
  f.worlds[16 + 12] = 3;
  expect(f.rows.applyOwnedTransforms([{ ...span, rows: [1] }], world).updated).toBe(1);
  expect(world.memoryStats().arena.requests).toBe(requests);
});
