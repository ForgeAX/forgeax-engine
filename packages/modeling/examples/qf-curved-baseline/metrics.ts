// Hole-boundary metrics of a quadrangulated shape, measured on the emitted mesh in 3D.
import { pcurvePoint } from '../../src/brep/curves.ts';
import { faceLoops } from '../../src/brep/faces.ts';
import type { QuadResult } from '../../src/brep/quad.ts';
import { surfacePoint } from '../../src/brep/surfaces.ts';
import type { Shape } from '../../src/brep/types.ts';

type V3 = readonly [number, number, number];

const ORTHO_TOL = Math.sin((10 * Math.PI) / 180);
const MATCH = 1e-7;

export interface HoleBoundaryMetrics {
  /** Hole-boundary edges whose adjacent face is a quad, over all hole-boundary edges. */
  readonly coverage: number;
  /** Share of boundary quads whose two radial sides are within 10 degrees of perpendicular to the loop. */
  readonly rowOnly: number;
  /** Same test over every face on a hole boundary; a triangle never counts as orthogonal. */
  readonly allBoundary: number;
  readonly boundaryEdges: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Mesh vertices of the holed faces' patch boundary that sit on a hole loop, grouped as boundary edges. */
export function holeBoundaryMetrics(shape: Shape, result: QuadResult): HoleBoundaryMetrics {
  const mesh = result.mesh;
  const holeMarks: V3[] = [];
  const holedFaces: number[] = [];
  shape.faces.forEach((face, f) => {
    const { holes } = faceLoops(shape, f);
    if (holes.length === 0) return;
    holedFaces.push(f);
    const surface = shape.surfaces[face.surface];
    if (surface === undefined) return;
    for (const hole of holes)
      for (const c of hole) {
        const co = shape.coedges[c];
        const e = co === undefined ? undefined : shape.edges[co.edge];
        if (co === undefined || e === undefined) continue;
        for (const t of [e.t0, e.t1]) {
          const uv = pcurvePoint(co.pcurve, t);
          holeMarks.push(surfacePoint(surface, uv[0], uv[1]));
        }
      }
  });
  const onMark = (p: V3): boolean => holeMarks.some((m) => len(sub(p, m)) < MATCH);

  let boundaryEdges = 0;
  let quadEdges = 0;
  let rowGood = 0;
  let rowCount = 0;
  let allGood = 0;
  let allCount = 0;
  for (const f of holedFaces) {
    const range = result.faceRanges[f] as readonly [number, number];
    const faces: number[] = [];
    for (let m = range[0]; m < range[1]; m++) if (mesh.isFaceAlive(m)) faces.push(m);
    const edgeUse = new Map<string, number>();
    const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
    for (const m of faces) {
      const vs = mesh.faceVertices(m);
      vs.forEach((a, k) => {
        const b = vs[(k + 1) % vs.length] as number;
        edgeUse.set(key(a, b), (edgeUse.get(key(a, b)) ?? 0) + 1);
      });
    }
    // A patch-boundary edge belongs to a hole when its connected boundary chain reaches a hole marker.
    const adj = new Map<number, number[]>();
    for (const [k, n] of edgeUse) {
      if (n !== 1) continue;
      const [a, b] = k.split(',').map(Number) as [number, number];
      adj.set(a, [...(adj.get(a) ?? []), b]);
      adj.set(b, [...(adj.get(b) ?? []), a]);
    }
    const holeVertex = new Set<number>();
    const seen = new Set<number>();
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const comp: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length > 0) {
        const v = stack.pop() as number;
        comp.push(v);
        for (const w of adj.get(v) ?? [])
          if (!seen.has(w)) {
            seen.add(w);
            stack.push(w);
          }
      }
      if (comp.some((v) => onMark(mesh.position(v) as V3))) for (const v of comp) holeVertex.add(v);
    }
    for (const m of faces) {
      const vs = mesh.faceVertices(m);
      const n = vs.length;
      const onLoop = vs.map((v) => holeVertex.has(v));
      for (let k = 0; k < n; k++) {
        const a = vs[k] as number;
        const b = vs[(k + 1) % n] as number;
        if (!(onLoop[k] && onLoop[(k + 1) % n] && edgeUse.get(key(a, b)) === 1)) continue;
        boundaryEdges++;
        if (n !== 4) {
          allCount++;
          continue;
        }
        quadEdges++;
        const pa = mesh.position(a) as V3;
        const pb = mesh.position(b) as V3;
        const c = vs[(k + 2) % n] as number;
        const d = vs[(k + 3) % n] as number;
        const tangentAt = (v: number, toward: V3): V3 => {
          const nb = (adj.get(v) ?? []).map((w) => mesh.position(w) as V3);
          const own = mesh.position(v) as V3;
          let t = unit(sub(toward, own));
          for (const q of nb) {
            const dq = sub(q, own);
            if (dot(dq, sub(toward, own)) < 0) t = unit(sub(t, unit(dq)));
          }
          return t;
        };
        const side = (v: number, other: number, toward: V3): boolean => {
          const s = unit(sub(mesh.position(other) as V3, mesh.position(v) as V3));
          return Math.abs(dot(tangentAt(v, toward), s)) <= ORTHO_TOL;
        };
        const ok = side(a, d, pb) && side(b, c, pa);
        rowCount++;
        allCount++;
        if (ok) {
          rowGood++;
          allGood++;
        }
      }
    }
  }
  return {
    coverage: boundaryEdges === 0 ? 0 : quadEdges / boundaryEdges,
    rowOnly: rowCount === 0 ? 0 : rowGood / rowCount,
    allBoundary: allCount === 0 ? 0 : allGood / allCount,
    boundaryEdges,
  };
}

