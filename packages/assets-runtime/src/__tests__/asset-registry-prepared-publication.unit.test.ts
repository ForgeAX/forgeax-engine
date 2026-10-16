import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { Asset, CatalogEntry, MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';
import { prepareAssetPayload } from '../prepare-payload.js';
import { defined } from './assert-defined.js';

const guid = '01900000-0000-7000-8000-000000000991';
const packageUrl = 'https://prepared.invalid/candidate.pack.json';
const fetcher: typeof fetch = async () => new Response('', { status: 404 });
const invalid = (): MaterialAsset =>
  ({ kind: 'material', passes: [], values: {} }) as unknown as MaterialAsset;
async function fixture() {
  const publication = createRuntimePackPublication({
    scopeId: 'prepared-test',
    sourcePath: 'candidate.pack.ts',
    sourceRevision: 'test',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'material',
          payload: { passes: [{ program: { module: 'test' } }], values: {} },
          refs: [],
          artifacts: {},
        },
      ],
    },
  });
  const rows: CatalogEntry[] = [
    {
      guid,
      kind: 'material',
      sourcePath: 'candidate.pack.ts',
      packageUrl,
      refs: [],
      publication: publication.publication,
    },
  ];
  const registry = new AssetRegistry({} as never);
  registry.setCatalogSource(createCatalogSource({ entries: [] }), fetcher);
  const prepare = () =>
    registry.preparePublication(rows, fetcher, undefined, { pack: publication.pack });
  return { registry, pack: publication.pack, rows, prepare };
}

it('keeps unpublished payloads private and ignores edits to source, rows, returned maps and reads', async () => {
  const { registry, pack, rows, prepare } = await fixture();
  try {
    const result = (await prepare()).unwrap();
    expect(registry.lookup(guid)).toBeUndefined();
    expect(registry.loadState.get(guid)).toBeUndefined();
    const read = defined(result.get(guid));
    const payload = typeof read === 'function' ? await read() : read;
    Object.assign(payload, invalid());
    (result as Map<string, Asset>).set(guid, invalid());
    (defined(pack.assets[0]).payload as Record<string, unknown>).passes = [];
    rows.length = 0;
    expect(prepareAssetPayload(invalid()).ok).toBe(false);
    registry.commitPreparedPublication(pack);
    const loaded = (await registry.loadByGuid<MaterialAsset>(registry.parseGuid(guid))).unwrap();
    expect(loaded.passes).toHaveLength(1);
    Object.assign(loaded, invalid());
    const retained = typeof read === 'function' ? await read() : read;
    expect((retained as MaterialAsset).passes).toHaveLength(1);
    expect(() => registry.commitPreparedPublication(pack)).toThrow();
    // Public registration remains validated even for a previously prepared object.
    Object.assign(loaded, invalid());
    expect(registry.catalog(guid, loaded).ok).toBe(false);
  } finally {
    registry.clearCatalogSource();
  }
});

it.each([
  'clear',
  'replace',
  'all',
  'guid',
  'guid-before-await',
  'changed-rows',
] as const)('rejects a candidate after %s invalidation', async (fault) => {
  const { registry, pack, rows, prepare } = await fixture();
  try {
    await registry.ensurePackIndexCache();
    const pending = prepare();
    if (fault === 'changed-rows') rows.length = 0;
    if (fault === 'guid-before-await') registry.invalidate(guid);
    (await pending).unwrap();
    if (fault === 'clear') registry.clearCatalogSource();
    if (fault === 'replace')
      registry.setCatalogSource(createCatalogSource({ entries: [] }), fetcher);
    if (fault === 'all') registry.invalidateAll();
    if (fault === 'guid' || fault === 'changed-rows') registry.invalidate(guid);
    expect(() => registry.commitPreparedPublication(pack)).toThrow();
    expect(registry.loadState.getPrepared(guid)).toBeUndefined();
  } finally {
    registry.clearCatalogSource();
  }
});

it('rejects cross-owner, copied and synchronously reentered candidate proofs', async () => {
  const { registry, pack, prepare } = await fixture();
  const foreign = new AssetRegistry({} as never);
  try {
    (await prepare()).unwrap();
    expect(() => foreign.commitPreparedPublication(pack)).toThrow();
    expect(() => registry.commitPreparedPublication(structuredClone(pack))).toThrow();
    expect(() =>
      registry.commitPreparedPublication(pack, () => registry.commitPreparedPublication(pack)),
    ).toThrow();
    expect(registry.loadState.getPrepared(guid)).toBeUndefined();
  } finally {
    registry.clearCatalogSource();
    foreign.clearCatalogSource();
  }
});

