import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import {
  assemblePreparedPlan,
  rebasePreparedBatchRows,
} from '../gpu-driven/production-raster-prepare';
import { GpuScene } from '../gpu-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

function fixture() {
  const f = createFilterPlanFixture({ instances: 65 });
  const prepared = f.prepare();
  const first = prepared.residentRows[0],
    row = prepared.residentRows[1];
  if (first === undefined || row === undefined) throw Error('missing real prepared rows');
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const available = GpuScene.create(device, 8).unwrap();
  if (available.status !== 'available') throw Error('missing GPU Scene');
  const scene = available.scene;
  scene
    .sync({
      created: f.slots.length,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [...f.slots],
      updatedSlots: [],
      contentUpdatedSlots: [],
      instanceUpdatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      previous: new Map(),
      resynced: 0,
    })
    .unwrap();
  const context = { scene, device };
  const owner = new FilteredPlanContributionOwner();
  const active = { ...prepared.source, batches: [first.origin], candidateCount: 65 };
  const partial = assemblePreparedPlan(prepared.source, [first], active);
  owner.update(partial, undefined, undefined, context);
  const input = {
    plan: prepared.source,
    index: 1,
    row,
    taskContext: context,
    isCurrent: () => true,
  };
  return {
    ...f,
    scene,
    inputs: scene.inputs,
    owner,
    context,
    prepared,
    first,
    row,
    partial,
    input,
    close() {
      try {
        owner.clear();
      } finally {
        scene.dispose();
      }
    },
  };
}

it('acquires successor custody before retiring a value-equivalent ordinary row rebase', () => {
  const f = fixture();
  const events: string[] = [];
  const hold = f.inputs.holdHeader.bind(f.inputs);
  const spy = vi.spyOn(f.inputs, 'holdHeader').mockImplementation((header, batch) => {
    const release = hold(header, batch);
    events.push('acquire');
    return () => {
      events.push('release');
      release();
    };
  });
  try {
    f.owner.prepareContribution(f.input).unwrap();
    const written = f.inputs.taskHeadersWritten;
    const next = rebasePreparedBatchRows(f.row, Object.freeze({ ...f.row.source }), f.row.origin);
    const source = {
      ...f.prepared.source,
      batches: [f.first.origin, next.origin],
      candidateCount: 130,
    };
    events.length = 0;
    f.owner.update(
      assemblePreparedPlan(f.prepared.source, [f.first, next], source),
      undefined,
      undefined,
      f.context,
    );
    expect(events).toEqual(['acquire', 'release']);
    expect(f.inputs.taskHeadersWritten).toBe(written);
    expect(f.inputs.taskHeadersReleased).toBe(0);
  } finally {
    spy.mockRestore();
    f.close();
  }
});

it.each([
  'release',
  'profile',
] as const)('does not publish ordinary work after %s clears its epoch', (operation) => {
  const f = fixture();
  const acquire = f.inputs.holdHeader.bind(f.inputs);
  let clear = false;
  const spy = vi.spyOn(f.inputs, 'holdHeader').mockImplementation((header, batch) => {
    const release = acquire(header, batch);
    return () => {
      release();
      if (clear) {
        clear = false;
        f.owner.clear();
      }
    };
  });
  try {
    f.owner.prepareContribution(f.input).unwrap();
    const next = rebasePreparedBatchRows(f.row, Object.freeze({ ...f.row.source }), f.row.origin);
    const third = f.prepared.residentRows[2];
    if (third === undefined) throw Error('missing the ordinary row after the callback');
    const prepared = assemblePreparedPlan(f.prepared.source, [f.first, next, third]);
    clear = operation === 'release';
    expect(() =>
      f.owner.update(
        prepared,
        undefined,
        operation === 'profile'
          ? (_part, action) => {
              const result = action();
              f.owner.clear();
              return result;
            }
          : undefined,
        f.context,
      ),
    ).toThrow();
    expect(Reflect.get(f.owner, 'publication')).toBeUndefined();
    expect(Reflect.get(f.owner, 'rows').size).toBe(0);
    expect(f.inputs.taskHeadersReleased).toBe(f.inputs.taskHeadersWritten);
    f.owner.update(f.partial, undefined, undefined, f.context);
  } finally {
    spy.mockRestore();
    f.close();
  }
});

