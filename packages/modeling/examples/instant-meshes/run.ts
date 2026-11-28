// Instant Meshes slice 1 evaluation: solves the PoSy field, extracts quads, scores them with the
// quad-eval metrics and renders network and jacobian views through brep-kit.
//   node examples/instant-meshes/run.ts [outDir]
// Baselines: the Instant Meshes baseline (qbase) is not on origin/integration/v2, so every
// comparison field is recorded as "baseline not available".

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES } from '../../scripts/quad-eval/cases.ts';
import { hausdorff, sharpCoverage, sharpEdges } from '../../scripts/quad-eval/fidelity.ts';
import type { EvalMesh, Vec3 } from '../../scripts/quad-eval/mesh.ts';
import { boundsOf } from '../../scripts/quad-eval/mesh.ts';
import { evaluate } from '../../scripts/quad-eval/metrics.ts';
import { extractQuads } from '../../src/quad/extract.ts';
import { finestLevel } from '../../src/quad/hierarchy.ts';
import { instantMeshesField } from '../../src/quad/instant-meshes.ts';
import type { TriMesh } from '../../src/quad/trimesh.ts';
import type { PolyMesh } from '../brep-kit/mesh-scene.ts';
import { renderShape } from '../brep-kit/render.ts';
import { bracket, chamferBox, flangedTee, lumpy } from '../quad-field/models.ts';

const outDir = process.argv[2] ?? join(tmpdir(), 'forgeax-instant-meshes');
mkdirSync(outDir, { recursive: true });

function toEval(mesh: TriMesh): EvalMesh {
  const n = mesh.positions.length / 3;
  const positions: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    positions.push([
      mesh.positions[3 * i] as number,
      mesh.positions[3 * i + 1] as number,
      mesh.positions[3 * i + 2] as number,
    ]);
  }
  const faces: number[][] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    faces.push([
      mesh.triangles[t] as number,
      mesh.triangles[t + 1] as number,
      mesh.triangles[t + 2] as number,
    ]);
  }
  return { positions, faces };
}

function quadsToEval(positions: Float64Array, quads: Uint32Array): EvalMesh {
  const pts: Vec3[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    pts.push([
      positions[3 * i] as number,
      positions[3 * i + 1] as number,
      positions[3 * i + 2] as number,
    ]);
  }
  const faces: number[][] = [];
  for (let q = 0; q < quads.length; q += 4) {
    faces.push([
      quads[q] as number,
      quads[q + 1] as number,
      quads[q + 2] as number,
      quads[q + 3] as number,
    ]);
  }
  return { positions: pts, faces };
}

function polyOf(positions: Float64Array, quads: Uint32Array): PolyMesh {
  const e = quadsToEval(positions, quads);
  return { positions: e.positions, faces: e.faces };
}

interface Subject {
  readonly id: string;
  readonly input: EvalMesh;
  readonly reference: EvalMesh;
  readonly referenceNote: string;
  readonly tri: TriMesh;
}

const lumpyCase = CASES.find((c) => c.id === 'lumpy-sphere-tri');
if (!lumpyCase || lumpyCase.status !== 'ready') throw new Error('lumpy-sphere-tri case missing');
const lumpyMeshes = lumpyCase.build();

const lumpyTri = lumpy();
const subjects: Subject[] = [
  {
    id: 'lumpy-sphere-tri',
    input: lumpyMeshes.identity,
    reference: lumpyMeshes.reference,
    referenceNote: 'case reference (2x resolution lumpy sphere)',
    tri: lumpyTri,
  },
  {
    id: 'chamfer-box',
    input: toEval(chamferBox()),
    reference: toEval(chamferBox()),
    referenceNote: 'input mesh (self reference)',
    tri: chamferBox(),
  },
  {
    id: 'bracket',
    input: toEval(bracket()),
    reference: toEval(bracket()),
    referenceNote: 'input mesh (self reference)',
    tri: bracket(),
  },
  {
    id: 'flanged-tee',
    input: toEval(flangedTee()),
    reference: toEval(flangedTee()),
    referenceNote: 'input mesh (self reference)',
    tri: flangedTee(),
  },
];

