import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid, type DirectPackJson, definePackageId } from '@forgeax/engine-pack/source';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type AssetKind, type MaterialAsset, ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimePackProducer } from '../../../import/src/runtime-pack.js';
import { AssetRegistry } from '../asset-registry.js';
import { runtimeAssets } from '../internal';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';
import { materialRecordFixture } from './fixtures/material-publication.js';
import { runtimePackDecoders } from './fixtures/runtime-pack-decoders';

// Exercise sharing while cache entries are live, independently of V8's GC
// schedule under coverage. artifact-transfer-cache.unit.test.ts separately
// verifies collection, refetch, byte isolation and explicit invalidation.
beforeEach(() => {
  const NativeWeakRef = globalThis.WeakRef;
  vi.stubGlobal(
    'WeakRef',
    class<T extends WeakKey> extends NativeWeakRef<T> {
      readonly retained: T;
      constructor(value: T) {
        super(value);
        this.retained = value;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const packageId = '01900000-0000-7000-8000-000000000891';

async function sharedMaterials() {
  const records = ['first', 'second'].map((name) =>
    materialRecordFixture({
      guid: AssetGuid.format(AssetGuid.derive(definePackageId(packageId), name)),
    }),
  );
  const assets: Record<string, DirectPackJson['assets'][string]> = {};
  const blobs: Record<string, number[]> = {};
  for (const [index, record] of records.entries()) {
    assets[index === 0 ? 'first' : 'second'] = {
      kind: 'material',
      payload: {
        kind: 'material',
        ...record.resolved,
        cooked: JSON.parse(serializeCookedMaterialRecord(record)),
      },
      refs: [],
      artifacts: Object.fromEntries(
        record.programs.map(({ artifact }) => {
          blobs[artifact.path] = Array.from(artifact.bytes);
          return [
            artifact.path,
            {
              path: artifact.path,
              mediaType: artifact.mediaType,
              byteLength: artifact.bytes.byteLength,
              contentEncoding: 'identity',
              integrity: { algorithm: 'sha256', digest: artifact.digest },
            },
          ];
        }),
      ),
    };
  }
  const producer: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'shared-material-transfer',
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: producer.catalog, fetcher: producer.fetch },
        { dependencies, decoders: runtimePackDecoders },
      ),
  });
  const publication = (
    await producer.admit({
      source: { schemaVersion: '3.0.0', packageId, assets },
      blobs,
    })
  ).unwrap();
  const registry = new AssetRegistry({
    scopeId: 'shared-material-transfer',
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  for (const { kind, decoder } of runtimePackDecoders)
    registry.installDecoder(kind as AssetKind<unknown>, decoder);
  const reads: string[] = [];
  registry.setCatalogSource(
    {
      enumerate: async () => ok(publication.rows),
      subscribe: () => () => {},
      openPackage(url) {
        const bound = defined(producer.catalog.openPackage(url));
        return async (input, init) => {
          if (String(input).endsWith('.wgsl')) reads.push(String(input));
          return bound(input, init);
        };
      },
    },
    async () => {
      throw new Error('escaped bound publication');
    },
  );
  return {
    registry,
    records,
    reads,
    load: (index: number) => registry.load(defined(records[index]).guid, 'material'),
    projection: async (index: number) => {
      const handle = (await registry.load(defined(records[index]).guid, 'material')).unwrap();
      return defined(
        registry.getMaterialProjectionForPayload(
          runtimeAssets(registry).borrow<MaterialAsset>(handle).unwrap(),
        ),
      );
    },
    dispose() {
      registry.clearCatalogSource();
      producer.dispose();
    },
  };
}

it.each([
  'sequential',
  'concurrent',
] as const)('shares one physical artifact across distinct material sources: %s', async (mode) => {
  const f = await sharedMaterials();
  try {
    if (mode === 'sequential') {
      expect((await f.load(0)).ok).toBe(true);
      expect((await f.load(1)).ok).toBe(true);
    } else {
      const loaded = await Promise.all([f.load(0), f.load(1)]);
      expect(loaded.every((result) => result.ok)).toBe(true);
    }
    expect(f.records[0]?.guid).not.toBe(f.records[1]?.guid);
    expect(f.reads).toHaveLength(1);
    await Promise.all([f.load(0), f.load(1)]);
    expect(f.reads).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('retains program identity without per-GUID program bytes in render projections', async () => {
  const f = await sharedMaterials();
  try {
    const projections = await Promise.all([f.projection(0), f.projection(1)]);
    for (const projection of projections) {
      const buffers = new Set<ArrayBufferLike>();
      const visit = (value: unknown): void => {
        if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
        else if (value !== null && typeof value === 'object')
          for (const child of Object.values(value)) visit(child);
      };
      visit(projection);
      expect(buffers.size).toBe(0);
    }
    expect(projections[0].passes[0]?.programs[0]?.specializationKey).toBe(
      projections[1].passes[0]?.programs[0]?.specializationKey,
    );
    expect(f.reads).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('isolates authored source bytes while sharing immutable projection identity', async () => {
  const f = await sharedMaterials();
  try {
    const first = await f.projection(0),
      second = await f.projection(1);
    const program = defined(f.records[0]?.programs[0]);
    const a = defined(f.registry.getMaterialArtifact(program.specializationKey));
    const b = defined(f.registry.getMaterialArtifact(program.specializationKey));
    expect(a.bytes).toBe(b.bytes);
    const expected = b.bytes.slice();
    program.artifact.bytes.fill(0);
    expect(b.bytes).toEqual(expected);
    expect(f.registry.getMaterialArtifact(program.specializationKey)?.bytes).toEqual(expected);
    expect(first).toBe(await f.projection(0));
    expect(second).toBe(await f.projection(1));
  } finally {
    f.dispose();
  }
});
