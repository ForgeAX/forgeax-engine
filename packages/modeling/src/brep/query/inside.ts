import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../../errors';
import { surfaceInverse, surfaceNormal } from '../surfaces';
import { brepError, type Coedge, type Face, type Shape, type Surface } from '../types';
import { add3, dot3, type P3, scale3 } from '../vec';
import type { Closest } from './distance';

export function closedShells(shape: Shape): boolean {
  const uses = new Uint8Array(shape.edges.length);
  for (const co of shape.coedges) uses[co.edge] = Math.min(255, (uses[co.edge] as number) + 1);
  return shape.edges.every((e, i) => (e.curve < 0 ? uses[i] === 1 : uses[i] === 2));
}

function outwardNormal(shape: Shape, f: number, u: number, v: number): P3 {
  const face = shape.faces[f] as Face;
  const n = surfaceNormal(shape.surfaces[face.surface] as Surface, u, v);
  return face.reversed ? scale3(n, -1) : n;
}

function facesOfEdge(shape: Shape, edge: number): number[] {
  const out: number[] = [];
  shape.faces.forEach((face, f) => {
    for (const l of face.loops)
      for (const c of (shape.loops[l] as Shape['loops'][number]).coedges)
        if ((shape.coedges[c] as Coedge).edge === edge) out.push(f);
  });
  return out;
}

const noNormal = (reason: string, expected: string): Result<never, ModelingError> =>
  err(brepError('brep-tol-exceeded', expected, { reason }));

/**
 * Whether `p` lies inside the closed shape, given its nearest point `near` on the surface: the sign
 * of `(p - foot) . n` at the nearest feature, using the face normal or the edge pseudo-normal (the
 * sum of its two faces' normals). A vertex foot, a seam or an open edge fails closed.
 */
export function insideAt(shape: Shape, p: P3, near: Closest): Result<boolean, ModelingError> {
  const { foot } = near;
  const away: P3 = [p[0] - foot.point[0], p[1] - foot.point[1], p[2] - foot.point[2]];
  if (foot.kind === 'face')
    return ok(dot3(away, outwardNormal(shape, foot.id, foot.u, foot.v)) < 0);
  const wanted = 'a nearest feature with a well-defined normal';
  if (foot.kind === 'vertex') return noNormal('containment-vertex-foot', wanted);
  const e = shape.edges[foot.id];
  if (e === undefined || e.curve < 0 || foot.t <= e.t0 || foot.t >= e.t1)
    return noNormal('containment-vertex-foot', wanted);
  const adjacent = facesOfEdge(shape, foot.id);
  if (adjacent.length !== 2)
    return noNormal('containment-open-edge', 'an edge shared by two faces');
  const normals = adjacent.map((f) => {
    const q = surfaceInverse(
      shape.surfaces[(shape.faces[f] as Face).surface] as Surface,
      foot.point,
    );
    return outwardNormal(shape, f, q.u, q.v);
  });
  return ok(dot3(away, add3(normals[0] as P3, normals[1] as P3)) < 0);
}
