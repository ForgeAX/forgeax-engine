// Rounded-rectangle caps: before = the trimmed route they used to take (triangle fans), after = isoQuadric with the
// rounded-rectangle layout (core + four strips + four corner triangles split into quads) (preview).
//   node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-m6c/render.ts
// Output: _scratch/viz-out/qf-m6c/{before,after}/<case>-<view>.png and summary.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extrude } from '../../src/brep/build.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import { must } from '../brep-heal/damage.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption } from '../gallery/common.ts';

const root = new URL('../../../../_scratch/viz-out/qf-m6c/', import.meta.url).pathname;

function roundedRect(w: number, h: number, r: number, n: number): [number, number][] {
  const centres: [number, number][] = [
    [w / 2 - r, h / 2 - r],
    [-(w / 2 - r), h / 2 - r],
    [-(w / 2 - r), -(h / 2 - r)],
    [w / 2 - r, -(h / 2 - r)],
  ];
  const out: [number, number][] = [];
  centres.forEach(([cx, cy], k) => {
    for (let i = 0; i <= n; i++) {
      const a = (Math.PI / 2) * (k + i / n);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  });
  return out;
}

const prism = (w: number, h: number, r: number, n: number, depth: number): Shape =>
  must(extrude({ profile: roundedRect(w, h, r, n), depth, label: 'rr' }));
const cases: [string, Shape, number][] = [
  ['module-24', prism(9, 10, 3, 5, 4.5), 0.35],
  ['grip-36', prism(3.6, 5, 1.4, 8, 6), 0.35],
  ['receiver-36', prism(20, 12, 4, 8, 6), 0.6],
];

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
    if (!r.ok) {
      if (iso) throw new Error(`${label} ${name} ${JSON.stringify(r.error.detail)}`);
      summary[`${label}/${name}`] = { failed: JSON.stringify(r.error.detail) };
      continue;
    }
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
