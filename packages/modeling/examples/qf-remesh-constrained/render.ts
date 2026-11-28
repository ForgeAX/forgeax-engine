// Constraint-aware quadRemesh preview: a 2x2 featured grid with bent diagonal creases, free vs constrained (preview).
//   node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-remesh-constrained/render.ts <label>
// Output: _scratch/viz-out/qf-remesh-constrained/<label>/{free,constrained}-iso.png and summary-<label>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditMesh } from '../../src/mesh.ts';
import { type FeatureConstraint, quadRemesh } from '../../src/quad/index.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption } from '../gallery/common.ts';

const label = process.env.LABEL ?? 'after';
const root = new URL('../../../../_scratch/viz-out/qf-remesh-constrained/', import.meta.url)
  .pathname;
const out = join(root, label);
mkdirSync(out, { recursive: true });

const H = 0.0185;
const mesh = new EditMesh();
const id = (x: number, y: number): number => mesh.addVertex(x, y, H * ((x + y) % 2));
const creases: FeatureConstraint[] = [];
for (let i = 0; i < 2; i++) {
  for (let j = 0; j < 2; j++) {
    const a = id(i, j);
    const b = id(i + 1, j);
    const c = id(i + 1, j + 1);
    const d = id(i, j + 1);
    mesh.addFace([a, b, c]);
    mesh.addFace([a, c, d]);
    creases.push({
      id: `diag-${i}-${j}`,
      polyline: [
        [i, j, H * ((i + j) % 2)],
        [i + 1, j + 1, H * ((i + j) % 2)],
      ],
      tolerance: 1e-3,
    });
  }
}

const free = quadRemesh(mesh, mesh.faces(), { constraints: [] });
const constrained = quadRemesh(mesh, mesh.faces(), { constraints: creases });
if (!free.ok) throw new Error(JSON.stringify(free.error).slice(0, 300));
const summary: Record<string, unknown> = {
  free: {
    residualTriangles: free.value.report.residualTriangles,
    unresolved: free.value.report.unresolvedFeatures,
  },
};
if (constrained.ok) {
  summary.constrained = {
    residualTriangles: constrained.value.report.residualTriangles,
    maxDeviation: constrained.value.report.featureDeviation.max,
  };
} else {
  summary.constrained = {
    failed: constrained.error.code,
    reason: constrained.error.detail?.reason,
  };
}

for (const [name, result] of [
  ['free', free.value],
  ['constrained', constrained.ok ? constrained.value : null],
] as const) {
  if (result === null) continue;
  const rendered = renderShape(result.mesh, {
    views: ['iso'],
    modes: ['jacobian'],
    size: 720,
    label: false,
    legend: 'none',
  });
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.error).slice(0, 300));
  for (const v of rendered.value.views) {
    caption(v.image, [
      `${label}: ${name} quadRemesh, 2x2 bent diagonal creases`,
      `residual t ${result.report.residualTriangles} unresolved ${result.report.unresolvedFeatures.length}`,
    ]);
    writeFileSync(join(out, `${name}-${v.view}.png`), toPng(v.image));
  }
}
writeFileSync(join(root, `summary-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
