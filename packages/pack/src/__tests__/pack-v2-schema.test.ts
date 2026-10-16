import { describe, expect, it } from 'vitest';
import { validatePack, validatePackV2 } from '../schema-compiled.js';
import { SCRIPTABLE_PACK_ASSET_KINDS } from '../scriptable-pack.js';

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_B = '22222222-2222-4222-8222-222222222222';

function validPack() {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    packageId: 'pkg/fixture',
    assets: [
      {
        guid: GUID_A,
        kind: 'texture',
        execution: 'cooked',
        payload: { kind: 'texture', width: 1, height: 1 },
        refs: [GUID_B],
        artifacts: {
          image: {
            path: 'artifacts/texture.bin',
            mediaType: 'image/ktx2',
            assetCodec: { name: 'basis', profile: 'uastc', version: '1' },
            contentEncoding: 'zstd',
            byteLength: 4,
            integrity: {
              algorithm: 'sha256',
              digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            },
          },
        },
      },
      {
        guid: GUID_B,
        kind: 'material',
        execution: 'cooked',
        payload: { kind: 'material' },
        refs: [],
        artifacts: {},
      },
    ],
  };
}

function mutablePack() {
  return JSON.parse(JSON.stringify(validPack())) as {
    schemaVersion: string;
    kind: string;
    assets: Array<Record<string, unknown>>;
  };
}

describe('Pack v2 schema', () => {
  it('accepts a v2 envelope with asset-local artifacts and separated encoding facts', () => {
    const pack = validPack();

    expect(validatePack(pack)).toBe(true);
    expect(validatePackV2(pack)).toBe(true);
  });

  it('rejects a non-v2 schema version', () => {
    const pack = { ...validPack(), schemaVersion: '1.0.0' };

    expect(validatePackV2(pack)).toBe(false);
  });

  it('rejects an artifact descriptor without required content facts', () => {
    const pack = mutablePack();
    const asset = pack.assets[0];
    if (!asset) throw new Error('fixture asset is missing');
    const artifacts = asset.artifacts as Record<string, Record<string, unknown>>;
    const image = artifacts.image;
    if (!image) throw new Error('fixture artifact is missing');
    delete image.mediaType;

    expect(validatePackV2(pack)).toBe(false);
  });

  it('rejects integrity that is not a structured algorithm and digest object', () => {
    const pack = mutablePack();
    const asset = pack.assets[0];
    if (!asset) throw new Error('fixture asset is missing');
    const artifacts = asset.artifacts as Record<string, Record<string, unknown>>;
    const image = artifacts.image;
    if (!image) throw new Error('fixture artifact is missing');
    image.integrity = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    expect(validatePackV2(pack)).toBe(false);
  });

  it('rejects duplicate asset GUIDs and duplicate artifact keys', () => {
    const duplicateGuidPack = mutablePack();
    const secondAsset = duplicateGuidPack.assets[1];
    if (!secondAsset) throw new Error('fixture asset is missing');
    secondAsset.guid = GUID_A;

    const duplicateArtifactKeyPack = mutablePack();
    const firstAsset = duplicateArtifactKeyPack.assets[0];
    if (!firstAsset) throw new Error('fixture asset is missing');
    const imageArtifact = (firstAsset.artifacts as Record<string, unknown>).image as Record<
      string,
      unknown
    >;
    firstAsset.artifacts = [
      { key: 'image', ...imageArtifact },
      { key: 'image', ...imageArtifact },
    ];

    expect(validatePackV2(duplicateGuidPack)).toBe(false);
    expect(validatePackV2(duplicateArtifactKeyPack)).toBe(false);
  });

  it('rejects missing descriptor fields instead of silently skipping the asset', () => {
    const pack = mutablePack();
    const asset = pack.assets[0];
    if (!asset) throw new Error('fixture asset is missing');
    delete asset.refs;

    expect(validatePackV2(pack)).toBe(false);
  });

  it('rejects a v2 asset with no explicit execution mode', () => {
    const pack = mutablePack();
    const asset = pack.assets[0];
    if (!asset) throw new Error('fixture asset is missing');
    delete asset.execution;

    expect(validatePackV2(pack)).toBe(false);
  });

  it('accepts every published durable kind without closing producer extensions', () => {
    for (const kind of SCRIPTABLE_PACK_ASSET_KINDS) {
      const pack = validPack();
      const asset = pack.assets[0];
      if (!asset) throw new Error('fixture asset is missing');
      asset.kind = kind;
      asset.payload = { kind };
      expect(validatePackV2(pack), kind).toBe(true);
    }
  });
});
