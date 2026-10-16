import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid, type DirectPackJson, definePackageId } from '@forgeax/engine-pack/source';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimePackProducer } from '../../../import/src/runtime-pack.js';
import { AssetRegistry } from '../asset-registry.js';
import { loadMaterialReadyByGuid } from '../registry/load-by-guid.js';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';
import { materialRecordFixture } from './fixtures/material-publication.js';

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
        { dependencies },
      ),
  });
  const publication = (
    await producer.admit({
      source: { schemaVersion: '3.0.0', packageId, assets },
      blobs,
    })
  ).unwrap();
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
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
    load: (index: number) => registry.loadByGuid(registry.parseGuid(defined(records[index]).guid)),
    ready: (index: number) =>
      loadMaterialReadyByGuid(registry, {
        guid: defined(records[index]).guid,
        specializationKey: 'publication/ready',
      }),
    dispose() {
      registry.clearCatalogSource();
      producer.dispose();
    },
  };
}

it.each([
  'sequential',
  'concurrent',
] as const)('reads one physical artifact for distinct material GUIDs through both APIs: %s', async (mode) => {
  const f = await sharedMaterials();
  try {
    if (mode === 'sequential') {
      expect((await f.load(0)).ok).toBe(true);
      expect((await f.ready(1)).status).toBe('Ready');
    } else {
      const [asset, material] = await Promise.all([f.load(0), f.ready(1)]);
      expect(asset.ok).toBe(true);
      expect(material.status).toBe('Ready');
    }
    expect(f.records[0]?.guid).not.toBe(f.records[1]?.guid);
    expect(f.reads).toHaveLength(1);
    expect((await f.ready(0)).status).toBe('Ready');
    expect((await f.load(1)).ok).toBe(true);
    expect(f.reads).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('retains program identity without per-GUID program byte copies', async () => {
  const f = await sharedMaterials();
  try {
    await Promise.all([f.load(0), f.load(1)]);
    const ready = await Promise.all([f.ready(0), f.ready(1)]);
    for (const material of ready) {
      expect(material.status).toBe('Ready');
      if (material.status !== 'Ready') throw new Error('material did not become Ready');
      const retained = defined(f.registry.getMaterialReadiness(material.record.guid));
      const buffers = new Set<ArrayBufferLike>();
      const visit = (value: unknown): void => {
        if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
        else if (value !== null && typeof value === 'object')
          for (const child of Object.values(value)) visit(child);
      };
      visit(retained);
      expect([...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBe(0);
      for (const program of material.record.programs) {
        const canonical = defined(f.registry.getMaterialArtifact(program.specializationKey));
        expect(program.artifact.bytes).toEqual(canonical.bytes);
        expect(program.artifact.bytes).not.toBe(canonical.bytes);
      }
    }
    expect(f.reads).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('keeps complete public Ready byte snapshots isolated from each other and the registry', async () => {
  const f = await sharedMaterials();
  try {
    const first = await f.ready(0);
    const second = await f.ready(1);
    const again = await f.ready(0);
    if (first.status !== 'Ready' || second.status !== 'Ready' || again.status !== 'Ready')
      throw new Error('material did not become Ready');
    const program = defined(first.record.programs[0]);
    const expected = program.artifact.bytes.slice();
    program.artifact.bytes.fill(0);
    expect(second.record.programs[0]?.artifact.bytes).toEqual(expected);
    expect(again.record.programs[0]?.artifact.bytes).toEqual(expected);
    expect(f.registry.getMaterialArtifact(program.specializationKey)?.bytes).toEqual(expected);
    const info = f.registry.getMaterialReadiness(first.record.guid);
    if (info?.status !== 'Ready') throw new Error('material info was not retained');
    const layout = info.receipt.identity.layoutIdentity;
    Reflect.set(first.record.receipt.identity, 'layoutIdentity', 'changed public snapshot');
    expect(info.receipt.identity.layoutIdentity).toBe(layout);
    expect(Reflect.set(info.receipt.identity, 'layoutIdentity', 'changed inspection')).toBe(false);
    expect(second.record.receipt.identity.layoutIdentity).toBe(layout);
  } finally {
    f.dispose();
  }
});
