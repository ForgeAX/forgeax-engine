// Hero-blaster faces that kept triangles (trigger blade, module slot, bolt plate), rendered with the current tree.
// Run it in a trunk checkout for `before` and in this branch for `after` (preview).
//   LABEL=after node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-m6d/render.ts
// Output: _scratch/viz-out/qf-m6d/<label>/<case>-<view>.png and summary-<label>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quadrangulate } from '../../src/brep/quad.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption } from '../gallery/common.ts';
import { boltPlate, moduleSlot, triggerBlade } from './cases.ts';

const label = process.env.LABEL ?? 'after';
const root = new URL('../../../../_scratch/viz-out/qf-m6d/', import.meta.url).pathname;
const out = join(root, label);
mkdirSync(out, { recursive: true });
const cases = [
  ['trigger-blade', triggerBlade()],
  ['module-slot', moduleSlot()],
  ['bolt-plate', boltPlate()],
] as const;
const summary: Record<string, unknown> = {};
for (const [name, shape] of cases) {
  const r = quadrangulate(shape, { size: 0.35, trimmed: 'quad-dominant', isoQuadric: true });
  if (!r.ok) {
    summary[name] = { failed: JSON.stringify(r.error.detail) };
    continue;
  }
  const rp = r.value.report;
  summary[name] = { quads: rp.quads, triangles: rp.triangles, minSj: rp.scaledJacobian.min };
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
      `${label}: ${name}`,
      `q ${rp.quads} t ${rp.triangles} minSJ ${rp.scaledJacobian.min.toFixed(2)}`,
    ]);
    writeFileSync(join(out, `${name}-${v.view}.png`), toPng(v.image));
  }
}
writeFileSync(join(root, `summary-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
