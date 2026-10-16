import { type AssetLoadError, err, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactCache } from '../internal/artifact-cache.js';
import { AssetGraph } from '../internal/asset-graph.js';
import { PackReader } from '../internal/pack-reader.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Value = { value: { revision: number }; refs: string[] };
const value = (revision = 1, refs: string[] = []) => ok({ value: { revision }, refs });
const A = '11111111-1111-4111-8111-111111111111';
const tuple = { scopeId: 'test', generation: 1, digest: 'test', outputSetDigest: 'test' };
const pack = {
  ...tuple,
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [{ guid: A, kind: 'test', payload: {}, refs: [], artifacts: {} }],
};

describe('independent asset request cancellation', () => {
  it.each([0, 1])('cancels caller %i without cancelling its peer or shared read', async (index) => {
    const pending = deferred<Result<Value, AssetLoadError>>();
    const read = vi.fn(() => pending.promise);
    const graph = new AssetGraph({ read });
    const controllers = [new AbortController(), new AbortController()];
    const requests = controllers.map((controller) => graph.load(A, controller.signal));
    controllers[index]?.abort();
    expect(await requests[index]).toMatchObject({
      ok: false,
      error: { code: 'asset-load-cancelled' },
    });
    pending.resolve(value());
    expect(await requests[1 - index]).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledTimes(1);
    graph.dispose();
  });

  it('retains owner work after all waits cancel, and observes pre-aborted and completed waits', async () => {
    const pending = deferred<Result<Value, AssetLoadError>>();
    const graph = new AssetGraph({ read: () => pending.promise });
    const first = new AbortController();
    const second = new AbortController();
    const requests = [graph.load(A, first.signal), graph.load(A, second.signal)];
    first.abort();
    second.abort();
    expect((await Promise.all(requests)).every((result) => !result.ok)).toBe(true);
    pending.resolve(value());
    const loaded = await graph.load(A);
    expect(loaded.ok).toBe(true);
    expect(await graph.load(A, first.signal)).toMatchObject({ ok: false });
    const completed = new AbortController();
    const ready = await graph.load(A, completed.signal);
    completed.abort();
    expect(ready.ok).toBe(true);
    graph.dispose();
  });

  it('shares one dependency read between roots while one root cancels', async () => {
    const dependency = deferred<Result<Value, AssetLoadError>>();
    const entered = deferred<void>();
    let dependencyReads = 0;
    const graph = new AssetGraph({
      read: async (guid) => {
        if (guid !== 'dependency') return value(1, ['dependency']);
        dependencyReads++;
        entered.resolve();
        return dependency.promise;
      },
    });
    const controller = new AbortController();
    const a = graph.load('a', controller.signal);
    const b = graph.load('b');
    await entered.promise;
    controller.abort();
    expect(await a).toMatchObject({ ok: false });
    dependency.resolve(value());
    expect(await b).toMatchObject({ ok: true });
    expect(dependencyReads).toBe(1);
    graph.dispose();
  });

  it('dispose aborts owner I/O and settles active and queued reads even if a reader ignores abort', async () => {
    const entered = deferred<AbortSignal>();
    const late = deferred<Result<Value, AssetLoadError>>();
    const graph = new AssetGraph({
      maxConcurrentReads: 1,
      read: (_guid, signal) => {
        entered.resolve(signal);
        return late.promise;
      },
    });
    const requests = [graph.load('a'), graph.load('b')];
    const signal = await entered.promise;
    graph.dispose();
    expect(signal.aborted).toBe(true);
    for (const result of await Promise.all(requests)) {
      expect(result).toMatchObject({ ok: false, error: { code: 'asset-runtime-disposed' } });
    }
    late.resolve(value());
    await Promise.resolve();
    expect(graph.snapshot()).toMatchObject({ ready: [], pending: 0, resources: 0 });
  });
});

