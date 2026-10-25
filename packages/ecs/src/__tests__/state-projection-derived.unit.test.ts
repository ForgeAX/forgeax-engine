import { expect, test } from 'vitest';
import { defineComponent } from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';
import { getDerivedWriter } from '../internal';
import { createStateProjection } from '../projection/state-projection';
import { World } from '../world';

const Input = defineComponent('ProjectionDerivedInput', { x: 'f32' });
const Binding = defineComponent('ProjectionDerivedBinding', { key: 'u32' });
const Output = defineComponent('ProjectionDerivedOutput', { x: 'f32' });
const Extra = defineComponent('ProjectionDerivedExtra', {});

test.each([
  1_000, 10_000, 100_000,
])('same-World derived writes can accept %i-source input without rediscovering unrelated identities', (count) => {
  const world = new World();
  const entities = Array.from({ length: count }, (_, x) =>
    world
      .spawn(
        { component: Input, data: { x } },
        { component: Binding, data: { key: x % 16 } },
        { component: Output, data: { x } },
      )
      .unwrap(),
  );
  const derive = createStateProjection(world, [Input, Binding]);
  const independent = createStateProjection(world, [Input, Binding]);
  derive.read().accept();
  independent.read().accept();
  for (let step = 1; step <= 3; step++) {
    const changed = Array.from(
      { length: 8 },
      (_, i) => entities[Math.floor((i * count) / 8)] as EntityHandle,
    );
    for (const entity of changed) world.set(entity, Input, { x: -step }).unwrap();
    const batch = derive.read();
    expect(new Set(batch.indices)).toEqual(new Set(changed.map(entityIndex)));
    expect(batch.scannedRows).toBe(8);
    expect(batch.checkedBlocks).toBe(0);
    expect(batch.checkedIndexEntries).toBeLessThan(4_096);
    for (const index of batch.indices) {
      const entity = derive.entity(index) as EntityHandle;
      world.set(entity, Output, { x: world.get(entity, Input).unwrap().x * 2 }).unwrap();
    }
    batch.accept();
    expect(derive.isCurrent()).toBe(true);
    expect(derive.read().indices).toEqual([]);
    const second = independent.read();
    expect(new Set(second.indices)).toEqual(new Set(changed.map(entityIndex)));
    second.accept();
  }
});

test('a completed derived writer can publish an output range before accepting its input', () => {
  const world = new World();
  const entity = world
    .spawn({ component: Input, data: { x: 1 } }, { component: Output, data: {} })
    .unwrap();
  const projection = createStateProjection(world, [Input]);
  projection.read().accept();
  world.set(entity, Input, { x: 2 }).unwrap();
  const batch = projection.read();
  const writer = getDerivedWriter(world.query({ write: [Output] }).unwrap(), Output).unwrap();
  writer
    .writeRange(
      0,
      0,
      0,
      1,
      (binding) => {
        binding.write.x[0] = 4;
      },
      undefined,
    )
    .unwrap();
  batch.accept();
  expect(projection.isCurrent()).toBe(true);
  world.insertResource('unobserved-operation-result', { status: 'prepared' });
  expect(projection.isCurrent()).toBe(true);
  expect(world.get(entity, Output).unwrap().x).toBe(4);
});

test('a later observed input write still rejects acceptance and survives retry', () => {
  const world = new World();
  const entity = world
    .spawn({ component: Input, data: { x: 1 } }, { component: Output, data: {} })
    .unwrap();
  const projection = createStateProjection(world, [Input]);
  projection.read().accept();
  world.set(entity, Input, { x: 2 }).unwrap();
  const candidate = projection.read();
  world.set(entity, Output, { x: 4 }).unwrap();
  world.set(entity, Input, { x: 3 }).unwrap();
  expect(() => candidate.accept()).toThrow();
  const retry = projection.read();
  expect(retry.indices).toEqual([entityIndex(entity)]);
  retry.accept();
});

test('candidate membership inputs and structure retain their acceptance fences', () => {
  const world = new World();
  const entity = world
    .spawn({ component: Input, data: {} }, { component: Binding, data: {} })
    .unwrap();
  const projection = createStateProjection(world, [Input], [Binding]);
  projection.read().accept();
  world.set(entity, Input, { x: 1 }).unwrap();
  const binding = projection.read();
  world.set(entity, Binding, { key: 1 }).unwrap();
  expect(() => binding.accept()).toThrow();
  const structure = projection.read();
  world.addComponent(entity, { component: Extra, data: {} }).unwrap();
  expect(() => structure.accept()).toThrow();
  projection.read().accept();
  const prior = projection.read();
  world.despawn(entity).unwrap();
  const replacement = world
    .spawn({ component: Input, data: {} }, { component: Binding, data: {} })
    .unwrap();
  expect(entityIndex(replacement)).toBe(entityIndex(entity));
  expect(() => prior.accept()).toThrow();
  const recreated = projection.read();
  expect(recreated.indices).toEqual([entityIndex(replacement)]);
  recreated.accept();
});
