import type { EditMesh } from '../mesh';
import type { P3 } from './vec';

/** Damping and sweeps for the owned-vertex Laplacian; fixed so the result is deterministic. */
export const RELAX_WEIGHT = 0.5;
export const RELAX_SWEEPS = 40;

/**
 * Laplacian relaxation of the interior vertices one split-3 face owns. Only ids in `owned` move: ring,
 * shared-edge and midpoint ids stay exactly where their neighbours put them. The move is fail-closed:
 * the original positions are returned unless the relaxed quads keep every scaled Jacobian positive and
 * the face's minimum does not drop.
 */
export function relaxOwned(
  quads: readonly (readonly [number, number, number, number])[],
  owned: readonly number[],
  position: (id: number) => P3,
  scaledJacobian: (p: readonly P3[]) => number,
): Map<number, P3> {
  const ownedSet = new Set(owned);
  const neighbours = new Map<number, Set<number>>();
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      const a = q[i] as number;
      const b = q[(i + 1) % 4] as number;
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      if (!neighbours.has(b)) neighbours.set(b, new Set());
      neighbours.get(a)?.add(b);
      neighbours.get(b)?.add(a);
    }
  }
  const original = new Map<number, P3>();
  for (const v of neighbours.keys()) original.set(v, position(v));
  const current = new Map(original);
  for (let sweep = 0; sweep < RELAX_SWEEPS; sweep++) {
    const next = new Map(current);
    for (const v of ownedSet) {
      const ns = neighbours.get(v);
      if (ns === undefined || ns.size === 0) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const n of ns) {
        const p = current.get(n) as P3;
        sx += p[0];
        sy += p[1];
        sz += p[2];
      }
      const c = current.get(v) as P3;
      const k = ns.size;
      next.set(v, [
        RELAX_WEIGHT * c[0] + (1 - RELAX_WEIGHT) * (sx / k),
        RELAX_WEIGHT * c[1] + (1 - RELAX_WEIGHT) * (sy / k),
        RELAX_WEIGHT * c[2] + (1 - RELAX_WEIGHT) * (sz / k),
      ]);
    }
    for (const [v, p] of next) current.set(v, p);
  }
  const minOf = (pos: Map<number, P3>): number => {
    let m = Infinity;
    for (const q of quads) m = Math.min(m, scaledJacobian(q.map((v) => pos.get(v) as P3)));
    return m;
  };
  const before = minOf(original);
  const after = minOf(current);
  if (!(after > 0) || after < before) return new Map();
  const moved = new Map<number, P3>();
  for (const v of ownedSet) moved.set(v, current.get(v) as P3);
  return moved;
}

/**
 * Relaxes each source face's interior vertices. A vertex is interior to face k when every quad that
 * uses it was emitted for face k (faceRanges gives each source face's contiguous mesh-face range).
 * Its move is judged with the quads of face k only, under the fail-closed rule in relaxOwned. Vertices
 * shared with another source face, and any vertex on the mesh boundary, never move.
 */
export function relaxSingleFaceVertices(
  mesh: EditMesh,
  faceRanges: readonly [number, number][],
  scaledJacobian: (p: readonly P3[]) => number,
): void {
  const boundaryVerts = new Set<number>();
  for (const e of mesh.edges()) {
    if (!mesh.isBoundaryEdge(e)) continue;
    const [a, b] = mesh.edgeVertices(e) as [number, number];
    boundaryVerts.add(a);
    boundaryVerts.add(b);
  }
  const ownerOf = new Map<number, number>();
  const shared = new Set<number>();
  faceRanges.forEach(([lo, hi], k) => {
    for (let f = lo; f < hi; f++) {
      if (!mesh.isFaceAlive(f)) continue;
      for (const v of mesh.faceVertices(f)) {
        const prev = ownerOf.get(v);
        if (prev === undefined) ownerOf.set(v, k);
        else if (prev !== k) shared.add(v);
      }
    }
  });
  faceRanges.forEach(([lo, hi]) => {
    const quads: [number, number, number, number][] = [];
    for (let f = lo; f < hi; f++) {
      if (!mesh.isFaceAlive(f)) continue;
      const v = mesh.faceVertices(f);
      if (v.length === 4) quads.push([v[0], v[1], v[2], v[3]] as [number, number, number, number]);
    }
    const owned = [...new Set(quads.flat())].filter(
      (v) => !shared.has(v) && !boundaryVerts.has(v) && ownerOf.get(v) !== undefined,
    );
    if (quads.length === 0 || owned.length === 0) return;
    const moved = relaxOwned(quads, owned, (id) => mesh.position(id) as P3, scaledJacobian);
    for (const [id, p] of moved) mesh.setPosition(id, p[0], p[1], p[2]);
  });
}
