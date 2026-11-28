import type { Coedge, Face, Loop, Shape } from './types';

/** One use of an edge by a face loop. `sense` is the traversal sense of the edge as seen from outside the solid. */
export interface EdgeUse {
  readonly coedge: number;
  readonly face: number;
  readonly loop: number;
  readonly sense: boolean;
}

/** Per edge, the uses by faces in coedge order; coedges outside every face loop are ignored. */
export function edgeUses(shape: Shape): EdgeUse[][] {
  const uses = shape.edges.map(() => [] as EdgeUse[]);
  shape.faces.forEach((f: Face, face) => {
    for (const l of f.loops) {
      for (const c of (shape.loops[l] as Loop).coedges) {
        const co = shape.coedges[c] as Coedge;
        (uses[co.edge] as EdgeUse[]).push({
          coedge: c,
          face,
          loop: l,
          sense: co.reversed !== f.reversed,
        });
      }
    }
  });
  return uses;
}

/** The shell index of every face. */
export function shellOfFaces(shape: Shape): number[] {
  const out = new Array<number>(shape.faces.length).fill(-1);
  shape.shells.forEach((s, i) => {
    for (const f of s.faces) out[f] = i;
  });
  return out;
}

/** Per vertex, the distinct edges that end at it (a closed edge is listed once). */
export function vertexEdges(shape: Shape): number[][] {
  const out = shape.vertices.map(() => [] as number[]);
  shape.edges.forEach((e, i) => {
    (out[e.v0] as number[]).push(i);
    if (e.v1 !== e.v0) (out[e.v1] as number[]).push(i);
  });
  return out;
}
