import { type EditMesh, NONE } from './mesh';

export interface Crossing {
  readonly face: number;
  readonly entry: number;
  readonly exit: number;
}

/**
 * Walk the edge ring through `seed`: across every even-sided face the ring leaves
 * by the opposite edge; odd-sided faces, boundaries and the start edge end it.
 */
export function edgeRing(
  mesh: EditMesh,
  seed: number,
): { edges: Set<number>; crossings: Crossing[] } {
  const edges = new Set<number>([seed]);
  const crossings: Crossing[] = [];
  for (const start of [seed * 2, seed * 2 + 1]) {
    let h = start;
    for (;;) {
      const f = mesh.hFace[h] as number;
      if (f === NONE) break;
      const n = mesh.fLen[f] as number;
      if (n % 2 !== 0) break;
      let o = h;
      for (let i = 0; i < n / 2; i++) o = mesh.hNext[o] as number;
      if (crossings.some((c) => c.face === f)) break;
      crossings.push({ face: f, entry: h, exit: o });
      if (edges.has(o >> 1)) break;
      edges.add(o >> 1);
      h = o ^ 1;
    }
  }
  return { edges, crossings };
}

/**
 * Walk the edge loop through `seed`: at every vertex with exactly four edges the
 * loop continues along the edge that shares no face with the incoming one; other
 * valences, boundaries and the start edge end it.
 */
export function edgeLoop(mesh: EditMesh, seed: number): Set<number> {
  const edges = new Set<number>([seed]);
  for (const start of [seed * 2, seed * 2 + 1]) {
    let h = start;
    for (;;) {
      const next = straightAcross(mesh, h);
      if (next === NONE || edges.has(next >> 1)) break;
      edges.add(next >> 1);
      h = next;
    }
  }
  return edges;
}

/**
 * The half-edge leaving the end vertex of `h` straight across from `h`: around an
 * interior vertex the outgoing halves follow twin(prev(out)); at valence four the
 * continuation is two steps from the incoming edge. Boundary vertices and other
 * valences return NONE.
 */
function straightAcross(mesh: EditMesh, h: number): number {
  const first = h ^ 1;
  const ring = [first];
  let out = first;
  for (;;) {
    if ((mesh.hFace[out] as number) === NONE) return NONE;
    out = (mesh.hPrev[out] as number) ^ 1;
    if (out === first) break;
    ring.push(out);
    if (ring.length > 4) return NONE;
  }
  return ring.length === 4 ? (ring[2] as number) : NONE;
}
