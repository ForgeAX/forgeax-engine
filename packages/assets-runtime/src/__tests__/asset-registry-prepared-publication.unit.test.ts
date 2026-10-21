import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import type { Asset, CatalogEntry, MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import type { CatalogListener } from '../catalog-source';
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
          payload: { passes: [{ name: 'forward', program: { module: 'test' } }], values: {} },
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
  const registry = new AssetRegistry({ scopeId: 'prepared-test' });
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  let listener: CatalogListener | undefined;
  registry.setCatalogSource(
    createCatalogSource({
      entries: [],
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    }),
    fetcher,
  );
  const publishedRows = structuredClone(rows);
  const publish = () =>
    listener?.({
      scopeId: 'prepared-test',
      generation: 0,
      added: publishedRows,
      changed: [],
      removed: [],
    });
  const prepare = () =>
    registry.preparePublication(rows, fetcher, undefined, { pack: publication.pack });
  return { registry, pack: publication.pack, rows, prepare, publish };
}

it('adopts prepared edits atomically without publishing them as saved source content', async () => {
  const { registry, pack, prepare, publish } = await fixture();
  try {
    (await prepare()).unwrap();
    registry.commitPreparedPublication(pack);
    publish();
    const handle = (await registry.load(guid, 'material')).unwrap();
    const origin = registry.sourceOf(handle);
    const row = registry.catalogEntry(guid);
    (await prepare()).unwrap();
    expect(registry.adoptPreparedContent(pack).ok).toBe(true);
    expect(registry.sourceOf(handle)).toMatchObject({
      modified: true,
      publication: origin?.publication,
    });
    expect(registry.catalogEntry(guid)).toEqual(row);
    expect(registry.adoptPreparedContent(pack).ok).toBe(false);
    (await prepare()).unwrap();
    registry.update(handle, { values: { color: [0.1, 0.2, 0.3, 1] } }).unwrap();
    expect(registry.adoptPreparedContent(pack)).toMatchObject({
      ok: false,
      error: { code: 'asset-write-conflict' },
    });
    expect(registry.read(handle).unwrap().values.color).toEqual([0.1, 0.2, 0.3, 1]);
    registry.release(handle).unwrap();
  } finally {
    registry.dispose();
  }
});

it('keeps unpublished payloads private and ignores edits to source, rows, returned maps and reads', async () => {
  const { registry, pack, rows, prepare, publish } = await fixture();
  try {
    const result = (await prepare()).unwrap();
    expect(registry.catalogEntry(guid)).toBeUndefined();
    expect(registry.inspectSource()?.ready).toEqual([]);
    const read = defined(result.get(guid));
    const payload = typeof read === 'function' ? await read() : read;
    Object.assign(payload, invalid());
    (result as Map<string, Asset>).set(guid, invalid());
    (defined(pack.assets[0]).payload as Record<string, unknown>).passes = [];
    rows.length = 0;
    expect(prepareAssetPayload(invalid()).ok).toBe(false);
    registry.commitPreparedPublication(pack);
    expect(registry.catalogEntry(guid)).toBeUndefined();
    publish();
    const handle = (await registry.load(guid, 'material')).unwrap();
    const loaded = registry.read(handle).unwrap();
    expect(loaded.passes).toHaveLength(1);
    Object.assign(loaded, invalid());
    const retained = typeof read === 'function' ? await read() : read;
    expect((retained as MaterialAsset).passes).toHaveLength(1);
    expect(() => registry.commitPreparedPublication(pack)).toThrow();
    // Public registration remains validated even for a previously prepared object.
    Object.assign(loaded, invalid());
    expect(registry.replace(handle, loaded).ok).toBe(false);
    registry.release(handle).unwrap();
  } finally {
    registry.dispose();
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
    await registry.enumerateCatalog();
    const pending = prepare();
    if (fault === 'changed-rows') rows.length = 0;
    if (fault === 'guid-before-await') registry.invalidate(guid);
    (await pending).unwrap();
    if (fault === 'clear') registry.dispose();
    if (fault === 'replace')
      registry.setCatalogSource(createCatalogSource({ entries: [] }), fetcher);
    if (fault === 'all') registry.invalidateAll();
    if (fault === 'guid' || fault === 'changed-rows') registry.invalidate(guid);
    expect(() => registry.commitPreparedPublication(pack)).toThrow();
    expect(registry.inspectSource()?.ready ?? []).not.toContain(guid);
  } finally {
    registry.dispose();
  }
});

it('rejects cross-owner, copied and synchronously reentered candidate proofs', async () => {
  const { registry, pack, prepare } = await fixture();
  const foreign = new AssetRegistry({ scopeId: 'prepared-test' });
  try {
    (await prepare()).unwrap();
    expect(() => foreign.commitPreparedPublication(pack)).toThrow();
    expect(() => registry.commitPreparedPublication(structuredClone(pack))).toThrow();
    expect(() =>
      registry.commitPreparedPublication(pack, () => registry.commitPreparedPublication(pack)),
    ).toThrow();
    expect(registry.inspectSource()?.ready ?? []).not.toContain(guid);
  } finally {
    registry.dispose();
    foreign.dispose();
  }
});

