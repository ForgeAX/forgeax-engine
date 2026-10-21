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

const SOURCE = fileURLToPath(new URL('./fixtures/foliage.gltf', import.meta.url));
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const MATERIAL_GUID = '019f0000-0000-7000-8000-000000000200';
const TEXTURE_GUIDS = [
  '019f0000-0000-7000-8000-000000000201',
  '019f0000-0000-7000-8000-000000000202',
] as const;
const SAMPLER_GUIDS = [
  '019f0000-0000-7000-8000-000000000203',
  '019f0000-0000-7000-8000-000000000204',
] as const;

function sourceBytes(extension: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_materials_diffuse_transmission'],
      materials: [
        {
          name: 'Leaf',
          doubleSided: true,
          pbrMetallicRoughness: { baseColorFactor: [0.3, 0.6, 0.2, 1], roughnessFactor: 0.7 },
          extensions: { KHR_materials_diffuse_transmission: extension },
        },
      ],
      textures: [
        { source: 0, sampler: 0 },
        { source: 1, sampler: 1 },
      ],
      samplers: [{}, {}],
      images: TEXTURE_GUIDS.map(() => ({
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        mimeType: 'image/png',
      })),
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
      { guid: MATERIAL_GUID, sourceIndex: 0, sourceKey: 'material/leaf', kind: 'material' },
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

function fs(extension: Record<string, unknown>, colorSpaces: string[]): ImportRunnerFs {
  return {
    readSource: async (sourcePath) =>
      sourcePath === SOURCE
        ? { ok: true, value: sourceBytes(extension) }
        : { ok: false, error: new Error(`unexpected source path ${sourcePath}`) },
    decodeImage: async (_bytes, _mimeType, settings) => {
      const colorSpace = settings.colorSpace === 'srgb' ? 'srgb' : 'linear';
      colorSpaces.push(colorSpace);
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

describe('glTF KHR_materials_diffuse_transmission import', { timeout: 60_000 }, () => {
  it('publishes the diffuseTransmission layer, values and textures through pack parsing', async () => {
    const importers = new ImporterRegistry();
    importers.register(gltfImporter);
    const cookers = new NativeCookerRegistry();
    cookers.register(createMaterialPackCooker());
    const colorSpaces: string[] = [];
    const result = await runImport(
      meta(),
      importers,
      fs(
        {
          diffuseTransmissionFactor: 0.6,
          diffuseTransmissionTexture: { index: 0 },
          diffuseTransmissionColorFactor: [0.5, 0.9, 0.3],
          diffuseTransmissionColorTexture: { index: 1 },
        },
        colorSpaces,
      ),
      cookers,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if ('skipped' in result.value) throw new Error('diffuse import did not publish');
    // The factor texture is alpha data; the tint texture is sRGB color.
    expect(colorSpaces).toEqual(['linear', 'srgb']);

    const material = result.value.pack.assets.find((asset) => asset.guid === MATERIAL_GUID);
    if (material === undefined) throw new Error('leaf material row missing');
    expect([...material.refs].sort()).toEqual([...TEXTURE_GUIDS, ...SAMPLER_GUIDS].sort());
    const names = new Set(
      (material.payload.parameters as readonly { name: string }[]).map((p) => p.name),
    );
    for (const name of [
      'diffuseTransmission',
      'diffuseTransmissionColor',
      'diffuseTransmissionTexture',
      'diffuseTransmissionColorTexture',
    ])
      expect(names.has(name)).toBe(true);

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
    expect(values.diffuseTransmission).toBeCloseTo(0.6);
    expect(values.diffuseTransmissionColor).toEqual([0.5, 0.9, 0.3]);
    expect(values.diffuseTransmissionTexture).toMatchObject({
      texture: textures[0],
      sampler: samplers[0],
    });
    expect(values.diffuseTransmissionColorTexture).toMatchObject({
      texture: textures[1],
      sampler: samplers[1],
    });
    for (const texture of textures)
      expect(runtime.read(texture).unwrap().data).toEqual(new Uint8Array([128, 96, 64, 255]));
    runtime.dispose();
  });

  it('defaults an empty extension to the KHR factor 0 and white tint', async () => {
    const importers = new ImporterRegistry();
    importers.register(gltfImporter);
    const result = await runImport(meta(), importers, fs({}, []));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if ('skipped' in result.value) throw new Error('diffuse import did not publish');
    const material = result.value.pack.assets.find((asset) => asset.guid === MATERIAL_GUID);
    const values = (material?.payload.values ?? {}) as Record<string, unknown>;
    expect(values.diffuseTransmission).toBe(0);
    expect(values.diffuseTransmissionColor).toEqual([1, 1, 1]);
  });

  it('rejects an out-of-range factor with the structured physical-material error', async () => {
    const importers = new ImporterRegistry();
    importers.register(gltfImporter);
    const result = await runImport(meta(), importers, fs({ diffuseTransmissionFactor: 1.5 }, []));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).toContain('KHR_materials_diffuse_transmission');
    expect(JSON.stringify(result.error)).toContain('diffuseTransmissionFactor');
  });
});
