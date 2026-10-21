import type { ImportContext, ImportedAsset } from '@forgeax/engine-types';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import {
  importedMesh,
  importedSource,
} from '../../../import/src/__tests__/fixtures/runtime-import';
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
    expect(importedMesh(mesh).indices).toEqual(new Uint16Array([0, 1, 2]));
  });

  it('loads the imported compressed artifact through Pack, Catalog, and source loading', async () => {
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
    const { assets: registry } = importedSource({
      assets: [{ ...mesh, refs: mesh.refs.map((ref: { guid: string }) => ref.guid) }],
    });
    try {
      const handle = (await registry.load(guid, 'mesh')).unwrap();
      const payload = registry.read(handle).unwrap();
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
      registry.dispose();
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
    const {
      assets: registry,
      bodies,
      packageUrl,
    } = importedSource({
      assets: [{ ...mesh, refs: mesh.refs.map((ref: { guid: string }) => ref.guid) }],
    });
    const damaged = new Uint8Array(mesh.artifacts.body.bytes);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;
    bodies.set(new URL(`${guid}/body`, packageUrl).href, damaged);
    try {
      expect(await registry.load(guid, 'mesh')).toMatchObject({
        ok: false,
        error: { code: 'asset-integrity-failed' },
      });
    } finally {
      registry.dispose();
    }
  });
});
