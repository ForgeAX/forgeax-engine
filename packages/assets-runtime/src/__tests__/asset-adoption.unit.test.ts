import { AssetError, err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type AssetAdoption, AssetRecords } from '../internal/asset-records';

function drain(task: AssetAdoption): void {
  for (let i = 0; i < 10000 && task.inspect().phase !== 'retired'; i++)
    task.stepRetirement(1).unwrap();
  expect(task.inspect()).toMatchObject({ phase: 'retired', bytes: 0, assets: 0 });
}

describe('private resumable record adoption', () => {
  it('isolates prepared values and facts while ordinary committed operations continue', () => {
    const records = new AssetRecords();
    const existing = records.create('texture', { value: 1 }).unwrap();
    const observer = records.observe().unwrap();
    const task = records.beginAdoption().unwrap();
    const child = task.adopt('texture', { value: 2 }, [], undefined, existing).unwrap();
    const parent = task.adopt('scene', { child }, [child]).unwrap();
    expect(records.read(existing).unwrap()).toEqual({ value: 1 });
    expect(records.validate(parent).ok).toBe(false);
    expect(records.retain(parent).ok).toBe(false);
    expect(records.release(parent).ok).toBe(false);
    expect(observer.read().unwrap().changes).toEqual([]);
    const unrelated = records.create('texture', { value: 3 }).unwrap();
    records.update(unrelated, { value: 4 }).unwrap();
    records.adoptClosure(() => records.create('texture', { value: 5 })).unwrap();
    const snapshot = records.snapshot(existing).unwrap();
    task
      .commit(() => {
        expect(records.read(existing).unwrap()).toEqual({ value: 2 });
        expect(records.read(parent).unwrap()).toEqual({ child });
        records.retain(parent).unwrap();
        expect(records.create('texture', {})).toMatchObject({ ok: false });
        expect(records.snapshot(parent)).toMatchObject({ ok: false });
      })
      .unwrap();
    expect(records.read(existing).unwrap()).toEqual({ value: 2 });
    expect(snapshot.read(existing).unwrap()).toEqual({ value: 1 });
    expect(snapshot.matchesCurrent()).toBe(false);
    expect(records.refcount(parent)).toBe(2);
    drain(task);
    snapshot.dispose();
    records.release(parent).unwrap();
    records.release(parent).unwrap();
    records.release(existing).unwrap();
    records.dispose();
  });

  it('uses current consumer holder counts and protects its own grants from ordinary release', () => {
    const records = new AssetRecords();
    const existing = records.create('texture', { value: 1 }).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('texture', { value: 2 }, [], undefined, existing).unwrap();
    records.retain(existing).unwrap();
    records.retain(existing).unwrap();
    records.release(existing).unwrap();
    task.commit().unwrap();
    drain(task);
    expect(records.refcount(existing)).toBe(2);
    records.release(existing).unwrap();
    records.release(existing).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('never refreshes a changed read or rewinds unrelated committed revisions on cancellation', () => {
    const records = new AssetRecords();
    const child = records.create('texture', { value: 1 }).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('scene', { child }, [child]).unwrap();
    records.update(child, { value: 2 }).unwrap();
    const epoch = records.currentRevision;
    expect(task.commit()).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(records.currentRevision).toBe(epoch);
    drain(task);
    expect(records.read(child).unwrap()).toEqual({ value: 2 });
    expect(records.refcount(child)).toBe(1);
    records.release(child).unwrap();
    expect(records.inspect()).toMatchObject({ assets: 0, adoptionAssets: 0, adoptionBytes: 0 });
  });

  it('guards every committed node visited only for final merged graph validation', () => {
    const records = new AssetRecords();
    const a = records.create('material', {}).unwrap();
    const b = records.create('material', {}).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('material', {}, [b], undefined, a).unwrap();
    records.adopt('material', {}, [a], undefined, b).unwrap();
    expect(task.commit().ok).toBe(false);
    drain(task);
    expect(records.dependencies(a).unwrap()).toEqual([]);
    records.release(a).unwrap();
    records.release(b).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('rejects a cycle wholly inside private replacements before running acceptance', () => {
    const records = new AssetRecords();
    const a = records.create('material', {}).unwrap();
    const b = records.create('material', {}).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('material', {}, [b], undefined, a).unwrap();
    task.adopt('material', {}, [a], undefined, b).unwrap();
    let called = false;
    expect(
      task.commit(() => {
        called = true;
      }).ok,
    ).toBe(false);
    expect(called).toBe(false);
    drain(task);
    records.release(a).unwrap();
    records.release(b).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('uses an explicit prepare reader while reentrant ordinary reads remain committed', () => {
    const records = new AssetRecords();
    const a = records.create('texture', { value: 1 }).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('texture', { value: 2 }, [], undefined, a).unwrap();
    const parent = task
      .adopt('scene', {}, [], (_owned, reader) => {
        expect(reader.read(a).unwrap()).toEqual({ value: 2 });
        expect(records.read(a).unwrap()).toEqual({ value: 1 });
        expect(records.retain(a).ok).toBe(false);
        expect(records.update(a, { value: 8 }).ok).toBe(false);
        expect(records.beginAdoption().ok).toBe(false);
        expect(records.adoptClosure(() => ok(undefined)).ok).toBe(false);
        return ok({ value: { child: a }, dependencies: [a] });
      })
      .unwrap();
    task.commit().unwrap();
    drain(task);
    records.release(parent).unwrap();
    records.release(a).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('keeps rejected private consumer identities release-only after callback unwind', () => {
    const records = new AssetRecords();
    const old = records.create('texture', { value: 1 }).unwrap();
    const observer = records.observe().unwrap();
    const task = records.beginAdoption().unwrap();
    const fresh = task.adopt('scene', { old }, [old]).unwrap();
    expect(() =>
      task.commit(() => {
        records.retain(fresh).unwrap();
        records.retain(old).unwrap();
        throw new Error('consumer rejected');
      }),
    ).toThrow('consumer rejected');
    expect(records.read(fresh).ok).toBe(false);
    expect(records.validate(fresh).ok).toBe(false);
    expect(records.retain(fresh).ok).toBe(false);
    task.stepRetirement(1000).unwrap();
    expect(task.inspect()).toMatchObject({ phase: 'retiring', consumerReferences: 1 });
    expect(records.inspect().adoptionBytes).toBeGreaterThan(0);
    expect(observer.read().unwrap().changes).toEqual([]);
    records.release(fresh).unwrap();
    expect(records.release(fresh).ok).toBe(false);
    drain(task);
    expect(records.refcount(old)).toBe(2); // The external committed consumer owns its grant.
    records.release(old).unwrap();
    records.release(old).unwrap();
    expect(records.inspect().assets).toBe(0);
  });

  it('checks external guards again after acceptance and preserves release settlement', () => {
    const records = new AssetRecords();
    let current = true;
    const task = records
      .beginAdoption(() =>
        current
          ? ok(undefined)
          : err(
              new AssetError({
                code: 'asset-write-conflict',
                expected: 'same input',
                hint: 'retry',
              }),
            ),
      )
      .unwrap();
    const fresh = task.adopt('scene', {}).unwrap();
    expect(
      task.commit(() => {
        records.retain(fresh).unwrap();
        current = false;
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(records.inspect().assets).toBe(0);
    records.release(fresh).unwrap();
    drain(task);
  });

  it('reserves private identity and payload capacity across ordinary transactions', () => {
    const records = new AssetRecords({ maxAssets: 2, maxBytes: 120 });
    const existing = records.create('texture', new Uint8Array(20)).unwrap();
    const task = records.beginAdoption().unwrap();
    const fresh = task.adopt('texture', new Uint8Array(70)).unwrap();
    expect(records.create('texture', new Uint8Array(1))).toMatchObject({ ok: false });
    records
      .adoptClosure(() => records.adopt('texture', new Uint8Array(20), [], undefined, existing))
      .unwrap();
    expect(records.inspect()).toMatchObject({ adoptionAssets: 1, adoptionBytes: 70 });
    expect(records.adopt('texture', new Uint8Array(40), [], undefined, existing).ok).toBe(false);
    task.commit().unwrap();
    drain(task);
    records.release(fresh).unwrap();
    records.release(existing).unwrap();
    expect(records.inspect()).toMatchObject({ assets: 0, adoptionAssets: 0, adoptionBytes: 0 });
  });

  it('retires one real reference per quantum, preserving other consumers and deletion facts', () => {
    const records = new AssetRecords();
    const child = records.create('texture', {}).unwrap();
    const oldRoot = records.create('scene', {}, [child]).unwrap();
    records.release(child).unwrap();
    const observer = records.observe().unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('scene', {}, [], undefined, oldRoot).unwrap();
    task.commit().unwrap();
    expect(records.validate(child).ok).toBe(true);
    let last = task.inspect().processedReferences;
    while (task.inspect().phase !== 'retired') {
      const status = task.stepRetirement(1).unwrap();
      expect(status.processedReferences - last).toBeLessThanOrEqual(1);
      last = status.processedReferences;
    }
    expect(records.validate(child).ok).toBe(false);
    expect(observer.read().unwrap().changes).toContainEqual(
      expect.objectContaining({ handle: child, removed: true }),
    );
    records.release(oldRoot).unwrap();
  });

  it('shares fixed-copy reservations without letting an ordinary transaction erase private bytes', () => {
    const records = new AssetRecords({ maxBytes: 160 });
    const existing = records.create('texture', new Uint8Array(40)).unwrap();
    const capture = records.beginContentCapture(existing).unwrap();
    const task = records.beginAdoption().unwrap();
    const fresh = task.adopt('texture', new Uint8Array(70)).unwrap();
    expect(records.create('texture', new Uint8Array(30)).ok).toBe(false);
    expect(
      records.adoptClosure(() =>
        records.adopt('texture', new Uint8Array(40), [], undefined, existing),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    expect(task.inspect()).toMatchObject({ phase: 'preparing', bytes: 70 });
    expect(capture.inspect()).toMatchObject({ phase: 'capturing', reservedBytes: 40 });
    const lease = capture.step(1).unwrap();
    if (lease === undefined) throw new Error('capture did not seal');
    expect(records.inspect()).toMatchObject({ adoptionBytes: 70, snapshotBytes: 40 });
    expect(lease.matchesCurrent()).toBe(true);
    lease.retire().unwrap().step(1).unwrap();
    task.commit().unwrap();
    drain(task);
    records.release(existing).unwrap();
    records.release(fresh).unwrap();
    expect(records.inspect()).toMatchObject({ assets: 0, adoptionBytes: 0, snapshotBytes: 0 });
  });

  it('registers unfinished candidates with the owner, including consumer settlement on close', () => {
    const records = new AssetRecords();
    const a = records.create('texture', {}).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('scene', {}, [a]).unwrap();
    expect(records.beginAdoption().ok).toBe(false);
    records.dispose();
    expect(task.inspect()).toMatchObject({ phase: 'closed', bytes: 0, assets: 0 });
    expect(records.inspect()).toMatchObject({ assets: 0, adoptionAssets: 0, adoptionBytes: 0 });
    expect(task.commit().ok).toBe(false);
  });

  it.each(
    Array.from({ length: 17 }, (_, prefix) => prefix),
  )('cancels preparation prefix %i without leaking shared grants or publishing private deletions', (prefix) => {
    const records = new AssetRecords();
    const shared = records.create('texture', { value: 1 }).unwrap();
    const observer = records.observe().unwrap();
    const task = records.beginAdoption().unwrap();
    const handles = [];
    for (let i = 0; i < prefix; i++) handles.push(task.adopt('scene', {}, [shared]).unwrap());
    task.retire();
    task.retire();
    for (const handle of handles) expect(records.validate(handle).ok).toBe(false);
    drain(task);
    expect(records.refcount(shared)).toBe(1);
    expect(observer.read().unwrap().changes).toEqual([]);
    expect(records.inspect()).toMatchObject({ assets: 1, adoptionAssets: 0, adoptionBytes: 0 });
    records.release(shared).unwrap();
  });

  it('does not consume protected preparation grants after the last outside caller releases', () => {
    const records = new AssetRecords();
    const shared = records.create('texture', {}).unwrap();
    const observer = records.observe().unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('scene', {}, [shared]).unwrap();
    records.release(shared).unwrap();
    expect(records.release(shared).ok).toBe(false);
    task.retire();
    drain(task);
    expect(records.inspect().assets).toBe(0);
    expect(observer.read().unwrap().changes).toMatchObject([{ handle: shared, removed: true }]);
  });

  it('keeps stale guard failure sticky even if a later external check would succeed', () => {
    const records = new AssetRecords();
    let current = true;
    const task = records
      .beginAdoption(() =>
        current
          ? ok(undefined)
          : err(
              new AssetError({
                code: 'asset-write-conflict',
                expected: 'initial input',
                hint: 'retry',
              }),
            ),
      )
      .unwrap();
    const fresh = task.adopt('scene', {}).unwrap();
    current = false;
    expect(task.reader.read(fresh).ok).toBe(false);
    current = true;
    expect(task.commit().ok).toBe(false);
    drain(task);
    expect(records.inspect().assets).toBe(0);
  });

  it('cleans a failed preparation without allowing a new committed mutation from its guard', () => {
    const records = new AssetRecords();
    const outside = records.create('texture', { value: 1 }).unwrap();
    const task = records
      .beginAdoption(() => {
        expect(records.update(outside, { value: 2 }).ok).toBe(false);
        return ok(undefined);
      })
      .unwrap();
    task.adopt('scene', {}, [outside]).unwrap();
    expect(task.adopt('scene', {}, [], () => err('rejected'))).toMatchObject({
      ok: false,
      error: 'rejected',
    });
    drain(task);
    expect(records.read(outside).unwrap()).toEqual({ value: 1 });
    expect(records.refcount(outside)).toBe(1);
    records.release(outside).unwrap();
  });

  it('prevents accepting a previously borrowed observer batch inside preparation or acceptance', () => {
    const records = new AssetRecords();
    const value = records.create('texture', { value: 1 }).unwrap();
    const observer = records.observe().unwrap();
    records.update(value, { value: 2 }).unwrap();
    const batch = observer.read().unwrap();
    const task = records.beginAdoption().unwrap();
    task
      .adopt('scene', {}, [], (owned) => {
        expect(() => batch.accept()).toThrow(AssetError);
        return ok({ value: owned });
      })
      .unwrap();
    task
      .commit(() => {
        expect(() => batch.accept()).toThrow(AssetError);
      })
      .unwrap();
    expect(observer.read().unwrap().changes).toContainEqual(
      expect.objectContaining({ handle: value }),
    );
    drain(task);
    batch.accept();
    records.dispose();
  });

  it('terminates the owner on an unexpected partial-publication fault without fake rollback', () => {
    const records = new AssetRecords();
    const old = records.create('texture', { value: 1 }).unwrap();
    const task = records.beginAdoption().unwrap();
    task.adopt('texture', { value: 2 }, [], undefined, old).unwrap();
    task.adopt('scene', {}).unwrap();
    Reflect.set(records, 'changed', () => {
      throw new Error('publication fault');
    });
    expect(() => task.commit()).toThrow('publication fault');
    expect(records.read(old)).toMatchObject({ ok: false, error: { code: 'asset-owner-closed' } });
    expect(task.inspect()).toMatchObject({ phase: 'closed', bytes: 0, assets: 0 });
    expect(records.inspect()).toMatchObject({ assets: 0, adoptionBytes: 0, adoptionAssets: 0 });
  });

  it('preserves private consumer responsibility when owner termination ends the session', () => {
    const records = new AssetRecords();
    const task = records.beginAdoption().unwrap();
    const fresh = task.adopt('scene', {}).unwrap();
    expect(() =>
      task.commit(() => {
        records.retain(fresh).unwrap();
        throw new Error('reject');
      }),
    ).toThrow('reject');
    records.dispose();
    expect(task.inspect()).toMatchObject({
      phase: 'closed',
      bytes: 0,
      assets: 0,
      consumerReferences: 1,
    });
    expect(task.stepRetirement(1).unwrap()).toMatchObject({
      phase: 'closed',
      consumerReferences: 1,
    });
    expect(records.release(fresh)).toMatchObject({
      ok: false,
      error: { code: 'asset-owner-closed' },
    });
  });
});
