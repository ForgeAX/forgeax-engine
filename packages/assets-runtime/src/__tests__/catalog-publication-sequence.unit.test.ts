import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { CatalogSource } from '../catalog-source';
import { CatalogReplica } from '../registry/catalog-state';

const scope = { scopeId: 'sequence', generation: 0 };
const guid = '11111111-1111-4111-8111-111111111111';
function row(value: number, assetGuid = guid, generation = 4 - value): CatalogEntry {
  const packageUrl = `https://fixture.invalid/${value}.pack.json`;
  return {
    guid: assetGuid,
    packageUrl,
    sourcePath: 'main.pack',
    kind: 'fixture',
    publication: createRuntimePackPublication({
      ...scope,
      generation,
      sourcePath: 'main.pack',
      sourceRevision: String(value),
      packageUrl,
      pack: { assets: [{ guid: assetGuid, kind: 'fixture', payload: { value } }] },
    }).publication,
  };
}
const revision = (value: number) => [{ rootId: 'producer', revision: value }];
const snapshot = (rows: readonly CatalogEntry[], value: number) =>
  Object.assign(ok(rows), { revisions: revision(value) });
const delta = (rows: readonly CatalogEntry[], value: number): CatalogDelta => ({
  ...scope,
  added: [],
  changed: rows,
  removed: [],
  revisions: { baseline: revision(value - 1), current: revision(value) },
});

it('rejects an unpublished demand result without skipping another asset in the hot stream', async () => {
  const otherGuid = '22222222-2222-4222-8222-222222222222';
  const first = row(1, guid, 1);
  const second = row(2, guid, 2);
  const third = row(3, guid, 3);
  let emit: (delta: CatalogDelta) => void = () => {};
  const replica = new CatalogReplica({
    expectedScope: scope,
    enumerate: async () => snapshot([first, row(1, otherGuid)], 1),
    get: async () => ok([third]),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  try {
    (await replica.start()).unwrap();
    expect(await replica.require(guid, true)).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid' },
    });
    expect(replica.get(guid)).toEqual(first);
    expect(replica.snapshot()).toMatchObject({ stale: false, revisions: revision(1) });
    emit(delta([second, row(2, otherGuid)], 2));
    emit(delta([third], 3));
    expect((await replica.require(guid, true)).unwrap()).toEqual(third);
    expect(replica.get(otherGuid)).toEqual(row(2, otherGuid));
    expect(replica.snapshot()).toMatchObject({ stale: false, revisions: revision(3) });
  } finally {
    replica.dispose();
  }
});

it('accepts demand after the producer publishes its complete window before resolving', async () => {
  let emit: (delta: CatalogDelta) => void = () => {};
  const next = row(2);
  const replica = new CatalogReplica({
    expectedScope: scope,
    enumerate: async () => snapshot([row(1)], 1),
    get: async () => {
      emit(delta([next], 2));
      return ok([next]);
    },
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  try {
    (await replica.start()).unwrap();
    expect((await replica.require(guid, true)).unwrap()).toEqual(next);
    expect(replica.snapshot()).toMatchObject({ stale: false, revisions: revision(2) });
  } finally {
    replica.dispose();
  }
});

it('retains an empty producer root and rejects replay after removal', async () => {
  let emit: (delta: CatalogDelta) => void = () => {};
  const replica = new CatalogReplica({
    expectedScope: scope,
    enumerate: async () => snapshot([], 7),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  try {
    (await replica.start()).unwrap();
    emit(delta([row(1)], 8));
    expect(replica.get(guid)).toEqual(row(1));
    emit({ ...delta([], 9), removed: [guid] });
    expect(replica.get(guid)).toBeUndefined();
    emit(delta([row(1)], 8));
    expect(replica.get(guid)).toBeUndefined();
    expect(replica.snapshot()).toMatchObject({ stale: true, revisions: revision(9) });
  } finally {
    replica.dispose();
  }
});

it('skips covered in-flight commits and applies only the following publication', async () => {
  let emit: (delta: CatalogDelta) => void = () => {};
  let finish!: (result: Awaited<ReturnType<CatalogSource['enumerate']>>) => void;
  const replica = new CatalogReplica({
    expectedScope: scope,
    enumerate: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  try {
    const started = replica.start();
    emit(delta([row(1)], 1));
    emit(delta([row(2)], 2));
    emit(delta([row(3)], 3));
    finish(snapshot([row(2)], 2));
    (await started).unwrap();
    expect(replica.get(guid)).toEqual(row(3));
    expect(replica.snapshot()).toMatchObject({ stale: false, revisions: revision(3) });
  } finally {
    replica.dispose();
  }
});

it.each([
  'scope',
  'window',
  'tuple',
  'degraded',
] as const)('does not hide an invalid %s behind an already covered baseline', async (fault) => {
  let emit: (delta: CatalogDelta) => void = () => {};
  let finish!: (result: Awaited<ReturnType<CatalogSource['enumerate']>>) => void;
  const replica = new CatalogReplica({
    expectedScope: scope,
    enumerate: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  try {
    const started = replica.start();
    const incoming = delta([row(2)], 2);
    emit(
      fault === 'scope'
        ? { ...incoming, scopeId: 'retired' }
        : fault === 'window'
          ? { ...incoming, revisions: { baseline: revision(3), current: revision(2) } }
          : fault === 'tuple'
            ? { ...incoming, changed: [row(1)] }
            : { ...incoming, authority: 'degraded', added: [], changed: [], removed: [] },
    );
    finish(snapshot([row(2)], 2));
    (await started).unwrap();
    expect(replica.get(guid)).toEqual(row(2));
    expect(replica.isStale).toBe(true);
  } finally {
    replica.dispose();
  }
});

it('propagates a reconciled sequence gap so a composed reader obtains its own baseline', async () => {
  let current = snapshot([row(1)], 1);
  let emit: (delta: CatalogDelta) => void = () => {};
  const producer = new CatalogReplica({
    expectedScope: scope,
    enumerate: async () => current,
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  const consumer = new CatalogReplica({
    expectedScope: scope,
    enumerate: async () => {
      (await producer.start()).unwrap();
      const accepted = producer.snapshot();
      return Object.assign(ok(accepted.entries), { revisions: accepted.revisions });
    },
    subscribe: (listener) => producer.subscribe(listener),
  });
  try {
    (await consumer.start()).unwrap();
    current = snapshot([row(2)], 3);
    (await producer.reconcile()).unwrap();
    expect(consumer.isStale).toBe(true);
    expect(consumer.get(guid)).toEqual(row(1));
    (await consumer.reconcile()).unwrap();
    expect(consumer.snapshot()).toMatchObject({ stale: false, revisions: revision(3) });
    emit(delta([row(3)], 4));
    expect(consumer.get(guid)).toEqual(row(3));
    expect(consumer.isStale).toBe(false);
  } finally {
    consumer.dispose();
    producer.dispose();
  }
});
