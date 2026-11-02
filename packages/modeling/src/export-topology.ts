import type { EditMesh } from './mesh';

/** Edge and shell counts of a mesh after welding positions at distance 0. */
export interface ExportTopology {
  /** Welded edges used by exactly one face. */
  readonly freeEdges: number;
  /** Welded edges used by more than two faces. */
  readonly nonManifoldEdges: number;
  /** Groups of faces connected through welded vertices. */
  readonly components: number;
}

/**
 * Topology of `faces` with vertices merged when their f32 positions are bitwise equal (-0
 * equals 0): the identity a renderer-side re-weld of the exported buffer sees, whatever
 * vertex ids the source used. Edges collapsed to a point by the weld are ignored.
 */
export function weldedTopology(mesh: EditMesh, faces: readonly number[]): ExportTopology {
  const ids = new Map<string, number>();
  const weldedOf = new Map<number, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  const weld = (v: number): number => {
    let id = weldedOf.get(v);
    if (id !== undefined) return id;
    const p = mesh.position(v);
    const key = `${Math.fround(p[0]) + 0},${Math.fround(p[1]) + 0},${Math.fround(p[2]) + 0}`;
    id = ids.get(key);
    if (id === undefined) {
      id = parent.length;
      parent.push(id);
      ids.set(key, id);
    }
    weldedOf.set(v, id);
    return id;
  };
  const uses = new Map<string, number>();
  const used = new Set<number>();
  for (const f of faces) {
    const loop = mesh.faceVertices(f).map(weld);
    for (const [k, a] of loop.entries()) {
      const b = loop[(k + 1) % loop.length] as number;
      used.add(a);
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
  return {
    freeEdges,
    nonManifoldEdges,
    components: new Set([...used].map(find)).size,
  };
}
