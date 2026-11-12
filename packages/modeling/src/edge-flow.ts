import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import { faceArea, faceCentroid, faceNormal, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import { curveCurvature, domain } from './nurbs';
import type { Issue } from './report';
import type { FeatureLine } from './surface-quality';

/**
 * Edge-flow check: whether the mesh's edges follow the feature
 * lines, how regular its faces are, and where its triangles and poles sit. Measured on
 * the editable n-gon mesh (the quads a subdivision or a modeler sees), not on its export
 * triangulation.
 */
/**
 * Least share of a line its counterpart must cover by default (an edge loop for a feature
 * line, a session feature line for a drawn one).
 * @internal
 */
export const LINE_COVERAGE = 0.98;

export interface EdgeFlowOptions {
  /** Faces to measure (default all). */
  readonly faces?: readonly number[];
  /** Largest distance from a feature line for an edge to lie on it (default 5e-4 m). */
  readonly tolerance?: number;
  /** Least share of a feature line's length its edge loop must cover (default 0.98). */
  readonly coverage?: number;
  /** Largest face aspect ratio (default 4). */
  readonly maxAspect?: number;
  /** Largest size ratio between faces sharing an edge (default 2). */
  readonly maxSizeRatio?: number;
  /**
   * The cells a trim cuts (tag `trim`: along a blend's seam, a hole, a shut line) take their
   * shape from the cut, so they are judged as their own group: largest aspect (default 8) and
   * size ratio to a neighbour (default 4).
   */
  readonly maxTrimAspect?: number;
  readonly maxTrimSizeRatio?: number;
  /** Located examples kept per finding (default 16). */
  readonly limit?: number;
}

export interface Distribution {
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  /** Values above the limit. */
  readonly over: number;
  readonly limit: number;
}

export interface FeatureLoop {
  readonly name: string;
  readonly length: number;
  /** Share of the line covered by mesh edges lying on it. */
  readonly coverage: number;
  readonly edges: number;
  /** Connected chains those edges form (one for a continuous loop). */
  readonly chains: number;
  /** Uncovered stretches: normalized arc-length range and a point in it. */
  readonly gaps: readonly { readonly range: readonly [number, number]; readonly point: Tuple3 }[];
  readonly pass: boolean;
}

export type EdgeFlowCode =
  | 'feature-loop'
  | 'aspect'
  | 'size-ratio'
  | 'trim-aspect'
  | 'trim-size-ratio'
  | 'triangles'
  | 'poles';

export interface EdgeFlowReport {
  readonly pass: boolean;
  readonly faces: number;
  readonly quads: number;
  readonly triangles: number;
  readonly ngons: number;
  readonly aspect: Distribution;
  readonly sizeRatio: Distribution;
  /** The trim-cut cells' own group (`maxTrimAspect`, `maxTrimSizeRatio`): their count and shapes. */
  readonly trim: {
    readonly faces: number;
    readonly triangles: number;
    readonly aspect: Distribution;
    readonly sizeRatio: Distribution;
  };
  /** Interior vertices of valence other than 4 and boundary vertices above 3, by valence. */
  readonly poles: { readonly count: number; readonly byValence: Readonly<Record<string, number>> };
  readonly featureLoops: readonly FeatureLoop[];
  /** `warn` fails the edge flow; `info` records triangles and poles. */
  readonly issues: readonly Issue<EdgeFlowCode>[];
}

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Tuple3) => Math.sqrt(dot(a, a));

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

/** Aspect ratio of a face: the ratio of the principal extents of its corners in its plane. */
export function faceAspect(points: readonly Tuple3[], normal: Tuple3): number {
  const helper: Tuple3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1u: Tuple3 = [
    normal[1] * helper[2] - normal[2] * helper[1],
    normal[2] * helper[0] - normal[0] * helper[2],
    normal[0] * helper[1] - normal[1] * helper[0],
  ];
  const l = len(e1u);
  const e1: Tuple3 = [e1u[0] / l, e1u[1] / l, e1u[2] / l];
  const e2: Tuple3 = [
    normal[1] * e1[2] - normal[2] * e1[1],
    normal[2] * e1[0] - normal[0] * e1[2],
    normal[0] * e1[1] - normal[1] * e1[0],
  ];
  const n = points.length;
  let cx = 0;
  let cy = 0;
  const xy = points.map((p) => {
    const x = dot(p, e1);
    const y = dot(p, e2);
    cx += x / n;
    cy += y / n;
    return [x, y] as const;
  });
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of xy) {
    sxx += (x - cx) * (x - cx);
    syy += (y - cy) * (y - cy);
    sxy += (x - cx) * (y - cy);
  }
  const mean = (sxx + syy) / 2;
  const root = Math.sqrt(((sxx - syy) / 2) * ((sxx - syy) / 2) + sxy * sxy);
  const small = mean - root;
  return small > 0 ? Math.sqrt((mean + root) / small) : Infinity;
}

