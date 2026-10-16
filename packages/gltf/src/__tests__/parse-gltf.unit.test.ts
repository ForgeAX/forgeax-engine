import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataUriBase64Payload, decodeBase64 } from '../data-uri.js';
import { parseMaterial as parseMaterialIr } from '../material/parse-material.js';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_uri: string) => new ArrayBuffer(0);

async function parseMaterial(material: Record<string, unknown>) {
  const result = await parseGltf(
    {
      asset: { version: '2.0' },
      materials: [material],
    },
    noopLoader,
    '/material-alpha.gltf',
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected material parse to succeed');
  return result.value.materials[0];
}

describe('glTF MASK alpha cutoff parsing', () => {
  it('applies the glTF default cutoff of 0.5', async () => {
    const material = await parseMaterial({
      alphaMode: 'MASK',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] },
    });

    expect(material?.alphaMode).toBe('MASK');
    expect(material?.alphaCutoff).toBe(0.5);
  });

  it.each([0, 0.5, 1])('preserves the explicit cutoff boundary %s', async (cutoff) => {
    const material = await parseMaterial({
      alphaMode: 'MASK',
      alphaCutoff: cutoff,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] },
    });

    expect(material?.alphaCutoff).toBe(cutoff);
  });
});

describe('glTF transmission material IR', () => {
  it('rejects BLEND materials with effective transmission as a structured error', () => {
    const result = parseMaterialIr(
      {
        alphaMode: 'BLEND',
        extensions: { KHR_materials_transmission: { transmissionFactor: 1 } },
      },
      [],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('gltf-material-transmission-invalid');
    expect(result.error.detail).toEqual({
      extension: 'KHR_materials_transmission',
      field: 'alphaMode',
      reason: 'blend',
      actual: 'BLEND',
    });
  });

  it('projects transmission, IOR, volume, channel, and texture transform facts', async () => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume'],
        materials: [
          {
            pbrMetallicRoughness: {
              baseColorTexture: {
                index: 0,
                texCoord: 1,
                extensions: {
                  KHR_texture_transform: {
                    offset: [0.25, 0.5],
                    rotation: 0.25,
                    scale: [2, 3],
                  },
                },
              },
            },
            extensions: {
              KHR_materials_transmission: {
                transmissionFactor: 0.75,
                transmissionTexture: { index: 1, texCoord: 2 },
              },
              KHR_materials_ior: { ior: 1.33 },
              KHR_materials_volume: {
                thicknessFactor: 0.04,
                thicknessTexture: { index: 2, texCoord: 3 },
                attenuationColor: [0.2, 0.4, 0.8],
                attenuationDistance: Number.POSITIVE_INFINITY,
              },
            },
          },
        ],
        textures: [
          { sampler: 7, source: 0 },
          { sampler: 8, source: 1 },
          { sampler: 9, source: 2 },
        ],
      },
      noopLoader,
      '/material-transmission.gltf',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.materials[0]).toMatchObject({
      transmissionFactor: 0.75,
      transmissionTexture: { texture: 1, sampler: 8, texCoord: 2 },
      ior: 1.33,
      thicknessFactor: 0.04,
      thicknessTexture: { texture: 2, sampler: 9, texCoord: 3 },
      attenuationColor: [0.2, 0.4, 0.8],
    });
    expect(result.value.materials[0]).not.toHaveProperty('attenuationDistance');
    expect(result.value.materials[0]?.baseColorTexture).toMatchObject({
      transform: { offset: [0.25, 0.5], rotation: 0.25, scale: [2, 3] },
    });
  });

  it('rejects an IOR at the non-positive boundary', async () => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_materials_ior'],
        materials: [{ extensions: { KHR_materials_ior: { ior: 0 } } }],
      },
      noopLoader,
      '/material-invalid-ior.gltf',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('gltf-material-transmission-invalid');
    expect(result.error.detail).toMatchObject({ extension: 'KHR_materials_ior', field: 'ior' });
  });

  it('accepts all transmission material required extensions through the parse path', async () => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume'],
        extensionsRequired: [
          'KHR_materials_transmission',
          'KHR_materials_ior',
          'KHR_materials_volume',
        ],
      },
      noopLoader,
      '/material-required-transmission.gltf',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics.unsupportedExtensions).toEqual([]);
  });
});

