import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defineAssetKind } from '../asset-kind.js';
import { type CatalogListener, createCatalogSource } from '../catalog-source.js';
import { CatalogSession } from '../internal/catalog-session.js';
import { createAssetRegistry } from '../internal/load-asset.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const scope = { scopeId: 'test', generation: 1 };
const kind = defineAssetKind<{ value: string }, 'test-demand'>('test-demand');
function gate<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function publication(guid: string, generation = 1, refs: string[] = [], plugin = false) {
  const packageUrl = `https://demand.invalid/${guid}.pack.json`;
  const value = createRuntimePackPublication({
    ...scope,
    generation,
    sourcePath: 'source.meta.json',
    sourceRevision: String(generation),
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: plugin ? 'plugin' : kind.kind,
          payload: plugin ? { kind: 'plugin', program: 'project:plugin#default' } : { value: guid },
          refs,
          artifacts: {},
        },
      ],
    },
  });
  const row: CatalogEntry = {
    guid,
    kind: plugin ? 'plugin' : kind.kind,
    packageUrl,
    sourcePath: 'source.meta.json',
    lifecycle: 'current',
    publication: value.publication,
  };
  return { ...value, row };
}
function declaration(row: CatalogEntry): CatalogEntry {
  const { publication: _, ...navigation } = row;
  return { ...navigation, lifecycle: 'missing' };
}
function subscribe() {
  let listener: CatalogListener = () => {};
  return {
    subscribe(next: CatalogListener) {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
    emit(delta: CatalogDelta) {
      listener(delta);
    },
  };
}

it('keeps native plugin references deferred until that asset is requested', async () => {
  const root = publication(A, 1, [B], true);
  const child = publication(B);
  const fetchPack = vi.fn(async (_guid: string) => ({ ok: true as const, entries: [child.row] }));
  const registry = createAssetRegistry({
    catalog: createCatalogSource({
      entries: [declaration(child.row), root.row],
      expectedScope: scope,
      importTransport: { fetchPack },
    }),
    fetcher: async () => Response.json(root.pack),
  });
  try {
    expect(await registry.readPluginDefinition(A)).toMatchObject({ ok: true });
    expect(fetchPack).not.toHaveBeenCalled();
    expect(registry.snapshot().ready).toEqual([A]);
  } finally {
    registry.dispose();
  }
});

it('materializes the requested eager closure while leaving an unrelated declaration untouched', async () => {
  const root = publication(A, 1, [B]);
  const child = publication(B);
  const unused = publication(C);
  const fetchPack = vi.fn(async (_guid: string) => ({ ok: true as const, entries: [child.row] }));
  const registry = createAssetRegistry({
    catalog: createCatalogSource({
      entries: [root.row, declaration(child.row), declaration(unused.row)],
      expectedScope: scope,
      importTransport: { fetchPack },
    }),
    fetcher: async (url) =>
      Response.json(String(url) === root.row.packageUrl ? root.pack : child.pack),
  });
  registry.installDecoder(kind, {
    async decode({ envelope }) {
      return ok(envelope.payload as { value: string });
    },
  });
  try {
    expect(await registry.load(A, kind)).toMatchObject({ ok: true, value: { value: A } });
    expect(fetchPack).toHaveBeenCalledTimes(1);
    expect(fetchPack.mock.calls[0]?.[0]).toBe(B);
    expect(registry.snapshot().ready).toEqual([A, B]);
  } finally {
    registry.dispose();
  }
});

it('rejects a declared kind mismatch before requesting its unpublished package', async () => {
  const published = publication(A);
  const fetchPack = vi.fn(async () => ({ ok: true as const, entries: [published.row] }));
  const registry = createAssetRegistry({
    catalog: createCatalogSource({
      entries: [declaration(published.row)],
      expectedScope: scope,
      importTransport: { fetchPack },
    }),
  });
  try {
    expect(await registry.load(A, 'mesh')).toMatchObject({
      ok: false,
      error: {
        code: 'asset-kind-mismatch',
        detail: { guid: A, expectedKind: 'mesh', actualKind: kind.kind },
      },
    });
    expect(fetchPack).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});

it('keeps independent concurrent demand publications from superseding an unrelated package read', async () => {
  const first = publication(A);
  const second = publication(B);
  const entered = gate<void>();
  const held = gate<Response>();
  const fetchPack = vi.fn(async (guid: string) => ({
    ok: true as const,
    entries: [guid === A ? first.row : second.row],
  }));
  const registry = createAssetRegistry({
    catalog: createCatalogSource({
      entries: [declaration(first.row), declaration(second.row)],
      expectedScope: scope,
      importTransport: { fetchPack },
    }),
    fetcher: async (url) => {
      if (String(url) === first.row.packageUrl) {
        entered.resolve();
        return held.promise;
      }
      return Response.json(second.pack);
    },
  });
  registry.installDecoder(kind, {
    async decode({ envelope }) {
      return ok(envelope.payload as { value: string });
    },
  });
  try {
    const firstRead = registry.load(A, kind);
    await entered.promise;
    expect(await registry.load(B, kind)).toMatchObject({ ok: true, value: { value: B } });
    held.resolve(Response.json(first.pack));
    expect(await firstRead).toMatchObject({ ok: true, value: { value: A } });
    expect(fetchPack).toHaveBeenCalledTimes(2);
    expect(registry.snapshot().ready).toEqual([A, B]);
  } finally {
    held.resolve(Response.json(first.pack));
    registry.dispose();
  }
});

it.each([
  'current',
  'missing',
] as const)('rejects a malformed %s publication without calling the producer', async (lifecycle) => {
  const valid = publication(A);
  const broken = {
    ...valid.row,
    lifecycle,
    publication: { ...valid.publication, generation: Number.NaN },
  };
  const fetchPack = vi.fn(async () => ({ ok: true as const, entries: [valid.row] }));
  const registry = createAssetRegistry({
    catalog: createCatalogSource({
      entries: [broken],
      expectedScope: scope,
      importTransport: { fetchPack },
    }),
  });
  try {
    expect(await registry.load(A, kind)).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid', detail: { reason: 'publication generation' } },
    });
    expect(fetchPack).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});

it('rejects late sibling publications after a newer sibling HMR update', async () => {
  const first = publication(A);
  const sibling = publication(B);
  const newerSibling = publication(B, 2);
  const channel = subscribe();
  const held = gate<readonly CatalogEntry[]>();
  const session = new CatalogSession(
    {
      enumerate: async () => ok([declaration(first.row), declaration(sibling.row)]),
      subscribe: channel.subscribe,
      get: async () => ok(await held.promise),
    },
    scope,
  );
  try {
    expect((await session.start()).ok).toBe(true);
    const pending = session.get(A);
    channel.emit({ added: [], changed: [newerSibling.row], removed: [], ...scope });
    held.resolve([first.row, sibling.row]);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'asset-superseded', detail: { guid: B } },
    });
    expect(session.current(B)?.publication?.generation).toBe(2);
    expect(session.current(A)?.publication).toBeUndefined();
  } finally {
    session.dispose();
  }
});

