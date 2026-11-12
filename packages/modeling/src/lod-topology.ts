import {
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

export interface LodTopology {
  readonly lod: number;
  /** Connected chains of boundary edges (edges with exactly one triangle). */
  readonly freeChains: number;
  /** Edges shared by more than two triangles. */
  readonly nonManifoldEdges: number;
  /** Whether this LOD's boundary edges, by welded position pair, are LOD0's. */
  readonly boundarySetEqualsLod0: boolean;
}

function positionsOf(mesh: MeshAsset): Float32Array | undefined {
  const direct = mesh.attributes.position;
  if (direct instanceof Float32Array) return direct;
  const unpacked = unpackInterleavedVertexAttributes(
    mesh.vertices,
    deriveVertexLayoutProjection(mesh.attributes),
  );
  const position = unpacked?.position;
  return position instanceof Float32Array ? position : undefined;
}

/** Triangle-list corners as ids of bitwise-equal positions, shared across every LOD. */
function weldedTriangles(lods: readonly MeshAsset[]): { ids: Uint32Array[]; count: number } {
  const byBits = new Map<string, number>();
  let count = 0;
  const idOf = (key: string): number => {
    let id = byBits.get(key);
    if (id === undefined) {
      id = count++;
      byBits.set(key, id);
    }
    return id;
  };
  const ids = lods.map((mesh, lod) => {
    const position = positionsOf(mesh);
    const bits =
      position === undefined
        ? undefined
        : new Uint32Array(position.buffer, position.byteOffset, position.length);
    const corners: number[] = [];
    const indices = mesh.indices ?? [];
    for (const submesh of mesh.submeshes) {
      if (submesh.topology !== 'triangle-list') continue;
      const end = submesh.indexOffset + submesh.indexCount - (submesh.indexCount % 3);
      for (let i = submesh.indexOffset; i < end; i++) {
        const v = indices[i] as number;
        const at = v * 3;
        corners.push(
          bits !== undefined && at + 2 < bits.length
            ? idOf(`${bits[at]},${bits[at + 1]},${bits[at + 2]}`)
            : idOf(`missing:${lod}:${v}`),
        );
      }
    }
    return Uint32Array.from(corners);
  });
  return { ids, count };
}

/**
 * Topology of each LOD after welding bitwise-equal positions, so seams that only split
 * vertices (normals, UVs, sections) stay closed. The boundary set of LOD0 is the designed
 * set every other LOD is compared against.
 */
export function lodTopologyReport(lods: readonly MeshAsset[]): LodTopology[] {
  const { ids, count } = weldedTriangles(lods);
  let designed: Set<number> | undefined;
  return ids.map((corners, lod) => {
    const uses = new Map<number, number>();
    for (let t = 0; t + 2 < corners.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = corners[t + k] as number;
        const b = corners[t + ((k + 1) % 3)] as number;
        if (a === b) continue;
        const key = Math.min(a, b) * count + Math.max(a, b);
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    const boundary = new Set<number>();
    let nonManifoldEdges = 0;
    for (const [key, n] of uses) {
      if (n === 1) boundary.add(key);
      else if (n > 2) nonManifoldEdges++;
    }
    designed ??= boundary;
    return {
      lod,
      freeChains: chainCount(boundary, count),
      nonManifoldEdges,
      boundarySetEqualsLod0:
        boundary.size === designed.size && [...boundary].every((key) => designed?.has(key)),
    };
  });
}

function chainCount(boundary: ReadonlySet<number>, count: number): number {
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let root = v;
    for (let p = parent.get(root); p !== undefined && p !== root; p = parent.get(root)) root = p;
    for (let node = v; node !== root; ) {
      const next = parent.get(node) as number;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const key of boundary) {
    const a = Math.floor(key / count);
    const b = key % count;
    for (const v of [a, b]) if (!parent.has(v)) parent.set(v, v);
    parent.set(find(a), find(b));
  }
  let chains = 0;
  for (const v of parent.keys()) if (find(v) === v) chains++;
  return chains;
}
