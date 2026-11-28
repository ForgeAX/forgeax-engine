// Flange quad-dominant, dominantSjFloor off vs on, four rows at equal size (bolt6/bolt12 x 0.8/0.5).
// Reports quad minSJ and the triangle quality (count, min angle, min triangle SJ = 2/sqrt(3) * sin(min corner))
// of the leftover triangles. rowOnly is not applicable (no rows in quad-dominant); coverage is the quad share of faces.
// Renders shaded + network for bolt6 0.8 floor-on. Writes summary.json and provenance.txt.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { quadrangulate, scaledJacobian } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import { renderShape } from '../brep-kit/render.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';

const outDir =
  process.env.QF_OUT ??
  new URL('../../../../_scratch/viz-out/qf-flange-qd-floor/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

function triMinAngle(p: readonly P3[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const a = p[i] as P3;
    const b = p[(i + 1) % 3] as P3;
    const c = p[(i + 2) % 3] as P3;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as P3;
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as P3;
    const d = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
    min = Math.min(
      min,
      Math.acos(Math.max(-1, Math.min(1, d / (Math.hypot(...u) * Math.hypot(...w))))),
    );
  }
  return min;
}

const rows: object[] = [];
for (const name of ['bolt6', 'bolt12']) {
  const shape = (PATTERN_CASES[name] as () => { shape: Shape })().shape;
  for (const size of [0.8, 0.5]) {
    for (const floor of [false, true]) {
      const r = quadrangulate(shape, {
        size,
        trimmed: 'quad-dominant',
        ...(floor ? { dominantSjFloor: true } : {}),
      });
      if (!r.ok) {
        rows.push({ case: `flange-${name}`, size, floor, status: r.error.code });
        continue;
      }
      const mesh = r.value.mesh;
      let minAngle = Number.POSITIVE_INFINITY;
      let quadMin = Number.POSITIVE_INFINITY;
      for (const f of mesh.faces()) {
        const pts = mesh.faceVertices(f).map((v) => mesh.position(v) as P3);
        if (pts.length === 3) minAngle = Math.min(minAngle, triMinAngle(pts));
        else if (pts.length === 4) quadMin = Math.min(quadMin, scaledJacobian(pts));
      }
      const rep = r.value.report;
      let pngs: unknown;
      if (name === 'bolt6' && size === 0.8 && floor) {
        const v = renderShape([mesh], {
          name: 'flange-bolt6-qd-floor-',
          modes: ['shaded', 'network'],
          views: ['iso', 'top'],
          outDir,
          colorBy: 'face',
        });
        pngs = v.ok ? v.value.views.map((x) => x.path) : String(v.error);
      }
      rows.push({
        case: `flange-${name}`,
        size,
        floor,
        status: 'ok',
        quads: rep.quads,
        tris: rep.triangles,
        quadShare: Number((rep.quads / (rep.quads + rep.triangles)).toFixed(4)),
        quadMinSj: quadMin,
        triMinAngleDeg: Number(((minAngle * 180) / Math.PI).toFixed(3)),
        triMinSj: Number(((2 / Math.sqrt(3)) * Math.sin(minAngle)).toFixed(4)),
        open: rep.openEdges,
        nm: rep.nonManifoldEdges,
        pngs,
      });
    }
  }
}
const git = (c: string) => execSync(`git ${c}`, { encoding: 'utf8' }).trim();
const sha = git('rev-parse HEAD');
const dirty = git('status --porcelain -- src examples').length > 0;
const body = `${JSON.stringify({ sha, dirty, rows }, null, 2)}\n`;
writeFileSync(`${outDir}summary.json`, body);
writeFileSync(
  `${outDir}provenance.txt`,
  [
    `head: ${sha}`,
    `tree: ${dirty ? 'DIRTY (uncommitted changes under src/ or examples/; do not hand over)' : 'clean'}`,
    `utc: ${new Date().toISOString()}`,
    'command: node --import ../qf-tools/register.mjs --experimental-strip-types examples/quad-feature-baseline/flange-qd-floor-run.ts',
    'exit: 0 (written after the last row)',
    `summary.json sha256: ${createHash('sha256').update(body).digest('hex')}`,
    '',
  ].join('\n'),
);
for (const row of rows) {
  // biome-ignore lint/suspicious/noConsole: example script output
  console.log(JSON.stringify({ ...row, pngs: undefined }));
}