export interface ValenceReport {
  /** Vertices by edge valence, over the whole closed mesh. */
  readonly histogram: Readonly<Record<string, number>>;
  /** Vertices whose valence is not 4. */
  readonly singularities: number;
}

/** Edge valence of every mesh vertex; a closed all-quad mesh has only valence-4 points besides its singularities. */
export function valenceReport(result: QuadResult): ValenceReport {
  const mesh = result.mesh;
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    const set = neighbours.get(a) ?? new Set<number>();
    set.add(b);
    neighbours.set(a, set);
  };
  for (let f = 0; f < mesh.faceCount; f++) {
    const vs = mesh.faceVertices(f);
    vs.forEach((v, k) => {
      const w = vs[(k + 1) % vs.length] as number;
      link(v, w);
      link(w, v);
    });
  }
  const histogram: Record<string, number> = {};
  let singularities = 0;
  for (const set of neighbours.values()) {
    histogram[String(set.size)] = (histogram[String(set.size)] ?? 0) + 1;
    if (set.size !== 4) singularities++;
  }
  return { histogram, singularities };
}

export interface QuadShapeReport {
  /** Largest angle in degrees between the corner normals of any one quad (0 for a planar quad). */
  readonly twistMaxDeg: number;
  /** Largest longest-edge over shortest-edge ratio of any quad. */
  readonly aspectMax: number;
}

/** Twist and aspect of every quad of the emitted mesh, measured in 3D (triangles are skipped). */
export function quadShapeReport(result: QuadResult): QuadShapeReport {
  const mesh = result.mesh;
  let twist = 0;
  let aspect = 0;
  for (let f = 0; f < mesh.faceCount; f++) {
    if (!mesh.isFaceAlive(f)) continue;
    const vs = mesh.faceVertices(f).map((v) => mesh.position(v) as V3);
    if (vs.length !== 4) continue;
    const cornerNormal = (k: number): V3 => {
      const a = sub(vs[(k + 1) % 4] as V3, vs[k] as V3);
      const b = sub(vs[(k + 3) % 4] as V3, vs[k] as V3);
      return unit([
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ]);
    };
    const normals = [0, 1, 2, 3].map(cornerNormal);
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++)
        twist = Math.max(
          twist,
          (Math.acos(Math.min(1, dot(normals[a] as V3, normals[b] as V3))) * 180) / Math.PI,
        );
    const edges = [0, 1, 2, 3].map((k) => len(sub(vs[(k + 1) % 4] as V3, vs[k] as V3)));
    aspect = Math.max(aspect, Math.max(...edges) / Math.min(...edges));
  }
  return { twistMaxDeg: twist, aspectMax: aspect };
}
