import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { ChangeEpochExhaustedError } from '../errors';
import { getDerivedWriter } from '../internal';
import { createStateProjection } from '../projection/state-projection';
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
    expect(candidate.scannedRows).toBe(4);

    const graph = world[worldInternal].getGraph();
    const record = world[worldInternal].getRecords()[0];
    const table = graph.tables[graph.archetypes[record?.archetypeId ?? -1]?.tableId ?? -1];
    const epochs = table?.storage.get(componentId(Value))?.epochs.changed;
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
    const graph = world[worldInternal].getGraph();
    const record = world[worldInternal].getRecords()[0];
    const table = graph.tables[graph.archetypes[record?.archetypeId ?? -1]?.tableId ?? -1];
    const epochs = table?.storage.get(componentId(Value))?.epochs.changed;
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
      const graph = world[worldInternal].getGraph();
      const record = world[worldInternal].getRecords()[0];
      const table = graph.tables[graph.archetypes[record?.archetypeId ?? -1]?.tableId ?? -1];
      const epochs = table?.storage.get(componentId(Value))?.epochs.changed;
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
    const graph = world[worldInternal].getGraph();
    const record = world[worldInternal].getRecords()[0];
    const table = graph.tables[graph.archetypes[record?.archetypeId ?? -1]?.tableId ?? -1];
    const epochs = table?.storage.get(componentId(Value))?.epochs.changed;
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