describe('shared Pack reader lifecycle', () => {
  it.each([0, 1])('isolates caller %i while retaining one fetch', async (index) => {
    const response = deferred<Response>();
    const fetcher = vi.fn(() => response.promise);
    const reader = new PackReader({ fetcher });
    const controllers = [new AbortController(), new AbortController()];
    const requests = controllers.map((controller) =>
      reader.read('/pack', tuple, controller.signal),
    );
    controllers[index]?.abort();
    expect(await requests[index]).toMatchObject({ ok: false });
    response.resolve(Response.json(pack));
    expect(await requests[1 - index]).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    reader.dispose();
  });

  it('does not accept malformed envelopes or retain results after disposal', async () => {
    const response = deferred<Response>();
    const reader = new PackReader({ fetcher: () => response.promise });
    expect(reader.verify({ ...pack, assets: [null] }, tuple)).toMatchObject({ ok: false });
    const loading = reader.read('/pack', tuple, new AbortController().signal);
    reader.dispose();
    expect(await loading).toMatchObject({ ok: false });
    response.resolve(Response.json(pack));
    await Promise.resolve();
    expect(await reader.read('/pack', tuple, new AbortController().signal)).toMatchObject({
      ok: false,
    });
  });
});

describe('ArtifactCache invalidation', () => {
  it.each([
    undefined,
    'bytes',
  ])('clear(%s) prevents late refill and preserves a fresh same-key read', async (key) => {
    const cache = new ArtifactCache();
    const old = deferred<Result<Uint8Array, AssetLoadError>>();
    const oldRead = cache.read('bytes', () => old.promise);
    await Promise.resolve();
    cache.clear(key);
    old.resolve(ok(Uint8Array.of(1)));
    await oldRead;
    expect(cache.snapshot()).toMatchObject({ entries: 0, pending: 0 });

    const stale = deferred<Result<Uint8Array, AssetLoadError>>();
    const fresh = deferred<Result<Uint8Array, AssetLoadError>>();
    const a = cache.read('bytes', () => stale.promise);
    await Promise.resolve();
    cache.clear(key);
    const b = cache.read('bytes', () => fresh.promise);
    const duplicate = cache.read('bytes', () => {
      throw new Error('must share');
    });
    expect(b).toBe(duplicate);
    fresh.resolve(ok(Uint8Array.of(2)));
    await b;
    stale.resolve(ok(Uint8Array.of(1)));
    await a;
    expect(
      (
        await cache.read('bytes', () => {
          throw new Error('must cache');
        })
      ).unwrap(),
    ).toEqual(Uint8Array.of(2));
    expect(cache.snapshot()).toMatchObject({ entries: 1, pending: 0 });
  });
});

it('materializes a fresh snapshot on demand and keeps listener counters current', async () => {
  const graph = new AssetGraph({ read: async () => value() });
  const initial = graph.snapshot();
  await graph.load('b');
  await graph.load('a');
  await graph.load('b');
  expect(initial.ready).toEqual([]);
  expect(graph.snapshot()).toMatchObject({
    ready: ['a', 'b'],
    resources: 2,
    counters: { loads: 2, cacheHits: 1 },
  });
  const snapshots: number[] = [];
  const unsubscribe = graph.subscribe((snapshot) => {
    snapshots.push(snapshot.counters.cacheHits);
  });
  await graph.load('a');
  unsubscribe();
  await graph.load('a');
  expect(snapshots).toEqual([2]);
  expect(graph.snapshot().counters.cacheHits).toBe(3);
  graph.dispose();
});

it('invalidates pending dependency parents and keeps late traversal from changing fresh edges', async () => {
  const late = deferred<Result<Value, AssetLoadError>>();
  const entered = deferred<void>();
  let dependencyReads = 0;
  const graph = new AssetGraph({
    read: async (guid) => {
      if (guid === 'root') return value(1, ['dependency']);
      if (++dependencyReads === 1) {
        entered.resolve();
        return late.promise;
      }
      return value(2);
    },
  });
  const old = graph.load('root');
  await entered.promise;
  expect(graph.invalidate('dependency')).toEqual(['dependency', 'root']);
  expect(await graph.load('root')).toMatchObject({ ok: true });
  late.resolve(value(1, ['old-only']));
  expect(await old).toMatchObject({ ok: false });
  expect(graph.lookup('dependency')).toEqual({ revision: 2 });
  expect(graph.snapshot().ready).toEqual(['dependency', 'root']);
  expect(graph.invalidate('dependency')).toEqual(['dependency', 'root']);
  graph.dispose();
});

