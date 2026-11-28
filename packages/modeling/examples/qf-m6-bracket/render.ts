// M-QF6 preview: filleted L-bracket with a 0.3 thin web, quad-dominant with isoQuadric (preview).
//   node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-m6-bracket/render.ts <label>
// Output: _scratch/viz-out/qf-m6-bracket/<label>/bracket-<view>.png and summary-<label>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quadrangulate } from '../../src/brep/quad.ts';
import { g1RowContinuity } from '../../src/brep/quad-g1-metric.ts';
import { thinWallEdges } from '../../src/brep/quad-thin.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption } from '../gallery/common.ts';
import { bracketFixture } from './fixture.ts';

const SIZE = 0.5;
const label = process.env.LABEL ?? 'after';
const root = new URL('../../../../_scratch/viz-out/qf-m6-bracket/', import.meta.url).pathname;
const out = join(root, label);
mkdirSync(out, { recursive: true });

const shape = bracketFixture();
const r = quadrangulate(shape, { size: SIZE, trimmed: 'quad-dominant', isoQuadric: true });
if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 300));
const rp = r.value.report;
const g = g1RowContinuity(shape, r.value);
if (!g.ok) throw new Error(JSON.stringify(g.error).slice(0, 300));
const summary = {
  thinWallEdges: thinWallEdges(shape, SIZE).size,
  quads: rp.quads,
  triangles: rp.triangles,
  minSj: rp.scaledJacobian.min,
  g1Fraction: g.value.fraction,
  g1Regular: g.value.regular,
};

const rendered = renderShape(r.value.mesh, {
  views: ['iso'],
  modes: ['jacobian'],
  size: 720,
  label: false,
  legend: 'none',
});
if (!rendered.ok) throw new Error(JSON.stringify(rendered.error).slice(0, 300));
for (const v of rendered.value.views) {
  caption(v.image, [
    `${label}: filleted bracket, thin web 0.3, size ${SIZE}`,
    `q ${rp.quads} t ${rp.triangles} minSJ ${rp.scaledJacobian.min.toFixed(2)} g1 ${g.value.fraction.toFixed(2)}`,
  ]);
  writeFileSync(join(out, `bracket-${v.view}.png`), toPng(v.image));
}
writeFileSync(join(root, `summary-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
