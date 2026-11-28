// M-QF3 curved baseline: what does today's quad layout do with faces that carry holes on a curved surface?
// Each case is a closed solid (see shapes.ts). We run quadrangulate in every trimmed mode and record the outcome
// (ok with quad counts, or the fail-closed model-partial reason), and render the solid with its iso lines and feature
// edges so the trim loops against the (u, v) grid are visible. Output: PNGs plus summary.json under QF_OUT.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { faceLoops } from '../../src/brep/faces.ts';
import { type QuadOptions, quadrangulate } from '../../src/brep/quad.ts';
import { renderShape } from '../brep-kit/render.ts';
import {
  type HoleBoundaryMetrics,
  holeBoundaryMetrics,
  type QuadShapeReport,
  quadShapeReport,
  type ValenceReport,
  valenceReport,
} from './metrics.ts';
import { CURVED_CASES, STRIP_LIMIT_CASES } from './shapes.ts';

const outDir =
  process.env.QF_OUT ?? new URL('../../../../_scratch/viz-out/qf-m3/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const RUNS: readonly { mode: NonNullable<QuadOptions['trimmed']>; iso: boolean }[] = [
  { mode: 'reject', iso: false },
  { mode: 'blossom', iso: false },
  { mode: 'blossom-row', iso: false },
  { mode: 'blossom-row', iso: true },
  { mode: 'quad-dominant', iso: true },
];
const SIZE = 0.25;

interface ModeRow {
  readonly mode: string;
  readonly status: 'ok' | 'model-partial' | 'error';
  readonly reason?: string;
  readonly face?: number;
  readonly surface?: string;
  readonly quads?: number;
  readonly minSj?: number;
  readonly triangles?: number;
  readonly open?: number;
  readonly nm?: number;
  readonly folded?: number;
  readonly boundary?: HoleBoundaryMetrics;
  readonly valence?: ValenceReport;
  readonly shape?: QuadShapeReport;
}

const rows: { case: string; holedFaces: number[]; modes: ModeRow[] }[] = [];
for (const c of [...CURVED_CASES, ...STRIP_LIMIT_CASES]) {
  const built = c.build();
  if (!built.ok)
    throw new Error(`${c.name} did not build: ${JSON.stringify(built.error).slice(0, 200)}`);
  const shape = built.value;
  const holedFaces = shape.faces
    .map((_, f) => f)
    .filter((f) => faceLoops(shape, f).holes.length > 0);
  const modes: ModeRow[] = [];
  for (const run of RUNS) {
    const mode = run.iso ? `${run.mode}+iso` : run.mode;
    const r = quadrangulate(shape, {
      size: SIZE,
      trimmed: run.mode,
      ...(run.iso ? { isoQuadric: true } : {}),
    });
    if (r.ok) {
      const rep = r.value.report;
      modes.push({
        mode,
        status: 'ok',
        quads: rep.quads,
        minSj: rep.scaledJacobian.min,
        triangles: rep.triangles,
        open: rep.openEdges,
        nm: rep.nonManifoldEdges,
        folded: r.value.faceQuality.reduce((n, q) => n + q.foldedPairs, 0),
        boundary: holeBoundaryMetrics(shape, r.value),
        valence: valenceReport(r.value),
        shape: quadShapeReport(r.value),
      });
      const after = renderShape(r.value.mesh, {
        name: `${c.name}-${mode}-`,
        modes: ['shaded', 'network'],
        outDir,
      });
      if (!after.ok)
        // biome-ignore lint/suspicious/noConsole: example script output
        console.log(
          `${c.name} ${mode} render skipped: ${JSON.stringify(after.error).slice(0, 250)}`,
        );
      continue;
    }
    const detail = r.error.detail as { face?: number; surface?: string; reason?: string };
    modes.push({
      mode,
      status: r.error.code === 'model-partial' ? 'model-partial' : 'error',
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      ...(detail.face === undefined ? {} : { face: detail.face }),
      ...(detail.surface === undefined ? {} : { surface: detail.surface }),
    });
  }
  rows.push({ case: c.name, holedFaces, modes });
  const rendered = renderShape(shape, {
    name: `${c.name}-before-`,
    modes: ['iso', 'features'],
    outDir,
    tessellation: { angle: Math.PI / 12 },
  });
  if (!rendered.ok) {
    // biome-ignore lint/suspicious/noConsole: example script output
    console.log(`${c.name} render skipped: ${JSON.stringify(rendered.error).slice(250, 520)}`);
  }
}

const git = (args: string): string => execSync(`git ${args}`, { encoding: 'utf8' }).trim();
const sha = git('rev-parse HEAD');
const dirty = git('status --porcelain -- src examples').length > 0;
const summary = { sha, dirty, size: SIZE, cases: rows };
const body = `${JSON.stringify(summary, null, 2)}\n`;
writeFileSync(`${outDir}/summary.json`, body);
writeFileSync(
  `${outDir}/provenance.txt`,
  [
    `head: ${sha}`,
    `tree: ${dirty ? 'DIRTY (uncommitted changes under src/ or examples/; do not hand over)' : 'clean'}`,
    `utc: ${new Date().toISOString()}`,
    `command: node --import ../qf-tools/register.mjs --experimental-strip-types examples/qf-curved-baseline/run.ts`,
    `exit: 0 (written after the last case completed)`,
    `summary.json sha256: ${createHash('sha256').update(body).digest('hex')}`,
    '',
  ].join('\n'),
);
for (const r of rows) {
  for (const m of r.modes) {
    const b = m.boundary;
    const detail =
      m.status === 'ok'
        ? `quads=${m.quads} tris=${m.triangles} open=${m.open} nm=${m.nm} folded=${m.folded} minSj=${m.minSj?.toFixed(2)} ` +
          `ortho rowOnly=${b?.rowOnly.toFixed(2)} allBoundary=${b?.allBoundary.toFixed(2)} coverage=${b?.coverage.toFixed(2)} ` +
          `twist=${m.shape?.twistMaxDeg.toFixed(2)} aspect=${m.shape?.aspectMax.toFixed(2)} ` +
          `singularities=${m.valence?.singularities} valence=${JSON.stringify(m.valence?.histogram)}`
        : (m.reason ?? '');
    // biome-ignore lint/suspicious/noConsole: example script output
    console.log(`${r.case} ${m.mode}: ${m.status} ${detail}`);
  }
}