describe('asset dependency closure promotion', () => {
  it('reads shared and cyclic edges once, records each SCC, and invalidates reverse parents', async () => {
    const refs: Record<string, string[]> = {
      root: ['a', 'a', 'self', 'shared'],
      a: ['b', 'shared'],
      b: ['a', 'c'],
      c: ['d'],
      d: ['c', 'shared'],
      self: ['self'],
      shared: [],
    };
    const read = vi.fn(async (guid: string) => value(1, refs[guid] ?? []));
    const graph = new AssetGraph({ read });
    expect(await graph.load('ROOT')).toMatchObject({ ok: true });
    expect(read.mock.calls.map(([guid]) => guid)).toEqual([
      'root',
      'a',
      'b',
      'c',
      'd',
      'shared',
      'self',
    ]);
    expect(graph.snapshot()).toMatchObject({
      ready: ['a', 'b', 'c', 'd', 'root', 'self', 'shared'],
      resources: 7,
      pending: 0,
      sccs: [['c', 'd'], ['a', 'b'], ['self']],
    });
    expect(await graph.load('b')).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledTimes(7);
    expect(graph.invalidate('c')).toEqual(['a', 'b', 'c', 'd', 'root']);
    expect(graph.snapshot()).toMatchObject({ ready: ['self', 'shared'], sccs: [] });
    expect(await graph.load('root')).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledTimes(12);
    expect(graph.snapshot().sccs).toEqual([['self'], ['c', 'd'], ['a', 'b']]);
    graph.dispose();
  });

  it('publishes no provisional member when a later dependency fails, then retries the closure', async () => {
    let fails = true;
    const read = vi.fn(async (guid: string): Promise<Result<Value, AssetLoadError>> => {
      if (guid === 'missing' && fails)
        return err({
          code: 'asset-decode-failed',
          expected: 'a decodable dependency',
          hint: 'repair the publication',
          detail: { guid, kind: 'test' },
        });
      return value(1, guid === 'root' ? ['cycle', 'missing'] : guid === 'cycle' ? ['root'] : []);
    });
    const graph = new AssetGraph({ read });
    expect(await graph.load('root')).toMatchObject({
      ok: false,
      error: {
        code: 'asset-dependency-failed',
        detail: { guid: 'root', dependencyGuid: 'missing' },
      },
    });
    expect(graph.snapshot()).toMatchObject({ ready: [], resources: 0, sccs: [] });
    expect(graph.lookup('cycle')).toBeUndefined();
    fails = false;
    expect(await graph.load('root')).toMatchObject({ ok: true });
    expect(graph.snapshot()).toMatchObject({
      ready: ['cycle', 'missing', 'root'],
      sccs: [['cycle', 'root']],
    });
    expect(read).toHaveBeenCalledTimes(6);
    graph.dispose();
  });

  it('retains deferred edges for SCC and invalidation without eagerly reading them', async () => {
    type DeferredValue = Value & { references?: 'deferred' };
    const read = vi.fn(
      async (guid: string): Promise<Result<DeferredValue, AssetLoadError>> =>
        ok({
          value: { revision: 1 },
          refs: guid === 'root' ? ['root', 'child'] : [],
          references: 'deferred',
        }),
    );
    const graph = new AssetGraph({ read });
    expect(await graph.load('root')).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(graph.snapshot()).toMatchObject({ ready: ['root'], resources: 1, sccs: [['root']] });
    expect(graph.lookup('child')).toBeUndefined();
    expect(graph.invalidate('child')).toEqual(['child', 'root']);
    expect(graph.snapshot().ready).toEqual([]);
    graph.dispose();
  });
});
