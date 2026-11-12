import {
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

export interface WeldedTopology {
  readonly freeEdges: number;
  readonly nonManifoldEdges: number;
  readonly components: number;
}

/**
 * Re-weld an exported buffer at distance 0 (bitwise-equal f32 positions, -0 equal to 0) and
 * count its edges: used once = free, used more than twice = non-manifold; components join
 * triangles that share a welded vertex. Independent of the kernel's own counting.
 */
export function reweldTopology(mesh: MeshAsset): WeldedTopology {
  const attributes = unpackInterleavedVertexAttributes(
    mesh.vertices,
    deriveVertexLayoutProjection(mesh.attributes),
  ) as unknown as Record<string, Float32Array>;
  const position = attributes.position as Float32Array;
  const indices = mesh.indices as ArrayLike<number>;
  const ids = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < position.length / 3; i++) {
    const key = [0, 1, 2].map((c) => (position[i * 3 + c] as number) + 0).join(',');
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    welded.push(id);
  }
  const parent = Array.from({ length: ids.size }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  const uses = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [0, 1, 2].map((k) => welded[indices[t + k] as number] as number);
    for (let k = 0; k < 3; k++) {
      const a = tri[k] as number;
      const b = tri[(k + 1) % 3] as number;
      parent[find(a)] = find(b);
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let freeEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of uses.values()) {
    if (count === 1) freeEdges++;
    else if (count > 2) nonManifoldEdges++;
  }
  const used = new Set<number>();
  for (let t = 0; t < indices.length; t++) used.add(find(welded[indices[t] as number] as number));
  return { freeEdges, nonManifoldEdges, components: used.size };
}
