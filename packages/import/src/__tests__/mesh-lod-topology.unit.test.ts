import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { generateMeshLods } from '../mesh-lod-generator.js';
import { lodRegionFixture } from './fixtures/lod-region-fixture.js';

const guid = (index: number) => {
  const parsed = AssetGuid.parse(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const decode = <T extends Float32Array | Uint16Array>(
  base64: string,
  Array_: new (b: ArrayBuffer) => T,
): T => {
  const bytes = Buffer.from(base64, 'base64');
  return new Array_(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const edgeCounts = (positions: Float32Array, indices: ArrayLike<number>) => {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const weld = new Map<string, number>();
  const ids = Array.from({ length: positions.length / 3 }, (_, v) => {
    const key = `${bits[v * 3]},${bits[v * 3 + 1]},${bits[v * 3 + 2]}`;
    if (!weld.has(key)) weld.set(key, weld.size);
    return weld.get(key) as number;
  });
  const uses = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3)
    for (let e = 0; e < 3; e++) {
      const a = ids[indices[i + e] as number] as number;
      const b = ids[indices[i + ((e + 1) % 3)] as number] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  const counts = [...uses.values()];
  return {
    nonManifold: counts.filter((n) => n > 2).length,
    boundary: counts.filter((n) => n === 1).length,
  };
};

describe('Mesh LOD topology across material sections', () => {
  it('keeps every level free of new non-manifold edges and open boundaries', async () => {
    const fixture = lodRegionFixture;
    const position = decode(fixture.positionsBase64, Float32Array);
    const indices = Uint32Array.from(decode(fixture.indicesBase64, Uint16Array));
    const attributes = { position };
    let offset = 0;
    const submeshes = fixture.sections.map(([indexCount, materialSlot]) => {
      const submesh = {
        indexOffset: offset,
        indexCount,
        vertexCount: position.length / 3,
        topology: 'triangle-list' as const,
        materialSlot,
      };
      offset += indexCount;
      return submesh;
    });
    const source = {
      kind: 'mesh' as const,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, position.length / 3).unwrap().vertices,
      indices,
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      submeshes,
      materialSlots: fixture.slots,
    };
    const base = edgeCounts(position, indices);
    expect(base.nonManifold).toBe(0);
    const levels = fixture.levels.map((level, i) => ({ ...level, mesh: guid(i + 1) }));
    const result = (
      await generateMeshLods(source, { levels, maxError: fixture.maxError })
    ).unwrap();
    for (const mesh of result.meshes) {
      const counts = edgeCounts(
        mesh.attributes.position as Float32Array,
        mesh.indices as Uint32Array,
      );
      expect(counts.nonManifold).toBe(0);
      expect(counts.boundary).toBeLessThanOrEqual(base.boundary);
    }
  });
});
