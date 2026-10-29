import { describe, expect, expectTypeOf, it } from 'vitest';
import { type Component, componentId, defineComponent } from '../component';
import { Disabled } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { QueryIterationActiveError, QueryIterationInvalidatedError } from '../errors';
import { QueryBatchUnavailableError } from '../errors/query-batch-errors';
import type { NumericField, ReadonlyColumn } from '../query/batch';
import { type ComponentData, World } from '../world';
import { worldInternal } from '../world-internal';

const Position = defineComponent('BatchPosition', { x: 'f32' });
const Tint = defineComponent('BatchTint', { alpha: 'f32' });
const Active = defineComponent('BatchActive', {}, { storage: 'sparse' });

describe('physical query batches', () => {
  it('reads sparse physical rows and optional columns without gathering', () => {
    const world = new World();
    for (let i = 0; i < 12; i++) {
      const entries: ComponentData[] = [{ component: Position, data: { x: i } }];
      if (i % 2 === 0) entries.push({ component: Tint, data: { alpha: 0.5 } });
      if (i % 3 === 0) entries.push({ component: Active, data: {} });
      world.spawn(...entries).unwrap();
    }
    const query = world.query({ read: [Position], optional: [Tint], with: [Active] }).unwrap();
    let sum = 0;
    const entities: number[] = [];
    for (const batch of query.batches().unwrap()) {
      expect(batch.kind).toBe('indexed');
      if (batch.kind !== 'indexed') throw new Error('Expected sparse row indices');
      const x = batch.read(Position, 'x');
      const alpha = batch.read(Tint, 'alpha');
      for (let i = 0; i < batch.count; i++) {
        const row = batch.rows[i] as number;
        sum += (x[row] as number) * (alpha === undefined ? 1 : (alpha[row] as number));
        entities.push(batch.entities[row] as number);
      }
    }
    expect(sum).toBe(15);
    expect(entities).toEqual(Array.from(query, (row) => row.entity));
  });
});

it('returns original dense columns and physical ranges, with cached preparation', () => {
  const world = new World();
  world.spawn({ component: Position, data: { x: 4 } }).unwrap();
  world.spawn({ component: Position, data: { x: 8 } }).unwrap();
  const query = world.query({ read: [Position] }).unwrap();
  const prepared = query.batches();
  expect(query.batches()).toBe(prepared);
  for (const batch of prepared.unwrap()) {
    if (batch.kind !== 'range') throw new Error('Expected a range');
    expect([batch.start, batch.end, batch.count]).toEqual([0, 2, 2]);
    const table = world[worldInternal].getGraph().tables.find((t) => t.size === 2);
    expect(batch.entities).toBe(table?.entities.view);
    expect(batch.read(Position, 'x')).toBe(
      table?.storage.get(componentId(Position))?.fields.get('x')?.view,
    );
    expectTypeOf(batch.read(Position, 'x')).toEqualTypeOf<ReadonlyColumn<Float32Array>>();
    expectTypeOf<typeof batch.entities>().not.toHaveProperty('set');
  }
});

it('exposes the actual noncontiguous sparse row prefix and preserves membership order', () => {
  const world = new World();
  const entities = Array.from({ length: 9 }, (_, i) =>
    world.spawn({ component: Position, data: { x: i } }).unwrap(),
  );
  for (const i of [2, 7, 1])
    world.addComponent(entities[i] as EntityHandle, { component: Active, data: {} }).unwrap();
  const query = world.query({ read: [Position], with: [Active] }).unwrap();
  for (const batch of query.batches().unwrap()) {
    if (batch.kind !== 'indexed') throw new Error('Expected indices');
    expect(Array.from({ length: batch.count }, (_, i) => batch.rows[i])).toEqual([2, 7, 1]);
    const owner = world[worldInternal].getEntityArchetype(entities[2] as EntityHandle);
    expect(batch.rows).toBe(owner?.rows);
    expect(batch.rows.length).toBeGreaterThan(batch.count);
    expect(batch.read(Position, 'x')[batch.rows[1] as number]).toBe(7);
  }
});

