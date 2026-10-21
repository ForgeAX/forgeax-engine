import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { World } from '../world';

import { worldInternal } from '../world-internal';

const Marker = defineComponent('ChangeDetectionMarker', { value: 'f32' });

describe('mutation epoch evidence', () => {
  it('does not report equal stored scalar or enum values as changes', () => {
    const Scalar = defineComponent('EqualStoredScalars', {
      value: 'f32',
      byte: 'u8',
      enabled: 'bool',
      state: { type: 'enum', labels: { hidden: 1, visible: 2 }, default: 2 },
    });
    const world = new World();
    const entity = world
      .spawn({ component: Scalar, data: { value: 0.1, byte: 1, enabled: true } })
      .unwrap();
    const changed = world.query({ read: [Scalar], changed: [Scalar] }).unwrap();
    expect([...changed]).toHaveLength(1);
    const epoch = world[worldInternal].getMutationEpoch();
    world.set(entity, Scalar, { value: 0.1, byte: 1, enabled: true, state: 2 }).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([]);
    expect(world[worldInternal].getMutationEpoch()).toBe(epoch);
    world.set(entity, Scalar, {}).unwrap();
    expect(world[worldInternal].getMutationEpoch()).toBe(epoch);
    world.set(entity, Scalar, { state: 1 }).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([entity]);
    expect(world[worldInternal].getMutationEpoch()).toBe(epoch + 1);
  });

  it('preserves explicit fixed-array publication after alias writes', () => {
    const Fixed = defineComponent('AliasedPublication', {
      values: 'array<f32, 3>',
      enabled: 'bool',
    });
    const world = new World();
    const entity = world.spawn({ component: Fixed, data: { values: [1, 2, 3] } }).unwrap();
    const changed = world.query({ read: [Fixed], changed: [Fixed] }).unwrap();
    expect([...changed]).toHaveLength(1);
    const view = world.get(entity, Fixed).unwrap().values;
    view[1] = 7;
    world.set(entity, Fixed, { values: view, enabled: false }).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([entity]);
    expect(world.get(entity, Fixed).unwrap().values[1]).toBe(7);
  });

  it('preserves borrowed variable arrays and subarrays when their pool slot is reused', () => {
    const Data = defineComponent('BorrowedArrayWrite', { values: 'array<u32>' });
    const world = new World();
    const entity = world.spawn({ component: Data, data: { values: [1, 2, 3, 4] } }).unwrap();
    const borrowed = world.get(entity, Data).unwrap().values;
    borrowed[1] = 9;
    world.set(entity, Data, { values: borrowed }).unwrap();
    expect([...world.get(entity, Data).unwrap().values]).toEqual([1, 9, 3, 4]);
    world
      .set(entity, Data, { values: world.get(entity, Data).unwrap().values.subarray(1) })
      .unwrap();
    expect([...world.get(entity, Data).unwrap().values]).toEqual([9, 3, 4]);
  });

  it.each([
    'array<u32>',
    'array<u32, 4>',
  ] as const)('captures cross-field borrowed writes before overwriting %s storage', (type) => {
    const Data = defineComponent(`BorrowedArraySwap${type}`, { a: type, b: type });
    const world = new World();
    const entity = world
      .spawn({ component: Data, data: { a: [1, 2, 3, 4], b: [5, 6, 7, 8] } })
      .unwrap();
    const borrowed = world.get(entity, Data).unwrap();
    world.set(entity, Data, { a: borrowed.b, b: borrowed.a }).unwrap();
    const after = world.get(entity, Data).unwrap();
    expect([...after.a]).toEqual([5, 6, 7, 8]);
    expect([...after.b]).toEqual([1, 2, 3, 4]);
  });

  it('captures borrowed buffer bytes, including cross-field DataView writes', () => {
    const Data = defineComponent('BorrowedBufferWrite', { a: 'buffer', b: 'buffer' });
    const world = new World();
    const entity = world
      .spawn({
        component: Data,
        data: { a: new Uint8Array([1, 2, 3, 4]), b: new Uint8Array([5, 6, 7, 8]) },
      })
      .unwrap();
    const borrowed = world.get(entity, Data).unwrap();
    world
      .set(entity, Data, {
        a: borrowed.b,
        b: new DataView(borrowed.a.buffer, borrowed.a.byteOffset + 1, 2),
      })
      .unwrap();
    const after = world.get(entity, Data).unwrap();
    expect([...after.a]).toEqual([5, 6, 7, 8]);
    expect([...after.b]).toEqual([2, 3]);
    world.set(entity, Data, { a: after.a }).unwrap();
    expect([...world.get(entity, Data).unwrap().a]).toEqual([5, 6, 7, 8]);
  });

  it('advances once per successful mutation and not for failures or no-ops', () => {
    const Other = defineComponent('MutationEpochOther', { value: 'f32' });
    const world = new World();
    const entity = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    expect(world[worldInternal].getMutationEpoch()).toBe(1);
    expect(world[worldInternal].getComponentChange(entity, componentId(Marker))).toEqual({
      added: 1,
      changed: 1,
    });

    expect(world.set(entity, Other, { value: 2 }).ok).toBe(false);
    world.removeResource('missing');
    expect(world[worldInternal].getMutationEpoch()).toBe(1);

    world.set(entity, Marker, { value: 2 }).unwrap();
    expect(world[worldInternal].getMutationEpoch()).toBe(2);
    expect(world[worldInternal].getComponentChange(entity, componentId(Marker))).toEqual({
      added: 1,
      changed: 2,
    });
  });

  it('keeps resource evidence on its ResourceStore entry', () => {
    const world = new World();
    world.insertResource('ChangeDetectionResource', { value: 1 });
    expect(world.getResourceChange('ChangeDetectionResource')).toEqual({ added: 1, changed: 1 });
    world.update(1 / 60).unwrap();
    world.insertResource('ChangeDetectionResource', { value: 2 });
    expect(world.getResourceChange('ChangeDetectionResource')).toEqual({ added: 1, changed: 2 });
  });

  it('keeps independent query cursors and retries after consumer throws', () => {
    const world = new World();
    const entity = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    const first = world.query({ read: [Marker], changed: [Marker] }).unwrap();
    const second = world.query({ read: [Marker], changed: [Marker] }).unwrap();

    expect(() => {
      for (const _row of first) throw new Error('consumer failure');
    }).toThrow('consumer failure');
    expect([...first].map((row) => row.entity)).toEqual([entity]);
    expect([...second].map((row) => row.entity)).toEqual([entity]);
  });

  it('does not inherit evidence when a slot generation is reused', () => {
    const world = new World();
    const retired = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    const added = world.query({ read: [Marker], added: [Marker] }).unwrap();
    expect([...added].map((row) => row.entity)).toEqual([retired]);

    world.despawn(retired).unwrap();
    const reused = world.spawn({ component: Marker, data: { value: 2 } }).unwrap();
    expect((reused as number) & 0xffffff).toBe((retired as number) & 0xffffff);
    expect(reused).not.toBe(retired);
    expect([...added].map((row) => row.entity)).toEqual([reused]);
  });

  it('carries evidence through grow, migration, and swap-pop', () => {
    const Attached = defineComponent('MutationEpochAttached', { flag: 'u8' });
    const world = new World();
    const entities = Array.from({ length: 65 }, (_, value) =>
      world.spawn({ component: Marker, data: { value } }).unwrap(),
    );
    const changed = world.query({ read: [Marker], changed: [Marker] }).unwrap();
    expect([...changed].length).toBe(65);

    const survivor = entities[0];
    const removed = entities[1];
    if (survivor === undefined || removed === undefined) throw new Error('fixture');
    world.addComponent(survivor, { component: Attached, data: { flag: 1 } }).unwrap();
    world.despawn(removed).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([]);

    world.set(survivor, Marker, { value: 99 }).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([survivor]);
  });
});
