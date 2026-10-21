import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { ChangeEpochExhaustedError } from '../errors';
import { getDerivedWriter } from '../internal';
import { createStateProjection } from '../projection/state-projection';
import {
  beginDerivedRangeAllocationTrace,
  endDerivedRangeAllocationTrace,
} from '../query/derived-range-writer';
import type { Query } from '../query/query';
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
  it('rejects nested writers on the same World without overwriting deferred runs', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const other = getDerivedWriter(
      world.query({ read: [Input], write: [Value] }).unwrap(),
      Value,
    ).unwrap();
    const projection = createStateProjection(world, [Value]);
    projection.read().accept();
    let nestedCalled = false;
    const result = writer.probeAndCommitRange(
      0,
      0,
      0,
      4,
      (_binding, row) => row === 0 || row === 2,
      (binding, row) => {
        binding.write.value[row] = row + 10;
        if (row === 2) {
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
        }
      },
      undefined,
    );
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

    const index = world[worldInternal].getComponentChangeIndex(componentId(Value));
    const epochs = Float64Array.from({ length: 4 }, (_, slot) => index?.get(slot) ?? 0);
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

  it('probes each row once and commits only the exact changed runs', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    let probes = 0;
    let commits = 0;
    const result = writer.probeAndCommitRange(
      0,
      0,
      0,
      4,
      (_binding, row) => {
        probes += 1;
        return row === 1 || row === 3;
      },
      (binding, row) => {
        commits += 1;
        binding.write.value[row] = row + 10;
      },
      undefined,
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(probes).toBe(4);
    expect(commits).toBe(2);
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch + 1);
    const values: number[] = [];
    for (const row of world.query({ read: [Value] }).unwrap()) values.push(row.get(Value).value);
    expect(values).toEqual([0, 11, 2, 13]);
    const index = world[worldInternal].getComponentChangeIndex(componentId(Value));
    const epochs = Float64Array.from({ length: 4 }, (_, slot) => index?.get(slot) ?? 0);
    expect(epochs?.[1]).toBe(beforeEpoch + 1);
    expect(epochs?.[3]).toBe(beforeEpoch + 1);
  });

  it('poisons the World when a changed-row commit fails after partial output', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const failed = writer.probeAndCommitRange(
      0,
      0,
      0,
      2,
      () => true,
      (binding, row) => {
        binding.write.value[row] = 31;
        if (row === 1) throw new Error('partial row commit failure');
      },
      undefined,
    );
    expect(failed.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(
      writer.probeAndCommitRange(
        0,
        0,
        0,
        1,
        () => false,
        () => undefined,
        undefined,
      ).ok,
    ).toBe(false);
  });

  it('keeps the World healthy when the initial epoch reservation is exhausted', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const rows = query[Symbol.iterator]();
    const first = rows.next();
    const firstEntity = first.done ? undefined : first.value.entity;
    rows.return?.();
    if (firstEntity === undefined) throw new Error('expected a fixture entity');
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    const originalNextEpoch = world[worldInternal].nextMutationEpoch;
    Object.defineProperty(world[worldInternal], 'nextMutationEpoch', {
      configurable: true,
      value: () => {
        throw new ChangeEpochExhaustedError(Number.MAX_SAFE_INTEGER);
      },
    });
    try {
      let commits = 0;
      const failed = writer.probeAndCommitRange(
        0,
        0,
        0,
        2,
        (_binding, row) => row === 0,
        (binding, row) => {
          commits += 1;
          binding.write.value[row] = 10;
        },
        undefined,
      );
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe('change-epoch-exhausted');
      expect(commits).toBe(0);
      expect(world.execution.health).toBe('healthy');
      expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch);
      expect(world.get(firstEntity, Value).unwrap().value).toBe(0);
      const index = world[worldInternal].getComponentChangeIndex(componentId(Value));
      const epochs = Float64Array.from({ length: 4 }, (_, slot) => index?.get(slot) ?? 0);
      expect(epochs?.slice(0, 4)).toEqual(new Float64Array([1, 2, 3, 4]));
    } finally {
      Object.defineProperty(world[worldInternal], 'nextMutationEpoch', {
        configurable: true,
        value: originalNextEpoch,
      });
    }

    const retried = writer.probeAndCommitRange(
      0,
      0,
      0,
      2,
      () => true,
      (binding, row) => {
        binding.write.value[row] = 10;
      },
      undefined,
    );
    expect(retried.ok).toBe(true);
    expect(world.execution.health).toBe('healthy');
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch + 1);
    expect(world.get(firstEntity, Value).unwrap().value).toBe(10);
  });

  it('poisons and restores the epoch when a later sparse probe fails', () => {
    const { world, query } = fixture();
    const writer = getDerivedWriter(query, Value).unwrap();
    const rows = query[Symbol.iterator]();
    const first = rows.next();
    const firstEntity = first.done ? undefined : first.value.entity;
    rows.return?.();
    if (firstEntity === undefined) throw new Error('expected a fixture entity');
    const beforeEpoch = world[worldInternal].getMutationEpoch();
    const failed = writer.probeAndCommitRange(
      0,
      0,
      0,
      3,
      (_binding, row) => {
        if (row === 2) throw new Error('later sparse probe failure');
        return row === 0;
      },
      (binding, row) => {
        binding.write.value[row] = row + 10;
      },
      undefined,
    );
    expect(failed.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch);
    expect(world.get(firstEntity, Value).unwrap().value).toBe(10);
    const index = world[worldInternal].getComponentChangeIndex(componentId(Value));
    const epochs = Float64Array.from({ length: 4 }, (_, slot) => index?.get(slot) ?? 0);
    expect(epochs?.slice(0, 4)).toEqual(new Float64Array([1, 2, 3, 4]));
    expect(
      writer.probeAndCommitRange(
        0,
        0,
        0,
        1,
        () => false,
        () => undefined,
        undefined,
      ).ok,
    ).toBe(false);
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
    expect(world[worldInternal].getMutationEpoch()).toBe(beforeEpoch);
    Object.defineProperty(world[worldInternal], 'nextMutationEpoch', {
      configurable: true,
      value: originalNextEpoch,
    });

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
    expect(writer.writeRange(0, 0, 0, 1, () => undefined, undefined).ok).toBe(false);
  });
});
