import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { ChangeEpochExhaustedError } from '../errors';
import { getDerivedWriter } from '../internal';
import { createStateProjection } from '../projection/state-projection';
import {
  beginDerivedRangeAllocationTrace,
  endDerivedRangeAllocationTrace,
} from '../query/derived-range-writer';
import type { Query } from '../query/query';
import { readComponentChanged } from '../storage/change-detection';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Value = defineComponent('DerivedRangeWriterValue', { value: 'f32' });
const Input = defineComponent('DerivedRangeWriterInput', { value: 'f32' });

function fixture(): {
  world: World;
  query: Query<readonly [typeof Input], readonly [typeof Value]>;
} {
  const world = new World();
  for (let index = 0; index < 4; index += 1) {
    world
      .spawn(
        { component: Input, data: { value: index } },
        { component: Value, data: { value: index } },
      )
      .unwrap();
  }
  const query = world.query({ read: [Input], write: [Value] }).unwrap();
  return { world, query };
}

describe('package-internal derived range writer contract', () => {
  it('locates binding zero and new tables across migration without changing failed cursors', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    let entity: EntityHandle | undefined;
    for (const row of query) {
      entity = row.entity;
      break;
    }
    if (entity === undefined) throw new Error('missing fixture entity');
    const cursor = { bindingIndex: -1, row: -1 };
    expect(writer.locateEntity(entity, cursor)).toBe(true);
    expect(cursor.bindingIndex).toBe(0);
    const first = writer.bindings[0];
    if (first === undefined) throw new Error('missing first binding');
    expect(writer.bindingOfTable(first.tableId)).toBe(0);

    const Extra = defineComponent('DerivedLocatedExtra', {});
    world.addComponent(entity, { component: Extra, data: {} }).unwrap();
    expect(writer.locateEntity(entity, cursor)).toBe(true);
    expect(cursor.bindingIndex).toBe(1);
    expect(writer.bindings[0]).toBe(first);
    const second = writer.bindings[1];
    if (second === undefined) throw new Error('missing new table binding');
    expect(writer.bindingOfTable(second.tableId)).toBe(1);

    const unmatched = world.spawn().unwrap();
    const retained = { ...cursor };
    expect(writer.locateEntity(unmatched, cursor)).toBe(false);
    expect(cursor).toEqual(retained);
    world.removeComponent(entity, Extra).unwrap();
    expect(writer.locateEntity(entity, cursor)).toBe(true);
    expect(cursor.bindingIndex).toBe(0);

    world.despawn(entity).unwrap();
    const replacement = world
      .spawn({ component: Input, data: {} }, { component: Value, data: {} })
      .unwrap();
    const beforeStale = { ...cursor };
    expect(writer.locateEntity(entity, cursor)).toBe(false);
    expect(cursor).toEqual(beforeStale);
    expect(writer.locateEntity(replacement, cursor)).toBe(true);
    expect(cursor.bindingIndex).toBe(0);
  });

  it('rejects nested writers on the same World without overwriting pending row publication', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const other = getDerivedWriter(
      world.query({ read: [Input], write: [Value] }).unwrap(),
      Value,
    ).unwrap();
    const projection = createStateProjection(world, [Value]);
    projection.read().accept();
    let nestedCalled = false;
    const binding = writer.bindings[0];
    if (!binding) throw new Error('expected a fixture binding');
    const result = writer.writeRows([0, 0, 0, 2], () => {
      binding.write.value[0] = 10;
      for (const nested of [writer, other]) {
        const rejected = nested.writeRange(
          0,
          0,
          3,
          1,
          () => {
            nestedCalled = true;
          },
          undefined,
        );
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.code).toBe('derived-write-active');
      }
      binding.write.value[2] = 12;
    });
    expect(result.ok).toBe(true);
    expect(nestedCalled).toBe(false);
    expect(world.execution.health).toBe('healthy');
    expect(projection.read().indices).toEqual([0, 2]);
  });

  it('rejects change reads and cursor acceptance until the World write is published', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const projection = createStateProjection(world, [Value]);
    projection.read().accept();
    const pending = projection.read();
    const changed = world.query({ read: [Value], changed: [Value] }).unwrap();
    const spans = world.query({ read: [Value], changed: [Value] }).unwrap();
    Array.from(changed);
    Array.from(spans.spans().unwrap());
    const held = changed[Symbol.iterator]();
    const result = writer.writeRange(
      0,
      0,
      0,
      1,
      (binding) => {
        binding.write.value[0] = 7;
        expect(projection.isCurrent()).toBe(false);
        for (const read of [
          () => projection.read(),
          () => pending.validate(),
          () => pending.accept(),
          () => held.next(),
          () => Array.from(spans.spans().unwrap()),
        ]) {
          expect(read).toThrowError(expect.objectContaining({ code: 'derived-write-active' }));
        }
      },
      undefined,
    );
    expect(result.ok).toBe(true);
    expect(projection.read().indices).toEqual([0]);
    expect(Array.from(changed, (row) => row.entity)).toHaveLength(1);
    expect(
      Array.from(spans.spans().unwrap()).flatMap((span) => Array.from(span.entities)),
    ).toHaveLength(1);
  });

  it.each([
    'staging',
    'invalid-pair',
    'odd-pair',
  ])('poisons unexpected %s failure after producer writes', (kind) => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const projection = createStateProjection(world, [Value]);
    projection.read().accept();
    const rows: number[] = [];
    if (kind === 'staging')
      Object.defineProperty(rows, 'push', {
        value: () => {
          throw new Error('staging allocation fault');
        },
      });
    const result = writer.writeRows(rows, () => {
      const binding = writer.bindings[0];
      if (binding === undefined) throw new Error('missing binding');
      binding.write.value[0] = 7;
      if (kind === 'odd-pair') rows.push(0);
      else rows.push(0, kind === 'invalid-pair' ? 999 : 0);
    });
    expect(result.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(world[worldInternal].isDerivedWriteActive()).toBe(false);
    expect(() => projection.read()).toThrowError(
      expect.objectContaining({ code: 'world-poisoned' }),
    );
  });

  it('preserves newer callback mutations while poisoning an invalid numeric producer', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const first = Array.from(world.query({ read: [Value] }).unwrap(), (row) => row.entity)[0];
    if (first === undefined) throw new Error('missing entity');
    const before = world[worldInternal].getMutationEpoch();
    let nestedEpoch = 0;
    const result = writer.writeRange(
      0,
      0,
      2,
      1,
      (binding) => {
        binding.write.value[2] = 7;
        world.set(first, Value, { value: 99 }).unwrap();
        nestedEpoch = world[worldInternal].getMutationEpoch();
      },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(nestedEpoch).toBeGreaterThan(before);
    expect(world[worldInternal].getMutationEpoch()).toBe(nestedEpoch);
    expect(world.execution.health).toBe('poisoned');
  });
  it('preserves unrelated bindings and refreshes only the column owner that grew', () => {
    const { world, query } = fixture();
    const Extra = defineComponent('DerivedBindingExtra', {});
    const Other = defineComponent('DerivedBindingOther', {});
    world
      .spawn(
        { component: Input, data: {} },
        { component: Value, data: {} },
        { component: Extra, data: {} },
      )
      .unwrap();
    const writer = getDerivedWriter(query, Value).unwrap();
    const first = writer.bindings[0];
    const second = writer.bindings[1];
    if (first === undefined || second === undefined) throw new Error('missing bound owners');
    const firstRead = first.read;
    const secondRead = second.read;
    const unrelated = world.spawn().unwrap();
    beginDerivedRangeAllocationTrace();
    world.addComponent(unrelated, { component: Other, data: {} }).unwrap();
    expect(writer.bindings[0]).toBe(first);
    expect(writer.bindings[1]).toBe(second);
    expect(first.read).toBe(firstRead);
    expect(second.read).toBe(secondRead);
    expect(endDerivedRangeAllocationTrace().bindingRebuilds).toBe(0);
    for (let i = 0; i < 70; i++)
      world.spawn({ component: Input, data: {} }, { component: Value, data: {} }).unwrap();
    beginDerivedRangeAllocationTrace();
    expect(writer.bindings[0]).toBe(first);
    expect(first.rowCapacity).toBe(74);
    expect(first.read === firstRead).toBe(false);
    expect(second.read).toBe(secondRead);
    expect(endDerivedRangeAllocationTrace().bindingRebuilds).toBe(1);
    writer
      .writeRange(
        0,
        0,
        73,
        1,
        (binding, _base, start) => {
          binding.write.value[start] = 42;
        },
        undefined,
      )
      .unwrap();
    expect(first.write.value[73]).toBe(42);
  });
  it('publishes only the exact span-relative range with one component epoch', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    const projection = createStateProjection(world, [Value]);
    projection.read().accept();

    expect(
      writer.writeRange(
        0,
        0,
        1,
        2,
        (binding, _base, start, count) => {
          expect(count).toBe(2);
          binding.write.value[start] = 11;
          binding.write.value[start + 1] = 12;
        },
        undefined,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch + 1);
    const values: number[] = [];
    for (const row of world.query({ read: [Value] }).unwrap()) {
      values.push(row.get(Value).value);
    }
    expect(values).toEqual([0, 11, 12, 3]);
    const candidate = projection.read();
    expect(candidate.indices).toEqual([1, 2]);
    expect(candidate.scannedRows).toBe(2);
    expect(candidate.checkedBlocks).toBe(0);

    const changedAt = (slot: number) =>
      readComponentChanged(
        world[worldInternal].graph,
        world[worldInternal].records,
        slot,
        componentId(Value),
      ) ?? 0;
    const epochs = Float64Array.from({ length: 4 }, (_, slot) => changedAt(slot));
    expect(epochs?.slice(0, 4)).toEqual(new Float64Array([1, beforeEpoch + 1, beforeEpoch + 1, 4]));
  });

  it('does not call the kernel or consume an epoch for a zero-length range', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    let called = false;
    expect(
      writer.writeRange(
        0,
        0,
        2,
        0,
        () => {
          called = true;
        },
        undefined,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(called).toBe(false);
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch);
  });

  it('publishes contiguous and isolated row pairs with one epoch', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    const binding = writer.bindings[0];
    if (!binding) throw new Error('expected a fixture binding');
    const result = writer.writeRows([0, 0, 0, 1, 0, 3], () => {
      for (const row of [0, 1, 3]) binding.write.value[row] = row + 10;
    });
    expect(result).toEqual({ ok: true, value: 2 });
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch + 1);
    const values: number[] = [];
    for (const row of world.query({ read: [Value] }).unwrap()) values.push(row.get(Value).value);
    expect(values).toEqual([10, 11, 2, 13]);
    const changedAt = (slot: number) =>
      readComponentChanged(
        world[worldInternal].graph,
        world[worldInternal].records,
        slot,
        componentId(Value),
      ) ?? 0;
    const epochs = Float64Array.from({ length: 4 }, (_, slot) => changedAt(slot));
    expect(epochs).toEqual(
      new Float64Array([beforeEpoch + 1, beforeEpoch + 1, 3, beforeEpoch + 1]),
    );
  });

  it('leaves the epoch untouched when the producer has no row pairs', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const owner = world[worldInternal];
    const beforeEpoch = owner.getMutationEpoch();
    expect(
      writer
        .writeRows([], () => {
          expect(owner.getMutationEpoch()).toBe(beforeEpoch);
        })
        .unwrap(),
    ).toBe(0);
    expect(owner.getMutationEpoch()).toBe(beforeEpoch);
  });

  it('publishes a later binding without republishing the earlier row pairs', () => {
    const { world, query } = fixture();
    const Extra = defineComponent('DerivedRowPairsExtra', {});
    for (let row = 0; row < 4; row++)
      world
        .spawn(
          { component: Input, data: {} },
          { component: Value, data: {} },
          { component: Extra, data: {} },
        )
        .unwrap();
    const writer = getDerivedWriter(query, Value).unwrap();
    const projection = createStateProjection(world, [Value]);
    projection.read().accept();
    const [firstBinding, secondBinding] = writer.bindings;
    if (!firstBinding || !secondBinding) throw new Error('expected two bindings');
    writer
      .writeRows([0, 0, 0, 2], () => {
        firstBinding.write.value[0] = 10;
        firstBinding.write.value[2] = 10;
      })
      .unwrap();
    const first = projection.read();
    expect(first.indices).toEqual([0, 2]);
    first.accept();
    writer
      .writeRows([1, 2], () => {
        secondBinding.write.value[2] = 10;
      })
      .unwrap();
    expect(projection.read().indices).toEqual([6]);
  });

  it('poisons without publishing when a row producer fails after touching output', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const owner = world[worldInternal];
    const beforeEpoch = owner.getMutationEpoch();
    const binding = writer.bindings[0];
    if (!binding) throw new Error('expected a fixture binding');
    const failed = writer.writeRows([0, 0], () => {
      binding.write.value[0] = 31;
      throw new Error('partial row write');
    });
    expect(failed.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(owner.getMutationEpoch()).toBe(beforeEpoch);
    expect(readComponentChanged(owner.graph, owner.records, 0, componentId(Value))).toBe(1);
    expect(writer.writeRows([], () => {}).ok).toBe(false);
  });

  it('rejects an out-of-bounds range before the kernel and permits same-cursor retry', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    const failed = writer.writeRange(
      0,
      0,
      3,
      2,
      () => {
        throw new Error('kernel must not run');
      },
      undefined,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.error.code === 'derived-range-out-of-bounds') {
      expect(failed.error.code).toBe('derived-range-out-of-bounds');
      expect(failed.error.expected).toContain('span-relative range');
      expect(failed.error.hint).toContain('start');
      expect(failed.error.detail).toMatchObject({ start: 3, count: 2 });
    }
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch);
    expect(
      writer.writeRange(
        0,
        0,
        2,
        1,
        (binding, _base, start) => {
          binding.write.value[start] = 22;
        },
        undefined,
      ).ok,
    ).toBe(true);
  });

  it('keeps state on epoch exhaustion and poisons after a partial kernel write', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    const originalNextEpoch = world[worldInternal].nextMutationEpoch;
    Object.defineProperty(world[worldInternal], 'nextMutationEpoch', {
      configurable: true,
      value: () => {
        throw new ChangeEpochExhaustedError(Number.MAX_SAFE_INTEGER);
      },
    });
    const exhausted = writer.writeRange(
      0,
      0,
      0,
      1,
      () => {
        throw new Error('kernel must not run');
      },
      undefined,
    );
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error.code).toBe('change-epoch-exhausted');
    expect(world.execution.health).toBe('healthy');
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch);
    Object.defineProperty(world[worldInternal], 'nextMutationEpoch', {
      configurable: true,
      value: originalNextEpoch,
    });

    expect(
      writer.writeRange(
        0,
        0,
        1,
        1,
        (binding) => {
          binding.write.value[1] = 11;
        },
        undefined,
      ).ok,
    ).toBe(true);
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch + 1);

    const partial = writer.writeRange(
      0,
      0,
      0,
      2,
      (binding) => {
        binding.write.value[0] = 31;
        throw new Error('partial kernel failure');
      },
      undefined,
    );
    expect(partial.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    const owner = world[worldInternal];
    expect(owner.getMutationEpoch()).toBe(beforeEpoch + 1);
    expect(readComponentChanged(owner.graph, owner.records, 0, componentId(Value))).toBe(1);
    expect(writer.writeRange(0, 0, 0, 1, () => undefined, undefined).ok).toBe(false);
  });
});
