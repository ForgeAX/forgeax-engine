import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetError, type AssetHandle, err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { samplerContribution } from '../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';
import { defined } from './assert-defined';

interface Counter {
  count: number;
  samples: Float32Array;
  dependency?: AssetHandle<'sampler'>;
}
const kind = defineAssetKind<Counter>('test-counter');
const invalid = () =>
  new AssetError({
    code: 'asset-invalid-value',
    expected: 'a finite nonnegative count',
    hint: 'supply a valid counter',
  });
function setup() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  let captured: Counter | undefined;
  const lease = assets.installDecoder(kind, {
    decode: async ({ envelope }) => ok(envelope.payload),
    prepare: (value, context) => {
      captured = value;
      if (!Number.isFinite(value.count) || value.count < 0) return err(invalid());
      if (value.dependency !== undefined) {
        const dependency = context.reference(value.dependency, 'sampler');
        if (!dependency.ok) return dependency;
        return ok({ ...value, dependency: dependency.value });
      }
      return ok(value);
    },
  });
  return { assets, lease, captured: () => captured };
}

describe('custom runtime asset owner preparation', () => {
  it('prepares source loads and rejects invalid reloads while keeping the accepted revision', async () => {
    const { assets } = setup();
    const guid = '00000000-0000-7000-8000-000000000123';
    const publish = (count: number) => {
      const packageUrl = 'https://counter.invalid/pack.json';
      const result = createRuntimePackPublication({
        scopeId: 'asset-runtime',
        sourcePath: 'counter.pack',
        sourceRevision: String(count),
        packageUrl,
        pack: {
          assets: [
            { guid, kind: kind.kind, refs: [], artifacts: {}, payload: { count, samples: [] } },
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
              sourcePath: 'counter.pack',
              publication: result.publication,
            },
          ],
          fetch: async () => new Response(JSON.stringify(result.pack)),
        }),
      );
    };
    publish(1);
    const handle = (await assets.load(guid, kind)).unwrap();
    assets.update(handle, { count: 2 }).unwrap();
    const revision = runtimeAssets(assets).version(handle).unwrap();
    publish(-1);
    expect(await assets.reload(handle, { conflict: 'overwrite' })).toMatchObject({
      ok: false,
      error: { code: 'asset-invalid-value' },
    });
    expect(assets.read(handle).unwrap().count).toBe(2);
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(revision);
    publish(3);
    (await assets.reload(handle, { conflict: 'overwrite' })).unwrap();
    expect(assets.read(handle).unwrap().count).toBe(3);
    assets.dispose();
  });

  it.each([12, null])('inspects the declared kind of a loaded scalar payload %s', async (value) => {
    const assets = new AssetRegistry();
    const scalar = defineAssetKind<number | null>('test-loaded-scalar');
    assets.installDecoder(scalar, {
      decode: async ({ envelope }) => ok(envelope.payload),
      prepare: (input) => ok(input),
    });
    const guid = '00000000-0000-7000-8000-000000000124';
    const packageUrl = 'https://counter.invalid/scalar.json';
    const publication = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: 'scalar.pack',
      sourceRevision: '1',
      packageUrl,
      pack: { assets: [{ guid, kind: scalar.kind, refs: [], artifacts: {}, payload: value }] },
    });
    assets.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid,
            kind: scalar.kind,
            name: 'counter',
            packageUrl,
            sourcePath: 'scalar.pack',
            publication: publication.publication,
          },
        ],
        fetch: async () => new Response(JSON.stringify(publication.pack)),
      }),
    );
    try {
      const handle = (await assets.load(guid, scalar)).unwrap();
      expect(assets.read(handle).unwrap()).toBe(value);
      expect(assets.inspect()).toEqual({ assets: [{ guid, kind: scalar.kind, name: 'counter' }] });
    } finally {
      assets.dispose();
    }
  });

  it('supports complete scalar payload replacement and rejects a preparation owner retiring during admission', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const scalar = defineAssetKind<number>('test-scalar');
    const lease = assets.installDecoder(scalar, {
      decode: async ({ envelope }) => ok(envelope.payload),
      prepare: (value) => {
        if (value === 3) lease.dispose();
        return Number.isFinite(value) ? ok(value) : err(invalid());
      },
    });
    const handle = assets.create(scalar, 1).unwrap();
    assets.replace(handle, 2).unwrap();
    const revision = runtimeAssets(assets).version(handle).unwrap();
    expect(assets.replace(handle, 3).ok).toBe(false);
    expect(assets.read(handle).unwrap()).toBe(2);
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(revision);
    assets.dispose();
  });

  it('creates, edits, copies and replaces without a source or manual revisions', () => {
    const { assets, captured } = setup();
    const input = { count: 1, samples: new Float32Array([2, 3]) };
    const handle = assets.create(kind, input).unwrap();
    input.samples[0] = 99;
    defined(captured()).samples[1] = 99;
    expect(assets.read(handle).unwrap().samples).toEqual(new Float32Array([2, 3]));
    const before = runtimeAssets(assets).version(handle).unwrap();
    const old = assets.snapshot(handle).unwrap();
    assets.update(handle, { count: 4 }).unwrap();
    expect(runtimeAssets(assets).version(handle).unwrap()).toBeGreaterThan(before);
    expect(old.read<Counter>(handle).unwrap().count).toBe(1);
    const copy = assets.copy(handle).unwrap();
    assets.update(copy, { count: 5 }).unwrap();
    expect(assets.read(handle).unwrap().count).toBe(4);
    assets.replace(handle, { count: 8, samples: new Float32Array([9]) }).unwrap();
    expect(assets.read(handle).unwrap()).toEqual({ count: 8, samples: new Float32Array([9]) });
    old.dispose();
    assets.dispose();
  });

  it('rejects invalid edits atomically and does not expose current bytes to preparation', () => {
    const { assets, captured } = setup();
    const handle = assets.create(kind, { count: 1, samples: new Float32Array([2]) }).unwrap();
    const before = runtimeAssets(assets).version(handle).unwrap();
    expect(assets.update(handle, { count: -1 })).toMatchObject({
      ok: false,
      error: { code: 'asset-invalid-value' },
    });
    defined(captured()).samples[0] = 99;
    expect(assets.read(handle).unwrap().samples[0]).toBe(2);
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(before);
    assets.dispose();
  });

  it('transfers dependency holds on update and retains the fixed old closure', () => {
    const { assets } = setup();
    const a = assets.create({ kind: 'sampler' }).unwrap();
    const b = assets.create({ kind: 'sampler' }).unwrap();
    const handle = assets
      .create(kind, { count: 1, samples: new Float32Array(), dependency: a })
      .unwrap();
    assets.release(a).unwrap();
    const old = assets.snapshot(handle).unwrap();
    assets.update(handle, { dependency: b }).unwrap();
    assets.release(b).unwrap();
    expect(assets.validate(b).ok).toBe(true);
    expect(old.read(a).ok).toBe(true);
    expect(assets.validate(a).ok).toBe(false);
    assets.replace(handle, { count: 2, samples: new Float32Array() }).unwrap();
    expect(assets.validate(b).ok).toBe(false);
    old.dispose();
    assets.dispose();
  });

  it('rejects foreign dependencies and expired preparation leases while keeping content readable', () => {
    const { assets, lease } = setup();
    const other = new AssetRegistry();
    other.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const foreign = other.create({ kind: 'sampler' }).unwrap();
    const handle = assets.create(kind, { count: 1, samples: new Float32Array() }).unwrap();
    expect(assets.update(handle, { dependency: foreign })).toMatchObject({
      ok: false,
      error: { code: 'asset-reference-invalid' },
    });
    lease.dispose();
    expect(assets.update(handle, { count: 2 }).ok).toBe(false);
    expect(assets.create(kind, { count: 2, samples: new Float32Array() }).ok).toBe(false);
    expect(assets.read(handle).unwrap().count).toBe(1);
    expect(assets.read(assets.copy(handle).unwrap()).unwrap().count).toBe(1);
    assets.dispose();
    other.dispose();
  });
});