it('distinguishes absent optional columns from present zero values and resolves inline strides', () => {
  const Inline = defineComponent('BatchInline', { values: 'array<f32, 3>', bytes: 'buffer<4>' });
  const world = new World();
  world
    .spawn(
      { component: Position, data: { x: 2 } },
      { component: Tint, data: { alpha: 0 } },
      { component: Inline, data: { values: [1, 2, 3], bytes: new Uint8Array([4, 5, 6, 7]) } },
    )
    .unwrap();
  world.spawn({ component: Position, data: { x: 3 } }).unwrap();
  const query = world.query({ read: [Position], optional: [Tint, Inline] }).unwrap();
  const alphas = [];
  for (const batch of query.batches().unwrap()) {
    const alpha = batch.read(Tint, 'alpha');
    expectTypeOf(alpha).toEqualTypeOf<ReadonlyColumn<Float32Array> | undefined>();
    alphas.push(alpha === undefined ? undefined : alpha[0]);
    expect(batch.stride(Inline, 'values')).toBe(3);
    expect(batch.stride(Inline, 'bytes')).toBe(4);
    const values = batch.read(Inline, 'values');
    if (values !== undefined) expect([values[0], values[1], values[2]]).toEqual([1, 2, 3]);
  }
  expect(alphas).toEqual([0, undefined]);
});

it('rejects managed fields, undeclared components and unknown fields explicitly', () => {
  const Mixed = defineComponent('BatchMixed', { x: 'f32', label: 'string', values: 'array<f32>' });
  expectTypeOf<NumericField<typeof Mixed>>().toEqualTypeOf<'x'>();
  const world = new World();
  world.spawn({ component: Mixed, data: { x: 1, label: 'label', values: [1, 2] } }).unwrap();
  for (const batch of world
    .query({ read: [Mixed] })
    .unwrap()
    .batches()
    .unwrap()) {
    const raw = batch as unknown as { read(c: Component, field: string): unknown };
    expect(() => raw.read(Mixed, 'label')).toThrow(QueryBatchUnavailableError);
    expect(() => raw.read(Mixed, 'values')).toThrow(QueryBatchUnavailableError);
    expect(() => raw.read(Mixed, 'unknown')).toThrow(QueryBatchUnavailableError);
    expect(() => raw.read(Position, 'x')).toThrow(QueryBatchUnavailableError);
    expect(batch.read(Mixed, 'x')[0]).toBe(1);
  }
});

it('expires batch access on advance and close, and releases an unstarted iterator', () => {
  const world = new World();
  world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  world
    .spawn({ component: Position, data: { x: 2 } }, { component: Tint, data: { alpha: 1 } })
    .unwrap();
  const query = world.query({ read: [Position] }).unwrap();
  const prepared = query.batches().unwrap();
  const unopened = prepared[Symbol.iterator]();
  unopened.return?.();
  const iterator = prepared[Symbol.iterator]();
  expect(() => prepared[Symbol.iterator]()).toThrow(QueryIterationActiveError);
  const first = iterator.next();
  if (first.done) throw new Error('Missing batch');
  iterator.next();
  expect(() => first.value.read(Position, 'x')).toThrow(QueryBatchUnavailableError);
  iterator.return?.();
  expect(Array.from(query, (row) => row.entity)).toHaveLength(2);
});

it('invalidates on structure changes before first next or while columns are borrowed', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const query = world.query({ read: [Position] }).unwrap();
  const prepared = query.batches().unwrap();
  const early = prepared[Symbol.iterator]();
  world.spawn({ component: Position, data: { x: 2 } }).unwrap();
  expect(() => early.next()).toThrow(QueryIterationInvalidatedError);
  const iterator = prepared[Symbol.iterator]();
  const first = iterator.next();
  if (first.done) throw new Error('Missing batch');
  world.despawn(entity).unwrap();
  expect(() => first.value.read(Position, 'x')).toThrow(QueryIterationInvalidatedError);
  expect(() => iterator.next()).toThrow(QueryIterationInvalidatedError);
  expect(Array.from(query, (row) => row.entity)).toHaveLength(1);
});

