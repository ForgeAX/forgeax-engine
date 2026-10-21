import { defineComponent, World } from '@forgeax/engine-ecs';
import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expect, test } from 'vitest';
import { AssetRecords } from '../internal/asset-records';

const Binding = defineComponent('OwnedAssetBinding', {
  first: 'asset<material>',
  second: 'asset<material>',
  list: 'array<asset<material>>',
  pair: 'array<asset<material>, 2>',
});
const Tag = defineComponent('OwnedAssetMigrationTag', {});
const create = (records: AssetRecords) =>
  records.create('material', { kind: 'material', values: {} }).unwrap();

describe('World asset binding ownership', () => {
  test('rejects foreign, stale and mistyped identities before inserting or replacing', () => {
    const records = new AssetRecords();
    const world = new World({ assets: records });
    const other = new AssetRecords();
    const foreign = create(other);
    const local = create(records);
    const entity = world.spawn({ component: Binding, data: { first: local } }).unwrap();
    const before = JSON.stringify(world.inspect());
    expect(world.spawn({ component: Binding, data: { first: foreign } }).ok).toBe(false);
    expect(world.set(entity, Binding, { first: foreign }).ok).toBe(false);
    expect(world.get(entity, Binding).unwrap().first).toBe(local);
    expect(JSON.stringify(world.inspect())).toBe(before);
    const mesh = records.create('mesh', { kind: 'mesh' }).unwrap();
    expect(
      world.set(entity, Binding, { first: mesh as unknown as AssetHandle<'material'> }).ok,
    ).toBe(false);
    records.release(local).unwrap();
    world.despawn(entity).unwrap();
    expect(world.spawn({ component: Binding, data: { first: local } }).ok).toBe(false);
    expect(new World().spawn({ component: Binding, data: { first: foreign } }).ok).toBe(false);
  });

  test('keeps sole World holds alive across self assignment and swaps, then releases them', () => {
    const records = new AssetRecords();
    const world = new World({ assets: records });
    const a = create(records);
    const b = create(records);
    const entity = world.spawn({ component: Binding, data: { first: a, second: b } }).unwrap();
    records.release(a).unwrap();
    records.release(b).unwrap();
    world.set(entity, Binding, { first: a }).unwrap();
    world.set(entity, Binding, { first: b, second: a }).unwrap();
    world.addComponent(entity, { component: Tag, data: {} }).unwrap();
    expect(records.read(a).ok).toBe(true);
    expect(world.get(entity, Binding).unwrap().first).toBe(b);
    world.removeComponent(entity, Binding).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  test('owns fixed and variable array elements, including duplicates and reorder', () => {
    const records = new AssetRecords();
    const world = new World({ assets: records });
    const a = create(records);
    const b = create(records);
    const entity = world
      .spawn({ component: Binding, data: { list: [a, a], pair: [a, b] } })
      .unwrap();
    records.release(a).unwrap();
    records.release(b).unwrap();
    world.set(entity, Binding, { list: [b], pair: [b, a] }).unwrap();
    const read = world.get(entity, Binding).unwrap();
    expect(Array.from(read.list)).toEqual([b]);
    expect(Array.from(read.pair)).toEqual([b, a]);
    (read.pair as unknown as Uint32Array).fill(0);
    expect(Array.from(world.get(entity, Binding).unwrap().pair)).toEqual([b, a]);
    expect(world.setArrayRange(entity, Binding, 'pair', 0, [0]).ok).toBe(false);
    world.set(entity, Binding, { list: [], pair: [] }).unwrap();
    expect(records.inspect().assets).toBe(0);
    world.despawn(entity).unwrap();
  });

  test('rejects invalid numeric encodings and does not truncate typed references', () => {
    const records = new AssetRecords();
    const world = new World({ assets: records });
    for (const raw of [-1, 1.5, 2 ** 32, NaN, 'source-guid']) {
      expect(
        world.spawn({ component: Binding, data: { first: raw as AssetHandle<'material'> } }).ok,
      ).toBe(false);
    }
    const handle = create(records);
    const data = { list: new Float32Array([handle]) } as unknown as {
      list: AssetHandle<'material'>[];
    };
    expect(world.spawn({ component: Binding, data }).ok).toBe(false);
  });

  test.each([
    'remove',
    'despawn',
  ] as const)('%s releases nonempty asset arrays after table migration', (operation) => {
    const records = new AssetRecords();
    const world = new World({ assets: records });
    const a = create(records);
    const b = create(records);
    const entity = world
      .spawn({ component: Binding, data: { list: [a, a, b], pair: [b, a] } })
      .unwrap();
    records.release(a).unwrap();
    records.release(b).unwrap();
    world.addComponent(entity, { component: Tag, data: {} }).unwrap();
    expect(Array.from(world.get(entity, Binding).unwrap().list)).toEqual([a, a, b]);
    if (operation === 'remove') world.removeComponent(entity, Binding).unwrap();
    else world.despawn(entity).unwrap();
    expect(records.inspect().assets).toBe(0);
  });
});