/** Undirected edges used by exactly one quad (boundary/open edges). */
function openEdgeCount(quads: Uint32Array): number {
  const count = new Map<number, number>();
  for (let q = 0; q < quads.length; q += 4) {
    for (let k = 0; k < 4; k++) {
      const a = quads[q + k] as number;
      const b = quads[q + ((k + 1) % 4)] as number;
      const key = Math.min(a, b) * 4294967296 + Math.max(a, b);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of count.values()) if (c === 1) open++;
  return open;
}

/** Area of the quads (two triangles each) divided by the input triangle area. */
function coveredAreaFraction(positions: Float64Array, quads: Uint32Array, tri: TriMesh): number {
  const area = (p: Float64Array, a: number, b: number, c: number): number => {
    const ux = (p[b * 3] as number) - (p[a * 3] as number);
    const uy = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
    const uz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
    const vx = (p[c * 3] as number) - (p[a * 3] as number);
    const vy = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
    const vz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  };
  let inputArea = 0;
  for (let t = 0; t < tri.triangles.length; t += 3) {
    inputArea += area(
      tri.positions,
      tri.triangles[t] as number,
      tri.triangles[t + 1] as number,
      tri.triangles[t + 2] as number,
    );
  }
  let quadArea = 0;
  for (let q = 0; q < quads.length; q += 4) {
    const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]] as [
      number,
      number,
      number,
      number,
    ];
    quadArea += area(positions, a, b, c) + area(positions, a, c, d);
  }
  return inputArea > 0 ? quadArea / inputArea : 0;
}

const summary: Record<string, unknown>[] = [];
for (const s of subjects) {
  const t0 = performance.now();
  const solved = instantMeshesField(s.tri);
  if (!solved.ok) throw new Error(`${s.id}: field failed ${solved.error.code}`);
  const graph = finestLevel(s.tri).graph;
  const out = extractQuads(solved.value.field, graph, { removeSpurious: false });
  const ms = performance.now() - t0;
  const evalMesh = quadsToEval(out.positions, out.quads);
  const ev = evaluate(evalMesh);
  const diag = boundsOf(s.reference.positions).diag;
  const haus = hausdorff(evalMesh, s.reference, diag);
  const sharp = sharpCoverage(evalMesh, diag, sharpEdges(s.reference, diag));
  const interior = ev.valence.interior;
  const v3 = interior.find((h) => h.valence === 3)?.count ?? 0;
  const v5 = interior.find((h) => h.valence === 5)?.count ?? 0;
  const nonQuadTraced = out.split;
  const nativeQuadRatio = out.traced > 0 ? 1 - nonQuadTraced / out.traced : 1;
  const row = {
    id: s.id,
    fieldVertices: s.tri.positions.length / 3,
    outputVertices: out.positions.length / 3,
    quads: out.quads.length / 4,
    openEdges: openEdgeCount(out.quads),
    coveredAreaFraction: coveredAreaFraction(out.positions, out.quads, s.tri),
    facesOver4Edges: out.split,
    tracedFaces: out.traced,
    splitNonQuadFaces: nonQuadTraced,
    nativeQuadRatio,
    scaledJacobianMin: ev.scaledJacobian.min,
    scaledJacobianP10: ev.scaledJacobian.p10,
    singularities: ev.valence.singularities.count,
    valence3Interior: v3,
    valence5Interior: v5,
    degenerate: ev.degenerate.count,
    inverted: ev.inverted.count,
    hausdorffMaxRel: haus.max / diag,
    sharpEdges: sharp?.edges ?? 0,
    sharpCoveredP95Rel: sharp ? sharp.p95 / diag : null,
    runtimeMs: Math.round(ms),
    baseline: 'baseline not available (qbase not on origin/integration/v2)',
    referenceNote: s.referenceNote,
  };
  summary.push(row);

  const poly = polyOf(out.positions, out.quads);
  const rendered = renderShape(poly, {
    outDir,
    name: `${s.id}-`,
    modes: ['network', 'jacobian'],
    label: true,
  });
  if (!rendered.ok) throw new Error(`${s.id}: render failed ${rendered.error.code}`);
}

writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
for (const row of summary) process.stdout.write(`${JSON.stringify(row)}\n`);
