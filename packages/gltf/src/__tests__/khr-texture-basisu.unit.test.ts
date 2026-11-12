import type { ImportContext, ImportedAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { extractImageBytes, parseGltfImages } from '../extract-image-bytes.js';
import { gltfImporter } from '../gltf-importer.js';
import { parseGltf } from '../parse-gltf.js';

const KTX2 = Uint8Array.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DecodeCall {
  readonly mimeType: string;
  readonly colorSpace: unknown;
  readonly bytes: Uint8Array;
}

const dataUri = (mime: string, bytes: Uint8Array) =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

/** Two textures share one sampler; texture 0 is baseColor (sRGB), texture 1 is normal (linear). */
function basisuDoc(textures: readonly Record<string, unknown>[]) {
  return {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_texture_basisu', 'KHR_texture_transform'],
    extensionsRequired: ['KHR_texture_basisu'],
    images: [
      { uri: dataUri('image/png', PNG), mimeType: 'image/png' },
      { uri: dataUri('image/ktx2', KTX2), mimeType: 'image/ktx2' },
      { uri: dataUri('image/ktx2', KTX2), mimeType: 'image/ktx2' },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33648 }],
    textures,
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: {
            index: 0,
            extensions: { KHR_texture_transform: { offset: [0.5, 0.25], scale: [2, 2] } },
          },
        },
        normalTexture: { index: 1 },
      },
    ],
  };
}

function importContext(doc: unknown, calls: DecodeCall[]): ImportContext {
  return {
    source: 'basisu.gltf',
    subAssets: [
      ...[0, 1, 2].map((sourceIndex) => ({
        kind: 'texture' as const,
        sourceIndex,
        guid: `019f0000-0000-7000-8000-0000000004${sourceIndex}0`,
      })),
      { kind: 'material', sourceIndex: 0, guid: '019f0000-0000-7000-8000-000000000499' },
    ],
    importSettings: {},
    readSource: async () => ({ ok: true, value: new TextEncoder().encode(JSON.stringify(doc)) }),
    readSibling: async () => {
      throw new Error('no sibling reads expected');
    },
    decodeImage: async (bytes, mimeType, settings) => {
      calls.push({ mimeType, colorSpace: settings.colorSpace, bytes });
      const colorSpace = settings.colorSpace === 'srgb' ? 'srgb' : 'linear';
      const texture: TextureAsset = {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
        colorSpace,
        mips: { kind: 'none' },
        data: bytes,
      };
      return mimeType === 'image/ktx2'
        ? {
            ok: true,
            value: {
              texture,
              bytes,
              mediaType: 'image/ktx2',
              assetCodec: { name: 'basis', container: 'ktx2', profile: 'etc1s', version: '1' },
            },
          }
        : { ok: true, value: { texture, bytes: texture.data } };
    },
  };
}

function unwrapAssets(result: Awaited<ReturnType<typeof gltfImporter.import>>): ImportedAsset[] {
  if (!result.ok) throw new Error(`import failed: ${result.error.code}`);
  return [...result.value.assets];
}

