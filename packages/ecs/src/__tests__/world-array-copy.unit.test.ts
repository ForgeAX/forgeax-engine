import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';
import { worldInternal } from '../world-internal';
import { worldRead } from '../world-read';

const Values = defineComponent('CopyReadValues', {
  fixed: 'array<f32, 4>',
  dynamic: 'array<f64>',
  scalar: 'f32',
});

describe('World array output reads', () => {
  it('copies physical inline rows into an existing output without materializing a view', () => {
    const world = new World();
    world.spawn({ component: Values, data: { fixed: [90, 91, 92, 93] } }).unwrap();
    const entity = world.spawn({ component: Values, data: { fixed: [1 / 3, 2, 3, 4] } }).unwrap();
    const output = new Float64Array(8).fill(-1),
      window = output.subarray(2, 7);
    const read = world[worldRead],
      view = vi.spyOn(world[worldInternal], 'getArrayView');
    const epoch = world.getStructureEpoch();
    expect(read.copyArray(entity, Values, 'fixed', window)).toBe(4);
    expect(Array.from(output)).toEqual([-1, -1, Math.fround(1 / 3), 2, 3, 4, -1, -1]);
    expect(view).not.toHaveBeenCalled();
    expect(world.getStructureEpoch()).toBe(epoch);
    output[2] = 42;
    expect(world.get(entity, Values).unwrap().fixed[0]).toBe(Math.fround(1 / 3));
    view.mockRestore();
  });

  it('does not write an insufficient or missing output and follows live dynamic counts', () => {
    const world = new World();
    const entity = world.spawn({ component: Values, data: { dynamic: [1 / 3, 7, 9] } }).unwrap();
    const read = world[worldRead],
      output = new Float64Array(5).fill(-1);
    expect(read.copyArray(entity, Values, 'fixed', output.subarray(0, 3))).toBeUndefined();
    expect(read.copyArray(entity, Values, 'missing', output)).toBeUndefined();
    expect(read.copyArray(entity, Values, 'scalar', output)).toBeUndefined();
    expect(Array.from(output)).toEqual([-1, -1, -1, -1, -1]);
    expect(read.copyArray(entity, Values, 'dynamic', output)).toBe(3);
    expect(Array.from(output)).toEqual([1 / 3, 7, 9, -1, -1]);
    world.set(entity, Values, { dynamic: [] }).unwrap();
    expect(read.copyArray(entity, Values, 'dynamic', output)).toBe(0);
    world.removeComponent(entity, Values).unwrap();
    expect(read.copyArray(entity, Values, 'fixed', output)).toBeUndefined();
    world.despawn(entity).unwrap();
    const replacement = world.spawn({ component: Values, data: { fixed: [5, 6, 7, 8] } }).unwrap();
    expect(read.copyArray(entity, Values, 'fixed', output)).toBeUndefined();
    expect(read.copyArray(replacement, Values, 'fixed', output)).toBe(4);
    expect(Array.from(output)).toEqual([5, 6, 7, 8, -1]);
  });

  it('preserves native overlapping output copies and fresh columns after structural changes', () => {
    const world = new World();
    const entity = world.spawn({ component: Values, data: { fixed: [1, 2, 3, 4] } }).unwrap();
    const second = world.spawn({ component: Values, data: { fixed: [8, 9, 10, 11] } }).unwrap();
    const first = world.get(entity, Values).unwrap().fixed;
    const overlap = new Float32Array(first.buffer, first.byteOffset + 4, 4);
    expect(world[worldRead].copyArray(entity, Values, 'fixed', overlap)).toBe(4);
    expect(Array.from(overlap)).toEqual([1, 2, 3, 4]);
    for (let i = 0; i < 140; i++) world.spawn({ component: Values, data: {} }).unwrap();
    const marker = defineComponent('CopyReadMarker', {});
    world.addComponent(second, { component: marker, data: {} }).unwrap();
    world.despawn(entity).unwrap();
    const output = new Float32Array(4);
    expect(world[worldRead].copyArray(second, Values, 'fixed', output)).toBe(4);
    expect(Array.from(output)).toEqual([4, 9, 10, 11]);
  });
});
