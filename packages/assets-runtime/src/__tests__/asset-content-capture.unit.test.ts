import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type AssetContentCapture, AssetRecords } from '../internal/asset-records';

function fixture() {
  const records = new AssetRecords();
  const leaf = records
    .create('texture', { data: new Uint8Array([1, 2, 3, 4]), label: 'original' })
    .unwrap();
  const root = records.create('scene', { child: leaf, value: 1 }, [leaf]).unwrap();
  return { records, leaf, root };
}
function drain(capture: AssetContentCapture) {
  const retirement = capture.retire().unwrap();
  while (!retirement.inspect().done) retirement.step(1).unwrap();
}

describe('incremental exact-closure content capture', () => {
  it('reserves without copying, limits each step, and publishes only the complete fixed lease', () => {
    const { records, leaf, root } = fixture();
    const capture = records.beginContentCapture(root).unwrap();
    expect(capture.inspect()).toMatchObject({
      phase: 'capturing',
      copiedAssets: 0,
      copiedBytes: 0,
    });
    expect(capture.inspect().reservedBytes).toBeGreaterThan(0);
    expect(records.inspect()).toMatchObject({ snapshots: 1, snapshotBytes: 0 });
    expect(capture.step(0).ok).toBe(false);
    expect(capture.step(1).unwrap()).toBeUndefined();
    expect(capture.inspect().copiedAssets).toBe(1);
    const lease = capture.step(1).unwrap();
    if (lease === undefined) throw new Error('missing sealed lease');
    expect(capture.step(1).unwrap()).toBe(lease);
    expect(capture.inspect()).toMatchObject({
      phase: 'complete',
      copiedAssets: 2,
      reservedBytes: 0,
    });
    expect(lease.read<{ child: number }>(root).unwrap().child).toBe(leaf);
    expect(Array.from(lease.read<{ data: Uint8Array }>(leaf).unwrap().data)).toEqual([1, 2, 3, 4]);
    records.update(leaf, { label: 'next' }).unwrap();
    expect(lease.matchesCurrent()).toBe(false);
    expect(lease.read<{ label: string }>(leaf).unwrap().label).toBe('original');
    drain(capture);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    records.release(root).unwrap();
    records.release(leaf).unwrap();
  });

  it('never refreshes the expected version after an already-copied or pending member changes', () => {
    for (const changed of ['root', 'leaf'] as const) {
      const f = fixture();
      const capture = f.records.beginContentCapture(f.root).unwrap();
      capture.step(1).unwrap();
      f.records.update(f[changed], { value: 2 }).unwrap();
      expect(capture.step(1)).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
      expect(capture.inspect().phase).toBe('cancelled');
      expect(capture.step(2).ok).toBe(false);
      drain(capture);
      expect(f.records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
      f.records.release(f.root).unwrap();
      f.records.release(f.leaf).unwrap();
    }
  });

  it('invalidates on byte-range writes even when the source handle is unchanged', () => {
    const { records, leaf, root } = fixture();
    const capture = records.beginContentCapture(root).unwrap();
    capture.step(1).unwrap();
    records
      .writeRanges(leaf, new Uint8Array([9]), (_root, bytes) =>
        ok([{ handle: leaf, ranges: { writes: [{ path: ['data'], byteOffset: 0, bytes }] } }]),
      )
      .unwrap();
    expect(capture.step(1).ok).toBe(false);
    drain(capture);
    records.release(root).unwrap();
    records.release(leaf).unwrap();
  });

  it('rejects staged beforeCommit operations and rollback does not poison the original capture', () => {
    const { records, leaf, root } = fixture();
    const capture = records.beginContentCapture(root).unwrap();
    capture.step(1).unwrap();
    const before = records.inspect();
    expect(() =>
      records.adoptClosure(
        () => {
          records
            .adopt(
              'texture',
              { data: new Uint8Array([8]), label: 'uncommitted' },
              [],
              undefined,
              leaf,
            )
            .unwrap();
          return ok(undefined);
        },
        () => {
          expect(records.beginContentCapture(root).ok).toBe(false);
          expect(capture.step(1)).toMatchObject({
            ok: false,
            error: { code: 'asset-write-conflict' },
          });
          expect(capture.inspect().copiedAssets).toBe(1);
          expect(capture.retire().ok).toBe(false);
          expect(() => records.dispose()).toThrow();
          throw new Error('rollback');
        },
      ),
    ).toThrow('rollback');
    expect(records.inspect()).toEqual(before);
    const lease = capture.step(1).unwrap();
    if (lease === undefined) throw new Error('rollback lost the pending capture');
    expect(lease.read<{ label: string }>(leaf).unwrap().label).toBe('original');
    drain(capture);
    records.release(root).unwrap();
    records.release(leaf).unwrap();
  });

  it('retains an old removed dependency from begin through failed capture cleanup', () => {
    const { records, leaf, root } = fixture();
    const capture = records.beginContentCapture(root).unwrap();
    records.release(leaf).unwrap();
    records.adopt('scene', { value: 2 }, [], undefined, root).unwrap();
    expect(records.validate(leaf).ok).toBe(true);
    expect(capture.step(1).ok).toBe(false);
    expect(records.validate(leaf).ok).toBe(true);
    drain(capture);
    expect(records.validate(leaf).ok).toBe(false);
    records.release(root).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('does not invalidate for an unrelated update or reset its reservation during adoption', () => {
    const { records, leaf, root } = fixture();
    const other = records.create('scene', { value: 0 }).unwrap();
    const capture = records.beginContentCapture(root).unwrap();
    const reservation = capture.inspect().reservedBytes;
    records.adopt('scene', { value: 7 }, [], undefined, other).unwrap();
    expect(capture.inspect().reservedBytes).toBe(reservation);
    expect(capture.step(1).unwrap()).toBeUndefined();
    expect(capture.step(1).unwrap()?.matchesCurrent()).toBe(true);
    drain(capture);
    records.release(root).unwrap();
    records.release(leaf).unwrap();
    records.release(other).unwrap();
  });

  it('reserves count and full byte capacity once while incomplete captures compete', () => {
    const measured = new AssetRecords();
    const payload = { data: new Uint8Array(128) };
    const probe = measured.create('texture', payload).unwrap();
    const bytes = measured.inspect().bytes;
    measured.release(probe).unwrap();
    const records = new AssetRecords({ maxSnapshots: 2, maxBytes: bytes * 2 });
    const root = records.create('texture', payload).unwrap();
    const first = records.beginContentCapture(root).unwrap();
    expect(records.beginContentCapture(root)).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    expect(records.create('texture', payload).ok).toBe(false);
    const lease = first.step(1).unwrap();
    expect(lease).toBeDefined();
    expect(records.inspect()).toMatchObject({ snapshots: 1, snapshotBytes: bytes });
    drain(first);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    const second = records.beginContentCapture(root).unwrap();
    drain(second);
    records.release(root).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('borrows a sealed closure under the same byte limit with independent holds', () => {
    const payload = { data: new Uint8Array(128) };
    const measuring = new AssetRecords();
    measuring.create('texture', payload).unwrap();
    const bytes = measuring.inspect().bytes;
    measuring.dispose();
    const records = new AssetRecords({ maxSnapshots: 2, maxBytes: bytes * 2 });
    const root = records.create('texture', payload).unwrap();
    const first = records.beginContentCapture(root).unwrap();
    const original = first.step(1).unwrap();
    const second = records.beginContentCapture(root).unwrap();
    expect(second.inspect()).toMatchObject({
      phase: 'complete',
      copiedBytes: 0,
      reservedBytes: 0,
    });
    const shared = second.step(1).unwrap();
    expect(shared?.read(root).unwrap()).toBe(original?.read(root).unwrap());
    expect(records.inspect()).toMatchObject({ snapshots: 2, snapshotBytes: bytes });
    records.release(root).unwrap();
    drain(first);
    expect(records.inspect()).toMatchObject({ assets: 1, snapshots: 1, snapshotBytes: bytes });
    expect(shared?.read(root).unwrap()).toEqual(payload);
    drain(second);
    expect(records.inspect()).toMatchObject({ assets: 0, snapshots: 0, snapshotBytes: 0 });
  });

  it('joins overlapping captures only at the current sealed dependency revision', () => {
    const { records, leaf, root } = fixture();
    const first = records.beginContentCapture(root).unwrap();
    const second = records.beginContentCapture(root).unwrap();
    expect(first.step(1).unwrap()).toBeUndefined();
    const sealed = second.step(2).unwrap();
    const retainedBytes = records.inspect().bytes;
    expect(first.step(1).unwrap()?.read(leaf).unwrap()).toBe(sealed?.read(leaf).unwrap());
    expect(first.inspect().copiedAssets).toBe(1);
    expect(records.inspect()).toMatchObject({ snapshots: 2, snapshotBytes: retainedBytes });
    records
      .writeRanges(leaf, new Uint8Array([9]), (_root, bytes) =>
        ok([{ handle: leaf, ranges: { writes: [{ path: ['data'], byteOffset: 0, bytes }] } }]),
      )
      .unwrap();
    const next = records.beginContentCapture(root).unwrap();
    expect(next.inspect().phase).toBe('capturing');
    const updated = next.step(2).unwrap();
    expect(updated?.read<{ data: Uint8Array }>(leaf).unwrap().data[0]).toBe(9);
    expect(sealed?.read<{ data: Uint8Array }>(leaf).unwrap().data[0]).toBe(1);
    expect(sealed?.matchesCurrent()).toBe(false);
    drain(first);
    drain(second);
    const last = records.beginContentCapture(root).unwrap();
    expect(last.step(1).unwrap()?.read(leaf).unwrap()).toBe(updated?.read(leaf).unwrap());
    expect(records.inspect()).toMatchObject({ snapshots: 2, snapshotBytes: retainedBytes });
    drain(next);
    drain(last);
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    records.release(root).unwrap();
    records.release(leaf).unwrap();
  });

  it('cancels each incomplete stage once and owner-close settles pending retirement without another caller step', () => {
    for (const copied of [0, 1]) {
      const { records, root } = fixture();
      const capture = records.beginContentCapture(root).unwrap();
      if (copied > 0) capture.step(copied).unwrap();
      const task = capture.retire().unwrap();
      expect(capture.retire().unwrap()).toBe(task);
      records.dispose();
      expect(task.inspect().done).toBe(true);
      expect(capture.step(1)).toMatchObject({ ok: false, error: { code: 'asset-owner-closed' } });
      expect(records.inspect()).toMatchObject({ assets: 0, snapshots: 0, snapshotBytes: 0 });
    }
  });

  it('cleans unfinished captures itself on owner disposal and keeps simultaneous capture holds independent', () => {
    const { records, root } = fixture();
    const first = records.beginContentCapture(root).unwrap();
    const second = records.beginContentCapture(root).unwrap();
    first.step(1).unwrap();
    drain(first);
    expect(second.step(1).unwrap()).toBeUndefined();
    records.dispose();
    expect(second.inspect().phase).toBe('cancelled');
    expect(second.retire().unwrap().inspect().done).toBe(true);
    expect(records.inspect()).toMatchObject({ assets: 0, snapshots: 0, snapshotBytes: 0 });
  });
});
