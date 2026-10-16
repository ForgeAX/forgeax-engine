import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toAssetPack } from '@forgeax/engine-image';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  inspectVolumetricFog,
  validateVolumetricFog,
} from '@forgeax/engine-render';
import { parsePackV2 } from '@forgeax/engine-pack/runtime';
import type { ImageMeta, TextureAsset } from '@forgeax/engine-types';
import {
  volumetricDensityLoader,
  VOLUMETRIC_DENSITY_KIND,
} from '../volumetric-density-importer';

const GUID = '019f0000-0000-7000-8000-0000000003f1';
const SOURCE_KEY = 'volumetric-fog/density.raw';
const GENERATION = 7;

function texture(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 64, height: 64, depth: 64 } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64 * 64 * 64).fill(19),
  };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('public volumetric fog MVD asset chain', () => {
  it('preserves one GUID, body digest, generation, shape and recovery evidence', async () => {
    const payload = texture();
    const bodyDigest = digest(payload.data);
    const meta = {
      guid: GUID,
      sourceKey: SOURCE_KEY,
      colorSpace: 'linear',
      mipmap: false,
      addressMode: 'clamp-to-edge',
      filterMode: 'linear',
    } as ImageMeta;

    const authored = toAssetPack(meta);
    expect(authored.subAssets[0]?.guid).toBe(GUID);
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      packageId: 'hello/volumetric-fog',
      assets: [
        {
          guid: GUID,
          kind: 'texture',
          execution: 'cooked',
          payload,
          refs: [],
          artifacts: {
            body: {
              path: SOURCE_KEY,
              mediaType: 'application/x-forgeax-r8',
              assetCodec: { name: 'r8unorm', version: '1' },
              byteLength: payload.data.byteLength,
              integrity: { algorithm: 'sha256', digest: bodyDigest },
            },
          },
        },
      ],
    };
    const parsed = parsePackV2(pack);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const registry = new AssetRegistry({} as never);
    registry.loaders.register(volumetricDensityLoader());
    expect(
      registry.catalog(
        GUID,
        { ...payload, kind: VOLUMETRIC_DENSITY_KIND } as unknown as TextureAsset,
      ).ok,
    ).toBe(true);
    const loaded = await registry.loadByGuid<TextureAsset>(registry.parseGuid(GUID));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.data).toEqual(payload.data);
    expect(digest(loaded.value.data)).toBe(bodyDigest);

    const validated = validateVolumetricFog({
      density: {
        guid: GUID,
        generation: GENERATION,
        shape: payload.shape,
        format: payload.format,
        colorSpace: payload.colorSpace,
      },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      extinction: [0.2, 0.2, 0.2],
      albedo: [0.8, 0.8, 0.8],
      emission: [0, 0, 0],
      anisotropy: 0,
      maxDistance: 50,
    });
    expect(validated.ok).toBe(true);
    const inspection = inspectVolumetricFog({
      authored: true,
      capability: 'available',
      recovery: {
        guid: GUID,
        generation: GENERATION,
        deviceEpoch: 0,
        status: 'accepted',
      },
      acceptedDigest: bodyDigest,
      format: 'r8unorm',
      passCount: 1,
      sampleCount: 1,
      memoryBytes: payload.data.byteLength,
    });
    expect(inspection).toMatchObject({
      status: 'available',
      resourceStage: 'accepted',
      guid: GUID,
      generation: GENERATION,
      digest: bodyDigest,
    });
  });
});
