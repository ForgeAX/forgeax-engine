// R-QF baseline: how well do today's trimmed-face quads follow their trim loops? For each planar cap (a plane face whose
// vertices all share the extreme z of the part) we take the mesh boundary of the cap group as the trim loop and measure
//   - corner: at every loop vertex, the angle between the loop tangent and the nearest interior quad edge (90 is ideal);
//   - quad: for each boundary quad, both side edges within 10 degrees of perpendicular to the boundary edge;
//   - row: for each boundary quad, the opposite edge within 10 degrees of parallel to the boundary edge.
// Output: per-case JSON plus network renders under _scratch/viz-out/qf-baseline/.
// Blossom and blossom-row are all-quad contracts (#604, #611): a face whose triangle count cannot be perfectly matched fails
// closed (row-front-odd-count / no-perfect-matching). The 11-09 stamp of plate-grid3x4 (84 quads + 26 triangles) was the older
// triangle-leftover output. QF_FALLBACK=split-3 passes the opt-in fallback that closes those faces all-quad.
import { mkdirSync, writeFileSync } from 'node:fs';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import { housing } from '../../src/brep/housing.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { renderShape } from '../brep-kit/render.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';
import { kindsOf, renderKinds } from './kind-render.ts';

const outDir =
  process.env.QF_OUT ??
  new URL('../../../../_scratch/viz-out/qf-baseline/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const FALLBACK = process.env.QF_FALLBACK === 'split-3' ? ('split-3' as const) : undefined;
const TOL = (10 * Math.PI) / 180;

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error).slice(0, 300)}`);
  return r.value;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l === 0 ? a : [a[0] / l, a[1] / l, a[2] / l];
};
/** Angle in [0, pi/2] between two undirected lines. */
const lineAngle = (a: V3, b: V3) => {
  const d = Math.abs(unit(a)[0] * unit(b)[0] + unit(a)[1] * unit(b)[1] + unit(a)[2] * unit(b)[2]);
  return Math.acos(Math.min(1, d));
};
const perpErr = (a: V3, b: V3) => Math.PI / 2 - lineAngle(a, b);
const parErr = (a: V3, b: V3) => lineAngle(a, b);

interface CapStats {
  cap: string;
  quads: number;
  triangles: number;
  loopVertices: number;
  boundaryQuads: number;
  cornerMedianDevDeg: number;
  cornerWithin10: number;
  /** Chord definition: boundary-quad loop edge vs the quad's own side, both within 10 degrees of perpendicular. */
  quadOrthoChordWithin10: number;
  /** Vertex-tangent definition (bisector of the two loop edges at each corner). Acceptance metric. */
  quadOrthoVertexWithin10: number;
  /** Row-only share of boundary quads with vertex-tangent orthogonality (row quads of blossom-row). */
  rowOrthoVertexWithin10: number;
  rowOrthoVertexCount: number;
  rowParallelWithin10: number;
  worstCornerDevDeg: number;
  /** Median and worst angle (deg, 0 = along the loop, 90 = perpendicular) of the first interior edge at each loop vertex. */
  firstInteriorMedianDeg: number;
  firstInteriorWorstDeg: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function capStats(
  mesh: EditMesh,
  which: 'top' | 'bottom',
  kindOf: (f: number) => string,
): CapStats | undefined {
  const zs = mesh.vertices().map((v) => mesh.position(v)[2]);
  const z = which === 'top' ? Math.max(...zs) : Math.min(...zs);
  const extent = Math.max(...zs) - Math.min(...zs);
  const inCap = new Set<number>();
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    if (vs.every((v) => Math.abs(mesh.position(v)[2] - z) < 1e-9 * Math.max(1, extent)))
      inCap.add(f);
  }
  if (inCap.size === 0) return undefined;
  const faceOfHalf = (f: number) => mesh.faceVertices(f);
  const boundary = new Map<number, number[]>(); // vertex -> boundary neighbours
  const boundaryEdges: { f: number; a: number; b: number }[] = [];
  const edgeFaces = new Map<string, number[]>();
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const f of mesh.faces()) {
    const vs = faceOfHalf(f);
    for (let i = 0; i < vs.length; i++) {
      const k = key(vs[i] as number, vs[(i + 1) % vs.length] as number);
      const l = edgeFaces.get(k) ?? [];
      l.push(f);
      edgeFaces.set(k, l);
    }
  }
  let triangles = 0;
  for (const f of inCap) {
    const vs = faceOfHalf(f);
    if (vs.length === 3) triangles++;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i] as number;
      const b = vs[(i + 1) % vs.length] as number;
      const fs = edgeFaces.get(key(a, b)) ?? [];
      if (fs.some((g) => !inCap.has(g))) {
        boundaryEdges.push({ f, a, b });
        for (const [p, q] of [
          [a, b],
          [b, a],
        ] as const) {
          const l = boundary.get(p) ?? [];
          l.push(q);
          boundary.set(p, l);
        }
      }
    }
  }
  const corner: number[] = [];
  for (const [v, nb] of boundary) {
    if (nb.length !== 2) continue;
    const pv = mesh.position(v);
    const t = sub(mesh.position(nb[0] as number), mesh.position(nb[1] as number));
    let best = Number.POSITIVE_INFINITY;
    for (const f of inCap) {
      const vs = faceOfHalf(f);
      const i = vs.indexOf(v);
      if (i < 0 || vs.length !== 4) continue;
      for (const w of [vs[(i + 1) % 4] as number, vs[(i + 3) % 4] as number]) {
        if ((boundary.get(v) ?? []).includes(w) && (boundary.get(w) ?? []).includes(v)) continue;
        best = Math.min(best, perpErr(t, sub(mesh.position(w), pv)));
        best = Math.min(best, Number.POSITIVE_INFINITY);
      }
    }
    // |perpErr| is signed-free (angle is undirected), so take the absolute value
    if (Number.isFinite(best)) corner.push(Math.abs(best));
  }
  // First interior edge: at each loop vertex with two loop neighbours, the interior edge that is
  // nearest to perpendicular-to-tangent, measured as the angle between the edge and the loop tangent.
  const firstInterior: number[] = [];
  for (const [v, nb] of boundary) {
    if (nb.length !== 2) continue;
    const pv = mesh.position(v);
    const t = sub(mesh.position(nb[0] as number), mesh.position(nb[1] as number));
    let best = Number.POSITIVE_INFINITY;
    for (const f of inCap) {
      const vs = faceOfHalf(f);
      const i = vs.indexOf(v);
      if (i < 0) continue;
      for (const w of [
        vs[(i + 1) % vs.length] as number,
        vs[(i + vs.length - 1) % vs.length] as number,
      ]) {
        if ((boundary.get(v) ?? []).includes(w)) continue;
        best = Math.min(best, parErr(t, sub(mesh.position(w), pv)));
      }
    }
    if (Number.isFinite(best)) firstInterior.push(best);
  }
  // Vertex tangent (acceptance definition): at a loop vertex, the bisector of its two loop edges.
  const vertexTangent = (v: number): V3 | undefined => {
    const nb = boundary.get(v);
    if (!nb || nb.length !== 2) return undefined;
    const pv = mesh.position(v);
    return unit([
      unit(sub(pv, mesh.position(nb[0] as number)))[0] +
        unit(sub(mesh.position(nb[1] as number), pv))[0],
      unit(sub(pv, mesh.position(nb[0] as number)))[1] +
        unit(sub(mesh.position(nb[1] as number), pv))[1],
      unit(sub(pv, mesh.position(nb[0] as number)))[2] +
        unit(sub(mesh.position(nb[1] as number), pv))[2],
    ] as V3);
  };
  let boundaryQuads = 0;
  let orthoQuads = 0;
  let orthoVertexQuads = 0;
  let rowOrthoVertex = 0;
  let rowOrthoVertexCount = 0;
  let rowQuads = 0;
  for (const { f, a, b } of boundaryEdges) {
    const vs = faceOfHalf(f);
    if (vs.length !== 4) continue;
    const i = vs.indexOf(a);
    const j = vs.indexOf(b);
    if (!((i + 1) % 4 === j || (j + 1) % 4 === i)) continue;
    boundaryQuads++;
    // order so that vs2 = [a, b, c, d] with a-b the boundary edge
    const fwd = (i + 1) % 4 === j;
    const ring = fwd
      ? [0, 1, 2, 3].map((k) => vs[(i + k) % 4] as number)
      : [0, 1, 2, 3].map((k) => vs[(i - k + 4) % 4] as number);
    const [pa, pb, pc, pd] = ring.map((v) => mesh.position(v)) as [V3, V3, V3, V3];
    const e = sub(pb, pa);
    if (perpErr(e, sub(pc, pb)) <= TOL && perpErr(e, sub(pd, pa)) <= TOL) orthoQuads++;
    const ta = vertexTangent(ring[0] as number);
    const tb = vertexTangent(ring[1] as number);
    const vertexOk =
      ta !== undefined &&
      tb !== undefined &&
      perpErr(ta, sub(pd, pa)) <= TOL &&
      perpErr(tb, sub(pc, pb)) <= TOL;
    if (vertexOk) orthoVertexQuads++;
    if (parErr(e, sub(pd, pc)) <= TOL) rowQuads++;
    // Row quads are the first rowQuads quads of their face; the kind is recorded by faceRanges in kindsOf.
    if (vertexOk && kindOf(f) === 'row') {
      rowOrthoVertex++;
    }
    if (kindOf(f) === 'row') rowOrthoVertexCount++;
  }
  const deg = (r: number) => (r * 180) / Math.PI;
  return {
    cap: which,
    quads: inCap.size - triangles,
    triangles,
    loopVertices: corner.length,
    boundaryQuads,
    cornerMedianDevDeg: deg(median(corner)),
    cornerWithin10: corner.filter((x) => x <= TOL).length / Math.max(1, corner.length),
    quadOrthoChordWithin10: orthoQuads / Math.max(1, boundaryQuads),
    quadOrthoVertexWithin10: orthoVertexQuads / Math.max(1, boundaryQuads),
    rowOrthoVertexWithin10: rowOrthoVertex / Math.max(1, rowOrthoVertexCount),
    rowOrthoVertexCount,
    rowParallelWithin10: rowQuads / Math.max(1, boundaryQuads),
    worstCornerDevDeg: deg(Math.max(0, ...corner)),
    firstInteriorMedianDeg: deg(median(firstInterior)),
    firstInteriorWorstDeg: deg(Math.max(0, ...firstInterior)),
  };
}

const cyl = must(cylinder({ radius: 0.3, height: 3, label: 'cyl' }));
const boxS = must(box({ size: [2.6, 1, 1], label: 'box' }));
const pattern = (k: string): Shape => (PATTERN_CASES[k] as () => { shape: Shape })().shape;
const cases: { id: string; name: string; shape: Shape }[] = [
  {
    id: 'plate-grid3x4',
    name: 'plate, 3x4 holes (pattern)',
    shape: pattern('grid3x4'),
  },
  {
    id: 'box-minus-cyl',
    name: 'box minus through cylinder',
    shape: must(booleanSolids(boxS, cyl, 'difference')),
  },
  { id: 'flange-bolt6', name: 'flange, 6 bores', shape: pattern('bolt6') },
  { id: 'flange-bolt12', name: 'flange, 12 bores', shape: pattern('bolt12') },
  {
    id: 'housing',
    name: 'housing (boss + bore)',
    shape: must(
      housing({
        size: [2.6, 1, 1],
        bossX: 0.8,
        bossRadius: 0.3,
        bossHeight: 1.6,
        boreRadius: 0.15,
      }),
    ),
  },
];

const rows: Record<string, unknown>[] = [];
for (const c of cases) {
  for (const mode of ['blossom', 'quad-dominant', 'blossom-row'] as const) {
    const r = quadrangulate(c.shape, {
      size: c.id.startsWith('plate') || c.id.startsWith('flange') ? 5 : 0.25,
      trimmed: mode,
      source: 'boolean',
      ...(FALLBACK === undefined ? {} : { fallback: FALLBACK }),
    });
    if (!r.ok) {
      rows.push({
        id: c.id,
        mode,
        fallback: FALLBACK ?? 'none',
        status: 'fail-closed',
        // Coverage is undefined for a fail-closed run: it is reported as its state, never as 0 or 1.
        coverage: 'fail-closed',
        code: r.error.code,
        detail: JSON.stringify(r.error.detail ?? {}).slice(0, 200),
      });
      continue;
    }
    const kindsByFace = kindsOf(r.value);
    const caps = (['top', 'bottom'] as const)
      .map((w) => capStats(r.value.mesh, w, (f) => kindsByFace[f] ?? 'interior'))
      .filter((x) => x !== undefined);
    const views = renderShape([r.value.mesh], {
      name: `${c.id}-${mode}`,
      modes: ['network'],
      outDir,
      colorBy: 'face',
    });
    if (mode === 'blossom-row' || mode === 'blossom') {
      renderKinds(r.value, `${c.id}-${mode}-kinds`, outDir);
    }
    rows.push({
      id: c.id,
      mode,
      fallback: FALLBACK ?? 'none',
      status: 'ok',
      report: r.value.report,
      faceQuality: r.value.faceQuality,
      caps,
      pngs: views.ok ? views.value.views.map((v) => v.path) : String(views.error),
    });
  }
}
writeFileSync(`${outDir}summary.json`, JSON.stringify(rows, null, 2));
for (const r of rows) {
  const caps = (r.caps as CapStats[] | undefined) ?? [];
  console.log(r.id, r.mode, r.status, r.status === 'ok' ? '' : r.detail);
  for (const q of (r.faceQuality as
    | {
        face: number;
        quads: number;
        triangles: number;
        minSj: number;
        rowSkipped?: number;
        fallback?: boolean;
      }[]
    | undefined) ?? []) {
    console.log(
      `  face ${q.face}: quads ${q.quads} tris ${q.triangles} minSj ${q.minSj.toFixed(3)} rowSkipped ${q.rowSkipped ?? '-'} fallback ${q.fallback ?? '-'}`,
    );
  }
  for (const c of caps)
    console.log(
      `  ${c.cap}: quads ${c.quads} tris ${c.triangles} loopV ${c.loopVertices} bq ${c.boundaryQuads} cornerMed ${c.cornerMedianDevDeg.toFixed(1)}deg corner<=10 ${(c.cornerWithin10 * 100).toFixed(0)}% rowPar ${(c.rowParallelWithin10 * 100).toFixed(0)}% quadOrthoChord ${(c.quadOrthoChordWithin10 * 100).toFixed(0)}% quadOrthoVertex ${(c.quadOrthoVertexWithin10 * 100).toFixed(0)}% rowOrthoVertex ${(c.rowOrthoVertexWithin10 * 100).toFixed(0)}% (n ${c.rowOrthoVertexCount}) worst ${c.worstCornerDevDeg.toFixed(0)}deg firstInterior med ${c.firstInteriorMedianDeg.toFixed(1)}deg worst ${c.firstInteriorWorstDeg.toFixed(1)}deg`,
    );
}
