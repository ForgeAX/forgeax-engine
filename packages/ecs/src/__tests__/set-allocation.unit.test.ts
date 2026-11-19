import { toShared } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { type Component, defineComponent } from '../component';
import { World } from '../world';

describe('partial component writes', () => {
  it('does not materialize an existing row to validate independent patch fields', () => {
    const Pose = defineComponent('PatchPose', { pos: 'array<f32, 3>', value: 'f32' });
    const world = new World();
    const entity = world.spawn({ component: Pose, data: { pos: [1, 2, 3] } }).unwrap();
    const read = vi.spyOn(
      world as unknown as { readRow: (...args: unknown[]) => unknown },
      'readRow',
    );
    world.set(entity, Pose, { value: 4 }).unwrap();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(Array.from(world.get(entity, Pose).unwrap().pos)).toEqual([1, 2, 3]);
  });

  it('preserves fixed-array encoding, overlap, and zero padding', () => {
    const Data = defineComponent('FixedWrite', { values: 'array<f32, 4>' });
    const world = new World();
    const entity = world.spawn({ component: Data, data: { values: [1, 2, 3, 4] } }).unwrap();
    const values = world.get(entity, Data).unwrap().values;
    world.set(entity, Data, { values: values.subarray(1) }).unwrap();
    expect(Array.from(world.get(entity, Data).unwrap().values)).toEqual([2, 3, 4, 0]);
    world.set(entity, Data, { values: [5, 6] }).unwrap();
    expect(Array.from(world.get(entity, Data).unwrap().values)).toEqual([5, 6, 0, 0]);
  });

  it('preserves native NaN payloads and negative zero in fixed and variable arrays', () => {
    const Data = defineComponent('NativeArrayBits', {
      fixed: 'array<f32, 4>',
      variable: 'array<f32>',
    });
    const world = new World();
    const bits = Uint32Array.of(0x7fc01234, 0x80000000, 0x3f800000);
    const values = new Float32Array(bits.buffer);
    const entity = world
      .spawn({ component: Data, data: { fixed: values, variable: values } })
      .unwrap();
    {
      const row = world.get(entity, Data).unwrap();
      expect(Array.from(new Uint32Array(row.fixed.buffer, row.fixed.byteOffset, 4))).toEqual([
        ...bits,
        0,
      ]);
      expect(Array.from(new Uint32Array(row.variable.buffer, row.variable.byteOffset, 3))).toEqual(
        Array.from(bits),
      );
    }
    world
      .set(entity, Data, { fixed: values.subarray(0, 2), variable: values.subarray(0, 2) })
      .unwrap();
    const row = world.get(entity, Data).unwrap();
    expect(Array.from(new Uint32Array(row.fixed.buffer, row.fixed.byteOffset, 4))).toEqual([
      0x7fc01234, 0x80000000, 0, 0,
    ]);
    expect(Array.from(new Uint32Array(row.variable.buffer, row.variable.byteOffset, 2))).toEqual([
      0x7fc01234, 0x80000000,
    ]);
  });

  it('owns only the copied shared-handle prefix and releases it after migration', () => {
    const Data = defineComponent('NativeArrayGrants', {
      fixed: 'array<shared<Value>, 4>',
      variable: 'array<shared<Value>>',
    });
    const Extra = defineComponent('NativeArrayGrantExtra', { value: 'u32' });
    const world = new World();
    const handle = world.allocSharedRef('Value', {});
    const empty = toShared<'Value'>(0);
    const entity = world
      .spawn({
        component: Data,
        data: {
          fixed: [handle, empty, handle, empty, handle],
          variable: [handle, handle, empty],
        },
      })
      .unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(5);
    world.set(entity, Data, { fixed: [empty, handle], variable: [] }).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(2);
    expect(Array.from(world.get(entity, Data).unwrap().fixed)).toEqual([0, handle, 0, 0]);
    world.addComponent(entity, { component: Extra, data: {} }).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(2);
    world.despawn(entity).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(1);
    world.sharedRefs.release(handle).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(0);
  });

  it('copies an admitted fixed reference prefix without calling input subarray overrides', () => {
    const Data: Component = defineComponent('NativeArrayPrefix', {
      values: 'array<shared<Value>, 2>',
    });
    const world = new World();
    const handle = world.allocSharedRef('Value', {});
    class NativeInput extends Uint32Array {
      override subarray(): never {
        throw new Error('input subarray must not run');
      }
    }
    const input = new NativeInput([handle, 0, handle]);
    const entity = world.spawn({ component: Data, data: { values: input } }).unwrap();
    expect(Array.from(world.get(entity, Data).unwrap().values as Uint32Array)).toEqual([handle, 0]);
    expect(world.sharedRefs.refcount(handle)).toBe(2);
    world.set(entity, Data, { values: input }).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(2);
    world.despawn(entity).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(1);
  });
});
