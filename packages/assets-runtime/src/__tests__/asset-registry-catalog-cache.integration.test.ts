import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { type CatalogListener, createCatalogSource } from '../catalog-source';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const kind = defineAssetKind<{ revision: number }>('catalog-cache-fixture');
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture() {
  let rows: CatalogEntry[] = [];
  let listener: CatalogListener = () => {};
  const packages = new Map<string, unknown>();
  const waits = new Map<string, ReturnType<typeof gate>>();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = packages.get(url);
    await waits.get(url)?.promise;
    return Response.json(body ?? {}, { status: body === undefined ? 404 : 200 });
  });
  const enumerate = vi.fn(async () => ok(rows));
  const source = {
    enumerate,
    openPackage: () => fetcher,
    subscribe(next: CatalogListener) {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
  };
  const assets = new AssetRegistry({ catalog: source });
  assets.installDecoder(kind, {
    decode: async ({ envelope }) => ok(envelope.payload),
    prepare: (value) => ok(value),
  });
  const publish = (guid: string, revision: number, notify = true, refs: string[] = []) => {
    const packageUrl = `https://catalog.invalid/${guid}/${revision}.pack.json`;
    const produced = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: guid,
      sourceRevision: String(revision),
      packageUrl,
      pack: { assets: [{ guid, kind: kind.kind, payload: { revision }, refs, artifacts: {} }] },
    });
    packages.set(packageUrl, produced.pack);
    const row: CatalogEntry = {
      guid,
      kind: kind.kind,
      sourcePath: guid,
      packageUrl,
      publication: produced.publication,
    };
    const existed = rows.some((entry) => entry.guid === guid);
    rows = [...rows.filter((entry) => entry.guid !== guid), row];
    if (notify)
      listener({ added: existed ? [] : [row], changed: existed ? [row] : [], removed: [] });
    return row;
  };
  return {
    assets,
    source,
    enumerate,
    fetcher,
    publish,
    block(url: string) {
      const wait = gate();
      waits.set(url, wait);
      return wait;
    },
    emit(delta: CatalogDelta) {
      listener(delta);
    },
    remove(guid: string) {
      rows = rows.filter((entry) => entry.guid !== guid);
    },
  };
}

it('shares one Catalog authority between concurrent navigation and loading, then retains gameplay edits', async () => {
  const f = fixture();
  try {
    f.publish(A, 1);
    const [navigation, first, second] = await Promise.all([
      f.assets.enumerateCatalog(),
      f.assets.load(A, kind),
      f.assets.load(A, kind),
    ]);
    expect(navigation.unwrap().map((row) => row.guid)).toEqual([A]);
    expect(first.unwrap()).toBe(second.unwrap());
    expect(f.enumerate).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.assets.update(first.unwrap(), { revision: 9 }).unwrap();
    f.publish(A, 2);
    const again = (await f.assets.load(A, kind)).unwrap();
    expect(again).toBe(first.unwrap());
    expect(f.assets.read(again).unwrap().revision).toBe(9);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    f.assets.dispose();
  }
});

it('reconciles missed source changes and removals without rewriting live runtime content', async () => {
  const f = fixture();
  try {
    f.publish(A, 1);
    f.publish(B, 1);
    const a = (await f.assets.load(A, kind)).unwrap();
    const b = (await f.assets.load(B, kind)).unwrap();
    f.publish(A, 2, false);
    f.remove(B);
    (await f.assets.reconcileCatalog()).unwrap();
    expect(f.assets.catalogEntry(B)).toBeUndefined();
    expect(f.assets.read(a).unwrap().revision).toBe(1);
    expect(f.assets.read(b).unwrap().revision).toBe(1);
    (await f.assets.reload(a, { conflict: 'reject' })).unwrap();
    expect(f.assets.read(a).unwrap().revision).toBe(2);
    expect((await f.assets.reload(b, { conflict: 'reject' })).ok).toBe(false);
    expect(f.assets.read(b).unwrap().revision).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  } finally {
    f.assets.dispose();
  }
});

