import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Asset, ImportContext, ImportedAsset } from '@forgeax/engine-types';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { createGltfImporter } from '../gltf-importer.js';
import { parseGlb } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const padded = new Uint8Array((bytes.byteLength + 3) & ~3);
  padded.fill(fill);
  padded.set(bytes);
  return padded;
}

function makeGlb(json: Record<string, unknown>, binary: Uint8Array): ArrayBuffer {
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binBytes = pad4(binary, 0);
  const totalLength = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.byteLength;
  view.setUint32(binHeader, binBytes.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  glb.set(binBytes, binHeader + 8);
  return glb.buffer;
}

function compressedGlb(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const positionBytes = MeshoptEncoder.encodeGltfBuffer(
    bytesOf(positions),
    positions.length / 3,
    12,
    'ATTRIBUTES',
  );
  const indexBytes = MeshoptEncoder.encodeGltfBuffer(
    bytesOf(indices),
    indices.length,
    2,
    'TRIANGLES',
  );
  const indexOffset = positionBytes.byteLength;
  const binary = new Uint8Array(indexOffset + indexBytes.byteLength);
  binary.set(positionBytes, 0);
  binary.set(indexBytes, indexOffset);
  return makeGlb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_meshopt_compression'],
      extensionsRequired: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [
        {
          buffer: 0,
          byteLength: 0,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: 0,
              byteLength: positionBytes.byteLength,
              byteStride: 12,
              count: 3,
              mode: 'ATTRIBUTES',
            },
          },
        },
        {
          buffer: 0,
          byteLength: 0,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: indexOffset,
              byteLength: indexBytes.byteLength,
              byteStride: 2,
              count: 3,
              mode: 'TRIANGLES',
            },
          },
        },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [
        {
          primitives: [{ attributes: { POSITION: 0 }, indices: 1 }],
        },
      ],
    },
    binary,
  );
}

