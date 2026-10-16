import type { ImportContext, ImportResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { meshIrToMeshAsset } from '../bridge.js';
import { dracoDecoder } from '../draco-node.js';
import { createGltfImporter } from '../gltf-importer.js';
import { parseGltf, toAssetPack } from '../parse-gltf.js';
import { dracoFixture } from './draco-fixture.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

const noExternal = async () => {
  throw new Error('inline fixture');
};

describe('KHR_draco_mesh_compression real decoder', () => {
  it('decodes compressed-only geometry and normalized integer colors through ordinary accessors', async () => {
    const { json } = await dracoFixture();
    const untouched = JSON.stringify(json);
    const doc = (
      await parseGltf(json, noExternal, 'fixture.gltf', { draco: dracoDecoder })
    ).unwrap();
    const mesh = meshIrToMeshAsset(doc.meshes).unwrap();
    expect(Array.from(required(mesh.aabb))).toEqual([0, 0, 0, 1, 1, 0]);
    expect(mesh.indices).toHaveLength(6);
    const colors = doc.meshes[0]?.colors0;
    expect(colors).toHaveLength(16);
    expect(colors?.every((value) => value === 0 || value === 1)).toBe(true);
    expect(JSON.stringify(json)).toBe(untouched);
  });
  it('requires a decoder for compressed-only input with an actionable structured error', async () => {
    const { json } = await dracoFixture();
    const result = await parseGltf(json, noExternal, 'fixture.gltf');
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'gltf-draco-decoder-required',
        detail: { meshIndex: 0, primitiveIndex: 0, bufferView: 0 },
      },
    });
  });
  it('admits optional Draco only when every ordinary fallback accessor has valid bytes', async () => {
    const { json } = await dracoFixture();
    json.extensionsRequired = [];
    const arrays = [
      new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
      new Uint16Array([0, 1, 2, 0, 2, 3]),
    ];
    for (const [index, array] of arrays.entries()) {
      const buffer = json.buffers.length;
      json.buffers.push({
        byteLength: array.byteLength,
        uri: `data:application/octet-stream;base64,${Buffer.from(array.buffer).toString('base64')}`,
      });
      const view = json.bufferViews.length;
      json.bufferViews.push({ buffer, byteLength: array.byteLength });
      Object.assign(required(json.accessors[index]), { bufferView: view });
    }
    expect((await parseGltf(json, noExternal, 'fallback.gltf')).ok).toBe(true);
    required(json.bufferViews[3]).byteLength = 1;
    expect(await parseGltf(json, noExternal, 'fallback.gltf')).toMatchObject({
      ok: false,
      error: { code: 'gltf-draco-decoder-required' },
    });
  });
  it.each([
    'truncated',
    'attribute-id',
    'count',
    'component',
    'range',
    'indices',
  ] as const)('rejects %s rather than falling through to empty accessors', async (fault) => {
    const { json, bytes } = await dracoFixture();
    if (fault === 'truncated')
      required(json.buffers[0]).uri =
        `data:application/octet-stream;base64,${Buffer.from(bytes.subarray(0, 9)).toString('base64')}`;
    if (fault === 'attribute-id')
      required(
        required(json.meshes[0]).primitives[0],
      ).extensions.KHR_draco_mesh_compression.attributes.POSITION = 999;
    if (fault === 'count') required(json.accessors[0]).count = 5;
    if (fault === 'component') required(json.accessors[0]).componentType = 42;
    if (fault === 'range') required(json.bufferViews[0]).byteLength += 1;
    if (fault === 'indices') required(json.accessors[2]).count = 3;
    const result = await parseGltf(json, noExternal, 'fixture.gltf', { draco: dracoDecoder });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'gltf-draco-decode-failed', detail: { reason: expect.any(String) } },
    });
  });
  it.each([
    'missing',
    'null',
    'array',
    'null-extension',
  ] as const)('returns a structured error for %s Draco declarations', async (fault) => {
    const { json } = await dracoFixture();
    const extensions = required(required(json.meshes[0]).primitives[0]).extensions as Record<
      string,
      unknown
    >;
    const declaration = extensions.KHR_draco_mesh_compression as Record<string, unknown>;
    if (fault === 'missing') delete declaration.attributes;
    if (fault === 'null') declaration.attributes = null;
    if (fault === 'array') declaration.attributes = [];
    if (fault === 'null-extension') extensions.KHR_draco_mesh_compression = null;
    const result = await parseGltf(json, noExternal, 'fixture.gltf', { draco: dracoDecoder });
    expect(result).toMatchObject({ ok: false, error: { code: 'gltf-draco-decode-failed' } });
  });
  it.each([
    false,
    { voxelSize: 0.5 },
  ] as const)('produces the same GUID closure and mesh-bin artifact with visibility settings %j', async (meshDistanceField) => {
    const { json } = await dracoFixture();
    const options = { draco: dracoDecoder };
    const doc = (await parseGltf(json, noExternal, 'fixture.gltf', options)).unwrap();
    const pack = toAssetPack(doc, undefined, 'fixture.gltf').unwrap();
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const context: ImportContext = {
      source: 'fixture.gltf',
      readSource: async () => ({ ok: true, value: bytes }),
      readSibling: noExternal,
      decodeImage: noExternal,
      subAssets: pack.subAssets,
      importSettings: { meshDistanceField },
    };
    const imported: ImportResult = await createGltfImporter(options).import(context);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.assets.map((asset) => asset.guid).sort()).toEqual(
      pack.subAssets.map((asset) => asset.guid).sort(),
    );
    expect(
      imported.value.assets.find((asset) => asset.kind === 'mesh')?.artifacts.body?.bytes?.length,
    ).toBeGreaterThan(0);
    const mesh = imported.value.assets.find((asset) => asset.kind === 'mesh');
    expect(mesh?.artifacts['distance-field.bin'] !== undefined).toBe(meshDistanceField !== false);
    if (meshDistanceField !== false) {
      expect(mesh?.payload).toMatchObject({ distanceField: { sectionSidedness: [0] } });
      expect(mesh?.artifacts['distance-field.bin']?.bytes?.length).toBeGreaterThan(0);
    }
  });
});
