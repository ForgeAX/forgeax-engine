// Mixed part: an L plate with a bore. Before = plain trimmed route (isoQuadric used to fail whole on the L caps);
// after = isoQuadric with the per-face trimmed fallback (preview).
//   node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-m6b/render.ts
// Output: _scratch/viz-out/qf-m6b/{before,after}/<case>-<view>.png and summary.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extrude } from '../../src/brep/build.ts';
import { measure } from '../../src/brep/measure.ts';
import { applyPattern, linearPattern } from '../../src/brep/pattern.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import { must } from '../brep-heal/damage.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { bore } from '../brep-pattern/render.ts';
import { caption } from '../gallery/common.ts';
import { buildLoftShowcase } from '../loft/showcase.ts';

const root = new URL('../../../../_scratch/viz-out/qf-m6b/', import.meta.url).pathname;

const profile: [number, number][] = [
  [0, 0],
  [6, 0],
  [6, 2],
  [2, 2],
  [2, 6],
  [0, 6],
];
const plate = must(extrude({ profile, depth: 1, label: 'L' }));
const tools = must(
  linearPattern(bore(0.5, [1, 1, 0], 4), { direction: [1, 0, 0], spacing: 3, count: 1 }),
);
const cases: [string, Shape, number][] = [['lplate', must(applyPattern(plate, tools)), 0.4]];
const loft = (buildLoftShowcase() as Shape[])[0] as Shape;
const lm = measure(loft);
if (lm.ok) cases.push(['loft-0', loft, Math.sqrt(lm.value.area) / 10]);

const summary: Record<string, unknown> = {};
for (const [label, iso] of [
  ['before', false],
  ['after', true],
] as const) {
  const out = join(root, label);
  mkdirSync(out, { recursive: true });
  for (const [name, shape, size] of cases) {
    const r = quadrangulate(shape, {
      size,
      trimmed: 'quad-dominant',
      ...(iso ? { isoQuadric: true } : {}),
    });
    if (!r.ok) throw new Error(`${label} ${name} ${JSON.stringify(r.error.detail)}`);
    const rp = r.value.report;
    summary[`${label}/${name}`] = {
      quads: rp.quads,
      triangles: rp.triangles,
      minSj: rp.scaledJacobian.min,
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
        `${label}: ${name} size ${size.toFixed(2)}`,
        `q ${rp.quads} t ${rp.triangles} minSJ ${rp.scaledJacobian.min.toFixed(2)}`,
      ]);
      writeFileSync(join(out, `${name}-${v.view}.png`), toPng(v.image));
    }
  }
}
writeFileSync(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
