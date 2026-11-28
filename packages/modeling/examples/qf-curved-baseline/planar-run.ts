// Planar holed faces under isoQuadric: the plate, the 12-hole plate and the bolt flanges, each with its outcome (ok
// with counts, or the named fail-closed reason). Renders the 12-hole plate (network + shaded) and writes one
// summary.json with provenance.txt from a committed, clean tree. Output: QF_OUT (default _scratch/viz-out/qf-planar/).
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { boxWithThroughHole } from '../../src/brep/boolean-hole.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import { renderShape } from '../brep-kit/render.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';
import { holeBoundaryMetrics, quadShapeReport } from './metrics.ts';

const outDir =
  process.env.QF_OUT ??
  new URL('../../../../_scratch/viz-out/qf-planar/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

interface Run {
  readonly name: string;
  readonly size: number;
  readonly build: () => Shape;
  readonly render?: boolean;
  /** Equal-size comparison routes on the same shape; iso is the default. */
  readonly mode?: 'iso' | 'quad-dominant' | 'blossom-row' | 'split-3';
}

const pattern = (key: string) => (): Shape =>
  (PATTERN_CASES[key] as () => { shape: Shape })().shape;
const RUNS: readonly Run[] = [
  {
    name: 'plate',
    size: 0.25,
    build: () => {
      const b = boxWithThroughHole({ size: [3, 3, 1], radius: 0.75, label: 'plate' });
      if (!b.ok) throw new Error('plate did not build');
      return b.value;
    },
    render: true,
  },
  ...[5, 3].map(
    (size): Run => ({ name: 'plate-grid3x4', size, build: pattern('grid3x4'), render: true }),
  ),
  { name: 'plate-grid3x4', size: 2, build: pattern('grid3x4') },
  { name: 'plate-grid3x4', size: 1.5, build: pattern('grid3x4') },
  { name: 'plate-grid3x4', size: 1, build: pattern('grid3x4'), render: true },
  { name: 'plate-grid3x4', size: 0.5, build: pattern('grid3x4'), render: true },
  ...[5, 3, 1.5].map(
    (size): Run => ({
      name: 'plate-grid3x4',
      size,
      build: pattern('grid3x4'),
      mode: 'quad-dominant',
    }),
  ),
  { name: 'plate-grid3x4', size: 2, build: pattern('grid3x4'), mode: 'quad-dominant' },
  { name: 'plate-grid3x4', size: 1, build: pattern('grid3x4'), mode: 'quad-dominant' },
  { name: 'plate-grid3x4', size: 1, build: pattern('grid3x4'), mode: 'split-3' },
  { name: 'plate-grid3x4', size: 0.5, build: pattern('grid3x4'), mode: 'quad-dominant' },
  { name: 'flange-bolt6', size: 1, build: pattern('bolt6') },
  { name: 'flange-bolt6', size: 0.8, build: pattern('bolt6'), render: true },
  { name: 'flange-bolt6', size: 0.5, build: pattern('bolt6') },
  { name: 'flange-bolt12', size: 1, build: pattern('bolt12') },
  { name: 'flange-bolt12', size: 0.8, build: pattern('bolt12') },
  { name: 'flange-bolt12', size: 0.5, build: pattern('bolt12'), render: true },
  ...['flange-bolt6', 'flange-bolt12'].flatMap((name) =>
    [0.8, 0.5].flatMap((size) =>
      (['quad-dominant', 'blossom-row', 'split-3'] as const).map(
        (mode): Run => ({
          name,
          size,
          mode,
          build: pattern(name === 'flange-bolt6' ? 'bolt6' : 'bolt12'),
        }),
      ),
    ),
  ),
];

const only = process.env.QF_ONLY;
const rows: Record<string, unknown>[] = [];
const cache = new Map<string, Shape>();
for (const run of RUNS.filter((r) => only === undefined || r.name.startsWith(only))) {
  const shape = cache.get(run.name) ?? run.build();
  cache.set(run.name, shape);
  const t = performance.now();
  const mode = run.mode ?? 'iso';
  const r = quadrangulate(
    shape,
    mode === 'iso'
      ? { size: run.size, trimmed: 'quad-dominant', isoQuadric: true }
      : mode === 'split-3'
        ? { size: run.size, trimmed: 'quad-dominant', fallback: 'split-3' }
        : { size: run.size, trimmed: mode },
  );
  const ms = Math.round(performance.now() - t);
  if (!r.ok) {
    const d = r.error.detail as { face?: number; surface?: string; reason?: string };
    rows.push({
      case: run.name,
      mode,
      size: run.size,
      status: r.error.code,
      reason: d.reason,
      face: d.face,
      ms,
    });
    continue;
  }
  const rep = r.value.report;
  rows.push({
    case: run.name,
    mode,
    size: run.size,
    status: 'ok',
    quads: rep.quads,
    triangles: rep.triangles,
    open: rep.openEdges,
    nm: rep.nonManifoldEdges,
    folded: r.value.faceQuality.reduce((n, q) => n + q.foldedPairs, 0),
    minSj: rep.scaledJacobian.min,
    boundary: holeBoundaryMetrics(shape, r.value),
    shape: quadShapeReport(r.value),
    ms,
  });
  if (run.render && mode === 'iso') {
    const out = renderShape(r.value.mesh, {
      name: `${run.name}-${run.size}-`,
      modes: ['network', 'shaded'],
      outDir,
    });
    if (!out.ok) throw new Error(`render failed: ${JSON.stringify(out.error).slice(0, 300)}`);
  }
}

const git = (args: string): string => execSync(`git ${args}`, { encoding: 'utf8' }).trim();
const sha = git('rev-parse HEAD');
const dirty = git('status --porcelain -- src examples').length > 0;
const body = `${JSON.stringify({ sha, dirty, trimmed: 'quad-dominant', isoQuadric: true, rows }, null, 2)}\n`;
writeFileSync(`${outDir}/summary.json`, body);
writeFileSync(
  `${outDir}/provenance.txt`,
  [
    `head: ${sha}`,
    `tree: ${dirty ? 'DIRTY (uncommitted changes under src/ or examples/; do not hand over)' : 'clean'}`,
    `utc: ${new Date().toISOString()}`,
    `command: node --import ../qf-tools/register.mjs --experimental-strip-types examples/qf-curved-baseline/planar-run.ts`,
    `exit: 0 (written after the last case completed)`,
    `summary.json sha256: ${createHash('sha256').update(body).digest('hex')}`,
    '',
  ].join('\n'),
);
for (const r of rows) {
  // biome-ignore lint/suspicious/noConsole: example script output
  console.log(JSON.stringify(r));
}
