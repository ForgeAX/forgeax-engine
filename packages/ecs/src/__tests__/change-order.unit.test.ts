import { expect, test, vi } from 'vitest';
import { type Component, defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { ChangedEntityOrder } from '../query/change-order';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Value = defineComponent('ChangedOrderValue', { x: 'f32' });
const Sparse = defineComponent('ChangedOrderSparse', {}, { storage: 'sparse' });

test.each([
  false,
  true,
])('changed rows retain physical ordering after churn (sparse=%s)', (sparse) => {
  const world = new World();
  const tags = Array.from({ length: 270 }, (_, i) => defineComponent(`OrderTag${sparse}${i}`, {}));
  const live: EntityHandle[] = [];
  for (let i = 0; i < 2100; i++) {
    live.push(
      world
        .spawn(
          { component: Value, data: { x: i } },
          ...(sparse ? [{ component: Sparse, data: {} }] : []),
          ...(i < tags.length ? [{ component: tags[i] as Component, data: {} }] : []),
        )
        .unwrap(),
    );
  }
  const descriptor = { read: [Value], ...(sparse ? { with: [Sparse] } : {}) };
  const changed = world.query({ ...descriptor, changed: [Value] }).unwrap();
  const spans = world.query({ ...descriptor, changed: [Value] }).unwrap();
  // Consume the first baseline before mutations rearrange native storage.
  Array.from(changed);
  if (!sparse) Array.from(spans.spans().unwrap());
  for (let i = 300; i < 1800; i += 7) {
    world.despawn(live[i] as EntityHandle).unwrap();
    live[i] = world
      .spawn(
        { component: Value, data: { x: -i } },
        ...(sparse ? [{ component: Sparse, data: {} }] : []),
      )
      .unwrap();
  }
  // A large row cohort and >256 owners exercise both halves of the key.
  for (let i = live.length - 1; i >= 0; i--)
    world.set(live[i] as EntityHandle, Value, { x: -i }).unwrap();
  const expected = Array.from(world.query(descriptor).unwrap(), (row) => row.entity);
  const nativeSort = vi.spyOn(Array.prototype, 'sort').mockImplementation(() => {
    throw new Error('changed query used native comparison sorting');
  });
  let actual: EntityHandle[];
  const spanEntities: number[] = [];
  try {
    actual = Array.from(changed, (row) => row.entity);
    if (!sparse) {
      for (const span of spans.spans().unwrap()) spanEntities.push(...span.entities);
    }
  } finally {
    nativeSort.mockRestore();
  }
  expect(actual).toEqual(expected);
  if (!sparse) expect(spanEntities).toEqual(expected);
  expect(Array.from(changed)).toEqual([]);
});

test('ordering scratch is lazy, fixed-size and does not retain the changed batch', () => {
  const world = new World();
  const order = new ChangedEntityOrder(world[worldInternal], false);
  const small = Array.from({ length: 32 }, () => world.spawn().unwrap()).reverse();
  order.sort(small);
  const scratch = () => (order as unknown as { scratch?: Uint32Array }).scratch;
  expect(scratch()).toBeUndefined();
  const large = Array.from({ length: 700 }, () => world.spawn().unwrap()).reverse();
  order.sort(large);
  const retained = scratch();
  expect(retained?.byteLength).toBe(8 * 256 * 3 * 4);
  order.sort(large.reverse());
  expect(scratch()).toBe(retained);
  expect(Object.values(order)).not.toContain(large);
});