describe('real EXT_meshopt_compression glTF matrix', () => {
  function decoder() {
    return {
      decode({
        source,
        count,
        stride,
        mode,
        filter,
      }: {
        source: Uint8Array;
        count: number;
        stride: number;
        mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
        filter: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';
      }) {
        const target = new Uint8Array(count * stride);
        MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode, filter);
        return target;
      },
    };
  }

  it('decodes compressed ATTRIBUTES and TRIANGLES streams before bridge projection', async () => {
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    const result = await parseGlb(compressedGlb(), 'meshopt-real.glb', { meshopt: decoder() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meshes).toHaveLength(1);
    expect(Array.from(result.value.meshes[0]?.positions ?? [])).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect(Array.from(result.value.meshes[0]?.indices ?? [])).toEqual([0, 1, 2]);

    const mesh = meshIrToMeshAsset(result.value.meshes);
    expect([
      mesh.vertices[0],
      mesh.vertices[1],
      mesh.vertices[2],
      mesh.vertices[12],
      mesh.vertices[13],
      mesh.vertices[14],
      mesh.vertices[24],
      mesh.vertices[25],
      mesh.vertices[26],
    ]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(mesh.indices ?? [])).toEqual([0, 1, 2]);
  });

  it('routes the same compressed source through the build-time importer capability', async () => {
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    const bytes = new Uint8Array(compressedGlb());
    const context: ImportContext = {
      source: 'meshopt-real.glb',
      readSource: async () => ({ ok: true as const, value: bytes }),
      readSibling: async () => {
        throw new Error('the compressed fixture has no sibling buffers');
      },
      decodeImage: async () => {
        throw new Error('the compressed fixture has no images');
      },
      subAssets: [
        {
          guid: '019f0000-0000-7000-8000-000000000201',
          sourceIndex: 0,
          kind: 'mesh',
        },
      ],
      importSettings: {},
    };
    const result = await createGltfImporter({ meshopt: decoder() }).import(context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value.assets.find((asset: { kind: string }) => asset.kind === 'mesh');
    expect(mesh?.guid).toBe('019f0000-0000-7000-8000-000000000201');
    expect(mesh?.payload.indices).toEqual(new Uint16Array([0, 1, 2]));
  });

  it('loads the imported compressed artifact through Pack, Catalog, and loadByGuid', async () => {
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    const guid = '019f0000-0000-7000-8000-000000000202';
    const sourceBytes = new Uint8Array(compressedGlb());
    const context: ImportContext = {
      source: 'meshopt-pack.glb',
      readSource: async () => ({ ok: true as const, value: sourceBytes }),
      readSibling: async () => {
        throw new Error('the compressed fixture has no sibling buffers');
      },
      decodeImage: async () => {
        throw new Error('the compressed fixture has no images');
      },
      subAssets: [{ guid, sourceIndex: 0, kind: 'mesh' }],
      importSettings: {},
    };
    const imported = await createGltfImporter({ meshopt: decoder() }).import(context);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const mesh = imported.value.assets.find((asset: ImportedAsset) => asset.guid === guid);
    expect(mesh?.kind).toBe('mesh');
    if (mesh?.kind !== 'mesh') return;
    const meshPayload = mesh.payload as Extract<Asset, { kind: 'mesh' }>;
    const body = mesh.artifacts.body;
    expect(body?.bytes.byteLength).toBeGreaterThan(0);
    if (body === undefined) return;

    const packIndexUrl = '/meshopt-pack-index.json';
    const packageUrl = '/ddc/meshopt-pack.pack.json';
    const originalFetch = globalThis.fetch;
    const registry = new AssetRegistry({} as never);
    registry.configurePackIndex(packIndexUrl);
    globalThis.fetch = ((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === packIndexUrl) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ guid, packageUrl, kind: 'mesh' }],
        });
      }
      if (url === packageUrl) {
        const pack = {
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid,
              kind: 'mesh',
              payload: meshPayload,
              refs: [],
              artifacts: {
                body: {
                  path: 'mesh.bin',
                  mediaType: body.mediaType,
                  byteLength: body.bytes.byteLength,
                  assetCodec: body.assetCodec,
                },
              },
            },
          ],
        };
        return Promise.resolve({
          ok: true,
          json: async () => JSON.parse(JSON.stringify(pack)),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () =>
          body.bytes.buffer.slice(
            body.bytes.byteOffset,
            body.bytes.byteOffset + body.bytes.byteLength,
          ),
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      const loaded = await registry.loadByGuid(registry.parseGuid(guid));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const payload = loaded.value as { vertices: Float32Array; indices?: Uint16Array };
      expect([
        payload.vertices[0],
        payload.vertices[1],
        payload.vertices[2],
        payload.vertices[12],
        payload.vertices[13],
        payload.vertices[14],
        payload.vertices[24],
        payload.vertices[25],
        payload.vertices[26],
      ]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      expect(Array.from(payload.indices ?? [])).toEqual([0, 1, 2]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a damaged compressed artifact after importer success', async () => {
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    const guid = '019f0000-0000-7000-8000-000000000203';
    const sourceBytes = new Uint8Array(compressedGlb());
    const context: ImportContext = {
      source: 'meshopt-damaged.glb',
      readSource: async () => ({ ok: true as const, value: sourceBytes }),
      readSibling: async () => {
        throw new Error('the compressed fixture has no sibling buffers');
      },
      decodeImage: async () => {
        throw new Error('the compressed fixture has no images');
      },
      subAssets: [{ guid, sourceIndex: 0, kind: 'mesh' }],
      importSettings: {},
    };
    const imported = await createGltfImporter({ meshopt: decoder() }).import(context);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const mesh = imported.value.assets.find((asset: ImportedAsset) => asset.guid === guid);
    if (mesh?.kind !== 'mesh' || mesh.artifacts.body === undefined) return;
    const meshPayload = mesh.payload as Extract<Asset, { kind: 'mesh' }>;
    const damaged = new Uint8Array(mesh.artifacts.body.bytes);
    const lastByte = damaged.length - 1;
    damaged[lastByte] = (damaged[lastByte] ?? 0) ^ 0xff;
    const registry = new AssetRegistry({} as never);
    const packIndexUrl = '/meshopt-damaged-index.json';
    const packageUrl = '/ddc/meshopt-damaged.pack.json';
    registry.configurePackIndex(packIndexUrl);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === packIndexUrl)
        return Promise.resolve({
          ok: true,
          json: async () => [{ guid, packageUrl, kind: 'mesh' }],
        });
      if (url === packageUrl)
        return Promise.resolve({
          ok: true,
          json: async () => ({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid,
                kind: 'mesh',
                payload: meshPayload,
                refs: [],
                artifacts: {
                  body: {
                    path: 'mesh.bin',
                    mediaType: mesh.artifacts.body?.mediaType,
                    byteLength: damaged.byteLength,
                    assetCodec: mesh.artifacts.body?.assetCodec,
                  },
                },
              },
            ],
          }),
        });
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () =>
          damaged.buffer.slice(damaged.byteOffset, damaged.byteOffset + damaged.byteLength),
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const loaded = await registry.loadByGuid(registry.parseGuid(guid));
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect([
        'asset-parse-failed',
        'asset-artifact-integrity-mismatch',
        'mesh-bin-contract-violation',
      ]).toContain(loaded.error.code);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
