import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import {
  type AssetDecoder,
  AssetError,
  type AssetHandle,
  type CatalogDelta,
  type CatalogEntry,
  ok,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import type { CatalogSource } from '../catalog-source';
import { runtimeAssetReference, runtimeAssets } from '../internal/runtime-assets';
import { CatalogReplica } from '../registry/catalog-state';

interface Payload {
  value: number;
  children: readonly (string | number)[];
  sum?: number;
}
const kind = defineAssetKind<Payload>('ingestion-fixture');
const ROOT = '00000000-0000-7000-8000-000000000601';
const CHILD = '00000000-0000-7000-8000-000000000602';
const OTHER = '00000000-0000-7000-8000-000000000603';
const EVIDENCE = '00000000-0000-7000-8000-000000000604';
const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function externalEvidenceRow(revision: number): CatalogEntry {
  const sourcePath = 'evidence.pack';
  const packageUrl = `https://ingestion.invalid/${revision}/evidence.json`;
  const { publication } = createRuntimePackPublication({
    scopeId: 'ingestion-fixture',
    sourcePath,
    sourceRevision: String(revision),
    generation: revision,
    packageUrl,
    pack: {
      assets: [{ guid: EVIDENCE, kind: kind.kind, payload: { value: revision, children: [] } }],
    },
  });
  return { guid: EVIDENCE, kind: kind.kind, sourcePath, packageUrl, publication };
}

function fixture(withExternalEvidence = false) {
  let external = withExternalEvidence ? externalEvidenceRow(1) : undefined;
  let rootHook: (() => void) | undefined;
  let rows: CatalogEntry[] = [],
    body = '',
    hook: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const listeners = new Set<(delta: CatalogDelta) => void>();
  const catalog: CatalogSource = {
    enumerate: async () => ok(external === undefined ? rows : [...rows, external]),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openPackage: () => async () => new Response(body),
  };
  const assets = new AssetRegistry({ catalog, scopeId: 'ingestion-fixture' });
  owners.push(assets);
  const records = runtimeAssets(assets);
  const decoder: AssetDecoder<Payload> = {
    decode: async ({ envelope }) => ok(envelope.payload),
    prepare: (value, context) => {
      const children: number[] = [];
      let sum = value.value;
      for (const child of value.children) {
        const handle = context.reference(child, kind.kind).unwrap();
        const data = context.read(handle).unwrap() as Payload;
        // The context sees private dependencies; a previously committed shared
        // dependency remains independently readable by existing consumers.
        expect(assets.read(handle).ok).toBe(runtimeAssetReference(assets, CHILD) === handle);
        children.push(handle);
        sum += data.sum ?? data.value;
      }
      if (value.children.length > 0) rootHook?.();
      if (value.children.length === 0 && reached !== undefined) {
        const notify = reached;
        reached = undefined;
        hook?.();
        // Cross the real driver's launch threshold to observe between steps.
        const start = performance.now();
        while (performance.now() - start < 3) {}
        notify();
      }
      return ok({ ...value, children, sum });
    },
  };
  let lease = assets.installDecoder(kind, decoder);
  const publish = (revision: number) => {
    const product = createRuntimePackPublication({
      scopeId: 'ingestion-fixture',
      sourcePath: 'ingestion.pack',
      sourceRevision: String(revision),
      generation: revision,
      packageUrl: `https://ingestion.invalid/${revision}/pack.json`,
      externalEvidence: withExternalEvidence
        ? [{ guid: EVIDENCE, usage: 'reference', generation: 1 }]
        : [],
      pack: {
        assets: [
          {
            guid: CHILD,
            kind: kind.kind,
            payload: { value: revision, children: [] },
            refs: [],
            artifacts: {},
          },
          {
            guid: ROOT,
            kind: kind.kind,
            payload: { value: 10, children: [CHILD] },
            refs: [CHILD],
            artifacts: {},
          },
          {
            guid: OTHER,
            kind: kind.kind,
            payload: { value: 20, children: [CHILD] },
            refs: [CHILD],
            artifacts: {},
          },
        ],
      },
    });
    const previous = rows;
    rows = product.pack.assets.map(({ guid }) => ({
      guid,
      kind: kind.kind,
      sourcePath: 'ingestion.pack',
      packageUrl: `https://ingestion.invalid/${revision}/pack.json`,
      publication: product.publication,
    }));
    body = JSON.stringify(product.pack);
    for (const listener of listeners)
      listener({
        scopeId: 'ingestion-fixture',
        generation: revision,
        added: previous.length === 0 ? rows : [],
        changed: previous.length === 0 ? [] : rows,
        removed: [],
      });
  };
  publish(1);
  return {
    assets,
    records,
    publish,
    replaceExternalEvidence: () => {
      external = externalEvidenceRow(2);
      for (const listener of listeners)
        listener({
          scopeId: 'ingestion-fixture',
          generation: 0,
          added: [],
          changed: [external],
          removed: [],
        });
    },
    pause: () =>
      new Promise<void>((resolve) => {
        reached = resolve;
      }),
    hook: (callback: () => void) => {
      hook = callback;
    },
    onRoot: (callback: () => void) => {
      rootHook = callback;
    },
    reinstall: () => {
      lease.dispose();
      lease = assets.installDecoder(kind, decoder);
    },
  };
}

describe('ordinary source ingestion uses private cooperative preparation', () => {
  it('validates shared publication references in one source program observation', async () => {
    const f = fixture();
    const registry = f.assets as unknown as {
      checkPreparedSourcePrograms: (...args: unknown[]) => unknown;
    };
    const prepare = registry.checkPreparedSourcePrograms.bind(registry);
    const lookups: string[] = [];
    const get = CatalogReplica.prototype.get;
    vi.spyOn(registry, 'checkPreparedSourcePrograms').mockImplementation((...args) => {
      const lookup = vi.spyOn(CatalogReplica.prototype, 'get').mockImplementation(function (
        this: CatalogReplica,
        guid,
      ) {
        lookups.push(guid);
        return get.call(this, guid);
      });
      try {
        return prepare(...args);
      } finally {
        lookup.mockRestore();
      }
    });
    const handle = (await f.assets.load(ROOT, kind)).unwrap();
    expect(lookups).toEqual([ROOT, CHILD, CHILD]);
    expect(f.assets.read(handle).unwrap()).toMatchObject({ sum: 11 });
    f.assets.release(handle).unwrap();
  });

  it('keeps candidates unpublished while unrelated committed operations continue', async () => {
    const f = fixture();
    const counter = f.records.create('counter', { value: 1 }).unwrap();
    const reached = f.pause();
    const loading = f.assets.load(ROOT, kind);
    await reached;
    expect(runtimeAssetReference(f.assets, ROOT)).toBeUndefined();
    expect(runtimeAssetReference(f.assets, CHILD)).toBeUndefined();
    expect(f.records.inspect().adoptionAssets).toBeGreaterThan(0);
    f.records.update(counter, { value: 2 }).unwrap();
    const handle = (await loading).unwrap();
    expect(f.assets.read(handle).unwrap()).toMatchObject({ sum: 11 });
    expect(f.records.inspect()).toMatchObject({
      adoptions: 0,
      adoptionAssets: 0,
      adoptionBytes: 0,
    });
    expect(f.records.read(counter).unwrap()).toEqual({ value: 2 });
    f.assets.release(handle).unwrap();
    f.records.release(counter).unwrap();
  });

  it('rejects an E0 to E1 source change and loads the new publication on retry', async () => {
    const f = fixture();
    const reached = f.pause();
    const loading = f.assets.load(ROOT, kind);
    await reached;
    f.publish(2);
    expect(await loading).toMatchObject({ ok: false });
    expect(runtimeAssetReference(f.assets, ROOT)).toBeUndefined();
    expect(f.records.inspect()).toMatchObject({ assets: 0, adoptions: 0, adoptionBytes: 0 });
    const handle = (await f.assets.load(ROOT, kind)).unwrap();
    expect(f.assets.read(handle).unwrap()).toMatchObject({ sum: 12 });
    expect(f.assets.sourceOf(handle)?.publication?.sourceRevision).toBe('2');
    f.assets.release(handle).unwrap();
  });

  it('rejects retirement and reinstall of the same decoder during preparation', async () => {
    const f = fixture();
    const reached = f.pause();
    const loading = f.assets.load(ROOT, kind);
    await reached;
    f.reinstall();
    expect(await loading).toMatchObject({ ok: false });
    expect(f.records.inspect()).toMatchObject({ assets: 0, adoptions: 0, adoptionBytes: 0 });
    const handle = (await f.assets.load(ROOT, kind)).unwrap();
    expect(f.assets.read(handle).unwrap()).toMatchObject({ sum: 11 });
    f.assets.release(handle).unwrap();
  });

  it('queues same-GUID loads with independent caller grants and cancellation', async () => {
    const f = fixture();
    const reached = f.pause();
    const first = f.assets.load(ROOT, kind);
    await reached;
    const abort = new AbortController();
    const cancelled = f.assets.load(ROOT, kind, { signal: abort.signal });
    const second = f.assets.load(ROOT, kind);
    abort.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { code: 'asset-load-cancelled' } });
    const a = (await first).unwrap(),
      b = (await second).unwrap();
    expect(a).toBe(b);
    expect(f.records.refcount(a)).toBe(3); // One cache and two independent callers.
    expect(f.records.inspect()).toMatchObject({ assets: 2, adoptions: 0, adoptionBytes: 0 });
    f.assets.release(a).unwrap();
    f.assets.release(b).unwrap();
  });

  it('preserves a shared committed dependency when another queued root is prepared', async () => {
    const f = fixture();
    const a = (await f.assets.load(ROOT, kind)).unwrap();
    const shared = runtimeAssetReference(f.assets, CHILD) as AssetHandle;
    const b = (await f.assets.load(OTHER, kind)).unwrap();
    expect(f.records.refcount(shared)).toBe(3); // Cache and the two real parent edges.
    expect(f.records.inspect()).toMatchObject({ assets: 3, adoptions: 0 });
    f.assets.release(a).unwrap();
    f.assets.release(b).unwrap();
  });

  it('closes suspended source readers and reservations without future frames', async () => {
    const f = fixture();
    const reached = f.pause();
    const loading = f.assets.load(ROOT, kind);
    await reached;
    f.assets.dispose();
    expect(f.records.inspect()).toMatchObject({ assets: 0, adoptionAssets: 0, adoptionBytes: 0 });
    expect(await loading).toMatchObject({ ok: false, error: { code: 'asset-owner-closed' } });
  });
  it('revalidates after extension code mutates source inside the same synchronous step', async () => {
    const f = fixture();
    f.onRoot(() => f.assets.invalidate(ROOT));
    expect(await f.assets.load(ROOT, kind)).toMatchObject({ ok: false });
    expect(runtimeAssetReference(f.assets, ROOT)).toBeUndefined();
    expect(f.records.inspect()).toMatchObject({ assets: 0, adoptions: 0, adoptionBytes: 0 });
  });

  it('rejects a changed external publication even when staged source rows remain current', async () => {
    const f = fixture(true);
    f.onRoot(f.replaceExternalEvidence);
    expect(await f.assets.load(ROOT, kind)).toMatchObject({
      ok: false,
      error: { code: 'asset-dependency-failed', detail: { dependencyGuid: EVIDENCE } },
    });
    expect(runtimeAssetReference(f.assets, ROOT)).toBeUndefined();
    expect(f.records.inspect()).toMatchObject({ assets: 0, adoptions: 0, adoptionBytes: 0 });
  });

  it('uses the existing realm clock fallback when Performance is unavailable', async () => {
    const f = fixture();
    vi.stubGlobal('performance', undefined);
    try {
      const handle = (await f.assets.load(ROOT, kind)).unwrap();
      expect(f.assets.read(handle).unwrap()).toMatchObject({ sum: 11 });
      f.assets.release(handle).unwrap();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('terminates after a partial record publication even when the unexpected fault is an AssetError', async () => {
    const f = fixture();
    const failure = new AssetError({
      code: 'asset-invalid-value',
      expected: 'injected publication failure',
      hint: 'rebuild owner',
    });
    Reflect.set(f.records, 'changed', () => {
      throw failure;
    });
    await expect(f.assets.load(ROOT, kind)).rejects.toBe(failure);
    expect(f.records.inspect()).toMatchObject({ assets: 0, adoptionAssets: 0, adoptionBytes: 0 });
    expect(await f.assets.load(ROOT, kind)).toMatchObject({
      ok: false,
      error: { code: 'asset-owner-closed' },
    });
  });
});
