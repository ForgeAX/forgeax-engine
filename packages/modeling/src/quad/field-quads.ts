import { minOf } from '../arrays';
// M-QF5b: the constrained cross field drives a loop-aligned quad network on one trimmed NURBS (or
// plane) face. Opt-in mesher path, narrower than the integer-grid chain (M-QF8):
//   1. `constrainedFaceField` gives the 4-RoSy field of the face: loop-parallel in a no-singularity
//      zone beside every trim loop, singularities kept out of that zone.
//   2. The trim loops are sampled once (even count per loop, shared ids) and `rows` layers of quads are
//      peeled from every loop with the row-front of the exact quad mesher. The field there is loop
//      parallel, so those rows are the field's integral lines (streamlines) beside the loops.
//   3. The region inside the last layer is triangulated (CDT) and paired into quads by a minimum-cost
//      perfect matching whose pair cost adds the field misalignment of the quad's four edges.
// The interior lattice is not a field-aligned grid: its triangle edges come from the CDT, the field
// only chooses among them. A lattice that follows the field through singularities is M-QF8.

import { err, ok, type Result } from '@forgeax/engine-types';
import { pcurvePoint } from '../brep/curves';
import { faceLoops } from '../brep/faces';
import { scaledJacobian } from '../brep/quad';
import { rowFrontInner } from '../brep/quad-row';
import {
  quadrangulateTrimmed,
  type TrimmedQuadFailure,
  type TrimmedQuadOptions,
} from '../brep/quad-trimmed';
import { surfacePoint } from '../brep/surfaces';
import type { TrimRing } from '../brep/tessellate-trimmed';
import type { Coedge, Edge, Face, Shape, Surface } from '../brep/types';
import { dist3, type P2, type P3 } from '../brep/vec';
import { atan2, cos as dcos, hypot3 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { EditMesh } from '../mesh';
import {
  type ConstrainedField,
  type ConstrainedFieldOptions,
  type ConstrainedFieldReport,
  constrainedFaceField,
} from './constrained-field';

export interface FieldQuadsOptions {
  /** Passed to `constrainedFaceField` (`faces` is set to the chosen face). */
  readonly field?: Omit<ConstrainedFieldOptions, 'faces'>;
  /** Target boundary sample spacing in model units (default: the median trim-edge length). */
  readonly spacing?: number;
  /** Cap on the interior triangle edge length (default 1.5 times the boundary spacing; `Infinity` leaves the trimmer's coarse default). */
  readonly interiorSpacing?: number;
  /** Boundary quad layers peeled from every loop (default 2, at least 1). */
  readonly rows?: number;
  /** Weight of the field misalignment in the interior pair cost (default 1; 0 is the unguided baseline). */
  readonly alignmentWeight?: number;
  /** `fallback: 'triangles'` also takes over when the strict interior has a quad below this scaled Jacobian (default 0.3). */
  readonly sjFloor?: number;
  /** Cap on triangles entering the interior matching (default 1500). */
  readonly maxTriangles?: number;
  /**
   * What happens when the interior has no perfect matching (default `fail`: `model-partial`,
   * `quad-no-perfect-matching`). `triangles` keeps a maximum-cardinality set of pairs above the
   * scaled-Jacobian floor and leaves the rest as triangles (quad-dominant); `split-3` is the exact
   * mesher's all-quad fallback (every triangle into three quads).
   */
  readonly fallback?: 'triangles' | 'split-3';
}

export interface AlignmentStats {
  readonly edges: number;
  readonly mean: number;
  readonly p95: number;
  readonly max: number;
}

export interface FieldQuadsReport {
  readonly quads: number;
  readonly triangles: number;
  readonly rowQuads: number;
  readonly interiorQuads: number;
  readonly rowsPeeled: number;
  /** The interior used the quad-dominant fallback (leftover triangles). */
  readonly dominantFallback: boolean;
  readonly boundarySamples: number;
  readonly minSj: number;
  readonly meanSj: number;
  /** Interior mesh vertices whose valence (edges) is not 4. */
  readonly irregularVertices: number;
  /** Field misalignment of the network's edges, in degrees mod 90 (0 = along a field axis). */
  readonly alignment: {
    readonly all: AlignmentStats;
    readonly rows: AlignmentStats;
    /** Boundary-row edges lying on the trim loop, and the rungs across the first row. */
    readonly loopEdges: AlignmentStats;
    readonly rungs: AlignmentStats;
    readonly interior: AlignmentStats;
  };
  readonly field: ConstrainedFieldReport;
}

export interface FieldQuadsResult {
  readonly mesh: EditMesh;
  readonly field: ConstrainedField;
  readonly report: FieldQuadsReport;
  /** The first `rowQuadCount` mesh faces (in `mesh.faces()` order) are boundary-row quads. */
  readonly rowQuadCount: number;
}

type Reason =
  | 'unknown-face'
  | 'surface-kind'
  | 'shared-edge'
  | 'degenerate-edge'
  | 'loop-not-closed'
  | 'bad-spacing'
  | 'bad-rows'
  | 'bad-weight'
  | 'row-front-collision'
  | 'mesh-not-manifold'
  | `quad-${TrimmedQuadFailure['reason']}`;

function fail(reason: Reason, detail: Record<string, unknown> = {}): Result<never, ModelingError> {
  return err(
    modelingError(
      reason === 'unknown-face' ||
        reason === 'bad-spacing' ||
        reason === 'bad-rows' ||
        reason === 'bad-weight'
        ? 'model-invalid-argument'
        : 'model-partial',
      'a field-guided quad network on a trimmed face',
      { ...detail, reason } as never,
    ),
  );
}

/** Trim-ring tolerance for a loop that must close in (u, v), relative to the loop's extent. */
const CLOSE = 1e-6;
const BUDGET_POINTS = 4096;
const SJ_FLOOR = 0.3;
/** Interior edge length as a multiple of the boundary spacing: smaller meshes only pay for long CDT fans. */
const INTERIOR_FACTOR = 1.5;

/** Substeps per trim edge when a loop is read as a dense (u, v) polyline. */
const DENSE = 6;
/** A loop vertex whose polyline turns by more than this (3D, degrees) stays a sample. */
const CORNER_DEGREES = 35;

interface Dense {
  readonly uv: P2[];
  readonly xyz: P3[];
}

/** The loop as a closed (u, v) polyline (last point not repeated) and its surface points. */
function denseLoop(
  shape: Shape,
  loop: readonly number[],
  surface: Surface,
): Result<Dense, ModelingError> {
  const uv: P2[] = [];
  for (const c of loop) {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    for (let k = 0; k < DENSE; k++) {
      const t = co.reversed
        ? e.t1 - ((e.t1 - e.t0) * k) / DENSE
        : e.t0 + ((e.t1 - e.t0) * k) / DENSE;
      uv.push(pcurvePoint(co.pcurve, t));
    }
  }
  const last = shape.coedges[loop[loop.length - 1] as number] as Coedge;
  const le = shape.edges[last.edge] as Edge;
  const end = pcurvePoint(last.pcurve, last.reversed ? le.t0 : le.t1);
  const first = uv[0] as P2;
  if (Math.abs(end[0] - first[0]) > CLOSE || Math.abs(end[1] - first[1]) > CLOSE) {
    return err(modelingError('model-partial', 'a closed trim loop'));
  }
  return ok({ uv, xyz: uv.map((q) => surfacePoint(surface, q[0], q[1])) });
}

/**
 * Even number of samples at about `spacing` apart in 3D arc length, with every corner kept: the loop
 * is cut at its corners, and each smooth run between two corners is resampled uniformly.
 */
function resampleLoop(d: Dense, spacing: number): P2[] {
  const n = d.uv.length;
  const cornerAt = (i: number): boolean => {
    const a = d.xyz[(i + n - DENSE) % n] as P3;
    const b = d.xyz[i] as P3;
    const c = d.xyz[(i + DENSE) % n] as P3;
    const u: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: P3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const lu = hypot3(u[0], u[1], u[2]);
    const lv = hypot3(v[0], v[1], v[2]);
    if (lu === 0 || lv === 0) return false;
    const cosine = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
    return cosine < dcos((CORNER_DEGREES * Math.PI) / 180);
  };
  const corners: number[] = [];
  for (let i = 0; i < n; i += DENSE) if (cornerAt(i)) corners.push(i);
  const cuts = corners.length === 0 ? [0] : corners;
  const runs = cuts.map((from, k) => {
    const to = cuts[(k + 1) % cuts.length] as number;
    const pts: number[] = [from];
    for (let i = (from + 1) % n; i !== to || pts.length === 1; i = (i + 1) % n) {
      pts.push(i);
      if (i === to) break;
    }
    if (pts[pts.length - 1] !== to) pts.push(to);
    return pts;
  });
  const lengths = runs.map((idx) => {
    let sum = 0;
    for (let k = 1; k < idx.length; k++) {
      sum += dist3(d.xyz[idx[k - 1] as number] as P3, d.xyz[idx[k] as number] as P3);
    }
    return sum;
  });
  const counts = lengths.map((l) => Math.max(1, Math.round(l / spacing)));
  if (counts.reduce((a, b) => a + b, 0) % 2 !== 0) {
    let widest = 0;
    let gap = -1;
    counts.forEach((c, k) => {
      const g = (lengths[k] as number) / c;
      if (g > gap) {
        gap = g;
        widest = k;
      }
    });
    counts[widest] = (counts[widest] as number) + 1;
  }
  const out: P2[] = [];
  runs.forEach((idx, r) => {
    const cum = [0];
    for (let k = 1; k < idx.length; k++) {
      cum.push(
        (cum[k - 1] as number) +
          dist3(d.xyz[idx[k - 1] as number] as P3, d.xyz[idx[k] as number] as P3),
      );
    }
    const total = cum[cum.length - 1] as number;
    const m = counts[r] as number;
    let seg = 0;
    for (let j = 0; j < m; j++) {
      const target = (total * j) / m;
      while (seg < idx.length - 2 && (cum[seg + 1] as number) < target) seg++;
      const span = (cum[seg + 1] as number) - (cum[seg] as number);
      const w = span === 0 ? 0 : (target - (cum[seg] as number)) / span;
      const a = d.uv[idx[seg] as number] as P2;
      const b = d.uv[idx[seg + 1] as number] as P2;
      out.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
    }
  });
  return out;
}

function ringsOf(
  shape: Shape,
  f: number,
  surface: Surface,
  spacingOption: number | undefined,
  store: P3[],
): Result<{ rings: TrimRing[]; spacing: number }, ModelingError> {
  const uses = new Map<number, number>();
  for (const c of shape.coedges) uses.set(c.edge, (uses.get(c.edge) ?? 0) + 1);
  const { outer, holes } = faceLoops(shape, f);
  const loops = [outer, ...holes];
  const lengthOf = (c: number): number => {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    let sum = 0;
    let prev: P3 | undefined;
    for (let k = 0; k <= 8; k++) {
      const uv = pcurvePoint(co.pcurve, e.t0 + ((e.t1 - e.t0) * k) / 8);
      const p = surfacePoint(surface, uv[0], uv[1]);
      if (prev !== undefined) sum += dist3(prev, p);
      prev = p;
    }
    return sum;
  };
  const lengths = new Map<number, number>();
  for (const loop of loops) {
    for (const c of loop) {
      const co = shape.coedges[c] as Coedge;
      if ((shape.edges[co.edge] as Edge).curve < 0) return fail('degenerate-edge', { coedge: c });
      if ((uses.get(co.edge) ?? 0) !== 1) return fail('shared-edge', { edge: co.edge });
      lengths.set(c, lengthOf(c));
    }
  }
  const sorted = [...lengths.values()].sort((a, b) => a - b);
  const spacing = spacingOption ?? (sorted[Math.floor(sorted.length / 2)] as number);
  if (!(spacing > 0) || !Number.isFinite(spacing)) return fail('bad-spacing', { spacing });

  const rings: TrimRing[] = [];
  for (const loop of loops) {
    const dense = denseLoop(shape, loop, surface);
    if (!dense.ok) return fail('loop-not-closed', { face: f });
    const uv = resampleLoop(dense.value, spacing);
    const ids: number[] = [];
    for (const q of uv) {
      ids.push(store.length);
      store.push(surfacePoint(surface, q[0], q[1]));
    }
    rings.push({ uv, ids });
  }
  return ok({ rings, spacing });
}

/** Field lookup by nearest triangle centroid: the in-plane axes of the field at a surface point. */
function fieldProbe(field: ConstrainedField['field']): (p: P3) => { q: P3; s: P3 } {
  const m = field.mesh;
  const count = m.triangles.length / 3;
  const cen = new Float64Array(3 * count);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const v = m.triangles[3 * t + k] as number;
      for (let a = 0; a < 3; a++) {
        cen[3 * t + a] = (cen[3 * t + a] as number) + (m.positions[3 * v + a] as number) / 3;
      }
    }
  }
  return (p) => {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let t = 0; t < count; t++) {
      const dx = (cen[3 * t] as number) - p[0];
      const dy = (cen[3 * t + 1] as number) - p[1];
      const dz = (cen[3 * t + 2] as number) - p[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const q: P3 = [
      field.direction[3 * best] as number,
      field.direction[3 * best + 1] as number,
      field.direction[3 * best + 2] as number,
    ];
    const n: P3 = [
      field.normal[3 * best] as number,
      field.normal[3 * best + 1] as number,
      field.normal[3 * best + 2] as number,
    ];
    const s: P3 = [n[1] * q[2] - n[2] * q[1], n[2] * q[0] - n[0] * q[2], n[0] * q[1] - n[1] * q[0]];
    return { q, s };
  };
}

