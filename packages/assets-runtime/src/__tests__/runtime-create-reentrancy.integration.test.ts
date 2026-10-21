import { type AssetHandle, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { samplerContribution } from '../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';

it('rechecks create capacity after custom preparation and preserves accepted nested content', () => {
  const assets = new AssetRegistry({ limits: { maxAssets: 1 } });
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const kind = defineAssetKind<number>('test-nested-create-budget');
  let nested: AssetHandle<'sampler'> | undefined;
  let calls = 0;
  assets.installDecoder(kind, {
    decode: async ({ envelope }) => ok(envelope.payload),
    prepare: (value) => {
      calls++;
      if (nested === undefined)
        nested = assets.create({ kind: 'sampler', minFilter: 'nearest' }).unwrap();
      return ok(value);
    },
  });
  const records = runtimeAssets(assets);
  const observer = records.observe().unwrap();
  try {
    expect(assets.create(kind, 1)).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    expect(nested).toBeDefined();
    if (nested === undefined) throw new Error('Missing accepted nested asset');
    expect(records.inspect().assets).toBe(1);
    expect(assets.read(nested).unwrap()).toMatchObject({ minFilter: 'nearest' });
    expect(
      observer
        .read()
        .unwrap()
        .changes.map(({ handle }) => handle),
    ).toEqual([nested]);
    const revision = records.currentRevision;
    expect(assets.create(kind, 2)).toMatchObject({ ok: false });
    expect(calls).toBe(1);
    expect(records.currentRevision).toBe(revision);
    assets.release(nested).unwrap();
    observer.read().unwrap().accept();
    const retry = assets.create(kind, 3).unwrap();
    expect(assets.read(retry).unwrap()).toBe(3);
    expect(records.version(retry).unwrap()).toBeGreaterThan(revision);
    expect(
      observer
        .read()
        .unwrap()
        .changes.map(({ handle }) => handle),
    ).toEqual([retry]);
  } finally {
    observer.dispose();
    assets.dispose();
  }
});
