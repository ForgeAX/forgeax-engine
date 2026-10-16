import type { ArrayRangesChange } from '@forgeax/engine-ecs/projection';
import { describe, expect, it } from 'vitest';
import {
  type InstanceCollectionSnapshot,
  InstanceProjectionStore,
  instancePreviousPairing,
  planInstanceUpload,
} from '../instances';

function projected<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw value;
  return value as Exclude<T, Error>;
}

/** Authored column with a hand-driven range log (element ranges). */
class Column {
  readonly values: Float32Array;
  epoch = 1;
  private log: { epoch: number; start: number; end: number }[] = [];
  whole = false;

  constructor(rows: number) {
    this.values = new Float32Array(rows * 16);
    for (let row = 0; row < rows; row += 1) this.values[row * 16 + 12] = row;
  }

  write(row: number, x: number): void {
    this.epoch += 1;
    this.values[row * 16 + 12] = x;
    this.log.push({ epoch: this.epoch, start: row * 16, end: row * 16 + 16 });
  }

  source() {
    const epoch = this.epoch;
    return {
      epoch,
      changedSince: (since: number): ArrayRangesChange =>
        this.whole
          ? 'whole'
          : this.log
              .filter((entry) => entry.epoch > since)
              .map(({ start, end }) => ({ start, end })),
    };
  }
}

function step(store: InstanceProjectionStore, world: object, column: Column) {
  const snapshot = projected(store.project(world, 1, column.values, column.source()));
  store.accept(world, 1, snapshot);
  return snapshot;
}

describe('instance row projection', () => {
  it('projects only written rows and ping-pongs two owned buffers', () => {
    const store = new InstanceProjectionStore();
    const world = {};
    const column = new Column(1000);
    const first = step(store, world, column);
    expect(first.dirtyRanges).toBeUndefined();
    const before = store.inspectWork();

    column.write(500, 42);
    const second = step(store, world, column);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.dirtyRanges).toEqual([{ start: 500, end: 501 }]);
    expect(second.transforms).not.toBe(first.transforms);
    expect(second.transforms[500 * 16 + 12]).toBe(42);
    // The retained revision stays intact while its successor is in flight.
    expect(first.transforms[500 * 16 + 12]).toBe(500);
    expect(second.generations).toBe(first.generations);

    column.write(7, -1);
    const third = step(store, world, column);
    expect(third.dirtyRanges).toEqual([{ start: 7, end: 8 }]);
    // Revision r + 2 reuses the buffer of revision r, refreshed on r + 1's rows.
    expect(third.transforms).toBe(first.transforms);
    expect(Array.from(third.transforms)).toEqual(Array.from(column.values));

    const work = store.inspectWork();
    expect(work.fullProjections - before.fullProjections).toBe(0);
    expect(work.rowProjections - before.rowProjections).toBe(2);
    // First row pass seeds the back buffer (1000 rows); later passes are O(rows).
    expect(work.rows - before.rows).toBeLessThanOrEqual(1000 + 4);
  });

  it('keeps the revision when a written row did not change', () => {
    const store = new InstanceProjectionStore();
    const world = {};
    const column = new Column(8);
    const first = step(store, world, column);
    column.write(3, 3);
    expect(step(store, world, column)).toBe(first);
  });

  it('falls back to the full column when the source cannot prove ranges', () => {
    const store = new InstanceProjectionStore();
    const world = {};
    const column = new Column(8);
    step(store, world, column);
    column.write(2, 9);
    column.whole = true;
    const snapshot = step(store, world, column);
    expect(snapshot.dirtyRanges).toBeUndefined();
    expect(store.inspectWork().fullProjections).toBe(2);
  });

  it('rejects a non-finite written row without publishing a revision', () => {
    const store = new InstanceProjectionStore();
    const world = {};
    const column = new Column(8);
    const first = step(store, world, column);
    column.write(4, Number.NaN);
    const failed = store.project(world, 1, column.values, column.source());
    expect(failed).toBeInstanceOf(Error);
    column.write(4, 1);
    expect(step(store, world, column).revision).toBe(first.revision + 1);
  });
});

describe('instance upload plan', () => {
  const generations = new Uint32Array([1, 2, 3, 4]);
  const subject = (
    revision: number,
    dirtyRanges?: InstanceCollectionSnapshot['dirtyRanges'],
  ): InstanceCollectionSnapshot => ({
    collectionId: 1 as InstanceCollectionSnapshot['collectionId'],
    revision,
    count: 4,
    transforms: new Float32Array(64),
    generations,
    ...(dirtyRanges === undefined ? {} : { dirtyRanges }),
  });

  it('pairs only the immediately preceding revision by ordinal', () => {
    const current = subject(5, [{ start: 1, end: 2 }]);
    expect(instancePreviousPairing(current, undefined)).toBe('none');
    expect(instancePreviousPairing(current, current)).toBe('none');
    expect(instancePreviousPairing(current, subject(4))).toBe('prior');
    expect(instancePreviousPairing(current, subject(3))).toBe('unpaired');
  });

  it('uploads dirty rows plus the rows whose previous matrix is stale', () => {
    const current = subject(5, [{ start: 3, end: 4 }]);
    const plan = planInstanceUpload({
      activeIsNew: false,
      resident: { uploadedRevision: 4, uploadedMotionRows: [{ start: 1, end: 2 }] },
      current,
      pairing: 'prior',
      window: { start: 0, end: 4 },
    });
    expect(plan.ranges).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    expect(plan.motionRows).toEqual([{ start: 3, end: 4 }]);
  });

  it('settles the previous lane without changing the current collection revision', () => {
    const current = subject(5, [{ start: 3, end: 4 }]);
    const plan = planInstanceUpload({
      activeIsNew: false,
      resident: {
        uploadedRevision: 5,
        uploadedMotionRows: [
          { start: 1, end: 2 },
          { start: 3, end: 4 },
        ],
      },
      current,
      pairing: 'none',
      window: { start: 2, end: 4 },
    });
    expect(plan).toEqual({ ranges: [{ start: 1, end: 2 }], motionRows: [] });
    expect(
      planInstanceUpload({
        activeIsNew: false,
        resident: { uploadedRevision: 5, uploadedMotionRows: [] },
        current,
        pairing: 'none',
        window: { start: 2, end: 4 },
      }).ranges,
    ).toEqual([]);
  });

  it('clips to a chunk window and rewrites everything without proof', () => {
    const current = subject(5, [{ start: 3, end: 4 }]);
    const chunk = planInstanceUpload({
      activeIsNew: false,
      resident: { uploadedRevision: 4, uploadedMotionRows: [] },
      current,
      pairing: 'no-previous-lane',
      window: { start: 2, end: 4 },
    });
    expect(chunk.ranges).toEqual([{ start: 1, end: 2 }]);
    for (const resident of [
      { uploadedRevision: 3, uploadedMotionRows: [] },
      { uploadedRevision: 4 },
    ]) {
      expect(
        planInstanceUpload({
          activeIsNew: false,
          resident,
          current,
          pairing: 'prior',
          window: { start: 0, end: 4 },
        }).ranges,
      ).toEqual([{ start: 0, end: 4 }]);
    }
    expect(
      planInstanceUpload({
        activeIsNew: true,
        resident: { uploadedRevision: 4, uploadedMotionRows: [] },
        current,
        pairing: 'prior',
        window: { start: 0, end: 4 },
      }).ranges,
    ).toEqual([{ start: 0, end: 4 }]);
  });
});