describe('glTF KHR_texture_basisu', () => {
  it('prefers the extension KTX2 source over the PNG fallback and keeps the sampler', async () => {
    const result = await parseGltf(
      basisuDoc([
        { source: 0, sampler: 0, extensions: { KHR_texture_basisu: { source: 1 } } },
        { sampler: 0, extensions: { KHR_texture_basisu: { source: 2 } } },
      ]),
      async () => new ArrayBuffer(0),
      '/basisu.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.textures?.map((texture) => texture.source)).toEqual([1, 2]);
    expect(result.value.textures?.map((texture) => texture.sampler)).toEqual([0, 0]);
    const baseColor = result.value.materials[0]?.baseColorTexture as
      | { texture: number; transform?: Record<string, unknown> }
      | undefined;
    expect(baseColor?.texture).toBe(0);
    expect(baseColor?.transform).toMatchObject({ offset: [0.5, 0.25], scale: [2, 2] });
  });

  it('imports KTX2 images through decodeImage with per-slot color space', async () => {
    const calls: DecodeCall[] = [];
    const doc = basisuDoc([
      { source: 0, sampler: 0, extensions: { KHR_texture_basisu: { source: 1 } } },
      { sampler: 0, extensions: { KHR_texture_basisu: { source: 2 } } },
    ]);
    const assets = unwrapAssets(await gltfImporter.import(importContext(doc, calls)));

    // Image 0 (the PNG fallback) is orphaned by the override and decodes as linear.
    expect(calls.map(({ mimeType, colorSpace }) => [mimeType, colorSpace])).toEqual([
      ['image/png', 'linear'],
      ['image/ktx2', 'srgb'],
      ['image/ktx2', 'linear'],
    ]);
    expect(calls[1]?.bytes).toEqual(KTX2);
    const ktxTexture = assets.find(
      (asset) => asset.guid === '019f0000-0000-7000-8000-000000000410',
    );
    expect(ktxTexture?.artifacts.body?.mediaType).toBe('image/ktx2');
    expect(ktxTexture?.artifacts.body?.assetCodec).toMatchObject({ container: 'ktx2' });
    const material = assets.find((asset) => asset.kind === 'material');
    expect(material?.refs.map((ref) => ref.guid)).toEqual(
      expect.arrayContaining([
        '019f0000-0000-7000-8000-000000000410',
        '019f0000-0000-7000-8000-000000000420',
      ]),
    );
    expect(material?.refs.map((ref) => ref.guid)).not.toContain(
      '019f0000-0000-7000-8000-000000000400',
    );
  });

  it('falls back to textures[].source when the extension is absent', async () => {
    const calls: DecodeCall[] = [];
    const doc = { ...basisuDoc([{ source: 0, sampler: 0 }]), extensionsRequired: [] };
    const parsed = await parseGltf(doc, async () => new ArrayBuffer(0), '/fallback.gltf');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.textures?.[0]?.source).toBe(0);

    await gltfImporter.import(importContext(doc, calls));
    expect(calls[0]).toMatchObject({ mimeType: 'image/png', colorSpace: 'srgb' });
  });
});

describe('glTF image MIME gate', () => {
  const noLoader = async () => new ArrayBuffer(0);

  it('admits declared image/ktx2 and rejects other declared types', async () => {
    const admitted = await parseGltfImages(
      [{ uri: dataUri('image/ktx2', KTX2), mimeType: 'image/ktx2' }],
      [],
      [],
      noLoader,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(extractImageBytes(admitted.value).extracted.get(0)?.mimeType).toBe('image/ktx2');

    const rejected = await parseGltfImages(
      [{ uri: 'albedo.webp', mimeType: 'image/webp' }],
      [],
      [],
      noLoader,
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('gltf-image-mime-unsupported');
  });

  it('classifies an undeclared external .ktx2 URI and a sniffed bufferView as KTX2', async () => {
    const parsed = await parseGltfImages(
      [{ uri: 'textures/albedo.KTX2?v=2' }, { bufferView: 0 }],
      [{ buffer: 0, byteLength: KTX2.length }],
      [KTX2],
      async () => KTX2.slice().buffer,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { extracted, failures } = extractImageBytes(parsed.value);
    expect(failures).toEqual([]);
    expect(extracted.get(0)?.mimeType).toBe('image/ktx2');
    expect(extracted.get(1)?.mimeType).toBe('image/ktx2');
  });

  it('rejects an image/ktx2 declaration whose bytes lack the KTX2 identifier', async () => {
    const parsed = await parseGltfImages(
      [{ uri: dataUri('image/ktx2', PNG), mimeType: 'image/ktx2' }],
      [],
      [],
      noLoader,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { extracted, failures } = extractImageBytes(parsed.value);
    expect(extracted.size).toBe(0);
    expect(failures[0]?.reason).toContain('png/jpeg/ktx2');
  });
});
