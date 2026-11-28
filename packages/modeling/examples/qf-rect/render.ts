// Before/after renders of rectilinear planar faces in iso mode: Jacobian-shaded quad networks of the gallery's merged
// planar boolean results. Run on the trunk checkout for `before` and on this branch for `after`:
//   node --import ./examples/gallery/register-entry.mjs --experimental-strip-types examples/qf-rect/render.ts <label>
// Output: _scratch/viz-out/qf-rect/<label>/<solid>-<view>.png and summary.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quadrangulate } from '../../src/brep/quad.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption } from '../gallery/common.ts';
import { steppedL, tUnion } from '../gallery/solids.ts';
import { buildBracket } from '../planar-boolean/bracket.ts';

const label = process.argv[2] ?? 'after';
const out = new URL(`../../../../_scratch/viz-out/qf-rect/${label}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
function bracket(name: string) {
  const stage = buildBracket().find((s) => s.name === name);
  if (stage === undefined) throw new Error(`bracket stage ${name} missing`);
  return stage.shape;
}
const solids = [
  { name: 'T-union', shape: tUnion(), size: 0.4 },
  { name: 'stepped-L-union', shape: steppedL(), size: 0.4 },
  { name: 'bracket-wall', shape: bracket('wall'), size: 0.8 },
  { name: 'bracket-groove', shape: bracket('groove'), size: 0.8 },
  { name: 'bracket-boss', shape: bracket('boss'), size: 0.8 },
  { name: 'bracket-gusset', shape: bracket('gusset'), size: 0.8 },
  { name: 'bracket-pocket', shape: bracket('pocket'), size: 0.8 },
];
const summary: Record<string, unknown> = {};
for (const s of solids) {
  const r = quadrangulate(s.shape, { size: s.size, trimmed: 'quad-dominant', isoQuadric: true });
  if (!r.ok) {
    summary[s.name] = { refused: r.error.detail?.reason, face: r.error.detail?.face };
    continue;
  }
  const rep = r.value.report;
  const row = {
    quads: rep.quads,
    triangles: rep.triangles,
    minSJ: Number(rep.scaledJacobian.min.toFixed(3)),
  };
  summary[s.name] = row;
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
      `${label}: ${s.name} iso size ${s.size}`,
      `q ${row.quads} t ${row.triangles} minSJ ${row.minSJ}`,
    ]);
    writeFileSync(join(out, `${s.name}-${v.view}.png`), toPng(v.image));
  }
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
