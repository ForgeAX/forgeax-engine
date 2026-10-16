import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  ImporterRegistry,
  type ImportRunnerFs,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gltfImporter } from '../gltf-importer.js';

const SOURCE = 'physical-material.gltf';
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

const MATERIAL_GUID = '019f0000-0000-7000-8000-000000000100';
const TEXTURE_GUIDS = [
  '019f0000-0000-7000-8000-000000000101',
  '019f0000-0000-7000-8000-000000000102',
  '019f0000-0000-7000-8000-000000000103',
  '019f0000-0000-7000-8000-000000000104',
  '019f0000-0000-7000-8000-000000000105',
] as const;
const SAMPLER_GUIDS = [
  '019f0000-0000-7000-8000-000000000106',
  '019f0000-0000-7000-8000-000000000107',
  '019f0000-0000-7000-8000-000000000108',
  '019f0000-0000-7000-8000-000000000109',
  '019f0000-0000-7000-8000-00000000010a',
] as const;

function dataUri(): string {
  return `data:image/png;base64,${TINY_PNG_BASE64}`;
}

function sourceBytes(): Uint8Array {
  const textures = TEXTURE_GUIDS.map((_guid, index) => ({ source: index, sampler: index }));
  return new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: [
        'KHR_materials_clearcoat',
        'KHR_materials_anisotropy',
        'KHR_materials_sheen',
        'KHR_materials_iridescence',
        'KHR_materials_specular',
      ],
      materials: [
        {
          name: 'PhysicalSurface',
          pbrMetallicRoughness: {
            baseColorFactor: [0.8, 0.7, 0.6, 1],
            metallicFactor: 0.1,
            roughnessFactor: 0.35,
          },
          extensions: {
            KHR_materials_clearcoat: {
              clearcoatFactor: 0.75,
              clearcoatRoughnessFactor: 0.2,
              clearcoatNormalTexture: { index: 0 },
            },
            KHR_materials_anisotropy: {
              anisotropyStrength: 0.5,
              anisotropyRotation: 0.25,
              anisotropyTexture: { index: 1 },
            },
            KHR_materials_sheen: {
              sheenColorFactor: [0.2, 0.1, 0.05],
              sheenRoughnessFactor: 0.3,
              sheenColorTexture: { index: 2 },
            },
            KHR_materials_iridescence: {
              iridescenceFactor: 0.6,
              iridescenceIor: 1.4,
              iridescenceThicknessMinimum: 120,
              iridescenceThicknessMaximum: 380,
              iridescenceTexture: { index: 3 },
            },
            KHR_materials_specular: {
              specularFactor: 0.8,
              specularColorFactor: [0.9, 0.85, 0.75],
              specularColorTexture: { index: 4 },
            },
          },
        },
      ],
      textures,
      samplers: [{}, {}, {}, {}, {}],
      images: TEXTURE_GUIDS.map(() => ({ uri: dataUri(), mimeType: 'image/png' })),
      scenes: [],
      nodes: [],
      meshes: [],
    }),
  );
}

function meta(): RunImportMeta {
  return {
    importer: 'gltf',
    source: SOURCE,
    subAssets: [
      {
        guid: MATERIAL_GUID,
        sourceIndex: 0,
        sourceKey: 'material/physical-surface',
        kind: 'material',
      },
      ...TEXTURE_GUIDS.map((guid, sourceIndex) => ({
        guid,
        sourceIndex,
        sourceKey: `texture/${sourceIndex}`,
        kind: 'texture' as const,
      })),
      ...SAMPLER_GUIDS.map((guid, sourceIndex) => ({
        guid,
        sourceIndex,
        sourceKey: `sampler/${sourceIndex}`,
        kind: 'sampler' as const,
      })),
    ],
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function fs(): ImportRunnerFs {
  return {
    readSource: async (sourcePath) =>
      sourcePath === SOURCE
        ? { ok: true, value: sourceBytes() }
        : { ok: false, error: new Error(`unexpected source path ${sourcePath}`) },
    decodeImage: async (_bytes, _mimeType, settings) => {
      const colorSpace = settings.colorSpace === 'srgb' ? 'srgb' : 'linear';
      const texture: TextureAsset = {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
        data: new Uint8Array([128, 96, 64, 255]),
        colorSpace,
        mips: { kind: 'generate' },
      };
      return {
        ok: true,
        value: {
          texture,
          bytes: decodeBase64(TINY_PNG_BASE64),
          mediaType: 'image/png',
          assetCodec: { name: 'rgba8', version: '1' },
        },
      };
    },
  };
}

describe('glTF physical material importer route', () => {
  it('carries all five KHR layers from importer through pack and runtime material parsing', async () => {
    const importers = new ImporterRegistry();
    importers.register(gltfImporter);

    const result = await runImport(meta(), importers, fs());
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value)
      throw new Error('physical import did not publish a pack');

    expect(result.value.pack.assets).toHaveLength(11);
    expect(result.value.cookProducts).toHaveLength(11);
    expect(result.value.cookProducts.every((product) => product.receipt !== undefined)).toBe(true);

    const material = result.value.pack.assets.find((asset) => asset.guid === MATERIAL_GUID);
    if (material === undefined) throw new Error('physical material pack row missing');
    expect(material.refs).toEqual([
      TEXTURE_GUIDS[0],
      SAMPLER_GUIDS[0],
      TEXTURE_GUIDS[1],
      SAMPLER_GUIDS[1],
      TEXTURE_GUIDS[2],
      SAMPLER_GUIDS[2],
      TEXTURE_GUIDS[3],
      SAMPLER_GUIDS[3],
      TEXTURE_GUIDS[4],
      SAMPLER_GUIDS[4],
    ]);

    const payload = material.payload;
    const parameterNames = new Set(
      (payload.parameters as readonly { name: string }[]).map((parameter) => parameter.name),
    );
    for (const name of [
      'clearcoat',
      'anisotropyStrength',
      'sheenColor',
      'iridescence',
      'specular',
      'clearcoatNormalTexture',
      'anisotropyTexture',
      'sheenColorTexture',
      'iridescenceTexture',
      'specularColorTexture',
    ]) {
      expect(parameterNames.has(name)).toBe(true);
    }

    const runtime = new AssetRegistry({
      findMaterialArtifact: () => ({ ok: false, error: new Error('shader registry not wired') }),
    } as never);
    const parsed = runtime.parseAndReturnAsset({
      kind: material.kind,
      payload,
      refs: [...material.refs],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.asset.kind).toBe('material');
    const values = (parsed.value.asset as { values?: Record<string, unknown> }).values ?? {};
    expect(values.clearcoatNormalTexture).toMatchObject({
      texture: TEXTURE_GUIDS[0],
      sampler: SAMPLER_GUIDS[0],
    });
    expect(values.anisotropyTexture).toMatchObject({
      texture: TEXTURE_GUIDS[1],
      sampler: SAMPLER_GUIDS[1],
    });
    expect(values.sheenColorTexture).toMatchObject({
      texture: TEXTURE_GUIDS[2],
      sampler: SAMPLER_GUIDS[2],
    });
    expect(values.iridescenceTexture).toMatchObject({
      texture: TEXTURE_GUIDS[3],
      sampler: SAMPLER_GUIDS[3],
    });
    expect(values.specularColorTexture).toMatchObject({
      texture: TEXTURE_GUIDS[4],
      sampler: SAMPLER_GUIDS[4],
    });
  });
});