it('refreshes sparse flips, growth, swap-removal and Disabled through the existing query owner', () => {
  const world = new World();
  const entities = Array.from({ length: 140 }, (_, i) =>
    world.spawn({ component: Position, data: { x: i } }).unwrap(),
  );
  const query = world.query({ read: [Position], with: [Active] }).unwrap();
  const prepared = query.batches().unwrap();
  expect(Array.from(prepared)).toHaveLength(0);
  world.addComponent(entities[90] as EntityHandle, { component: Active, data: {} }).unwrap();
  world.addComponent(entities[4] as EntityHandle, { component: Active, data: {} }).unwrap();
  world.addComponent(entities[4] as EntityHandle, { component: Disabled, data: {} }).unwrap();
  world.despawn(entities[0] as EntityHandle).unwrap();
  const observed: number[] = [];
  for (const batch of prepared) {
    if (batch.kind !== 'indexed') throw new Error('Expected indices');
    for (let i = 0; i < batch.count; i++)
      observed.push(batch.entities[batch.rows[i] as number] as number);
  }
  expect(observed).toEqual(Array.from(query, (row) => row.entity));
  expect(observed).toEqual([entities[90]]);
  world.removeComponent(entities[90] as EntityHandle, Active).unwrap();
  expect(Array.from(prepared)).toHaveLength(0);
});

it('reports unsupported write and temporal descriptors without silently changing their semantics', () => {
  const world = new World();
  for (const [descriptor, reason] of [
    [{ write: [Position] }, 'write-access'],
    [{ read: [Position], changed: [Position] }, 'temporal-filter'],
    [{ read: [Position], added: [Position] }, 'temporal-filter'],
  ] as const) {
    const query = world.query(descriptor).unwrap();
    const result = query.batches();
    expect(query.batches()).toBe(result);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe(reason);
  }
});

it('never revives an expired batch when the next traversal reuses its lease', () => {
  const world = new World();
  world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const prepared = world
    .query({ read: [Position] })
    .unwrap()
    .batches()
    .unwrap();
  const first = prepared[Symbol.iterator]();
  const step = first.next();
  if (step.done) throw new Error('Missing batch');
  first.return?.();
  const second = prepared[Symbol.iterator]();
  expect(() => step.value.read(Position, 'x')).toThrow(QueryBatchUnavailableError);
  second.return?.();
});

it('does not let an old iterator return close a newer traversal', () => {
  const world = new World();
  world.spawn({ component: Position, data: { x: 7 } }).unwrap();
  const query = world.query({ read: [Position] }).unwrap();
  const prepared = query.batches().unwrap();
  const first = prepared[Symbol.iterator]();
  first.next();
  first.return?.();
  const second = prepared[Symbol.iterator]();
  first.return?.();
  const step = second.next();
  if (step.done) throw new Error('Missing current batch');
  expect(step.value.read(Position, 'x')[0]).toBe(7);
  expect(() => query[Symbol.iterator]()).toThrow(QueryIterationActiveError);
  second.return?.();
});

it('keeps old close calls from unlocking row and span iterations', () => {
  const world = new World();
  world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const query = world.query({ read: [Position] }).unwrap();
  for (const mode of ['row', 'span'] as const) {
    const old = query.batches().unwrap()[Symbol.iterator]();
    while (!old.next().done) {
      /* fully consume */
    }
    const current =
      mode === 'row' ? query[Symbol.iterator]() : query.spans().unwrap()[Symbol.iterator]();
    old.return?.();
    expect(() => query[Symbol.iterator]()).toThrow(QueryIterationActiveError);
    current.return?.();
  }
});

it('fences active derived writes before exposing columns and releases failed traversal state', () => {
  const world = new World();
  world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const owner = world[worldInternal];
  const prepared = world
    .query({ read: [Position] })
    .unwrap()
    .batches()
    .unwrap();
  owner.beginDerivedWrite();
  expect(() => prepared[Symbol.iterator]()).toThrow('derived');
  owner.endDerivedWrite();
  const iterator = prepared[Symbol.iterator]();
  const batch = iterator.next();
  if (batch.done) throw new Error('Missing batch');
  owner.beginDerivedWrite();
  expect(() => batch.value.read(Position, 'x')).toThrow('derived');
  expect(() => iterator.next()).toThrow('derived');
  owner.endDerivedWrite();
  expect(Array.from(prepared)).toHaveLength(1);
});