function distribution(values: number[], limit: number): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length === 0 ? 0 : (sorted[Math.floor(q * (sorted.length - 1))] as number);
  return {
    max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
    p50: at(0.5),
    p95: at(0.95),
    over: sorted.filter((v) => v > limit).length,
    limit,
  };
}

const round = (p: Tuple3): Tuple3 => [
  Math.round(p[0] * 1e6) / 1e6,
  Math.round(p[1] * 1e6) / 1e6,
  Math.round(p[2] * 1e6) / 1e6,
];

/** How well mesh edges trace one feature line. */
function featureLoop(
  mesh: EditMesh,
  edges: readonly number[],
  line: FeatureLine,
  tolerance: number,
  minimum: number,
  limit: number,
): FeatureLoop {
  const [t0, t1] = domain(line.curve);
  const count = 512;
  const points: Tuple3[] = [];
  const arc: number[] = [];
  for (let k = 0; k <= count; k++) {
    const p = curveCurvature(line.curve, t0 + ((t1 - t0) * k) / count).point;
    arc.push(k === 0 ? 0 : (arc[k - 1] as number) + len(sub(p, points[k - 1] as Tuple3)));
    points.push(p);
  }
  const length = arc[count] as number;
  // Segments hashed on a grid of cells at least as large as a segment and the tolerance.
  const cell = Math.max(length / count, tolerance) * 2;
  const key = (p: Tuple3) =>
    `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  const grid = new Map<string, number[]>();
  for (let k = 0; k < count; k++) {
    const a = points[k] as Tuple3;
    const b = points[k + 1] as Tuple3;
    for (const p of [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as Tuple3]) {
      const list = grid.get(key(p)) ?? [];
      if (!list.includes(k)) list.push(k);
      grid.set(key(p), list);
    }
  }
  /** Arc length of the closest line point within the tolerance, if any. */
  const project = (p: Tuple3): number | undefined => {
    let best: { d: number; s: number } | undefined;
    const [ix, iy, iz] = [
      Math.floor(p[0] / cell),
      Math.floor(p[1] / cell),
      Math.floor(p[2] / cell),
    ];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const k of grid.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? []) {
            const a = points[k] as Tuple3;
            const ab = sub(points[k + 1] as Tuple3, a);
            const l2 = dot(ab, ab);
            const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
            const d = len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
            if (d <= tolerance && (best === undefined || d < best.d))
              best = {
                d,
                s: (arc[k] as number) + t * ((arc[k + 1] as number) - (arc[k] as number)),
              };
          }
    return best?.s;
  };
  const on: number[] = [];
  const intervals: [number, number][] = [];
  for (const e of edges) {
    const [a, b] = mesh.edgeVertices(e);
    const sa = project(mesh.position(a));
    if (sa === undefined) continue;
    const sb = project(mesh.position(b));
    if (sb === undefined) continue;
    // The edge runs along the line: its length matches the arc it spans.
    const l = len(sub(mesh.position(b), mesh.position(a)));
    if (Math.abs(sb - sa) < 0.9 * l - tolerance) continue;
    on.push(e);
    intervals.push([Math.min(sa, sb), Math.max(sa, sb)]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  const gaps: FeatureLoop['gaps'][number][] = [];
  let covered = 0;
  let reach = 0;
  const gap = (from: number, to: number) => {
    if (to - from <= tolerance) return;
    if (gaps.length < limit) {
      const mid = (from + to) / 2;
      const k = Math.max(
        0,
        arc.findIndex((s) => s >= mid),
      );
      gaps.push({ range: [from / length, to / length], point: round(points[k] as Tuple3) });
    }
  };
  for (const [from, to] of intervals) {
    if (from > reach) gap(reach, from);
    if (to > reach) {
      covered += to - Math.max(from, reach);
      reach = to;
    }
  }
  if (reach < length) gap(reach, length);
  // Chains: edges on the line connected through shared vertices.
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as number;
    parent.set(v, r);
    return r;
  };
  for (const e of on) {
    const [a, b] = mesh.edgeVertices(e);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const chains = new Set([...parent.keys()].map(find)).size;
  const coverage = length > 0 ? covered / length : 0;
  return {
    name: line.name,
    length,
    coverage,
    edges: on.length,
    chains,
    gaps,
    pass: coverage >= minimum && chains === 1,
  };
}

/** Measure edge flow on `faces` of `mesh` against the feature lines. */
export function checkEdgeFlow(
  mesh: EditMesh,
  lines: readonly FeatureLine[],
  options: EdgeFlowOptions = {},
): Result<EdgeFlowReport, ModelingError> {
  const tolerance = options.tolerance ?? 5e-4;
  const minimum = options.coverage ?? LINE_COVERAGE;
  const maxAspect = options.maxAspect ?? 4;
  const maxSizeRatio = options.maxSizeRatio ?? 2;
  const maxTrimAspect = options.maxTrimAspect ?? 8;
  const maxTrimSizeRatio = options.maxTrimSizeRatio ?? 4;
  const limit = options.limit ?? 16;
  for (const [name, v] of Object.entries({
    tolerance,
    maxAspect,
    maxSizeRatio,
    maxTrimAspect,
    maxTrimSizeRatio,
  }))
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0))
      return err(invalid(`${name} is positive`, { [name]: v }));
  if (!(minimum > 0 && minimum <= 1))
    return err(invalid('coverage is in (0, 1]', { coverage: minimum }));
  if (!(Number.isInteger(limit) && limit >= 0))
    return err(invalid('limit is a non-negative integer', { limit }));
  const faces = options.faces ?? mesh.faces();
  const inside = new Set(faces);
  // Support strips are thin by design (subdivision support loops, blend bands): no shape
  // limits, and their triangles and poles are not counted.
  const supportTag = mesh.tagNames.indexOf('support');
  const thin = (f: number) => supportTag >= 0 && mesh.hasTag(f, supportTag);
  const trimTag = mesh.tagNames.indexOf('trim');
  const cut = (f: number) => !thin(f) && trimTag >= 0 && mesh.hasTag(f, trimTag);
  const trimAspects: number[] = [];
  const trimRatios: number[] = [];
  const worstTrimAspect: { face: number; value: number; point: Tuple3 }[] = [];
  const worstTrimRatio: { faces: [number, number]; value: number; point: Tuple3 }[] = [];
  let trimFaces = 0;
  let trimTriangles = 0;
  const issues: Issue<EdgeFlowCode>[] = [];
  const aspects: number[] = [];
  const worstAspect: { face: number; value: number; point: Tuple3 }[] = [];
  const area = new Map<number, number>();
  let quads = 0;
  let triangles = 0;
  let ngons = 0;
  const triangleAt: { face: number; point: Tuple3 }[] = [];
  for (const f of faces) {
    const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
    if (cut(f)) {
      trimFaces++;
      if (loop.length === 3) trimTriangles++;
    }
    if (loop.length === 3) {
      if (!thin(f) && !cut(f)) {
        triangles++;
        if (triangleAt.length < limit)
          triangleAt.push({ face: f, point: round(faceCentroid(mesh, f)) });
      }
    } else if (loop.length === 4) quads++;
    else ngons++;
    area.set(f, faceArea(mesh, f));
    if (thin(f)) continue;
    const aspect = faceAspect(loop, faceNormal(mesh, f));
    const [values, bound, worst] = cut(f)
      ? [trimAspects, maxTrimAspect, worstTrimAspect]
      : [aspects, maxAspect, worstAspect];
    values.push(aspect);
    if (aspect > bound) worst.push({ face: f, value: aspect, point: round(faceCentroid(mesh, f)) });
  }
  const ratios: number[] = [];
  const worstRatio: { faces: [number, number]; value: number; point: Tuple3 }[] = [];
  const valence = new Map<number, number>();
  const boundary = new Set<number>();
  const supported = new Set<number>();
  const edges: number[] = [];
  for (const e of mesh.edges()) {
    const fa = mesh.hFace[2 * e] as number;
    const fb = mesh.hFace[2 * e + 1] as number;
    if (!inside.has(fa) && !inside.has(fb)) continue;
    edges.push(e);
    const [a, b] = mesh.edgeVertices(e);
    if (thin(fa) || thin(fb) || cut(fa) || cut(fb)) {
      supported.add(a);
      supported.add(b);
    }
    valence.set(a, (valence.get(a) ?? 0) + 1);
    valence.set(b, (valence.get(b) ?? 0) + 1);
    if (!(inside.has(fa) && inside.has(fb))) {
      boundary.add(a);
      boundary.add(b);
      continue;
    }
    if (thin(fa) || thin(fb)) continue;
    const ra = area.get(fa) as number;
    const rb = area.get(fb) as number;
    const ratio = Math.sqrt(Math.max(ra, rb) / Math.max(Math.min(ra, rb), 1e-300));
    const trimmed = cut(fa) || cut(fb);
    (trimmed ? trimRatios : ratios).push(ratio);
    if (ratio > (trimmed ? maxTrimSizeRatio : maxSizeRatio)) {
      const pa = mesh.position(a);
      const pb = mesh.position(b);
      (trimmed ? worstTrimRatio : worstRatio).push({
        faces: [fa, fb],
        value: ratio,
        point: round([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]),
      });
    }
  }
  const byValence: Record<string, number> = {};
  const poleAt: { vertex: number; valence: number; point: Tuple3 }[] = [];
  let poles = 0;
  for (const [v, n] of [...valence].sort((x, y) => x[0] - y[0])) {
    const pole = boundary.has(v) ? n > 3 : n !== 4;
    if (!pole || supported.has(v)) continue;
    poles++;
    byValence[String(n)] = (byValence[String(n)] ?? 0) + 1;
    if (poleAt.length < limit)
      poleAt.push({ vertex: v, valence: n, point: round(mesh.position(v)) });
  }
  const loops = lines.map((line) => featureLoop(mesh, edges, line, tolerance, minimum, limit));
  for (const loop of loops)
    if (!loop.pass)
      issues.push({
        code: 'feature-loop',
        severity: 'warn',
        detail: {
          line: loop.name,
          coverage: loop.coverage,
          chains: loop.chains,
          gaps: loop.gaps,
          ...(loop.gaps[0] === undefined ? {} : { point: loop.gaps[0].point }),
        },
      });
  const byValue = <T extends { value: number }>(list: T[]) =>
    list.sort((x, y) => y.value - x.value).slice(0, limit);
  const aspect = distribution(aspects, maxAspect);
  if (aspect.over > 0) {
    const worst = byValue(worstAspect);
    issues.push({
      code: 'aspect',
      severity: 'warn',
      detail: {
        over: aspect.over,
        limit: maxAspect,
        worst,
        faces: worst.map((w) => w.face),
        point: worst[0]?.point,
      },
    });
  }
  const sizeRatio = distribution(ratios, maxSizeRatio);
  if (sizeRatio.over > 0) {
    const worst = byValue(worstRatio);
    issues.push({
      code: 'size-ratio',
      severity: 'warn',
      detail: {
        over: sizeRatio.over,
        limit: maxSizeRatio,
        worst,
        faces: worst.flatMap((w) => w.faces),
        point: worst[0]?.point,
      },
    });
  }
  const trimAspect = distribution(trimAspects, maxTrimAspect);
  const trimSizeRatio = distribution(trimRatios, maxTrimSizeRatio);
  for (const [code, d, worstList, bound] of [
    ['trim-aspect', trimAspect, worstTrimAspect, maxTrimAspect],
    ['trim-size-ratio', trimSizeRatio, worstTrimRatio, maxTrimSizeRatio],
  ] as const) {
    if (d.over === 0) continue;
    const worst = byValue([...worstList] as { value: number; point: Tuple3 }[]);
    issues.push({
      code,
      severity: 'warn',
      detail: { over: d.over, limit: bound, worst, point: worst[0]?.point },
    });
  }
  if (triangles > 0)
    issues.push({
      code: 'triangles',
      severity: 'info',
      detail: { count: triangles, at: triangleAt, faces: triangleAt.map((t) => t.face) },
    });
  if (poles > 0)
    issues.push({
      code: 'poles',
      severity: 'info',
      detail: { count: poles, byValence, at: poleAt, vertices: poleAt.map((p) => p.vertex) },
    });
  return ok({
    pass: issues.every((i) => i.severity === 'info'),
    faces: faces.length,
    quads,
    triangles,
    ngons,
    aspect,
    sizeRatio,
    trim: {
      faces: trimFaces,
      triangles: trimTriangles,
      aspect: trimAspect,
      sizeRatio: trimSizeRatio,
    },
    poles: { count: poles, byValence },
    featureLoops: loops,
    issues,
  });
}