it('fences replacement scope and disposal while a producer response remains pending', async () => {
  for (const retire of ['scope', 'dispose'] as const) {
    const published = publication(A);
    const channel = subscribe();
    const held = gate<readonly CatalogEntry[]>();
    const session = new CatalogSession(
      {
        enumerate: async () => ok([declaration(published.row)]),
        subscribe: channel.subscribe,
        get: async () => ok(await held.promise),
      },
      scope,
    );
    await session.start();
    const pending = session.get(A);
    if (retire === 'dispose') session.dispose();
    else channel.emit({ added: [], changed: [], removed: [], ...scope, generation: 2 });
    if (retire === 'scope') held.resolve([published.row]);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: retire === 'dispose' ? 'asset-runtime-disposed' : 'catalog-discontinuous' },
    });
    held.resolve([published.row]);
    expect(session.current(A)?.publication).toBeUndefined();
    session.dispose();
  }
});

it('rejects a late read after removal and identical navigation re-addition', async () => {
  const published = publication(A);
  const row = declaration(published.row);
  const channel = subscribe();
  const held = gate<readonly CatalogEntry[]>();
  const session = new CatalogSession(
    {
      enumerate: async () => ok([row]),
      subscribe: channel.subscribe,
      get: async () => ok(await held.promise),
    },
    scope,
  );
  await session.start();
  const pending = session.get(A);
  channel.emit({ added: [], changed: [], removed: [A], ...scope });
  channel.emit({ added: [row], changed: [], removed: [], ...scope });
  held.resolve([published.row]);
  expect(await pending).toMatchObject({ ok: false, error: { code: 'asset-superseded' } });
  expect(session.current(A)?.publication).toBeUndefined();
  session.dispose();
});

it('returns a structured Result when a custom source get rejects', async () => {
  const published = publication(A);
  const session = new CatalogSession(
    {
      enumerate: async () => ok([declaration(published.row)]),
      subscribe: () => () => {},
      get: async () => {
        throw new Error('native source rejection');
      },
    },
    scope,
  );
  await session.start();
  expect(await session.get(A)).toMatchObject({
    ok: false,
    error: {
      code: 'asset-package-invalid',
      detail: { guid: A, reason: 'native source rejection' },
    },
  });
  expect(session.current(A)?.publication).toBeUndefined();
  session.dispose();
});

it('applies the source fixed revision requirement to fresh demand rows', async () => {
  const published = publication(A);
  const revision = { digest: 'fixed', observedAt: 1, rootId: 'authored' };
  const source = createCatalogSource({
    entries: [{ ...declaration(published.row), revision }],
    expectedScope: scope,
    expectedRevision: revision,
    importTransport: {
      fetchPack: async () => ({
        ok: true,
        entries: [{ ...published.row, revision: { ...revision, digest: 'other' } }],
      }),
    },
  });
  expect(await source.get?.(A)).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
});
