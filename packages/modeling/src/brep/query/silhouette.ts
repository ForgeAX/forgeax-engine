import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../../arrays';
import type { ModelingError } from '../../errors';
import { curvePoint } from '../curves';
import { surfaceInverse, surfaceNormal, surfacePoint } from '../surfaces';
import { brepError, type Coedge, type Edge, type Shape, type Surface } from '../types';
import { dot3, len3, type P3, scale3, sub3 } from '../vec';
import { contourFace, type FaceCurve } from './contour';
import { type JoinedCurve, stitch } from './stitch';
import { trimIndexOf } from './trim-index';

/** An orthographic view along `direction` (from the viewer into the scene) or a perspective eye. */
export type Camera =
  | { readonly kind: 'orthographic'; readonly direction: P3 }
  | { readonly kind: 'perspective'; readonly eye: P3 };

export interface SilhouetteOptions {
  readonly resolution?: number;
  /** Samples per edge when classifying and emitting edge silhouettes (default 24). */
  readonly edgeSamples?: number;
}

export interface Silhouette {
  /** Smooth contours (the surface turns edge-on) joined across faces. */
  readonly contours: readonly JoinedCurve[];
  /** Edges whose two faces face opposite ways, and open boundary edges; polylines on the edge. */
  readonly edges: readonly (readonly P3[])[];
  /** Largest |n . view| at a contour vertex (near rounding: the vertices are bisected onto the contour). */
  readonly residual: number;
}

function outward(shape: Shape, f: number, p: P3): P3 {
  const face = shape.faces[f] as Shape['faces'][number];
  const surface = shape.surfaces[face.surface] as Surface;
  const q = surfaceInverse(surface, p);
  const n = surfaceNormal(surface, q.u, q.v);
  return face.reversed ? scale3(n, -1) : n;
}

/** Direction from the viewer to `p`. */
function viewOf(camera: Camera, p: P3): P3 {
  return camera.kind === 'orthographic' ? camera.direction : sub3(p, camera.eye);
}

export function silhouette(
  shape: Shape,
  camera: Camera,
  options: SilhouetteOptions = {},
): Result<Silhouette, ModelingError> {
  const vec = camera.kind === 'orthographic' ? camera.direction : camera.eye;
  if (!vec.every(Number.isFinite) || (camera.kind === 'orthographic' && !(len3(vec) > 1e-12)))
    return err(
      brepError('brep-bad-argument', 'a finite camera with a non-zero direction', {
        reason: 'silhouette-camera',
      }),
    );
  const res = options.resolution ?? 64;
  const samples = options.edgeSamples ?? 24;
  const curves: FaceCurve[] = [];
  let residual = 0;
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Shape['faces'][number];
    const surface = shape.surfaces[face.surface] as Surface;
    if (surface.kind === 'plane') continue;
    const trim = trimIndexOf(shape, f);
    if (!trim.ok) return trim;
    const facing = (u: number, v: number): number => {
      const p = surfacePoint(surface, u, v);
      const w = viewOf(camera, p);
      const n = surfaceNormal(surface, u, v);
      return dot3(n, w) / (len3(w) || 1);
    };
    const c = contourFace(f, surface, trim.value, facing, res, 0);
    pushAll(curves, c.curves);
    residual = Math.max(residual, c.residual);
  }

  const users = new Map<number, number[]>();
  const uses = new Uint8Array(shape.edges.length);
  shape.faces.forEach((face, f) => {
    for (const l of face.loops)
      for (const c of (shape.loops[l] as Shape['loops'][number]).coedges) {
        const e = (shape.coedges[c] as Coedge).edge;
        uses[e] = Math.min(255, (uses[e] as number) + 1);
        const list = users.get(e);
        if (list === undefined) users.set(e, [f]);
        else if (!list.includes(f)) list.push(f);
      }
  });
  const edges: P3[][] = [];
  shape.edges.forEach((edge: Edge, e) => {
    if (edge.curve < 0) return;
    const curve = shape.curves[edge.curve] as Shape['curves'][number];
    const faces = users.get(e) ?? [];
    const mid = curvePoint(curve, (edge.t0 + edge.t1) / 2);
    const side = (f: number): number => dot3(outward(shape, f, mid), viewOf(camera, mid));
    const open = uses[e] === 1;
    const turns = faces.length === 2 && side(faces[0] as number) * side(faces[1] as number) < 0;
    if (!open && !turns) return;
    edges.push(
      Array.from({ length: samples + 1 }, (_, i) =>
        curvePoint(curve, edge.t0 + ((edge.t1 - edge.t0) * i) / samples),
      ),
    );
  });
  return ok({
    contours: stitch(curves, Math.max(shape.tol, 1e-6)),
    edges,
    residual,
  });
}
