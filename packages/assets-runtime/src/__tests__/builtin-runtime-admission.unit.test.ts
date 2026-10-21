import { equirectContribution } from '@forgeax/engine-image';
import { type Asset, type AssetDecoderContribution, ok } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { navigationMeshContribution } from '../../../navigation/src/asset-decoder';
import {
  renderPipelineContribution,
  samplerContribution,
} from '../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { pluginAssetDecoder } from '../loaders/plugin';

const cases: readonly {
  contribution: AssetDecoderContribution<Asset>;
  valid: Asset;
  invalid: readonly object[];
}[] = [
  {
    contribution: samplerContribution,
    valid: { kind: 'sampler' },
    invalid: [
      { lodMinClamp: -1 },
      { lodMinClamp: 3, lodMaxClamp: 2 },
      { maxAnisotropy: 1.5 },
      { maxAnisotropy: 0 },
      { maxAnisotropy: 17 },
      { maxAnisotropy: 2 },
    ],
  },
  {
    contribution: renderPipelineContribution,
    valid: { kind: 'render-pipeline', pipelineId: 'forgeax::standard' },
    invalid: [
      { renderPath: 'unknown' },
      { config: { clusterGrid: { x: 1, y: 0, z: 1 } } },
      { config: { ssao: { enabled: true, radius: -1 } } },
      { config: { ssao: { enabled: false, directLightingStrength: 2 } } },
    ],
  },
  {
    contribution: equirectContribution,
    valid: {
      kind: 'equirect',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      colorSpace: 'linear',
      data: new Uint8Array(4),
    },
    invalid: [{ width: 0 }, { data: new Uint8Array(3) }, { colorSpace: 'other' }],
  },
  {
    contribution: navigationMeshContribution,
    valid: {
      kind: 'navigation-mesh',
      version: 'recast-poly/1',
      sourceDigest: 'fixture',
      vertices: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
      polygons: [[0, 1, 2, 3]],
      settings: {
        radius: 0.3,
        height: 1.8,
        maxSlopeDeg: 45,
        maxStep: 0.3,
        cellSize: 0.1,
        cellHeight: 0.05,
      },
    },
    invalid: [
      { polygons: [[0, 1, 7]] },
      { polygons: [[0, 1, 1]] },
      { polygons: [[0, 2, 1, 3]] },
      {
        polygons: [
          [0, 1, 2],
          [0, 1, 3],
          [0, 1, 2],
        ],
      },
    ],
  },
  {
    contribution: {
      kind: defineAssetKind('plugin'),
      consumer: 'Plugin',
      decoder: pluginAssetDecoder,
    },
    valid: { kind: 'plugin', program: 'example::program', config: { speed: 1 } },
    invalid: [{ program: '' }, { program: 123 }, { config: { broken: Number.POSITIVE_INFINITY } }],
  },
] as unknown as readonly {
  contribution: AssetDecoderContribution<Asset>;
  valid: Asset;
  invalid: readonly object[];
}[];

for (const { contribution, valid, invalid } of cases) {
  test(`${valid.kind} rejects invalid create/update/replace atomically through its owner`, async () => {
    const assets = new AssetRegistry();
    if (valid.kind !== 'plugin') assets.installDecoder(contribution.kind, contribution.decoder);
    const handle = assets.create(valid).unwrap();
    const observer = assets.observe().unwrap();
    for (const patch of invalid) {
      const candidate = { ...valid, ...patch } as Asset;
      expect(assets.create(candidate), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      expect(assets.update(handle, patch)).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      expect(assets.replace(handle, candidate)).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      expect(assets.read(handle).unwrap()).toEqual(valid);
      expect(observer.read().unwrap().changes).toHaveLength(0);
      const decoded = await contribution.decoder.decode({
        envelope: {
          guid: 'fixture',
          kind: valid.kind,
          payload: candidate,
          refs: [],
          artifacts: {},
        },
        artifacts: { read: async () => ok(new Uint8Array()) },
        signal: new AbortController().signal,
      });
      expect(decoded.ok, JSON.stringify(patch)).toBe(false);
    }
    observer.dispose();
    assets.dispose();
  });
  if (valid.kind !== 'plugin')
    test(`${valid.kind} requires its runtime preparation lease`, () => {
      const assets = new AssetRegistry();
      expect(assets.create(valid)).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      const lease = assets.installDecoder(contribution.kind, contribution.decoder);
      const handle = assets.create(valid).unwrap();
      lease.dispose();
      expect(assets.update(handle, {})).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      expect(assets.replace(handle, valid)).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      expect(assets.read(handle).unwrap()).toEqual(valid);
      assets.dispose();
    });
}

test('sampler accepts anisotropy with its complete linear filter contract', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const value = {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    maxAnisotropy: 16,
  } as const;
  const handle = assets.create(value).unwrap();
  expect(assets.read(handle).unwrap()).toEqual(value);
  assets.dispose();
});