it('checks publication context again after provider notification', async () => {
  const { registry, pack, prepare } = await fixture();
  try {
    (await prepare()).unwrap();
    expect(() =>
      registry.commitPreparedPublication(pack, () => registry.invalidateAll()),
    ).toThrow();
    expect(registry.inspectSource()?.ready ?? []).not.toContain(guid);
  } finally {
    registry.dispose();
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
    registry.dispose();
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
    const registry = new AssetRegistry({ scopeId: 'prepared-test' });
    registry.installDecoder(materialContribution.kind, materialContribution.decoder);
    let listener: CatalogListener | undefined;
    registry.setCatalogSource(
      createCatalogSource({
        entries: [parent.row, ...(prepared ? [] : [dependent.row])],
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      }),
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
        listener?.({
          scopeId: 'prepared-test',
          generation: 0,
          added: [dependent.row],
          changed: [],
          removed: [],
        });
      }
      const result = await registry.load(child, 'material');
      if (validParent && !result.ok) throw result.error;
      expect(result.ok).toBe(validParent);
      if (!result.ok) expect(result.error.code).toBe('asset-dependency-failed');
      else registry.release(result.value).unwrap();
    } finally {
      registry.dispose();
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

it('repeated prepared generations keep GUID handles and roll back every sibling on an invalid Scene', async () => {
  const { World, defineComponent } = await import('@forgeax/engine-ecs');
  const { sceneAssetContribution, ChildOf, Children } = await import('@forgeax/engine-scene');
  const { registry, pack, prepare, publish } = await fixture();
  const world = new World({ assets: registry });
  const Light = defineComponent('AuthorLight', { intensity: 'f32' });
  const Instance = defineComponent('SceneInstance', {
    source: 'asset<scene>',
    mapping: 'array<entity>',
    state: 'unique<SceneInstanceState>',
  });
  for (const component of [Light, Instance, ChildOf, Children])
    world.components.register(component).unwrap();
  registry.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  const sceneGuid = '01900000-0000-7000-8000-000000000992';
  try {
    (await prepare()).unwrap();
    registry.commitPreparedPublication(pack);
    publish();
    const handle = (await registry.load(guid, 'material')).unwrap();
    const catalog = registry.catalogEntry(guid);
    const candidate = async (color: number, intensity: unknown) => {
      const prepared = createRuntimePackPublication({
        scopeId: 'prepared-test',
        sourcePath: 'candidate.pack.ts',
        sourceRevision: 'draft',
        packageUrl,
        pack: {
          assets: [
            {
              guid,
              kind: 'material',
              refs: [],
              artifacts: {},
              payload: {
                passes: [{ name: 'forward', program: { module: 'test' } }],
                values: { color: [color, 0, 0, 1] },
              },
            },
            {
              guid: sceneGuid,
              kind: 'scene',
              refs: [],
              artifacts: {},
              payload: { entities: { light: { components: { AuthorLight: { intensity } } } } },
            },
          ],
        },
      });
      const rows: CatalogEntry[] = prepared.pack.assets.map((asset) => ({
        guid: asset.guid,
        kind: asset.kind,
        refs: [],
        sourcePath: 'candidate.pack.ts',
        packageUrl,
        publication: prepared.publication,
      }));
      (
        await registry.preparePublication(rows, fetcher, undefined, { pack: prepared.pack })
      ).unwrap();
      return prepared.pack;
    };
    registry.adoptPreparedContent(await candidate(0.2, 1)).unwrap();
    expect(registry.read(handle).unwrap().values.color).toEqual([0.2, 0, 0, 1]);
    registry
      .adoptPreparedContent(await candidate(0.3, 2), [
        { guid, path: ['values', 'color'], value: [0, 1, 0, 1] },
      ])
      .unwrap();
    expect(registry.read(handle).unwrap().values.color).toEqual([0, 1, 0, 1]);
    const observer = registry.observe().unwrap();
    observer.read().unwrap().accept();
    const rejected = await candidate(0.8, 4);
    expect(() =>
      registry.adoptPreparedContent(rejected, [], () => {
        throw new Error('Scene consumer rejected candidate');
      }),
    ).toThrow('Scene consumer rejected candidate');
    expect(registry.read(handle).unwrap().values.color).toEqual([0, 1, 0, 1]);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    expect(registry.adoptPreparedContent(await candidate(0.9, 'invalid')).ok).toBe(false);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    observer.dispose();
    expect(registry.read(handle).unwrap().values.color).toEqual([0, 1, 0, 1]);
    expect(registry.catalogEntry(guid)).toEqual(catalog);
    expect(registry.catalogEntry(sceneGuid)).toBeUndefined();
    expect((await registry.load(guid, 'material')).unwrap()).toBe(handle);
    registry.release(handle).unwrap();
    registry.release(handle).unwrap();
  } finally {
    registry.dispose();
  }
});