it('preserves an unrelated pending load and fences changed content across reconciliation', async () => {
  const f = fixture();
  const rowA = f.publish(A, 1),
    rowB = f.publish(B, 1);
  const waitA = f.block(rowA.packageUrl),
    waitB = f.block(rowB.packageUrl);
  try {
    const a = f.assets.load(A, kind),
      stale = f.assets.load(B, kind);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    f.publish(B, 2, false);
    (await f.assets.reconcileCatalog()).unwrap();
    const fresh = (await f.assets.load(B, kind)).unwrap();
    waitA.release();
    waitB.release();
    expect(f.assets.read((await a).unwrap()).unwrap().revision).toBe(1);
    expect((await stale).ok).toBe(false);
    expect(f.assets.read(fresh).unwrap().revision).toBe(2);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  } finally {
    waitA.release();
    waitB.release();
    f.assets.dispose();
  }
});

it('rejects incomplete eager closures before exposing their root and admits the repaired source', async () => {
  const f = fixture();
  try {
    f.publish(A, 1, true, [B]);
    expect((await f.assets.load(A, kind)).ok).toBe(false);
    expect(f.assets.inspect().assets).toEqual([]);
    f.publish(B, 1);
    const root = (await f.assets.load(A, kind)).unwrap();
    expect(f.assets.read(root).unwrap().revision).toBe(1);
    expect(f.assets.inspectSource()?.ready).toEqual([A, B]);
  } finally {
    f.assets.dispose();
  }
});

it('uses only the explicitly installed source when another configured URL was replaced', async () => {
  const f = fixture();
  try {
    f.publish(A, 1);
    const first = (await f.assets.load(A, kind)).unwrap();
    const other = fixture();
    try {
      other.publish(B, 2);
      f.assets.setCatalogSource(other.source);
      expect((await f.assets.enumerateCatalog()).unwrap().map((entry) => entry.guid)).toEqual([B]);
      expect(f.assets.read((await f.assets.load(B, kind)).unwrap()).unwrap().revision).toBe(2);
      expect(f.assets.read(first).unwrap().revision).toBe(1);
      expect((await f.assets.reload(first, { conflict: 'reject' })).ok).toBe(false);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      other.assets.dispose();
    }
  } finally {
    f.assets.dispose();
  }
});

it.each([
  'scope',
  'revision',
] as const)('does not reuse a formerly accepted URL catalog across a new %s constraint', async (constraint) => {
  const f = fixture();
  try {
    const row = f.publish(A, 1);
    const first = (await f.assets.load(A, kind)).unwrap();
    const revision = { rootId: 'root', digest: 'sha256:first', observedAt: 1 };
    const fetcher = vi.fn(async () =>
      Response.json({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'first',
        generation: 1,
        authority: 'authoritative',
        entries: [{ ...row, revision }],
        diagnostics: [],
      }),
    );
    f.assets.setCatalogSource(
      createCatalogSource({
        url: 'https://catalog.invalid/catalog.json',
        fetch: fetcher,
        ...(constraint === 'scope'
          ? { expectedScope: { scopeId: 'second', generation: 1 } }
          : { expectedRevision: { ...revision, digest: 'sha256:second', observedAt: 2 } }),
      }),
    );
    expect((await f.assets.enumerateCatalog()).ok).toBe(false);
    expect((await f.assets.reload(first, { conflict: 'reject' })).ok).toBe(false);
    expect(f.assets.read(first).unwrap().revision).toBe(1);
    expect(fetcher).toHaveBeenCalled();
  } finally {
    f.assets.dispose();
  }
});

it('rejects a delayed enumeration from a retired source and retains the current Catalog', async () => {
  const waiting = gate(),
    entered = gate();
  const f = fixture();
  try {
    const row = f.publish(A, 1);
    f.assets.setCatalogSource({
      enumerate: async () => {
        entered.release();
        await waiting.promise;
        return ok([row]);
      },
      subscribe: () => () => {},
    });
    const old = f.assets.enumerateCatalog();
    await entered.promise;
    f.assets.setCatalogSource(createCatalogSource({ entries: [] }));
    expect((await f.assets.enumerateCatalog()).unwrap()).toEqual([]);
    waiting.release();
    expect((await old).ok).toBe(false);
    expect(f.assets.listCatalog()).toEqual([]);
  } finally {
    waiting.release();
    f.assets.dispose();
  }
});