/** Angle in degrees, folded into [0, 45], between segment a->b and the nearest field axis at its midpoint. */
function misalignment(probe: (p: P3) => { q: P3; s: P3 }, a: P3, b: P3): number {
  const e: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const mid: P3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const { q, s } = probe(mid);
  const x = e[0] * q[0] + e[1] * q[1] + e[2] * q[2];
  const y = e[0] * s[0] + e[1] * s[1] + e[2] * s[2];
  const r = Math.abs(atan2(y, x)) % (Math.PI / 2);
  return ((r > Math.PI / 4 ? Math.PI / 2 - r : r) * 180) / Math.PI;
}

function stats(values: readonly number[]): AlignmentStats {
  if (values.length === 0) return { edges: 0, mean: 0, p95: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    edges: sorted.length,
    mean,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

/**
 * A quad network of one trimmed face of `shape`, guided by its constrained cross field. Fails closed
 * (`model-partial`, `detail.reason`) when the face has a shared or degenerate edge, a row layer would
 * fold, the interior has no perfect matching, or the field itself fails (passed through unchanged).
 */
export function fieldQuads(
  shape: Shape,
  face: number,
  options: FieldQuadsOptions = {},
): Result<FieldQuadsResult, ModelingError> {
  const rows = options.rows ?? 2;
  const weight = options.alignmentWeight ?? 1;
  if (!Number.isInteger(rows) || rows < 1) return fail('bad-rows', { rows });
  if (!Number.isFinite(weight) || weight < 0) return fail('bad-weight', { weight });
  const f = shape.faces[face] as Face | undefined;
  if (!Number.isInteger(face) || f === undefined) return fail('unknown-face', { face });
  const surface = shape.surfaces[f.surface] as Surface;
  if (surface.kind !== 'nurbs' && surface.kind !== 'plane') {
    return fail('surface-kind', { kind: surface.kind });
  }

  const fieldResult = constrainedFaceField(shape, { ...options.field, faces: [face] });
  if (!fieldResult.ok) return fieldResult;
  const field = fieldResult.value;
  const probe = fieldProbe(field.field);

  const store: P3[] = [];
  const base = ringsOf(shape, face, surface, options.spacing, store);
  if (!base.ok) return base;
  let rings = base.value.rings;
  const boundarySamples = rings.reduce((n, r) => n + r.uv.length, 0);
  if (boundarySamples > BUDGET_POINTS) return fail('quad-matching-too-large', { boundarySamples });

  const position = (id: number): P3 => store[id] as P3;
  const addVertex = (p: P3): number => {
    store.push(p);
    return store.length - 1;
  };

  const rowQuads: [number, number, number, number][] = [];
  let peeled = 0;
  for (let layer = 0; layer < rows; layer++) {
    const row = rowFrontInner(rings);
    if (!row.ok) {
      if (layer === 0) return fail('row-front-collision', { layer });
      break;
    }
    if (row.skipped.every(Boolean)) break;
    const next: TrimRing[] = [];
    rings.forEach((ring, r) => {
      if (row.skipped[r]) {
        next.push(ring);
        return;
      }
      const inner = row.inner[r] as readonly P2[];
      const n = ring.uv.length;
      const innerIds = inner.map((p) => addVertex(surfacePoint(surface, p[0], p[1])));
      next.push({ uv: inner, ids: innerIds });
      for (let k = 0; k < n; k++) {
        const a = ring.uv[k] as P2;
        const b = ring.uv[(k + 1) % n] as P2;
        const c = inner[(k + 1) % n] as P2;
        const quad: [number, number, number, number] = [
          ring.ids[k] as number,
          ring.ids[(k + 1) % n] as number,
          innerIds[(k + 1) % n] as number,
          innerIds[k] as number,
        ];
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        rowQuads.push(area >= 0 ? quad : [quad[3], quad[2], quad[1], quad[0]]);
      }
    });
    rings = next;
    peeled++;
  }

  const pairCost =
    weight === 0
      ? undefined
      : (corners: readonly P3[]): number => {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += misalignment(probe, corners[k] as P3, corners[(k + 1) % 4] as P3) / 45;
          }
          return (weight * sum) / 4;
        };
  const run = (extra: Partial<TrimmedQuadOptions>) =>
    quadrangulateTrimmed(surface, rings, position, addVertex, {
      angle: Math.PI / 6,
      maxPoints: BUDGET_POINTS,
      maxTriangles: options.maxTriangles ?? 1500,
      ...(pairCost === undefined ? {} : { pairCost }),
      spacing: options.interiorSpacing ?? INTERIOR_FACTOR * base.value.spacing,
      ...extra,
    });
  let built = run({
    globalMatch: true,
    ...(options.fallback === 'split-3' ? { fallback: 'split-3' as const } : {}),
  });
  let usedFallback = false;
  const interiorMinSj = (qs: readonly (readonly number[])[]): number =>
    qs.length === 0 ? 1 : minOf(qs.map((q) => scaledJacobian(q.map(position))));
  const floor = options.sjFloor ?? SJ_FLOOR;
  if (
    options.fallback === 'triangles' &&
    (built.ok
      ? interiorMinSj(built.value.quads) < floor
      : built.error.reason === 'no-perfect-matching')
  ) {
    built = run({ dominant: true, dominantSjFloor: true });
    usedFallback = true;
  }
  if (!built.ok) return fail(`quad-${built.error.reason}`, { ...built.error });

  const flip = f.reversed;
  const orient = <T extends readonly number[]>(v: T): number[] =>
    flip ? v.slice().reverse() : v.slice();
  const mesh = new EditMesh();
  const meshOf = new Map<number, number>();
  const vertex = (id: number): number => {
    let m = meshOf.get(id);
    if (m === undefined) {
      const p = position(id);
      m = mesh.addVertex(p[0], p[1], p[2]);
      meshOf.set(id, m);
    }
    return m;
  };
  const allQuads = [...rowQuads, ...built.value.quads];
  const polygons = [...allQuads, ...built.value.singles];
  for (const poly of polygons) {
    const r = mesh.addFace(orient(poly).map(vertex));
    if (!r.ok) return fail('mesh-not-manifold', { cause: r.error.code });
  }

  const sj: number[] = allQuads.map((q) => scaledJacobian(q.map(position)));
  const edgesOf = (qs: readonly (readonly number[])[]): number[] =>
    qs.flatMap((q) =>
      q.map((v, k) => misalignment(probe, position(v), position(q[(k + 1) % q.length] as number))),
    );
  const rowEdges = edgesOf(rowQuads);
  const alongLoop = rowQuads.map((q) => misalignment(probe, position(q[0]), position(q[1])));
  const rungs = rowQuads.map((q) => misalignment(probe, position(q[1]), position(q[2])));
  const interiorEdges = edgesOf([...built.value.quads, ...built.value.singles]);

  const valence = new Map<number, Set<number>>();
  const boundaryEdge = new Map<string, number>();
  for (const poly of polygons) {
    poly.forEach((v, k) => {
      const w = poly[(k + 1) % poly.length] as number;
      for (const [a, b] of [
        [v, w],
        [w, v],
      ] as const) {
        const s = valence.get(a) ?? new Set<number>();
        valence.set(a, s);
        s.add(b);
      }
      const key = v < w ? `${v}:${w}` : `${w}:${v}`;
      boundaryEdge.set(key, (boundaryEdge.get(key) ?? 0) + 1);
    });
  }
  const onBoundary = new Set<number>();
  for (const [key, n] of boundaryEdge) {
    if (n === 1) for (const v of key.split(':')) onBoundary.add(Number(v));
  }
  let irregular = 0;
  for (const [v, s] of valence) if (!onBoundary.has(v) && s.size !== 4) irregular++;

  return ok({
    mesh,
    field,
    rowQuadCount: rowQuads.length,
    report: {
      quads: allQuads.length,
      triangles: built.value.singles.length,
      rowQuads: rowQuads.length,
      interiorQuads: built.value.quads.length,
      rowsPeeled: peeled,
      dominantFallback: usedFallback,
      boundarySamples,
      minSj: sj.length === 0 ? 0 : minOf(sj),
      meanSj: sj.length === 0 ? 0 : sj.reduce((s, v) => s + v, 0) / sj.length,
      irregularVertices: irregular,
      alignment: {
        all: stats([...rowEdges, ...interiorEdges]),
        rows: stats(rowEdges),
        loopEdges: stats(alongLoop),
        rungs: stats(rungs),
        interior: stats(interiorEdges),
      },
      field: field.report,
    },
  });
}
