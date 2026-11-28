// Flange bolt6 quad-dominant at size 0.8 (the row whose minSJ is 0.004): shaded + quad network renders,
// colored by source face, with a stamped summary.json and provenance.txt. Quad-dominant admits every
// convex flat pair (no SJ floor), so the cap faces keep sliver quads from rim fans; see summary worst-face rows.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import { renderShape } from '../brep-kit/render.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';

const outDir =
  process.env.QF_OUT ??
  new URL('../../../../_scratch/viz-out/qf-flange-qd/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const shape = (PATTERN_CASES.bolt6 as () => { shape: Shape })().shape;
const size = 0.8;
const r = quadrangulate(shape, { size, trimmed: 'quad-dominant' });
if (!r.ok) throw new Error(`failed: ${r.error.code}`);
const faces = r.value.faceQuality;
const views = renderShape([r.value.mesh], {
  name: 'flange-bolt6-qd-',
  modes: ['shaded', 'network'],
  views: ['iso', 'top'],
  outDir,
  colorBy: 'face',
});
const git = (c: string) => execSync(`git ${c}`, { encoding: 'utf8' }).trim();
const sha = git('rev-parse HEAD');
const dirty = git('status --porcelain -- src examples').length > 0;
const row = {
  id: 'flange-bolt6',
  mode: 'quad-dominant',
  size,
  quads: r.value.report.quads,
  tris: r.value.report.triangles,
  minSj: Math.min(...faces.map((f) => f.minSj)),
  open: r.value.report.openEdges,
  nm: r.value.report.nonManifoldEdges,
  worstFaces: [...faces]
    .sort((a, b) => a.minSj - b.minSj)
    .slice(0, 3)
    .map((f) => ({ minSj: f.minSj, quads: f.quads, triangles: f.triangles })),
  pngs: views.ok ? views.value.views.map((v) => v.path) : String(views.error),
};
const body = `${JSON.stringify({ sha, dirty, row }, null, 2)}\n`;
writeFileSync(`${outDir}summary.json`, body);
writeFileSync(
  `${outDir}provenance.txt`,
  [
    `head: ${sha}`,
    `tree: ${dirty ? 'DIRTY (uncommitted changes under src/ or examples/; do not hand over)' : 'clean'}`,
    `utc: ${new Date().toISOString()}`,
    'command: node --import ../qf-tools/register.mjs --experimental-strip-types examples/quad-feature-baseline/flange-qd-run.ts',
    'exit: 0 (written after the last render)',
    `summary.json sha256: ${createHash('sha256').update(body).digest('hex')}`,
    '',
  ].join('\n'),
);
// biome-ignore lint/suspicious/noConsole: example script output
console.log(JSON.stringify({ ...row, pngs: undefined }));
