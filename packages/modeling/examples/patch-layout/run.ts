// M6: feature-only vs field-driven patch layout on five models. Writes summary.json and patch-network PNGs
// (shaded, patches coloured by group, cut network as sharp edges).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutPatches, layoutPatchesAlongField } from '../../src/quad/patch-layout.ts';
import type { TriMesh } from '../../src/quad/trimesh.ts';
import type { PolyMesh } from '../brep-kit/mesh-scene.ts';
import { renderShape } from '../brep-kit/render.ts';
import { bracket, chamferBox, flangedTee, lumpy } from '../quad-field/models.ts';

const outDir = process.argv[2] ?? join(tmpdir(), 'forgeax-patch-layout-m6');
mkdirSync(outDir, { recursive: true });

/** Closed cylinder: a tube of n segments with two triangle-fan caps. */
function cylinder(n: number): TriMesh {
  const pos: number[] = [];
  const tri: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pos.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1);
  }
  const bottomC = 2 * n;
  const topC = 2 * n + 1;
  pos.push(0, 0, 0, 0, 0, 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1);
    tri.push(bottomC, 2 * j, 2 * i);
    tri.push(topC, 2 * i + 1, 2 * j + 1);
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tri) };
}

const subjects: { id: string; tri: TriMesh }[] = [
  { id: 'cylinder-24', tri: cylinder(24) },
  { id: 'chamfer-box', tri: chamferBox() },
  { id: 'bracket', tri: bracket() },
  { id: 'flanged-tee', tri: flangedTee() },
  { id: 'lumpy', tri: lumpy() },
];

const summary: Record<string, unknown>[] = [];
for (const s of subjects) {
  const feature = layoutPatches(s.tri);
  const field = layoutPatchesAlongField(s.tri, { minPatchTriangles: 4 });
  if (!field.ok) throw new Error(`${s.id}: field layout failed ${field.error.code}`);
  const layout = field.value;
  const summaryRow = (name: string, l: typeof feature) => ({
    id: s.id,
    layout: name,
    triangles: s.tri.triangles.length / 3,
    patches: l.patchCount,
    corners: l.corners.length,
    singularities: l.singularities,
    separatrixEdges: l.separatrixEdges,
    featureCoverage: l.featureCoverage,
    patchesNotFour: l.patchesNotFour,
    patchCorners: l.patchCorners,
  });
  summary.push(summaryRow('feature-only', feature));
  summary.push(summaryRow('field-driven', layout));
  // Rendered from the field-driven layout; the mesh is the one the field was solved on.
  const poly: PolyMesh = {
    positions: Array.from({ length: s.tri.positions.length / 3 }, (_, v) => [
      s.tri.positions[3 * v] as number,
      s.tri.positions[3 * v + 1] as number,
      s.tri.positions[3 * v + 2] as number,
    ]),
    faces: Array.from({ length: s.tri.triangles.length / 3 }, (_, f) => [
      s.tri.triangles[3 * f] as number,
      s.tri.triangles[3 * f + 1] as number,
      s.tri.triangles[3 * f + 2] as number,
    ]),
    sharp: layout.cutEdges,
    group: Array.from(layout.patchOf),
  };
  const rendered = renderShape(poly, {
    outDir,
    name: `${s.id}-field-`,
    modes: ['shaded'],
    colorBy: 'face',
    label: true,
  });
  if (!rendered.ok) throw new Error(`${s.id}: render failed ${rendered.error.code}`);
}

writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
for (const row of summary) process.stdout.write(`${JSON.stringify(row)}\n`);