describe('glTF specular material IR', () => {
  it('projects specularTexture through the alpha channel', () => {
    const result = parseMaterialIr(
      {
        extensions: {
          KHR_materials_specular: {
            specularFactor: 0.75,
            specularTexture: { index: 0 },
            specularColorFactor: [0.8, 0.7, 0.6],
            specularColorTexture: { index: 1 },
          },
        },
      },
      [{ source: 0 }, { source: 1 }],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      specularFactor: 0.75,
      specularChannel: 3,
      specularTexture: { texture: 0 },
      specularColorFactor: [0.8, 0.7, 0.6],
      specularColorChannel: [0, 1, 2],
      specularColorTexture: { texture: 1 },
    });
  });
});

describe('glTF required extension admission', () => {
  it.each([
    'KHR_materials_transmission',
    'KHR_materials_ior',
    'KHR_materials_volume',
  ])('accepts %s through the parse path', async (extension) => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        extensionsUsed: [extension],
        extensionsRequired: [extension],
      },
      noopLoader,
      `/required-${extension}.gltf`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics.unsupportedExtensions).toEqual([]);
  });
});
describe('glTF COLOR_0 importer carrier', () => {
  it('publishes normalized VEC3 FLOAT colors as importer-owned RGBA', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/color-0/float-vec3.gltf', import.meta.url), 'utf8'),
    ) as {
      readonly buffers: readonly { readonly uri: string }[];
      readonly meshes: readonly {
        readonly primitives: readonly { readonly attributes: Record<string, number> }[];
      }[];
      readonly accessors: readonly unknown[];
      readonly bufferViews: readonly unknown[];
    };
    const uri = fixture.buffers[0]?.uri;
    if (uri === undefined) throw new Error('fixture buffer is missing');
    const payload = dataUriBase64Payload(uri);
    if (payload === undefined) throw new Error('fixture buffer must be a data URI');
    const result = await parseGltf(
      fixture,
      async () => {
        const bytes = decodeBase64(payload);
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
      },
      '/fixtures/color-0/float-vec3.gltf',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value.meshes[0] as unknown as {
      readonly colors0?: Float32Array;
    };
    expect(Array.from(mesh.colors0 ?? [])).toEqual([0, 0.5, 1, 1, 1, 0.25, 0, 1]);
  });

  it('keeps an absent COLOR_0 distinct from a present-invalid accessor', async () => {
    const source = JSON.parse(
      readFileSync(new URL('./fixtures/color-0/float-vec3.gltf', import.meta.url), 'utf8'),
    ) as {
      readonly asset: { readonly version: string };
      readonly buffers: readonly unknown[];
      readonly bufferViews: readonly unknown[];
      readonly accessors: readonly unknown[];
      readonly meshes: readonly {
        readonly primitives: readonly { readonly attributes: Record<string, number> }[];
      }[];
    };
    const sourcePrimitive = source.meshes[0]?.primitives[0];
    if (sourcePrimitive === undefined) throw new Error('fixture primitive is missing');
    const plain = await parseGltf(
      {
        ...source,
        meshes: [
          {
            primitives: [{ attributes: { POSITION: sourcePrimitive.attributes.POSITION ?? 0 } }],
          },
        ],
      },
      noopLoader,
      '/fixtures/color-0/absent.gltf',
    );
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(
      (plain.value.meshes[0] as unknown as { readonly colors0?: unknown }).colors0,
    ).toBeUndefined();

    const invalid = await parseGltf(
      {
        ...source,
        meshes: [
          {
            primitives: [
              {
                attributes: {
                  POSITION: sourcePrimitive.attributes.POSITION ?? 0,
                  COLOR_0: 9,
                },
              },
            ],
          },
        ],
      },
      noopLoader,
      '/fixtures/color-0/present-invalid.gltf',
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.detail).toMatchObject({ semantic: 'COLOR_0', accessorIndex: 9 });
  });
});
