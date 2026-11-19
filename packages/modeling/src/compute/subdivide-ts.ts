import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll, replaceAll } from '../arrays';
import { creaseWeights, edgeSharpness, withCrease } from '../crease';
import { type ModelingError, modelingError } from '../errors';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { faceCentroid, type Tuple3 } from '../geom';
import { type CornerChannelName, EDGE_SHARP, EditMesh, NONE } from '../mesh';
import { TS_BACKEND_IDENTITY } from './boolean-ts';
import type {
  BackendOutput,
  ComputeBackend,
  ComputeJobKind,
  ComputeJobRequest,
  SubdivideJobParams,
  SubdivisionBoundary,
  SubdivisionScheme,
  WorkMeter,
} from './job';

/**
 * Faces after `levels` refinements: every selected n-gon becomes n quads, later levels
 * multiply by four; unselected faces stay one face. Infinity once it passes `limit`.
 */
export function subdividedFaceCount(
  corners: number,
  untouched: number,
  levels: number,
  limit: number,
): number {
  let faces = corners;
  for (let level = 1; level < levels; level++) {
    faces *= 4;
    if (faces + untouched > limit) return Infinity;
  }
  return faces + untouched;
}

interface Level {
  readonly mesh: EditMesh;
  /** Output face id -> input face id of this level. */
  readonly parent: Int32Array;
  /** Per output face id: refine it at the next level. */
  readonly selected: Uint8Array;
  /** Crease sharpness per output edge id (0 smooth, Infinity infinitely sharp). */
  readonly sharp: Float64Array;
}

function average(points: readonly Tuple3[]): Tuple3 {
  const c: Tuple3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return [c[0] / points.length, c[1] / points.length, c[2] / points.length];
}

/**
 * Catmull-Clark vertex rule with DeRose semi-sharp creases. `sharp` holds every edge's
 * sharpness; with only infinite creases the result is the classic rule (corner at three or
 * more, crease rule at two, interior rule at none or one). A finite crease blends the
 * rules: smooth to crease by the second-largest sharpness, crease to corner by the third,
 * each clamped to 0..1, so a crease of sharpness s is a full crease for s - 1 levels and
 * blends on the last one. A vertex next to an unselected face is pinned so the unselected
 * faces only gain collinear edge points.
 */
function vertexPoint(
  mesh: EditMesh,
  v: number,
  corners: readonly number[],
  selected: Uint8Array,
  facePoint: Map<number, Tuple3>,
  boundary: SubdivisionBoundary,
  sharp: Float64Array,
): Tuple3 {
  const p = mesh.position(v);
  const edges = new Set<number>();
  for (const h of corners) {
    if ((selected[mesh.hFace[h] as number] as number) === 0) return p;
    edges.add(h >> 1);
    edges.add((mesh.hPrev[h] as number) >> 1);
  }
  const creases = [...edges]
    .filter((e) => (sharp[e] as number) > 0)
    .sort((x, y) => (sharp[y] as number) - (sharp[x] as number) || x - y);
  const boundaryCorner =
    boundary === 'edgeAndCorner' &&
    corners.length === 1 &&
    creases.length === 2 &&
    creases.every((e) => mesh.isBoundaryEdge(e));
  if (boundaryCorner) return p;
  const { crease: a, corner: b } = creaseWeights(creases.map((e) => sharp[e] as number));
  if (b >= 1) return p;
  const creaseRule = (): Tuple3 => {
    const [x, y] = creases.slice(0, 2).map((e) => {
      const [i, j] = mesh.edgeVertices(e);
      return mesh.position(i === v ? j : i);
    }) as [Tuple3, Tuple3];
    return [
      (x[0] + 6 * p[0] + y[0]) / 8,
      (x[1] + 6 * p[1] + y[1]) / 8,
      (x[2] + 6 * p[2] + y[2]) / 8,
    ];
  };
  if (a >= 1 && b <= 0) return creaseRule();
  const smoothRule = (): Tuple3 => {
    const n = edges.size;
    const q = average(corners.map((h) => facePoint.get(mesh.hFace[h] as number) as Tuple3));
    const r = average(
      [...edges].map((e) => {
        const [x, y] = mesh.edgeVertices(e);
        return average([mesh.position(x), mesh.position(y)]);
      }),
    );
    return [
      (q[0] + 2 * r[0] + (n - 3) * p[0]) / n,
      (q[1] + 2 * r[1] + (n - 3) * p[1]) / n,
      (q[2] + 2 * r[2] + (n - 3) * p[2]) / n,
    ];
  };
  if (a <= 0) return smoothRule();
  const smooth = a < 1 ? smoothRule() : ([0, 0, 0] as Tuple3);
  const crease = a > b ? creaseRule() : ([0, 0, 0] as Tuple3);
  return [0, 1, 2].map((k) => {
    const x = (1 - a) * (smooth[k] as number);
    const y = (a - b) * (crease[k] as number);
    return x + y + b * (p[k] as number);
  }) as Tuple3;
}

