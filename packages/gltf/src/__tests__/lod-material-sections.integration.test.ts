import { decodeMeshBinary } from '@forgeax/engine-geometry';
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';
import { gltfImporter } from '../gltf-importer';

// MSFT_lod lets each level reference its own mesh with "different geometry and
// materials across various levels". The runtime LOD chain draws every level
// through the root's material sections, so a lower mesh must be published in
// the root's section layout: same section count, same slot per section, with
// sections the level does not author left empty.

const GUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

interface Primitive {
  readonly positions: number;
  readonly material: number;
}

function triangle(z: number): number[] {
  return [0, 0, z, 1, 0, z, 0, 1, z];
}

async function produce(meshes: readonly (readonly Primitive[])[], materialCount: number) {
  const positions = new Float32Array([0, 1, 2, 3].flatMap(triangle));
  const indices = new Uint16Array([0, 1, 2]);
  const bytes = new Uint8Array(positions.byteLength + 8);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength);
  const source = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['MSFT_lod'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        {
          mesh: 0,
          extensions: { MSFT_lod: { ids: meshes.slice(1).map((_, index) => index + 1) } },
        },
        ...meshes.slice(1).map((_, index) => ({ mesh: index + 1 })),
      ],
      meshes: meshes.map((primitives, index) => ({
        name: `level${index}`,
        primitives: primitives.map(({ positions: accessor, material }) => ({
          attributes: { POSITION: accessor },
          indices: 4,
          material,
        })),
      })),
      materials: Array.from({ length: materialCount }, (_, index) => ({ name: `m${index}` })),
      buffers: [
        {
          byteLength: bytes.byteLength,
          uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
        },
      ],
      bufferViews: [
        { buffer: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: 6 },
      ],
      accessors: [
        ...[0, 1, 2, 3].map((index) => ({
          bufferView: 0,
          byteOffset: index * 36,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, index],
          max: [1, 1, index],
        })),
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
    }),
  );
  const registry = new ImporterRegistry();
  registry.register(gltfImporter);
  return runImport(
    {
      importer: 'gltf',
      source: 'lod.gltf',
      importSettings: {},
      subAssets: meshes.map((_, sourceIndex) => ({
        guid: GUIDS[sourceIndex] as string,
        sourceIndex,
        sourceKey: `mesh:${sourceIndex}`,
        kind: 'mesh' as const,
      })),
    },
    registry,
    { readSource: async () => ({ ok: true as const, value: source }) },
  );
}

async function decodedMeshes(meshes: readonly (readonly Primitive[])[], materialCount: number) {
  const result = await produce(meshes, materialCount);
  if (!result.ok) throw result.error;
  if ('skipped' in result.value) throw new Error('expected mesh products');
  const { assets } = result.value.pack;
  return GUIDS.slice(0, meshes.length).map((guid) => {
    const row = assets.find((asset) => asset.guid === guid);
    const bytes = row?.artifacts.body?.bytes;
    if (row === undefined || bytes === undefined) throw new Error(`missing mesh ${guid}`);
    const mesh = decodeMeshBinary(bytes, row.refs);
    if (mesh === undefined) throw new Error(`invalid mesh ${guid}`);
    return mesh;
  });
}

function sections(mesh: Awaited<ReturnType<typeof decodedMeshes>>[number]) {
  return mesh.submeshes.map(({ materialSlot, topology, indexCount }) => ({
    slot: mesh.materialSlots[materialSlot]?.sourceKey,
    materialSlot,
    topology,
    indexCount,
  }));
}

describe('MSFT_lod levels with their own primitives and materials', () => {
  it('publishes a lower level with fewer primitives and fewer materials in the root section layout', async () => {
    const [root, lower] = await decodedMeshes(
      [
        [
          { positions: 0, material: 0 },
          { positions: 1, material: 1 },
        ],
        [{ positions: 2, material: 1 }],
      ],
      2,
    );
    if (root === undefined || lower === undefined) throw new Error('missing levels');
    expect(lower.materialSlots.map((slot) => slot.sourceKey)).toEqual(
      root.materialSlots.map((slot) => slot.sourceKey),
    );
    expect(sections(root)).toEqual([
      { slot: 'gltf:material:0', materialSlot: 0, topology: 'triangle-list', indexCount: 3 },
      { slot: 'gltf:material:1', materialSlot: 1, topology: 'triangle-list', indexCount: 3 },
    ]);
    expect(sections(lower)).toEqual([
      { slot: 'gltf:material:0', materialSlot: 0, topology: 'triangle-list', indexCount: 0 },
      { slot: 'gltf:material:1', materialSlot: 1, topology: 'triangle-list', indexCount: 3 },
    ]);
    // The level keeps its own geometry: its one authored triangle sits at z = 2.
    const z = lower.attributes.position as Float32Array;
    expect(Array.from(lower.indices ?? [], (index) => z[index * 3 + 2])).toEqual([2, 2, 2]);
  });

  it('maps repeated materials to root sections in authored order', async () => {
    const [, lower] = await decodedMeshes(
      [
        [
          { positions: 0, material: 0 },
          { positions: 1, material: 1 },
          { positions: 2, material: 0 },
        ],
        [
          { positions: 3, material: 0 },
          { positions: 1, material: 0 },
        ],
      ],
      2,
    );
    if (lower === undefined) throw new Error('missing level');
    expect(
      sections(lower).map(({ materialSlot, indexCount }) => [materialSlot, indexCount]),
    ).toEqual([
      [0, 3],
      [1, 0],
      [0, 3],
    ]);
    expect(lower.submeshes.map((section) => section.indexOffset)).toEqual([0, 0, 3]);
  });

  it('rejects a lower level whose material has no root section', async () => {
    expect(
      await produce([[{ positions: 0, material: 0 }], [{ positions: 1, material: 1 }]], 2),
    ).toMatchObject({ ok: false, error: { code: 'mesh-lod-contract-invalid' } });
  });
});
