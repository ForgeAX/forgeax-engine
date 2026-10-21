import { fileURLToPath } from 'node:url';
import { textureContribution } from '@forgeax/engine-image';
import {
  ImporterRegistry,
  type ImportRunnerFs,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { materialContribution, samplerContribution } from '@forgeax/engine-render';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { importedSource } from '../../../import/src/__tests__/fixtures/runtime-import';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { gltfImporter } from '../gltf-importer.js';

const SOURCE = fileURLToPath(new URL('./fixtures/physical-material.gltf', import.meta.url));
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
          bytes: new Uint8Array([128, 96, 64, 255]),
          mediaType: 'application/octet-stream',
          assetCodec: { name: 'rgba8', version: '1' },
        },
      };
    },
  };
}

describe('glTF physical material importer route', { timeout: 60_000 }, () => {
  it('carries all five KHR layers from importer through pack and runtime material parsing', async () => {
    const importers = new ImporterRegistry();
    importers.register(gltfImporter);
    const cookers = new NativeCookerRegistry();
    cookers.register(createMaterialPackCooker());

    const result = await runImport(meta(), importers, fs(), cookers);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value)
      throw new Error('physical import did not publish a pack');

    expect(result.value.pack.assets).toHaveLength(11);
    expect(result.value.cookProducts).toHaveLength(11);
    expect(result.value.cookProducts.every((product) => product.receipt !== undefined)).toBe(true);

    const material = result.value.pack.assets.find((asset) => asset.guid === MATERIAL_GUID);
    if (material === undefined) throw new Error('physical material pack row missing');
    expect([...material.refs].sort()).toEqual([...TEXTURE_GUIDS, ...SAMPLER_GUIDS].sort());

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

    const { assets: runtime } = importedSource(result.value.pack);
    runtime.installDecoder(materialContribution.kind, materialContribution.decoder);
    runtime.installDecoder(textureContribution.kind, textureContribution.decoder);
    runtime.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const handle = (await runtime.load(MATERIAL_GUID, 'material')).unwrap();
    const values = runtime.read(handle).unwrap().values ?? {};
    const textures = await Promise.all(
      TEXTURE_GUIDS.map(async (guid) => (await runtime.load(guid, 'texture')).unwrap()),
    );
    const samplers = await Promise.all(
      SAMPLER_GUIDS.map(async (guid) => (await runtime.load(guid, 'sampler')).unwrap()),
    );
    expect(values.clearcoatNormalTexture).toMatchObject({
      texture: textures[0],
      sampler: samplers[0],
    });
    expect(values.anisotropyTexture).toMatchObject({
      texture: textures[1],
      sampler: samplers[1],
    });
    expect(values.sheenColorTexture).toMatchObject({
      texture: textures[2],
      sampler: samplers[2],
    });
    expect(values.iridescenceTexture).toMatchObject({
      texture: textures[3],
      sampler: samplers[3],
    });
    expect(values.specularColorTexture).toMatchObject({
      texture: textures[4],
      sampler: samplers[4],
    });
    for (const texture of textures)
      expect(runtime.read(texture).unwrap().data).toEqual(new Uint8Array([128, 96, 64, 255]));
    runtime.dispose();
  });
});
