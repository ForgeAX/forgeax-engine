import { err } from '@forgeax/engine-types';
import { assert, describe, expect, it } from 'vitest';
import { AssetRecords } from '../internal/asset-records';

describe('fixed asset content and reference custody', () => {
  it('captures every dependency at one version and holds old dependencies through adoption', () => {
    const assets = new AssetRecords();
    const old = assets.create('texture', { pixels: new Uint8Array([3, 7]) }).unwrap();
    const root = assets.create('scene', { child: old }, [old]).unwrap();
    const lease = assets.beginContentCapture(root).unwrap().step(1000).unwrap();
    assert.isDefined(lease);
    const captured = lease.read<{ pixels: Uint8Array }>(old).unwrap();
    expect(lease.read(old).unwrap()).toBe(captured);
    expect(lease.matchesCurrent()).toBe(true);
    assets.release(old).unwrap();
    const next = assets.create('texture', { pixels: new Uint8Array([11]) }).unwrap();
    assets.adopt('scene', { child: next }, [next], undefined, root).unwrap();
    expect(lease.matchesCurrent()).toBe(false);
    expect(lease.read<{ child: number }>(root).unwrap().child).toBe(old);
    expect(Array.from(captured.pixels)).toEqual([3, 7]);
    expect(assets.validate(old).ok).toBe(true);
    expect(lease.read(next).ok).toBe(false);
    const task = lease.retire().unwrap();
    expect(lease.retire().unwrap()).toBe(task);
    expect(lease.read(root).ok).toBe(false);
    while (!task.inspect().done) task.step(1).unwrap();
    expect(assets.validate(old).ok).toBe(false);
    expect(assets.validate(root).ok).toBe(true);
    expect(assets.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
    assets.release(root).unwrap();
    assets.release(next).unwrap();
    expect(assets.inspect().assets).toBe(0);
  });

  it('keeps public reads detached and refuses custody acquisition without snapshot capacity', () => {
    const assets = new AssetRecords({ maxSnapshots: 1 });
    const root = assets.create('scene', { name: 'fixed' }).unwrap();
    const snapshot = assets.snapshot(root).unwrap();
    expect(assets.beginContentCapture(root)).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    snapshot.dispose();
    const lease = assets.beginContentCapture(root).unwrap().step(1000).unwrap();
    assert.isDefined(lease);
    const owned = assets.read<{ name: string }>(root).unwrap();
    owned.name = 'changed detached read';
    expect(lease.read<{ name: string }>(root).unwrap().name).toBe('fixed');
    assets.release(root).unwrap();
    expect(assets.release(root).ok).toBe(false);
    lease.retire().unwrap().step(1).unwrap();
    expect(assets.inspect()).toMatchObject({ assets: 0, snapshots: 0 });
  });

  it('bounds dependency retirement work and preserves another consumer acquired while draining', () => {
    const assets = new AssetRecords();
    const children = Array.from({ length: 40 }, (_, value) =>
      assets.create('texture', { value }).unwrap(),
    );
    const root = assets.create('scene', { children }, children).unwrap();
    const task = assets.deferRelease([root]).unwrap();
    expect(assets.deferRelease([root]).ok).toBe(false);
    expect(assets.release(root).ok).toBe(false);
    for (const child of children) assets.release(child).unwrap();
    const shared = children[children.length - 1] as number;
    assets.retain(shared).unwrap();
    let processed = 0;
    while (!task.inspect().done) {
      const before = task.inspect().processedReferences;
      const result = task.step(3).unwrap();
      expect(result.processedReferences - before).toBeLessThanOrEqual(3);
      processed = result.processedReferences;
    }
    expect(processed).toBe(41);
    expect(assets.inspect().assets).toBe(1);
    expect(assets.read(shared).unwrap()).toEqual({ value: 39 });
    expect(task.step(3).unwrap()).toMatchObject({ done: true, processedReferences: 41 });
    assets.release(shared).unwrap();
    expect(assets.inspect().assets).toBe(0);
  });

  it('refuses invalid work budgets and invalid transfers before consuming any reference', () => {
    const assets = new AssetRecords();
    const root = assets.create('scene', {}).unwrap();
    expect(assets.deferRelease([root, root]).ok).toBe(false);
    const task = assets.deferRelease([root]).unwrap();
    const before = assets.inspect();
    for (const budget of [0, -1, NaN, Infinity, 0.5])
      expect(task.step(budget)).toMatchObject({ ok: false });
    expect(assets.inspect()).toEqual(before);
    expect(task.inspect()).toMatchObject({ done: false, processedReferences: 0 });
    task.step(1).unwrap();
    expect(assets.inspect().assets).toBe(0);
  });

  it('does not unwind a deep dependency chain with one caller release', () => {
    const assets = new AssetRecords();
    let root = assets.create('material', { depth: 0 }).unwrap();
    for (let depth = 1; depth <= 128; depth++) {
      const next = assets.create('material', { depth }, [root]).unwrap();
      assets.release(root).unwrap();
      root = next;
    }
    const task = assets.deferRelease([root]).unwrap();
    for (let retired = 1; retired <= 129; retired++) {
      expect(task.step(1).unwrap()).toMatchObject({
        processedReferences: retired,
        retiredAssets: retired,
        pendingReferences: retired === 129 ? 0 : 1,
        done: retired === 129,
      });
      expect(assets.inspect().assets).toBe(129 - retired);
    }
  });

  it('keeps independent captured consumers alive until their own custody is drained', () => {
    const assets = new AssetRecords();
    const root = assets.create('scene', { value: 1 }).unwrap();
    const first = assets.beginContentCapture(root).unwrap().step(1000).unwrap();
    assert.isDefined(first);
    const second = assets.beginContentCapture(root).unwrap().step(1000).unwrap();
    assert.isDefined(second);
    assets.release(root).unwrap();
    first.retire().unwrap().step(1).unwrap();
    expect(assets.inspect()).toMatchObject({ assets: 1, snapshots: 1 });
    expect(second.read(root).unwrap()).toEqual({ value: 1 });
    second.retire().unwrap().step(1).unwrap();
    expect(assets.inspect()).toMatchObject({ assets: 0, snapshots: 0 });
  });

  it('rejects custody changes inside an adoption transaction without losing the old lease', () => {
    const assets = new AssetRecords();
    const root = assets.create('scene', { value: 1 }).unwrap();
    const lease = assets.beginContentCapture(root).unwrap().step(1000).unwrap();
    assert.isDefined(lease);
    const before = assets.inspect();
    assets.adoptClosure(() => {
      expect(assets.beginContentCapture(root)).toMatchObject({
        ok: false,
        error: { code: 'asset-write-conflict' },
      });
      expect(assets.deferRelease([root]).ok).toBe(false);
      expect(lease.retire().ok).toBe(false);
      return err('rejected');
    });
    expect(assets.inspect()).toEqual(before);
    expect(lease.matchesCurrent()).toBe(true);
    expect(lease.read(root).unwrap()).toEqual({ value: 1 });
    assets.release(root).unwrap();
    lease.retire().unwrap().step(1).unwrap();
    expect(assets.inspect().assets).toBe(0);
  });

  it('rejects a mixed valid/foreign transfer before taking custody of the valid hold', () => {
    const assets = new AssetRecords();
    const foreign = new AssetRecords();
    const root = assets.create('scene', {}).unwrap();
    const other = foreign.create('scene', {}).unwrap();
    expect(assets.deferRelease([root, other]).ok).toBe(false);
    assets.release(root).unwrap();
    expect(assets.inspect().assets).toBe(0);
    foreign.release(other).unwrap();
  });

  it('closes captured copies and transferred holds after the asset owner itself is disposed', () => {
    const assets = new AssetRecords();
    const root = assets.create('scene', { value: 1 }).unwrap();
    const lease = assets.beginContentCapture(root).unwrap().step(1000).unwrap();
    assert.isDefined(lease);
    assets.dispose();
    expect(lease.matchesCurrent()).toBe(false);
    const task = lease.retire().unwrap();
    expect(task.step(1).unwrap().done).toBe(true);
    expect(assets.inspect()).toMatchObject({ assets: 0, snapshots: 0, snapshotBytes: 0 });
  });
});
