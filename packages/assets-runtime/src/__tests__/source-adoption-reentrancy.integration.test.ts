import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { samplerContribution } from '../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';

function setup() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const sampler = assets.create({ kind: 'sampler', minFilter: 'nearest' }).unwrap();
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([1, 2, 3, 4]),
    })
    .unwrap();
  const records = runtimeAssets(assets);
  return { assets, sampler, texture, records, observer: records.observe().unwrap() };
}
type Fixture = ReturnType<typeof setup>;

const operations: readonly [string, (f: Fixture) => unknown][] = [
  ['update', ({ assets, sampler }) => assets.update(sampler, { minFilter: 'linear' })],
  ['create', ({ assets }) => assets.create({ kind: 'sampler', minFilter: 'linear' })],
  [
    'replace',
    ({ assets, sampler }) => assets.replace(sampler, { kind: 'sampler', minFilter: 'linear' }),
  ],
  [
    'writeRange',
    ({ assets, texture }) =>
      assets.writeRange(texture, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: new Uint8Array([8, 7, 6, 5]),
      }),
  ],
  ['release', ({ assets, sampler }) => assets.release(sampler)],
  ['retain', ({ assets, sampler }) => assets.retain(sampler)],
  ['snapshot', ({ assets, sampler }) => assets.snapshot(sampler)],
  ['pin', ({ records, sampler }) => records.pin(sampler)],
  ['observe', ({ records }) => records.observe()],
  ['observer read', ({ observer }) => observer.read()],
  ['dispose', ({ assets }) => assets.dispose()],
  ['clearCatalogSource', ({ assets }) => assets.clearCatalogSource()],
  [
    'setCatalogSource',
    ({ assets }) => assets.setCatalogSource(createCatalogSource({ entries: [] })),
  ],
];

it.each(
  operations,
)('rejects reentrant %s during source preparation without losing revisions or retryability', async (_name, mutate) => {
  const f = setup();
  const { assets, sampler, texture, records, observer } = f;
  assets.update(sampler, { minFilter: 'nearest' }).unwrap();
  const priorChanges = observer.read().unwrap().changes;
  const prior = records.currentRevision;
  const priorStats = records.inspect();
  const priorSampler = assets.read(sampler).unwrap();
  const priorTexture = assets.read(texture).unwrap();
  const kind = defineAssetKind<{ count: number }>('test-reentrant-source');
  const failure = new AssetError({
    code: 'asset-invalid-value',
    expected: 'valid source',
    hint: 'retry',
  });
  let preparingFailure = true;
  let attempted: unknown;
  assets.installDecoder(kind, {
    decode: async ({ envelope }) => ok(envelope.payload),
    prepare: (value) => {
      if (!preparingFailure) return ok(value);
      try {
        attempted = mutate(f);
      } catch (error) {
        attempted = err(error);
      }
      return err(failure);
    },
  });
  const guid = '00000000-0000-7000-8000-000000000919';
  const dependencyGuid = '00000000-0000-7000-8000-000000000918';
  const packageUrl = 'https://reentrant.invalid/pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'reentrant.pack',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        {
          guid: dependencyGuid,
          kind: 'sampler',
          refs: [],
          artifacts: {},
          payload: { kind: 'sampler', minFilter: 'nearest' },
        },
        { guid, kind: kind.kind, refs: [dependencyGuid], artifacts: {}, payload: { count: 1 } },
      ],
    },
  });
  assets.setCatalogSource(
    createCatalogSource({
      entries: [
        {
          guid,
          kind: kind.kind,
          packageUrl,
          sourcePath: 'reentrant.pack',
          publication: publication.publication,
        },
        {
          guid: dependencyGuid,
          kind: 'sampler',
          packageUrl,
          sourcePath: 'reentrant.pack',
          publication: publication.publication,
        },
      ],
      fetch: async () => new Response(JSON.stringify(publication.pack)),
    }),
  );
  try {
    expect(await assets.load(guid, kind)).toMatchObject({ ok: false, error: failure });
    expect(attempted).toMatchObject({ ok: false, error: { code: 'asset-write-conflict' } });
    expect(records.currentRevision).toBe(prior);
    expect(records.inspect()).toEqual(priorStats);
    expect(records.refcount(sampler)).toBe(1);
    expect(assets.read(sampler).unwrap()).toEqual(priorSampler);
    expect(assets.read(texture).unwrap()).toEqual(priorTexture);
    expect(observer.read().unwrap().changes).toEqual(priorChanges);

    preparingFailure = false;
    const loaded = (await assets.load(guid, kind)).unwrap();
    expect(assets.read(loaded).unwrap()).toEqual({ count: 1, kind: kind.kind });
    observer.read().unwrap().accept();
    assets.update(sampler, { minFilter: 'linear' }).unwrap();
    expect(records.version(sampler).unwrap()).toBe(records.currentRevision);
    expect(observer.read().unwrap().changes).toMatchObject([
      { handle: sampler, revision: records.currentRevision },
    ]);
  } finally {
    observer.dispose();
    assets.dispose();
  }
});
