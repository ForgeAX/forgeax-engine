import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from '../arrays';
import { atan2 } from '../dmath';
import type { ModelingError } from '../errors';
import { measureContinuity } from './continuity';
import type { QuadResult } from './quad';
import type { Shape } from './types';
import { cross3, dot3, len3, type P3, sub3 } from './vec';

/**
 * How well quad rows run through the tangent-continuous (G1 / G2) seams of a quad layout. At every mesh vertex on a
 * seam between two faces whose shared B-rep edges are all tangent-continuous, with exactly two seam neighbours and one
 * cross edge into each face (valence 4), the row crosses the seam when both cross edges are within `maxAngleDeg` of
 * perpendicular to the seam. (Collinearity of the two chords is no test: a chord of a coarse arc bends away from its
 * tangent by half the step angle, so that bend is only reported as `maxBendDeg`.) Other seam vertices are counted, not judged: `ends` (chain ends, junctions, corners) and `irregular`
 * (valence other than 4). Pairs that also share a sharp or open edge are `mixedPairs` and skipped whole.
 */
export interface G1RowContinuity {
  /** Face pairs sharing at least one tangent-continuous edge. */
  readonly pairs: number;
  readonly mixedPairs: number;
  readonly seamVertices: number;
  readonly regular: number;
  readonly continued: number;
  readonly irregular: number;
  readonly ends: number;
  /** `continued / regular`; 1 when no vertex was judged. */
  readonly fraction: number;
  /** Largest deviation of a cross edge from perpendicular to its seam over the judged vertices, degrees. */
  readonly maxPerpDeg: number;
  /** Largest bend between the two cross edges (0 = collinear) over the judged vertices, degrees; informational. */
  readonly maxBendDeg: number;
}

const RAD_TO_DEG = 57.29577951308232;

export function g1RowContinuity(
  shape: Shape,
  result: QuadResult,
  maxAngleDeg = 10,
): Result<G1RowContinuity, ModelingError> {
  const report = measureContinuity(shape);
  if (!report.ok) return err(report.error);
  const gradesByPair = new Map<string, { tangent: number; other: number }>();
  for (const e of report.value.edges) {
    if (e.seam) continue;
    const key = `${minOf(e.faces)},${maxOf(e.faces)}`;
    const row = gradesByPair.get(key) ?? { tangent: 0, other: 0 };
    if (e.grade === 'G1' || e.grade === 'G2') row.tangent++;
    else row.other++;
    gradesByPair.set(key, row);
  }
  const mesh = result.mesh;
  const owner = new Map<number, number>();
  result.faceRanges.forEach((range, f) => {
    for (let m = range[0]; m < range[1]; m++) if (mesh.isFaceAlive(m)) owner.set(m, f);
  });
  // Per undirected mesh edge: the brep face of each mesh face using it.
  const edgeFaces = new Map<string, number[]>();
  const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [m, f] of owner) {
    const vs = mesh.faceVertices(m);
    vs.forEach((a, k) => {
      const b = vs[(k + 1) % vs.length] as number;
      const k2 = key(a, b);
      const list = edgeFaces.get(k2);
      if (list === undefined) edgeFaces.set(k2, [f]);
      else list.push(f);
    });
  }
  const neighbours = new Map<number, number[]>();
  for (const k2 of edgeFaces.keys()) {
    const [a, b] = k2.split(',').map(Number) as [number, number];
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const out = {
    pairs: 0,
    mixedPairs: 0,
    seamVertices: 0,
    regular: 0,
    continued: 0,
    irregular: 0,
    ends: 0,
    maxPerp: 0,
    maxBend: 0,
  };
  const seamVerts = new Map<string, Set<number>>();
  for (const [k2, faces] of edgeFaces) {
    if (faces.length !== 2 || faces[0] === faces[1]) continue;
    const a = Math.min(faces[0] as number, faces[1] as number);
    const b = Math.max(faces[0] as number, faces[1] as number);
    const pair = gradesByPair.get(`${a},${b}`);
    if (pair === undefined || pair.tangent === 0 || pair.other > 0) continue;
    const set = seamVerts.get(`${a},${b}`) ?? new Set<number>();
    for (const v of k2.split(',').map(Number)) set.add(v);
    seamVerts.set(`${a},${b}`, set);
  }
  for (const [pair, row] of gradesByPair) {
    if (row.tangent === 0) continue;
    if (row.other > 0) out.mixedPairs++;
    else if (seamVerts.has(pair)) out.pairs++;
  }
  for (const [pair, verts] of seamVerts) {
    const [a, b] = pair.split(',').map(Number) as [number, number];
    for (const v of verts) {
      out.seamVertices++;
      const seam: number[] = [];
      const acrossA: number[] = [];
      const acrossB: number[] = [];
      let broken = false;
      for (const w of neighbours.get(v) ?? []) {
        const faces = edgeFaces.get(key(v, w)) as number[];
        const onA = faces.filter((f) => f === a).length;
        const onB = faces.filter((f) => f === b).length;
        if (onA === 1 && onB === 1) seam.push(w);
        else if (onA === 2) acrossA.push(w);
        else if (onB === 2) acrossB.push(w);
        else broken = true;
      }
      if (broken || seam.length !== 2) {
        out.ends++;
        continue;
      }
      if (acrossA.length !== 1 || acrossB.length !== 1) {
        out.irregular++;
        continue;
      }
      const p = mesh.position(v) as P3;
      const da = sub3(mesh.position(acrossA[0] as number) as P3, p);
      const db = sub3(mesh.position(acrossB[0] as number) as P3, p);
      const la = len3(da);
      const lb = len3(db);
      out.regular++;
      if (la === 0 || lb === 0) continue;
      const bend = atan2(len3(cross3(da, db)), -dot3(da, db)) * RAD_TO_DEG;
      const t = sub3(
        mesh.position(seam[0] as number) as P3,
        mesh.position(seam[1] as number) as P3,
      );
      const perp = (d: P3): number => atan2(Math.abs(dot3(d, t)), len3(cross3(d, t))) * RAD_TO_DEG;
      const worst = Math.max(perp(da), perp(db));
      out.maxPerp = Math.max(out.maxPerp, worst);
      out.maxBend = Math.max(out.maxBend, bend);
      if (worst <= maxAngleDeg) out.continued++;
    }
  }
  return ok({
    pairs: out.pairs,
    mixedPairs: out.mixedPairs,
    seamVertices: out.seamVertices,
    regular: out.regular,
    continued: out.continued,
    irregular: out.irregular,
    ends: out.ends,
    fraction: out.regular === 0 ? 1 : out.continued / out.regular,
    maxPerpDeg: out.maxPerp,
    maxBendDeg: out.maxBend,
  });
}