function cornerAverage(
  mesh: EditMesh,
  name: CornerChannelName,
  halves: readonly number[],
): number[] {
  const dim = mesh.channel(name).dim;
  const out = new Array<number>(dim).fill(0);
  for (const h of halves) {
    const value = mesh.corner(name, h) as Float32Array;
    for (let k = 0; k < dim; k++) out[k] = (out[k] as number) + (value[k] as number);
  }
  return out.map((x) => x / halves.length);
}

/** One refinement of the selected faces; corner values interpolate linearly. */
function refine(
  mesh: EditMesh,
  selected: Uint8Array,
  scheme: SubdivisionScheme,
  boundary: SubdivisionBoundary,
  sharp: Float64Array,
): Result<Level, ModelingError> {
  const out = new EditMesh();
  pushAll(out.tagNames, mesh.tagNames);
  replaceAll(out.labelNames, mesh.labelNames);
  replaceAll(out.roleNames, mesh.roleNames);
  replaceAll(out.materialNames, mesh.materialNames);
  out.reserveTagWords(mesh.tagWords);
  const faces = mesh.faces();
  const facePoint = new Map<number, Tuple3>();
  for (const f of faces) if ((selected[f] as number) !== 0) facePoint.set(f, faceCentroid(mesh, f));
  const cornersOf = new Map<number, number[]>();
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const v = mesh.hVert[h] as number;
      const list = cornersOf.get(v);
      if (list === undefined) cornersOf.set(v, [h]);
      else list.push(h);
    }
  }
  const vertexOf = new Map<number, number>();
  for (const v of mesh.vertices()) {
    const corners = cornersOf.get(v);
    if (corners === undefined) continue;
    const p =
      scheme === 'simple'
        ? mesh.position(v)
        : vertexPoint(mesh, v, corners, selected, facePoint, boundary, sharp);
    vertexOf.set(v, out.addVertex(...p));
  }
  const edgeOf = new Map<number, number>();
  for (const e of mesh.edges()) {
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    const sa = fa !== NONE && (selected[fa] as number) !== 0;
    const sb = fb !== NONE && (selected[fb] as number) !== 0;
    if (!sa && !sb) continue;
    const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v)) as [Tuple3, Tuple3];
    const hardness = Math.min(1, sharp[e] as number);
    const smooth = scheme === 'catmullClark' && sa && sb && hardness < 1;
    const middle = average([a, b]);
    const full = smooth
      ? average([a, b, facePoint.get(fa) as Tuple3, facePoint.get(fb) as Tuple3])
      : middle;
    const p: Tuple3 =
      smooth && hardness > 0
        ? [
            (1 - hardness) * full[0] + hardness * middle[0],
            (1 - hardness) * full[1] + hardness * middle[1],
            (1 - hardness) * full[2] + hardness * middle[2],
          ]
        : full;
    edgeOf.set(e, out.addVertex(...p));
  }
  const centerOf = new Map<number, number>();
  for (const [f, p] of facePoint) centerOf.set(f, out.addVertex(...p));
  const parent: number[] = [];
  const next: number[] = [];
  const channels = [...mesh.channels.keys()];
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const at = (h: number) => vertexOf.get(mesh.hVert[h] as number) as number;
    if ((selected[f] as number) !== 0) {
      const full = channels.filter((name) =>
        halves.every((h) => mesh.corner(name, h) !== undefined),
      );
      const center = full.map((name) => cornerAverage(mesh, name, halves));
      for (const h of halves) {
        const prev = mesh.hPrev[h] as number;
        const nextHalf = mesh.hNext[h] as number;
        const added = out.addFace([
          at(h),
          edgeOf.get(h >> 1) as number,
          centerOf.get(f) as number,
          edgeOf.get(prev >> 1) as number,
        ]);
        if (!added.ok) return refineFailure(added.error, f);
        const g = added.value;
        mesh.copyFaceAttributesTo(f, out, g);
        parent[g] = f;
        next[g] = 1;
        const to = out.faceHalves(g);
        for (const [i, name] of full.entries()) {
          out.setCorner(name, to[0] as number, mesh.corner(name, h) as Float32Array);
          out.setCorner(name, to[1] as number, cornerAverage(mesh, name, [h, nextHalf]));
          out.setCorner(name, to[2] as number, center[i] as number[]);
          out.setCorner(name, to[3] as number, cornerAverage(mesh, name, [prev, h]));
        }
      }
      continue;
    }
    const loop: number[] = [];
    const values: { name: CornerChannelName; half: number; value: ArrayLike<number> }[] = [];
    for (const h of halves) {
      values.push(
        ...channels
          .filter((name) => mesh.corner(name, h) !== undefined)
          .map((name) => ({
            name,
            half: loop.length,
            value: mesh.corner(name, h) as Float32Array,
          })),
      );
      loop.push(at(h));
      const split = edgeOf.get(h >> 1);
      if (split === undefined) continue;
      const nextHalf = mesh.hNext[h] as number;
      values.push(
        ...channels
          .filter((name) => [h, nextHalf].every((x) => mesh.corner(name, x) !== undefined))
          .map((name) => ({
            name,
            half: loop.length,
            value: cornerAverage(mesh, name, [h, nextHalf]),
          })),
      );
      loop.push(split);
    }
    const added = out.addFace(loop);
    if (!added.ok) return refineFailure(added.error, f);
    const g = added.value;
    mesh.copyFaceAttributesTo(f, out, g);
    parent[g] = f;
    next[g] = 0;
    const to = out.faceHalves(g);
    for (const { name, half, value } of values) out.setCorner(name, to[half] as number, value);
  }
  const childSharp = new Float64Array(out.eFlags.length);
  for (const e of mesh.edges()) {
    const flags = mesh.eFlags[e] as number;
    const s = sharp[e] as number;
    if (flags === 0 && s <= 0) continue;
    const [a, b] = mesh.edgeVertices(e).map((v) => vertexOf.get(v) as number) as [number, number];
    const split = edgeOf.get(e);
    const pieces: [number, number][] =
      split === undefined
        ? [[a, b]]
        : [
            [a, split],
            [split, b],
          ];
    const next = split === undefined || scheme === 'simple' ? s : Math.max(0, s - 1);
    const childFlags =
      split === undefined || scheme === 'simple' || (flags & EDGE_SHARP) === 0
        ? flags
        : withCrease(flags, next);
    for (const [x, y] of pieces) {
      const h = out.findHalf(x, y);
      if (h === NONE) continue;
      out.eFlags[h >> 1] = childFlags;
      childSharp[h >> 1] = next;
    }
  }
  return ok({
    mesh: out,
    parent: Int32Array.from(parent),
    selected: Uint8Array.from(next),
    sharp: childSharp,
  });
}