it('checks publication context again after provider notification', async () => {
  const { registry, pack, prepare } = await fixture();
  try {
    (await prepare()).unwrap();
    expect(() =>
      registry.commitPreparedPublication(pack, () => registry.invalidateAll()),
    ).toThrow();
    expect(registry.loadState.getPrepared(guid)).toBeUndefined();
  } finally {
    registry.clearCatalogSource();
  }
});

it('rejects shared mutable bytes and accessors before preparing any owner payload', async () => {
  const { registry, pack, prepare } = await fixture();
  try {
    const payload = defined(pack.assets[0]).payload as Record<string, unknown>;
    payload.values = { scratch: new Uint8Array(new SharedArrayBuffer(4)) };
    expect(await prepare()).toMatchObject({
      ok: false,
      error: { code: 'asset-parse-failed', hint: expect.stringContaining('shared') },
    });
    let reads = 0;
    Object.defineProperty(payload, 'values', {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return {};
      },
    });
    expect(await prepare()).toMatchObject({
      ok: false,
      error: { code: 'asset-parse-failed', hint: expect.stringContaining('data property') },
    });
    expect(reads).toBe(0);
    expect(() => registry.commitPreparedPublication(pack)).toThrow();
  } finally {
    registry.clearCatalogSource();
  }
});

it.each([
  true,
  false,
])('keeps material Pack refs and parent errors when Catalog refs are omitted (valid parent: %s)', async (validParent) => {
  const child = '01900000-0000-7000-8000-000000000992';
  const make = (id: string, payload: unknown, refs: string[]) => {
    const url = `https://prepared.invalid/${id}.pack.json`;
    const publication = createRuntimePackPublication({
      scopeId: 'prepared-test',
      sourcePath: 'candidate.pack.ts',
      sourceRevision: 'test',
      packageUrl: url,
      pack: { assets: [{ guid: id, kind: 'material', payload, refs, artifacts: {} }] },
    });
    const row: CatalogEntry = {
      guid: id,
      kind: 'material',
      sourcePath: 'candidate.pack.ts',
      packageUrl: url,
      publication: publication.publication,
    };
    return { pack: publication.pack, row };
  };
  const parent = make(
    guid,
    { passes: validParent ? [{ program: { module: 'test' } }] : [], values: {} },
    [],
  );
  const dependent = make(child, { parent: guid, values: {} }, [guid]);
  const read: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(String(input) === parent.row.packageUrl ? parent.pack : dependent.pack),
    );
  for (const prepared of [false, true]) {
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(
      createCatalogSource({ entries: [parent.row, ...(prepared ? [] : [dependent.row])] }),
      read,
    );
    try {
      if (prepared) {
        (
          await registry.preparePublication([dependent.row], read, undefined, {
            pack: dependent.pack,
            dependencies: new Map([[guid, { row: parent.row }]]),
          })
        ).unwrap();
        registry.commitPreparedPublication(dependent.pack);
      }
      const result = await registry.loadByGuid(registry.parseGuid(child));
      expect(result.ok).toBe(validParent);
      if (!result.ok) expect(result.error.hint).toContain('loading parent material ');
    } finally {
      registry.clearCatalogSource();
    }
  }
});

it('normalizes a wire parentGuid child once and reports child-contract failures', () => {
  const parent = '01900000-0000-7000-8000-000000000992';
  const child = (extra: Record<string, unknown>) =>
    ({ kind: 'material', parentGuid: parent, values: { a: 1 }, ...extra }) as unknown as Asset;
  const ok = prepareAssetPayload(child({}));
  expect(ok.ok && ok.value).toMatchObject({ kind: 'material', values: { a: 1 } });
  expect(ok.ok && 'parentGuid' in ok.value).toBe(false);
  expect(prepareAssetPayload(child({ parentGuid: 'not-a-guid' }))).toMatchObject({
    ok: false,
    error: {
      code: 'asset-parse-failed',
      hint: "parent GUID 'not-a-guid' is not a valid UUID format",
    },
  });
  expect(prepareAssetPayload(child({ passes: [] }))).toMatchObject({
    ok: false,
    error: { code: 'asset-parse-failed', detail: { field: 'material-child-contract' } },
  });
});
