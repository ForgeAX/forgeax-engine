import type { ImportContext, ImportedAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gltfImporter } from '../gltf-importer.js';
import { parseGltf, toAssetPack } from '../parse-gltf.js';
import type { GltfMetaJson } from '../reimport-reuse-meta.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (id: number) => Uint8Array.from([...PNG_MAGIC, id, id, id, id]);
const REPEAT = 10497;
const CLAMP = 33071;

/** One material: `color` as sRGB base colour, `data` as the linear normal map, both on one sampler. */
function document(color: string, data: string, wrap: number) {
  return {
    asset: { version: '2.0' },
    images: [
      { name: 'color', uri: color, mimeType: 'image/png' },
      { name: 'data', uri: data, mimeType: 'image/png' },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: wrap, wrapT: wrap }],
    textures: [
      { name: 'color', source: 0, sampler: 0 },
      { name: 'data', source: 1, sampler: 0 },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } },
    ],
  };
}

type Files = Record<string, Uint8Array>;

async function meta(
  json: unknown,
  files: Files,
  textureIdentity: 'content' | undefined,
  previous?: GltfMetaJson,
): Promise<GltfMetaJson> {
  const parsed = await parseGltf(
    json,
    async (uri) => {
      const bytes = files[uri];
      if (bytes === undefined) throw new Error(`missing ${uri}`);
      return bytes.slice().buffer;
    },
    '/model.gltf',
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  const existing =
    previous ??
    (textureIdentity === undefined
      ? undefined
      : ({
          subAssets: [],
          importSettings: { textureIdentity },
        } as unknown as GltfMetaJson));
  const pack = toAssetPack(parsed.value, existing, 'model.gltf');
  if (!pack.ok) throw new Error(pack.error.code);
  return pack.value.meta;
}

async function importAll(json: unknown, files: Files, declared: GltfMetaJson) {
  const decoded: { colorSpace: unknown; bytes: Uint8Array }[] = [];
  const context: ImportContext = {
    source: 'model.gltf',
    subAssets: declared.subAssets,
    importSettings: declared.importSettings,
    readSource: async () => ({ ok: true, value: new TextEncoder().encode(JSON.stringify(json)) }),
    readSibling: async (uri) => ({ ok: true, value: files[uri] ?? new Uint8Array() }),
    decodeImage: async (bytes, _mimeType, settings) => {
      decoded.push({ colorSpace: settings.colorSpace, bytes });
      const colorSpace = settings.colorSpace === 'srgb' ? 'srgb' : 'linear';
      const texture: TextureAsset = {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
        colorSpace,
        mips: { kind: 'none' },
        data: bytes,
      };
      return { ok: true, value: { texture, bytes } };
    },
  };
  const result = await gltfImporter.import(context);
  if (!result.ok) throw new Error(result.error.code);
  return result.value.assets as readonly ImportedAsset[];
}

const guidOf = (declared: GltfMetaJson, kind: string, sourceIndex: number) =>
  declared.subAssets.find((sub) => sub.kind === kind && sub.sourceIndex === sourceIndex)?.guid;

/** Resolve the material's base-colour and normal bindings to the GUIDs they reference. */
function bindings(assets: readonly ImportedAsset[]) {
  const material = assets.find((asset) => asset.kind === 'material');
  if (material === undefined) throw new Error('material output missing');
  const values = (material.payload as { values: Record<string, unknown> }).values;
  const guid = (index: number) => material.refs[index]?.guid;
  const slot = (name: string) => {
    const binding = values[name] as { texture: number; sampler: number };
    return { texture: guid(binding.texture), sampler: guid(binding.sampler) };
  };
  return { baseColor: slot('baseColorTexture'), normal: slot('normalTexture') };
}

describe('content-identified glTF textures', () => {
  const files: Files = { 'brick.png': png(1), 'brick-copy.png': png(1), 'mask.png': png(2) };
  // `a` reads brick as colour and mask as normal data; `b` reads the same
  // brick bytes (another file) as colour on a clamped sampler and the mask
  // bytes as colour.
  const a = document('brick.png', 'mask.png', REPEAT);
  const b = document('brick-copy.png', 'brick.png', CLAMP);
  const c = document('mask.png', 'brick.png', CLAMP);

  it('two glTF files declare one texture for the same bytes used the same way', async () => {
    const metaA = await meta(a, files, 'content');
    const metaB = await meta(b, files, 'content');
    expect(guidOf(metaA, 'texture', 0)).toBe(guidOf(metaB, 'texture', 0));
    expect(metaA.importSettings.textureIdentity).toBe('content');
    // Regenerating keeps the identity stable.
    expect(await meta(a, files, 'content', metaA)).toEqual(metaA);
    // Without the setting each file keeps its own texture identities.
    const plainA = await meta(a, files, undefined);
    const plainB = await meta(b, files, undefined);
    expect(guidOf(plainA, 'texture', 0)).not.toBe(guidOf(plainB, 'texture', 0));
    expect(plainA.importSettings.textureIdentity).toBeUndefined();
  });

  it('never crosses colour spaces or samplers between files sharing image bytes', async () => {
    const metaA = await meta(a, files, 'content');
    const metaB = await meta(b, files, 'content');
    const metaC = await meta(c, files, 'content');
    // brick as sRGB colour vs brick as linear normal data.
    expect(guidOf(metaB, 'texture', 1)).not.toBe(guidOf(metaA, 'texture', 0));
    // mask as linear normal data vs mask as sRGB colour.
    expect(guidOf(metaC, 'texture', 0)).not.toBe(guidOf(metaA, 'texture', 1));
    // Samplers stay per file.
    expect(guidOf(metaB, 'sampler', 0)).not.toBe(guidOf(metaA, 'sampler', 0));

    const assetsA = await importAll(a, files, metaA);
    const assetsB = await importAll(b, files, metaB);
    expect(bindings(assetsA)).toEqual({
      baseColor: { texture: guidOf(metaA, 'texture', 0), sampler: guidOf(metaA, 'sampler', 0) },
      normal: { texture: guidOf(metaA, 'texture', 1), sampler: guidOf(metaA, 'sampler', 0) },
    });
    expect(bindings(assetsB)).toEqual({
      baseColor: { texture: guidOf(metaA, 'texture', 0), sampler: guidOf(metaB, 'sampler', 0) },
      normal: { texture: guidOf(metaB, 'texture', 1), sampler: guidOf(metaB, 'sampler', 0) },
    });
    const texture = (assets: readonly ImportedAsset[], guid: string | undefined) =>
      assets.find((asset) => asset.guid === guid)?.payload as TextureAsset;
    // Both files publish the shared GUID with identical sRGB payloads.
    const sharedGuid = guidOf(metaA, 'texture', 0);
    expect(texture(assetsB, sharedGuid)).toEqual(texture(assetsA, sharedGuid));
    expect(texture(assetsA, sharedGuid).colorSpace).toBe('srgb');
    expect(texture(assetsB, guidOf(metaB, 'texture', 1)).colorSpace).toBe('linear');
    const samplers = (assets: readonly ImportedAsset[]) =>
      assets.filter((asset) => asset.kind === 'sampler').map((asset) => asset.payload);
    expect(samplers(assetsA)).toMatchObject([{ addressModeU: 'repeat' }]);
    expect(samplers(assetsB)).toMatchObject([{ addressModeU: 'clamp-to-edge' }]);
  });

  it('decode settings are part of the identity', async () => {
    const plain = await meta(a, files, 'content');
    const plainB = await meta(b, files, 'content');
    const downscaledB = await meta(b, files, undefined, {
      ...plainB,
      importSettings: { ...plainB.importSettings, downscaleMaxDimension: 256 },
    });
    expect(guidOf(plainB, 'texture', 0)).toBe(guidOf(plain, 'texture', 0));
    expect(guidOf(downscaledB, 'texture', 0)).not.toBe(guidOf(plain, 'texture', 0));
  });

  it('changed bytes split one file off and leave the other on the shared texture', async () => {
    const metaA = await meta(a, files, 'content');
    const metaB = await meta(b, files, 'content');
    const edited = { ...files, 'brick-copy.png': png(3) };
    // A stale meta must not publish new bytes under the shared GUID.
    await expect(importAll(b, edited, metaB)).rejects.toThrow(/changed since the meta was written/);
    const refreshed = await meta(b, edited, 'content', metaB);
    expect(guidOf(refreshed, 'texture', 0)).not.toBe(guidOf(metaA, 'texture', 0));
    expect(guidOf(refreshed, 'texture', 1)).toBe(guidOf(metaB, 'texture', 1));
    expect(guidOf(refreshed, 'sampler', 0)).toBe(guidOf(metaB, 'sampler', 0));
    expect(guidOf(await meta(a, edited, 'content', metaA), 'texture', 0)).toBe(
      guidOf(metaA, 'texture', 0),
    );
    expect(bindings(await importAll(b, edited, refreshed)).baseColor.texture).toBe(
      guidOf(refreshed, 'texture', 0),
    );
  });
});
