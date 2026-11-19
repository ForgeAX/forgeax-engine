import { expect, it } from 'vitest';
import { bindSharedSpan, defineSharedKernel, sliceSharedSpan } from '../execution/shared-kernel';
import { defineComponent, type QuerySpan, World } from '../index';

function runBindingKernel(_spans: readonly QuerySpan[]): void {}

it('preserves distinct same-label component slots and the query index when sharding', () => {
  const First = defineComponent('SameKernelComponent', { x: 'f32' });
  const Second = defineComponent('SameKernelComponent', { x: 'f32' });
  const world = new World({ storage: 'shared' });
  for (let x = 1; x <= 4; x++) {
    world
      .spawn({ component: First, data: { x } }, { component: Second, data: { x: x * 10 } })
      .unwrap();
  }
  const kernel = defineSharedKernel(import.meta.url, {
    name: 'same-label-kernel',
    queries: [{ read: [First] }, { write: [First, Second] }],
    run: runBindingKernel,
  });
  const span = [
    ...world
      .query({ write: [First, Second] })
      .unwrap()
      .spans()
      .unwrap(),
  ][0];
  if (span === undefined) throw new Error('Missing shared span');
  const binding = bindSharedSpan(kernel, span, 1);
  expect(Object.values(binding.write)).toHaveLength(2);
  expect(binding.queryIndex).toBe(1);
  const shards = [sliceSharedSpan(binding, 0, 2), sliceSharedSpan(binding, 2, 4)];
  expect(shards).toHaveLength(2);
  for (const [index, shard] of shards.entries()) {
    expect(shard.queryIndex).toBe(1);
    expect(shard.write).toHaveLength(2);
    expect(Array.from(shard.write[0]?.x ?? [])).toEqual(index === 0 ? [1, 2] : [3, 4]);
    expect(Array.from(shard.write[1]?.x ?? [])).toEqual(index === 0 ? [10, 20] : [30, 40]);
    expect(shard.write[0]?.x?.buffer).toBe(binding.write[0]?.x?.buffer);
    expect(shard.write[1]?.x?.buffer).toBe(binding.write[1]?.x?.buffer);
  }
});