it.each([
  'reject',
  'clear',
] as const)('retires a staged physical header after the final source guard %s', (operation) => {
  const f = fixture();
  let checks = 0;
  try {
    const result = f.owner.prepareContribution({
      ...f.input,
      isCurrent() {
        if (++checks !== 3) return true;
        if (operation === 'clear') {
          f.owner.clear();
          return true;
        }
        return false;
      },
    });
    expect(result.ok).toBe(false);
    expect(checks).toBe(3);
    expect(f.inputs.taskHeadersWritten).toBeGreaterThan(0);
    expect(f.inputs.taskHeadersReleased).toBe(f.inputs.taskHeadersWritten);
    expect(Reflect.get(f.owner, 'failure')).toBeUndefined();
    f.owner.update(f.partial, undefined, undefined, f.context);
    f.owner.prepareContribution(f.input).unwrap();
  } finally {
    f.close();
  }
});

it.each([false, true])('keeps unknown header acquisition effects sticky (after=%s)', (after) => {
  const f = fixture();
  const acquire = f.inputs.holdHeader.bind(f.inputs);
  const fault = Error('header acquisition effect is unknown');
  const spy = vi.spyOn(f.inputs, 'holdHeader').mockImplementation((header, batch) => {
    if (after) acquire(header, batch);
    throw fault;
  });
  try {
    expect(() => f.owner.prepareContribution(f.input)).toThrow(AggregateError);
    expect(Reflect.get(f.owner, 'failure').headers.size).toBe(1);
    spy.mockRestore();
    expect(() => f.owner.clear()).toThrow(AggregateError);
    expect(f.owner.prepareContribution(f.input).ok).toBe(false);
    expect(() => f.owner.update(f.partial, undefined, undefined, f.context)).toThrow();
  } finally {
    spy.mockRestore();
    expect(() => f.close()).toThrow(AggregateError);
    expect(f.inputs.arena.live).toBe(false);
  }
});

it.each([
  false,
  true,
])('attempts all row retirement and retains unknown header release (after=%s)', (after) => {
  const f = fixture();
  const acquire = f.inputs.holdHeader.bind(f.inputs);
  const releases: number[] = [];
  const spy = vi.spyOn(f.inputs, 'holdHeader').mockImplementation((header, batch) => {
    const release = acquire(header, batch);
    return () => {
      releases.push(header.address);
      if (after) release();
      throw Error('unknown physical release');
    };
  });
  try {
    f.owner.prepareContribution(f.input).unwrap();
    const third = f.prepared.residentRows[2];
    if (third === undefined) throw Error('missing independent third row');
    f.owner.prepareContribution({ ...f.input, index: 2, row: third }).unwrap();
    expect(f.inputs.taskHeadersWritten).toBe(2);
    expect(() => f.owner.clear()).toThrow(AggregateError);
    expect(new Set(releases).size).toBe(2);
    expect(Reflect.get(f.owner, 'failure').headers.size).toBe(2);
    expect(() => f.owner.clear()).toThrow(AggregateError);
    expect(Reflect.get(f.owner, 'failure').headers.size).toBe(2);
  } finally {
    spy.mockRestore();
    expect(() => f.close()).toThrow(AggregateError);
  }
});

it('retires inactive header ownership when ordinary membership removes the row', () => {
  const f = fixture();
  try {
    f.owner.prepareContribution(f.input).unwrap();
    const only = assemblePreparedPlan(f.partial.source, [f.first]);
    f.owner.update(only, undefined, undefined, f.context);
    expect(f.inputs.taskHeadersReleased).toBe(f.inputs.taskHeadersWritten);
  } finally {
    f.close();
  }
});
