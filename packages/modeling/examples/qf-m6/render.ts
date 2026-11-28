// Thin-wall rows: a rib at several thicknesses meshed with the thin-feature floor (preview).
//   node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-m6/render.ts <label>
// Output: _scratch/viz-out/qf-m6/<label>/rib-<t>-<view>.png and summary.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { box } from '../../src/brep/build.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption } from '../gallery/common.ts';

const label = process.argv[2] ?? 'after';
const out = new URL(`../../../../_scratch/viz-out/qf-m6/${label}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const summary: Record<string, unknown> = {};
for (const t of [0.1, 0.3, 0.6]) {
  const shape = box({ size: [4, t, 2], label: 'rib' });
  if (!shape.ok) throw new Error(JSON.stringify(shape.error));
  const r = quadrangulate(shape.value, { size: 0.5, trimmed: 'quad-dominant', isoQuadric: true });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const ys = new Set<number>();
  for (let v = 0; v < r.value.mesh.vertexCount; v++) {
    ys.add(Math.round(r.value.mesh.position(v)[1] * 1e6));
  }
  const row = { quads: r.value.report.quads, rowsAcross: ys.size - 1 };
  summary[`rib-${t}`] = row;
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
      `${label}: rib t=${t} size 0.5`,
      `q ${row.quads} rows across ${row.rowsAcross}`,
    ]);
    writeFileSync(join(out, `rib-${t}-${v.view}.png`), toPng(v.image));
  }
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
