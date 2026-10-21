import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { type RuntimePackContent, RuntimePackProducer } from '../../../import/src/runtime-pack.js';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry.js';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';
import { materialRecordFixture } from './fixtures/material-publication.js';

const parent = '01900000-0000-7000-8000-000000000801';
const child = '01900000-0000-7000-8000-000000000802';
function material(
  packageId: string,
  generation = 1,
  dependency?: {
    guid: string;
    digest: string;
  },
): RuntimePackContent {
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'surface'));
  const original = materialRecordFixture({ guid, generation });
  const record = {
    ...original,
    refs: { ...original.refs, parent: dependency ? [dependency.guid] : [] },
  };
  const artifacts = Object.fromEntries(
    record.programs.map(({ artifact }) => [
      artifact.path,
      {
        path: artifact.path,
        mediaType: artifact.mediaType,
        byteLength: artifact.bytes.byteLength,
        integrity: { algorithm: 'sha256', digest: artifact.digest },
      },
    ]),
  );
  return {
    source: {
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        surface: {
          kind: 'material',
          payload: {
            kind: 'material',
            ...record.resolved,
            cooked: JSON.parse(serializeCookedMaterialRecord(record)),
          },
          refs: dependency ? [dependency.guid] : [],
          artifacts,
        },
      },
    },
    blobs: Object.fromEntries(
      record.programs.map(({ artifact }) => [artifact.path, Array.from(artifact.bytes)]),
    ),
    ...(dependency ? { dependencies: { [dependency.guid]: dependency.digest } } : {}),
  };
}
function producer() {
  const source: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'asset-runtime',
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: source.catalog, fetcher: source.fetch },
        { dependencies, decoders: [materialContribution] },
      ),
  });
  return source;
}
it('keeps material artifacts on the same bound publication through delayed readiness', async () => {
  const source = producer();
  const publication = (await source.admit(material(parent))).unwrap();
  const row = defined(publication.rows[0]);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let opens = 0;
  const registry = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  registry.setCatalogSource(
    {
      enumerate: async () => ok(publication.rows),
      subscribe: () => () => {},
      openPackage(url) {
        opens++;
        const fetcher = defined(source.catalog.openPackage(url));
        return async (input, init) => {
          if (String(input) === row.packageUrl) {
            enter();
            await gate;
          }
          return fetcher(input, init);
        };
      },
    },
    async () => {
      throw new Error('material read escaped its bound publication');
    },
  );
  try {
    const pending = registry.load(row.guid, 'material');
    await entered;
    source.withdraw(parent);
    expect(source.catalog.openPackage(row.packageUrl)).toBeUndefined();
    resume();
    const loaded = await pending;
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    expect(opens).toBe(1);
  } finally {
    resume();
    registry.clearCatalogSource();
    source.dispose();
  }
});
it('fences the direct material readiness operation against a changed parent publication', async () => {
  const source = producer();
  const dependency = defined(
    defined((await source.admit(material(parent))).unwrap().publication).outputs[0],
  );
  const publication = (await source.admit(material(child, 1, dependency))).unwrap();
  const registry = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  registry.setCatalogSource(source.catalog, source.fetch);
  const request = {
    guid: defined(publication.rows[0]).guid,
    specializationKey: 'publication/ready',
  };
  try {
    const reference = (await registry.load(request.guid, 'material')).unwrap();
    source.withdraw(parent);
    (await source.admit(material(parent, 2))).unwrap();
    expect(await registry.reload(reference, { conflict: 'overwrite' })).toMatchObject({
      ok: false,
    });
  } finally {
    registry.clearCatalogSource();
    source.dispose();
  }
});

async function sharedArtifactFixture(blockFirstBody = false) {
  const source = producer();
  const publication = (await source.admit(material(parent))).unwrap();
  const row = defined(publication.rows[0]);
  const registry = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const reads: string[] = [];
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  registry.setCatalogSource(
    {
      enumerate: async () => ok(publication.rows),
      subscribe: () => () => {},
      openPackage(url) {
        const bound = defined(source.catalog.openPackage(url));
        return async (input, init) => {
          const response = await bound(input, init);
          if (!String(input).endsWith('.wgsl')) return response;
          reads.push(String(input));
          const ordinal = reads.length;
          const body = response.arrayBuffer.bind(response);
          Object.defineProperty(response, 'arrayBuffer', {
            value: async () => {
              if (ordinal === 1) {
                enter();
                if (blockFirstBody) await gate;
              }
              return body();
            },
          });
          return response;
        };
      },
    },
    async () => {
      throw new Error('read escaped its bound publication');
    },
  );
  return {
    registry,
    row,
    reads,
    entered,
    resume,
    load: () => registry.load(row.guid, 'material'),
    dispose() {
      resume();
      registry.clearCatalogSource();
      source.dispose();
    },
  };
}

it('shares verified program bytes across repeated asset loads and invalidation', async () => {
  const f = await sharedArtifactFixture();
  try {
    expect((await f.load()).ok).toBe(true);
    expect((await f.load()).ok).toBe(true);
    expect(await f.load()).toMatchObject({ ok: true });
    expect(f.reads).toHaveLength(1);
    f.registry.invalidate(f.row.guid);
    expect((await f.load()).ok).toBe(true);
    expect(await f.load()).toMatchObject({ ok: true });
    expect(f.reads).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('shares an unfinished body read between simultaneous asset loads', async () => {
  const f = await sharedArtifactFixture(true);
  const first = f.load();
  let second: ReturnType<typeof f.load> | undefined;
  let finished = false;
  try {
    await f.entered;
    second = f.load();
    void second.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(f.reads).toHaveLength(1);
    expect(finished).toBe(false);
    f.resume();
    expect((await first).ok).toBe(true);
    expect(await second).toMatchObject({ ok: true });
    expect(f.reads).toHaveLength(1);
  } finally {
    f.resume();
    await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    f.dispose();
  }
});