function refineFailure(cause: ModelingError, face: number): Result<never, ModelingError> {
  return err(
    modelingError(
      'model-degenerate',
      'every refined face is a valid manifold face',
      { face, cause: cause.code },
      'the input repeats a vertex in a face or overlaps itself; run m.validate() first',
    ),
  );
}

function runSubdivide(
  request: ComputeJobRequest<'subdivide'>,
  work: WorkMeter,
): Result<BackendOutput<'subdivide'>, ModelingError> {
  const params: SubdivideJobParams = request.params;
  const decoded = decodeSnapshot(request.inputs[0] as Uint8Array);
  if (!decoded.ok) return decoded;
  let mesh = decoded.value;
  const inputFaces = mesh.faces();
  let selected: Uint8Array = new Uint8Array(mesh.faceHighWater);
  if (params.faces === 'all') selected.fill(1);
  else for (const i of params.faces) selected[inputFaces[i] as number] = 1;
  let corners = 0;
  for (const f of inputFaces) if ((selected[f] as number) !== 0) corners += mesh.fLen[f] as number;
  const untouched = inputFaces.filter((f) => (selected[f] as number) === 0).length;
  const estimate = subdividedFaceCount(corners, untouched, params.levels, Infinity);
  // Each output face costs a handful of units at every level; reserve the total up front.
  if (!work.spend(estimate * 4)) return err(work.failure as ModelingError);
  const indexOf = new Map(inputFaces.map((f, i) => [f, i]));
  let origin = new Int32Array(mesh.faceHighWater);
  for (const f of inputFaces) origin[f] = indexOf.get(f) as number;
  const fallback = params.creaseSharpness ?? Infinity;
  let sharp: Float64Array = new Float64Array(mesh.eFlags.length);
  for (const e of mesh.edges()) sharp[e] = edgeSharpness(mesh, e, fallback);
  for (let level = 0; level < params.levels; level++) {
    const step = refine(mesh, selected, params.scheme, params.boundary, sharp);
    if (!step.ok) return step;
    const refined = step.value;
    const composed = new Int32Array(refined.parent.length);
    for (let g = 0; g < refined.parent.length; g++) {
      composed[g] = origin[refined.parent[g] as number] as number;
    }
    origin = composed;
    mesh = refined.mesh;
    selected = refined.selected;
    sharp = refined.sharp;
  }
  const { faceMap } = mesh.compact();
  const face = new Int32Array(mesh.faceCount).fill(NONE);
  for (const f of mesh.faces()) face[faceMap[f] as number] = origin[f] as number;
  return ok({
    status: 'ok',
    outputs: [encodeSnapshot(mesh)],
    provenance: [{ face }],
    metrics: {
      inputFaces: inputFaces.length,
      refinedFaces: inputFaces.length - untouched,
      outputFaces: mesh.faceCount,
      outputVertices: mesh.vertexCount,
    },
    locations: [],
  });
}

/** TS baseline of the `subdivide` job: Catmull-Clark (infinite and DeRose semi-sharp creases) or Simple. */
export const tsSubdivideBackend: ComputeBackend = {
  name: 'ts',
  identity: TS_BACKEND_IDENTITY,
  supports: (kind: ComputeJobKind) => kind === 'subdivide',
  quality: () => 'baseline',
  run<K extends ComputeJobKind>(
    request: ComputeJobRequest<K>,
    work: WorkMeter,
  ): Result<BackendOutput<K>, ModelingError> {
    return runSubdivide(request as ComputeJobRequest<'subdivide'>, work) as Result<
      BackendOutput<K>,
      ModelingError
    >;
  },
};
