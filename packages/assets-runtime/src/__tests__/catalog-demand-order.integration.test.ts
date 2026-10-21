import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { CatalogReplica } from '../registry/catalog-state';

const guid = '11111111-1111-4111-8111-111111111111';
function row(value: number, generation = value, observedAt = 1): CatalogEntry {
  const packageUrl = `https://fixture.invalid/${value}.pack.json`;
  const produced = createRuntimePackPublication({
    scopeId: 'order-review',
    generation,
    sourcePath: 'main.pack',
    sourceRevision: 'same-source',
    packageUrl,
    pack: { assets: [{ guid, kind: 'fixture', payload: { value } }] },
  });
  return {
    guid,
    packageUrl,
    sourcePath: 'main.pack',
    kind: 'fixture',
    revision: { rootId: 'root', digest: 'same-source', observedAt },
    publication: produced.publication,
  };
}

it('orders stable content identities by the accepted producer window and rejects replay', async () => {
  const first = row(1, 300);
  const second = row(2, 100);
  const third = row(3, 200);
  let emit: (delta: CatalogDelta) => void = () => {};
  const replica = new CatalogReplica({
    enumerate: async () =>
      Object.assign(ok([first]), { revisions: [{ rootId: 'producer', revision: 1 }] }),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  const delta = (entry: CatalogEntry, baseline: number): CatalogDelta => ({
    added: [],
    changed: [entry],
    removed: [],
    revisions: {
      baseline: [{ rootId: 'producer', revision: baseline }],
      current: [{ rootId: 'producer', revision: baseline + 1 }],
    },
  });
  try {
    (await replica.start()).unwrap();
    emit(delta(second, 1));
    expect(replica.get(guid)).toEqual(second);
    expect(replica.isStale).toBe(false);
    emit(delta(second, 1));
    expect(replica.isStale).toBe(false);
    emit(delta(third, 2));
    expect(replica.get(guid)).toEqual(third);
    emit(delta(second, 1));
    expect(replica.get(guid)).toEqual(third);
    expect(replica.snapshot()).toMatchObject({
      stale: true,
      diagnostics: [{ code: 'catalog-revision-stale' }],
    });
  } finally {
    replica.dispose();
  }
});

it('keeps publication tuple fences strict even with a contiguous producer window', async () => {
  const first = row(1);
  const conflicting = row(2, 1, 2);
  let emit: (delta: CatalogDelta) => void = () => {};
  const replica = new CatalogReplica({
    enumerate: async () =>
      Object.assign(ok([first]), { revisions: [{ rootId: 'producer', revision: 1 }] }),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  try {
    (await replica.start()).unwrap();
    emit({
      added: [],
      changed: [conflicting],
      removed: [],
      revisions: {
        baseline: [{ rootId: 'producer', revision: 1 }],
        current: [{ rootId: 'producer', revision: 2 }],
      },
    });
    expect(replica.get(guid)).toEqual(first);
    expect(replica.snapshot()).toMatchObject({
      stale: true,
      revisions: [{ rootId: 'producer', revision: 1 }],
      diagnostics: [{ code: 'catalog-revision-conflict' }],
    });
  } finally {
    replica.dispose();
  }
});
it('does not let a queued older hot result replace a completed demand refresh', async () => {
  const first = row(1),
    second = row(2, 2, 4),
    third = row(3);
  let emit: (delta: CatalogDelta) => void = () => {};
  const replica = new CatalogReplica({
    expectedScope: { scopeId: 'order-review', generation: 1 },
    enumerate: async () => ok([first]),
    get: async () => ok([third]),
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  await replica.start();
  (await replica.require(guid, true)).unwrap();
  expect(replica.get(guid)?.publication?.digest).toBe(third.publication?.digest);
  emit({ scopeId: 'order-review', generation: 1, added: [], changed: [second], removed: [] });
  expect(replica.get(guid)?.publication?.digest).toBe(third.publication?.digest);
  replica.dispose();
});

it.each([
  0, 1,
])('refreshes cooked output when source observation remains at %s', async (observedAt) => {
  const first = row(1);
  const next = row(2, 2, observedAt);
  const replica = new CatalogReplica({
    expectedScope: { scopeId: 'order-review', generation: 1 },
    enumerate: async () => ok([first]),
    get: async () => ok([next]),
    subscribe: () => () => {},
  });
  try {
    (await replica.start()).unwrap();
    expect((await replica.require(guid, true)).unwrap().publication.generation).toBe(2);
    expect(replica.get(guid)?.revision?.observedAt).toBe(observedAt);
    expect(replica.isStale).toBe(false);
  } finally {
    replica.dispose();
  }
});

it('admits the first publication of an unchanged source declaration', async () => {
  const published = row(1);
  const { publication: _publication, ...navigation } = published;
  const replica = new CatalogReplica({
    expectedScope: { scopeId: 'order-review', generation: 1 },
    enumerate: async () => ok([{ ...navigation, lifecycle: 'missing' }]),
    get: async () => ok([published]),
    subscribe: () => () => {},
  });
  try {
    (await replica.start()).unwrap();
    expect((await replica.require(guid)).unwrap().publication).toEqual(published.publication);
    expect(replica.isStale).toBe(false);
  } finally {
    replica.dispose();
  }
});

it('rejects changed bytes that reuse a publication generation despite a newer source timestamp', async () => {
  const first = row(1);
  const conflicting = row(2, 1, 2);
  const replica = new CatalogReplica({
    expectedScope: { scopeId: 'order-review', generation: 1 },
    enumerate: async () => ok([first]),
    get: async () => ok([conflicting]),
    subscribe: () => () => {},
  });
  try {
    (await replica.start()).unwrap();
    expect(await replica.require(guid, true)).toMatchObject({
      ok: false,
      error: { code: 'catalog-discontinuous' },
    });
    expect(replica.get(guid)?.publication?.digest).toBe(first.publication?.digest);
    expect(replica.snapshot().diagnostics).toMatchObject([{ code: 'catalog-revision-conflict' }]);
  } finally {
    replica.dispose();
  }
});
