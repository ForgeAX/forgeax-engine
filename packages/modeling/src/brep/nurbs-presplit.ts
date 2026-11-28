import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { splitEdgeAt } from './edge-split';
import type { Coedge, Face, Loop, Shape } from './types';

/**
 * S2a: pre-split stage. Before a NURBS section is clipped, every boundary edge it crosses must
 * already have its chord endpoint as a vertex, so the clipped pieces share those vertices. Pure:
 * applies splitEdgeAt once per site, in order, and returns the new shape with the inserted vertex
 * index for each site. Because splitEdgeAt rewrites every face that uses the edge, a vertex from
 * one site is shared by all faces bounded by that edge.
 */
export interface PreSplit {
  readonly shape: Shape;
  /** Inserted vertex index for each site, in the order given. */
  readonly vertices: readonly number[];
}

export interface EdgeSiteParam {
  readonly edge: number;
  readonly t: number;
}

export function presplitEdges(
  shape: Shape,
  sites: readonly EdgeSiteParam[],
): Result<PreSplit, ModelingError> {
  let current = shape;
  const vertices: number[] = [];
  for (const s of sites) {
    const r = splitEdgeAt(current, s.edge, s.t);
    if (!r.ok) return r;
    current = r.value.shape;
    vertices.push(r.value.vertex);
  }
  return ok({ shape: current, vertices });
}

/** Faces whose outer loop uses `vertex` as a coedge endpoint. Used to check sharing. */
export function facesUsingVertex(shape: Shape, vertex: number): number[] {
  const out: number[] = [];
  shape.faces.forEach((f: Face, fi) => {
    const hit = f.loops.some((li) => {
      const loop = shape.loops[li] as Loop;
      return loop.coedges.some((ci) => {
        const co = shape.coedges[ci] as Coedge;
        const e = shape.edges[co.edge];
        return e !== undefined && (e.v0 === vertex || e.v1 === vertex);
      });
    });
    if (hit) out.push(fi);
  });
  return out;
}
