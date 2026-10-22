import { err, type MaterialAsset, ok } from '@forgeax/engine-types';
import { describe, expect, test } from 'vitest';
import { AssetRecords } from '../internal/asset-records';

const material = (roughness = 1): MaterialAsset => ({ kind: 'material', values: { roughness } });

describe('owned runtime asset content', () => {
  test('guards an exact dependency closure without retaining fixed content copies', () => {
    const records = new AssetRecords({ maxSnapshots: 1 });
    const dependency = records.create('material', material(0.2)).unwrap();
    const root = records.create('mesh', { kind: 'mesh' }, [dependency]).unwrap();
    const unrelated = records.create('material', material()).unwrap();
    const fixed = records.snapshot(root).unwrap();
    const before = records.inspect();
    const guard = records.captureRevision(root).unwrap();
    const revision = guard.version(root).unwrap();
    expect(records.inspect()).toMatchObject({
      snapshots: before.snapshots,
      snapshotBytes: before.snapshotBytes,
    });
    expect(records.snapshot(root)).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    records.update(unrelated, { values: { roughness: 0.4 } }).unwrap();
    expect(guard.matchesCurrent()).toBe(true);
    records.update(dependency, { values: { roughness: 0.8 } }).unwrap();
    expect(records.version(root).unwrap()).toBe(revision);
    expect(guard.matchesCurrent()).toBe(false);
    expect(guard.version(root).unwrap()).toBe(revision);
    guard.dispose();
    guard.dispose();
    expect(guard.matchesCurrent()).toBe(false);
    expect(guard.version(root).ok).toBe(false);
    fixed.dispose();
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
  });

  test('stages complete updates with decoder replacements before publishing one revision', () => {
    const records = new AssetRecords();
    const sampler = records.create('sampler', 'linear').unwrap();
    const root = records.create('material', material(), [sampler]).unwrap();
    const fixed = records.snapshot(root).unwrap();
    const observer = records.observe().unwrap();
    const before = records.inspect();
    const replace = () => {
      records.adopt('sampler', 'nearest', [], undefined, sampler).unwrap();
      records.update(root, { ...material(0.2) }, { replace: true }).unwrap();
    };
    expect(
      records.adoptClosure(() => {
        replace();
        return err('rejected');
      }).ok,
    ).toBe(false);
    expect(records.inspect()).toEqual(before);
    expect(records.read(root).unwrap()).toEqual(material());
    expect(records.read(sampler).unwrap()).toBe('linear');
    expect(observer.read().unwrap().changes).toHaveLength(0);
    expect(fixed.matchesCurrent()).toBe(true);
    records
      .adoptClosure(() => {
        replace();
        return ok(undefined);
      })
      .unwrap();
    const changes = observer.read().unwrap().changes;
    expect(changes.map((change) => change.handle)).toEqual([sampler, root]);
    expect(changes[0]?.revision).toBe(changes[1]?.revision);
    expect(records.read(root).unwrap()).toEqual(material(0.2));
    expect(records.read(sampler).unwrap()).toBe('nearest');
    expect(fixed.read(root).unwrap()).toEqual(material());
    expect(fixed.read(sampler).unwrap()).toBe('linear');
    expect(fixed.matchesCurrent()).toBe(false);
    records.release(sampler).unwrap();
    records.release(root).unwrap();
    expect(records.inspect().assets).toBe(0);
    fixed.dispose();
    observer.dispose();
  });

  test('counts complete update candidates against the closure budget and rolls back all holds', () => {
    const content = { data: new Uint8Array(100) };
    const measure = new AssetRecords();
    const measured = measure.create('texture', content).unwrap();
    const bytes = measure.inspect().bytes;
    measure.release(measured).unwrap();
    const records = new AssetRecords({ maxBytes: bytes * 3, maxAssets: 2 });
    const a = records.create('texture', content).unwrap();
    const b = records.create('texture', content).unwrap();
    const observer = records.observe().unwrap();
    const before = records.inspect();
    expect(
      records.adoptClosure(() => {
        records.update(a, { data: new Uint8Array(100).fill(1) }, { replace: true }).unwrap();
        return records.update(b, { data: new Uint8Array(100).fill(2) }, { replace: true });
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-budget-exceeded' } });
    expect(records.inspect()).toEqual(before);
    expect(records.read(a).unwrap()).toEqual(content);
    expect(records.read(b).unwrap()).toEqual(content);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    records.release(a).unwrap();
    records.release(b).unwrap();
    expect(records.inspect().assets).toBe(0);
    observer.dispose();
  });

  test('rejects partial, duplicate and reentrant updates during closure preparation', () => {
    const records = new AssetRecords();
    const root = records.create('material', material()).unwrap();
    const before = records.inspect();
    expect(records.adoptClosure(() => records.update(root, { values: {} }))).toMatchObject({
      ok: false,
      error: { code: 'asset-write-conflict' },
    });
    expect(
      records.adoptClosure(() => records.update(root, {}, { field: 'values', replace: true })),
    ).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(
      records.adoptClosure(() => {
        records.update(root, { ...material(0.2) }, { replace: true }).unwrap();
        return records.update(root, { ...material(0.3) }, { replace: true });
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(
      records.adoptClosure(() =>
        records.update(
          root,
          { ...material(0.2) },
          {
            replace: true,
            prepare: () => {
              const nested = records.create('material', material());
              return nested.ok ? ok({ value: {} }) : nested;
            },
          },
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(records.inspect()).toEqual(before);
    expect(records.read(root).unwrap()).toEqual(material());
    records.release(root).unwrap();
  });

  test('adopts a standalone decoder replacement without requiring a second caller transaction', () => {
    const records = new AssetRecords();
    const handle = records.create('custom', 'before').unwrap();
    records.adopt('custom', 'after', [], undefined, handle).unwrap();
    expect(records.read(handle).unwrap()).toBe('after');
    records.release(handle).unwrap();
  });

  test('replaces existing source identities atomically, retaining fixed closures and dependency holds', () => {
    const records = new AssetRecords();
    const texture = records.create('texture', new Uint8Array([1, 2])).unwrap();
    const root = records.create('material', material(), [texture]).unwrap();
    const fixed = records.snapshot(root).unwrap();
    const observer = records.observe().unwrap();
    const before = records.inspect();
    const replace = () => {
      records.adopt('texture', new Uint8Array([3, 4]), [], undefined, texture).unwrap();
      records.adopt('material', material(0.2), [texture], undefined, root).unwrap();
    };
    expect(
      records.adoptClosure(() => {
        replace();
        return err('rejected');
      }).ok,
    ).toBe(false);
    expect(records.inspect()).toEqual(before);
    expect(records.read<MaterialAsset>(root).unwrap().values?.roughness).toBe(1);
    expect(records.read<Uint8Array>(texture).unwrap()).toEqual(new Uint8Array([1, 2]));
    expect(observer.read().unwrap().changes).toHaveLength(0);
    expect(fixed.matchesCurrent()).toBe(true);
    records
      .adoptClosure(() => {
        replace();
        return ok(undefined);
      })
      .unwrap();
    expect(records.read<MaterialAsset>(root).unwrap().values?.roughness).toBe(0.2);
    expect(records.read<Uint8Array>(texture).unwrap()).toEqual(new Uint8Array([3, 4]));
    const changes = observer.read().unwrap().changes;
    expect(changes.map((change) => change.handle)).toEqual([texture, root]);
    expect(changes[0]?.revision).toBe(changes[1]?.revision);
    expect(fixed.read<Uint8Array>(texture).unwrap()).toEqual(new Uint8Array([1, 2]));
    expect(fixed.matchesCurrent()).toBe(false);
    records.release(texture).unwrap();
    records.release(root).unwrap();
    expect(records.inspect().assets).toBe(0);
    fixed.dispose();
    observer.dispose();
  });

  test('rejects cycles introduced across staged replacements without leaking holds or changes', () => {
    const records = new AssetRecords();
    const a = records.create('material', material()).unwrap();
    const b = records.create('material', material()).unwrap();
    const observer = records.observe().unwrap();
    const before = records.inspect();
    expect(
      records.adoptClosure(() => {
        records.adopt('material', material(0.2), [b], undefined, a).unwrap();
        return records.adopt('material', material(0.3), [a], undefined, b);
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-reference-invalid' } });
    expect(records.inspect()).toEqual(before);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    records.release(a).unwrap();
    records.release(b).unwrap();
    expect(records.inspect().assets).toBe(0);
    observer.dispose();
  });

  test('budgets replacement candidates alongside live content and rolls back partial preparation', () => {
    const records = new AssetRecords({ maxBytes: 100, maxAssets: 2 });
    const a = records.create('texture', new Uint8Array(30)).unwrap();
    const b = records.create('texture', new Uint8Array(30)).unwrap();
    const observer = records.observe().unwrap();
    const before = records.inspect();
    expect(
      records.adoptClosure(() => {
        records.adopt('texture', new Uint8Array(30).fill(1), [], undefined, a).unwrap();
        return records.adopt('texture', new Uint8Array(30).fill(2), [], undefined, b);
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-budget-exceeded' } });
    expect(records.inspect()).toEqual(before);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    records
      .adoptClosure(() => records.adopt('texture', new Uint8Array(30).fill(3), [], undefined, a))
      .unwrap();
    expect(records.read<Uint8Array>(a).unwrap()[0]).toBe(3);
    expect(records.read<Uint8Array>(b).unwrap()[0]).toBe(0);
    records.release(a).unwrap();
    records.release(b).unwrap();
    expect(records.inspect().assets).toBe(0);
    observer.dispose();
  });

  test('shares fixed engine content until explicit queue and consumer leases retire', () => {
    const records = new AssetRecords({ maxSnapshots: 2 });
    const handle = records
      .create('texture', { kind: 'texture', data: new Uint8Array([1, 2]) })
      .unwrap();
    const first = records.pin<{ data: Uint8Array }>(handle).unwrap();
    const same = records.pin<{ data: Uint8Array }>(handle).unwrap();
    const queued = first.retain();
    expect(same.value).toBe(first.value);
    expect(records.inspect().snapshots).toBe(1);
    records.update(handle, { data: new Uint8Array([3, 4]) }).unwrap();
    const next = records.pin<{ data: Uint8Array }>(handle).unwrap();
    expect(next.handle).toBe(first.handle);
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(Array.from(queued.value.data)).toEqual([1, 2]);
    expect(Array.from(next.value.data)).toEqual([3, 4]);
    first.dispose();
    same.dispose();
    records.release(handle).unwrap();
    expect(records.inspect()).toMatchObject({ assets: 0, snapshots: 2 });
    queued.dispose();
    expect(records.inspect().snapshots).toBe(1);
    expect(() => first.retain()).toThrow();
    next.dispose();
    expect(records.inspect()).toMatchObject({ snapshots: 0, snapshotBytes: 0 });
  });

  test('publishes an adopted closure atomically and rolls back failed dependency holds', () => {
    const records = new AssetRecords();
    const retained = records.create('material', material()).unwrap();
    const observer = records.observe().unwrap();
    const before = records.inspect();
    expect(
      records.adoptClosure(() => {
        const child = records.create('mesh', { kind: 'mesh' }, [retained]).unwrap();
        records.create('scene', { kind: 'scene' }, [child]).unwrap();
        return err('rejected');
      }).ok,
    ).toBe(false);
    expect(records.inspect()).toEqual(before);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    const handles = records
      .adoptClosure(() => {
        const texture = records.create('texture', new Uint8Array([1, 2, 3])).unwrap();
        const root = records.create('material', material(), [texture]).unwrap();
        return ok([texture, root]);
      })
      .unwrap();
    const changes = observer.read().unwrap().changes;
    expect(changes.map((change) => change.handle)).toEqual(handles);
    for (const change of changes)
      expect(records.version(change.handle).unwrap()).toBe(change.revision);
    records.release(retained).unwrap();
    expect(records.read(retained).ok).toBe(false);
    const texture = handles[0];
    if (texture === undefined) throw new Error('missing texture');
    const bytes = records.read<Uint8Array>(texture).unwrap();
    bytes[0] = 8;
    expect(records.read<Uint8Array>(texture).unwrap()[0]).toBe(1);
  });

  test('isolates creation, public reads and independent owner identities', () => {
    const a = new AssetRecords();
    const b = new AssetRecords();
    const input = material();
    const handle = a.create('material', input).unwrap();
    const other = b.create('material', material()).unwrap();
    expect(other).not.toBe(handle);
    expect(b.read(handle).ok).toBe(false);
    expect(a.retain(handle, 'mesh').ok).toBe(false);
    expect(a.read<MaterialAsset>(handle).unwrap()).toEqual(input);
    expect(a.borrow<MaterialAsset>(handle).unwrap()).not.toBe(input);
    a.release(handle).unwrap();
    expect(a.read(handle).ok).toBe(false);
  });

  test('commits content and change evidence together without caller revisions', () => {
    const records = new AssetRecords();
    const handle = records.create('material', material()).unwrap();
    const fast = records.observe().unwrap();
    const slow = records.observe().unwrap();
    for (let i = 0; i < 8; i++) {
      records.update(handle, { values: { roughness: i / 10 } }).unwrap();
    }
    const first = fast.read().unwrap();
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]?.handle).toBe(handle);
    first.accept();
    expect(fast.read().unwrap().changes).toHaveLength(0);
    expect(slow.read().unwrap().changes).toHaveLength(1);
    expect(records.read<MaterialAsset>(handle).unwrap().values?.roughness).toBe(0.7);
    slow.read().unwrap().accept();
    expect(records.inspect().pendingAssets).toBe(0);
    fast.dispose();
    slow.dispose();
  });

  test('range writes isolate every external alias and fixed snapshots', () => {
    const records = new AssetRecords();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const asset = { kind: 'texture', data: bytes };
    const handle = records.create('texture', asset).unwrap();
    const snapshot = records.snapshot(handle).unwrap();
    bytes.fill(9);
    const input = new Uint8Array([7, 8]);
    records
      .writeRange(handle, input, (_current, captured) =>
        ok({ writes: [{ path: ['data'], byteOffset: 1, bytes: captured }] }),
      )
      .unwrap();
    input.fill(0);
    const read = records.read<{ kind: 'texture'; data: Uint8Array }>(handle).unwrap();
    expect(Array.from(read.data)).toEqual([1, 7, 8, 4]);
    read.data.fill(0);
    expect(Array.from(records.borrow<{ data: Uint8Array }>(handle).unwrap().data)).toEqual([
      1, 7, 8, 4,
    ]);
    expect(Array.from(snapshot.read<{ data: Uint8Array }>(handle).unwrap().data)).toEqual([
      1, 2, 3, 4,
    ]);
    snapshot.dispose();
    expect(records.inspect().snapshotBytes).toBe(0);
  });

  test('fixed snapshots retain dependency versions when only the dependency changes', () => {
    const records = new AssetRecords();
    const dependency = records.create('material', material(0.2)).unwrap();
    const root = records.create('material', material(1), [dependency]).unwrap();
    const snapshot = records.snapshot(root).unwrap();
    const version = records.version(root).unwrap();
    records.update(dependency, { values: { roughness: 0.8 } }).unwrap();
    expect(records.version(root).unwrap()).toBe(version);
    expect(snapshot.matchesCurrent()).toBe(false);
    expect(snapshot.read<MaterialAsset>(dependency).unwrap().values?.roughness).toBe(0.2);
    expect(records.read<MaterialAsset>(dependency).unwrap().values?.roughness).toBe(0.8);
    snapshot.dispose();
  });

  test('snapshot freshness consumes changed identities, independently of observer capacity', () => {
    const records = new AssetRecords({ maxObservers: 1, maxSnapshots: 2 });
    const dependency = records.create('material', material(0.2)).unwrap();
    const root = records.create('material', material(), [dependency]).unwrap();
    const unrelated = records.create('material', material()).unwrap();
    const observer = records.observe().unwrap();
    const first = records.snapshot(root).unwrap();
    const second = records.snapshot(root).unwrap();
    expect(records.observe().ok).toBe(false);
    expect(records.snapshot(root).ok).toBe(false);
    expect(records.inspect()).toMatchObject({ snapshots: 2, observers: 1 });
    records.update(unrelated, { values: { roughness: 0.3 } }).unwrap();
    observer.read().unwrap().accept();
    expect(first.matchesCurrent()).toBe(true);
    expect(second.matchesCurrent()).toBe(true);
    expect(records.inspect().pendingAssets).toBe(0);
    records.update(dependency, { values: { roughness: 0.8 } }).unwrap();
    observer.read().unwrap().accept();
    expect(first.matchesCurrent()).toBe(false);
    expect(second.matchesCurrent()).toBe(false);
    expect(records.inspect().pendingAssets).toBe(0);
    records.update(dependency, { values: { roughness: 0.2 } }).unwrap();
    expect(first.matchesCurrent()).toBe(false);
    expect(first.read<MaterialAsset>(dependency).unwrap().values?.roughness).toBe(0.2);
    first.dispose();
    second.dispose();
    observer.dispose();
    expect(records.inspect()).toMatchObject({
      snapshots: 0,
      observers: 0,
      snapshotBytes: 0,
      pendingAssets: 0,
    });
  });

  test('budget failure leaves the last accepted content intact', () => {
    const records = new AssetRecords({ maxAssets: 1, maxBytes: 128 });
    const handle = records
      .create('texture', { kind: 'texture', data: new Uint8Array(16) })
      .unwrap();
    expect(records.create('material', material()).ok).toBe(false);
    expect(records.update(handle, { data: new Uint8Array(64) }).ok).toBe(false);
    expect(records.borrow<{ data: Uint8Array }>(handle).unwrap().data.byteLength).toBe(16);
    records.dispose();
    expect(records.read(handle).ok).toBe(false);
    expect(records.create('material', material()).ok).toBe(false);
  });

  test('dependency replacement transfers holds atomically and rejects cycles', () => {
    const records = new AssetRecords();
    const a = records.create('material', material(0.1)).unwrap();
    const b = records.create('material', material(0.2)).unwrap();
    const root = records.create('material', material(), [a]).unwrap();
    records.release(a).unwrap();
    const version = records.version(root).unwrap();
    expect(records.update(a, {}, { dependencies: [root] }).ok).toBe(false);
    expect(records.version(root).unwrap()).toBe(version);
    const snapshot = records.snapshot(root).unwrap();
    records.update(root, {}, { dependencies: [b] }).unwrap();
    expect(records.read(a).ok).toBe(false);
    expect(snapshot.read<MaterialAsset>(a).unwrap().values?.roughness).toBe(0.1);
    records.release(b).unwrap();
    expect(records.read(b).ok).toBe(true);
    records.release(root).unwrap();
    expect(records.inspect().assets).toBe(0);
    snapshot.dispose();
  });

  test('logical view copies and repeated source aliases have consistent byte accounting', () => {
    const records = new AssetRecords();
    const backing = new Uint8Array(4096);
    const input = backing.subarray(100, 116);
    const handle = records.create('texture', { kind: 'texture', a: input, b: input }).unwrap();
    const initial = records.inspect().bytes;
    const read = records.read<{ a: Uint8Array; b: Uint8Array }>(handle).unwrap();
    expect(read.a.buffer.byteLength).toBe(16);
    expect(read.a.buffer).not.toBe(read.b.buffer);
    records.update(handle, { a: new Uint8Array(8) }).unwrap();
    expect(records.inspect().bytes).toBe(initial - 8);
    records
      .writeRange(handle, new Uint8Array([7]), (_current, bytes) =>
        ok({ writes: [{ path: ['a'], byteOffset: 0, bytes }] }),
      )
      .unwrap();
    expect(records.read<{ b: Uint8Array }>(handle).unwrap().b[0]).toBe(0);
    records.release(handle).unwrap();
    expect(records.inspect().bytes).toBe(0);
  });

  test('coalesces overlapping ranges while preserving slow and out-of-order acknowledgments', () => {
    const records = new AssetRecords({ maxRanges: 2 });
    const handle = records
      .create('texture', { kind: 'texture', data: new Uint8Array(16) })
      .unwrap();
    const fast = records.observe().unwrap();
    const slow = records.observe().unwrap();
    records
      .writeRange(handle, new Uint8Array([1, 2]), (_current, bytes) =>
        ok({ writes: [{ path: ['data'], byteOffset: 0, bytes }] }),
      )
      .unwrap();
    const old = fast.read().unwrap();
    records
      .writeRange(handle, new Uint8Array([3, 4]), (_current, bytes) =>
        ok({ writes: [{ path: ['data'], byteOffset: 1, bytes }] }),
      )
      .unwrap();
    const latest = fast.read().unwrap();
    expect(latest.changes[0]?.ranges).toEqual([{ path: ['data'], byteOffset: 0, byteLength: 3 }]);
    latest.accept();
    old.accept();
    const idle = fast.read();
    expect(fast.read()).toBe(idle);
    expect(slow.read().unwrap().changes).toHaveLength(1);
    slow.read().unwrap().accept();
    expect(records.inspect().pendingAssets).toBe(0);
  });

  test('rejects accessor and cyclic input without executing code or committing evidence', () => {
    const records = new AssetRecords();
    const handle = records.create('material', material()).unwrap();
    const channel = records.observe().unwrap();
    let reads = 0;
    const input = {
      get values() {
        reads++;
        return {};
      },
    };
    expect(records.update(handle, input).ok).toBe(false);
    expect(reads).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(records.update(handle, cycle).ok).toBe(false);
    expect(channel.read().unwrap().changes).toHaveLength(0);
  });

  test('counts only the changed nested fields and accounts for complete replacement', () => {
    const records = new AssetRecords();
    const reference = records
      .create('material', { kind: 'material', values: { a: [1, 2], b: [3, 4] }, removed: 'old' })
      .unwrap();
    const priorBytes = records.inspect().bytes;
    records.update(reference, { a: [1, 2, 3] }, { field: 'values' }).unwrap();
    // One additional array element: numeric bytes, its property key and field metadata.
    expect(records.inspect().bytes - priorBytes).toBe(18);
    const next = { kind: 'material', values: { b: [1] } };
    records.update(reference, next, { replace: true }).unwrap();
    const comparison = new AssetRecords();
    comparison.create('material', next).unwrap();
    expect(records.inspect().bytes).toBe(comparison.inspect().bytes);
    expect(records.read(reference).unwrap()).toEqual(next);
  });

  test('rejects a candidate when preparation replaced or retired its input', () => {
    const records = new AssetRecords();
    const reference = records.create('material', material()).unwrap();
    const result = records.update(
      reference,
      { values: { roughness: 0.2 } },
      {
        prepare: (_current, owned) => {
          records.update(reference, { values: { roughness: 0.8 } }).unwrap();
          return ok({ value: owned });
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(records.read<MaterialAsset>(reference).unwrap().values?.roughness).toBe(0.8);
    const retired = records.update(
      reference,
      { values: { roughness: 0.2 } },
      {
        prepare: (_current, owned) => {
          records.release(reference).unwrap();
          return ok({ value: owned });
        },
      },
    );
    expect(retired).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(records.inspect().assets).toBe(0);
    expect(records.inspect().bytes).toBe(0);
  });
});

test('validates linked byte writes and nested metadata before a single atomic revision', () => {
  const records = new AssetRecords();
  const texture = records.create('texture', { kind: 'texture', data: new Uint8Array(4) }).unwrap();
  const root = records
    .create(
      'terrain',
      { kind: 'terrain', heights: new Float32Array(4), sections: [{ minHeight: 0, maxHeight: 0 }] },
      [texture],
    )
    .unwrap();
  const old = records.snapshot(root).unwrap();
  const observer = records.observe().unwrap();
  const initialBytes = records.inspect().bytes;
  const write = (offset: number) =>
    records.writeRanges(root, new Uint8Array([4]), (_root, bytes) =>
      ok([
        {
          handle: root,
          ranges: {
            writes: [{ path: ['heights'], byteOffset: 0, bytes }],
            fieldWrites: [{ path: ['sections', '0', 'maxHeight'], value: 8 }],
          },
        },
        { handle: texture, ranges: { writes: [{ path: ['data'], byteOffset: offset, bytes }] } },
      ]),
    );
  expect(write(4).ok).toBe(false);
  expect(old.matchesCurrent()).toBe(true);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  write(1).unwrap();
  expect(
    records.read<{ sections: { maxHeight: number }[] }>(root).unwrap().sections[0]?.maxHeight,
  ).toBe(8);
  expect(
    old.read<{ sections: { maxHeight: number }[] }>(root).unwrap().sections[0]?.maxHeight,
  ).toBe(0);
  expect(records.read<{ data: Uint8Array }>(texture).unwrap().data).toEqual(
    new Uint8Array([0, 4, 0, 0]),
  );
  expect(
    new Set(
      observer
        .read()
        .unwrap()
        .changes.map((change) => change.revision),
    ).size,
  ).toBe(1);
  expect(records.inspect().bytes).toBe(initialBytes);
  old.dispose();
  observer.dispose();
  records.dispose();
});
