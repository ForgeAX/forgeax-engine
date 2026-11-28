// Split-3 stamped run: the baseline cases quadrangulated with `fallback: 'split-3'` for the blossom-row mode, plus the
// default quad-dominant and blossom-row rows for context. Writes summary.json and shaded + network renders per row.
// Density: a row reports 4 when its density-1 layout folds and the split-3 retry (curved-edge counts x4) succeeds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import { housing } from '../../src/brep/housing.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import { renderShape } from '../brep-kit/render.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';

const outDir =
  process.env.QF_OUT ??
  new URL('../../../../_scratch/viz-out/qf-split3/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error).slice(0, 300)}`);
  return r.value;
}

const boxS = must(box({ size: [2.6, 1, 1], label: 'box' }));
const cyl = must(cylinder({ radius: 0.3, height: 3, label: 'cyl' }));
const pattern = (k: string): Shape => (PATTERN_CASES[k] as () => { shape: Shape })().shape;

const cases: { id: string; size: number; shape: Shape }[] = [
  { id: 'plate-grid3x4', size: 5, shape: pattern('grid3x4') },
  { id: 'box-minus-cyl', size: 0.25, shape: must(booleanSolids(boxS, cyl, 'difference')) },
  { id: 'flange-bolt6', size: 5, shape: pattern('bolt6') },
  { id: 'flange-bolt12', size: 5, shape: pattern('bolt12') },
  {
    id: 'housing',
    size: 0.25,
    shape: must(
      housing({
        size: [2.6, 1, 1],
        bossX: 0.8,
        bossRadius: 0.3,
        bossHeight: 1.6,
        boreRadius: 0.15,
      }),
    ),
  },
];

const rows: Record<string, unknown>[] = [];
for (const c of cases) {
  for (const mode of ['quad-dominant', 'blossom-row'] as const) {
    const r = quadrangulate(c.shape, { size: c.size, trimmed: mode, source: 'boolean' });
    rows.push(summarise(c.id, mode, r, mode));
  }
  const d1 = quadrangulate(c.shape, {
    size: c.size,
    trimmed: 'blossom-row',
    source: 'boolean',
    fallback: 'split-3',
  });
  rows.push(summarise(c.id, 'blossom-row+split-3', d1, 'blossom-row'));
}

function summarise(
  id: string,
  label: string,
  r: ReturnType<typeof quadrangulate>,
  mode: 'quad-dominant' | 'blossom-row',
): Record<string, unknown> {
  if (!r.ok) {
    return {
      id,
      mode: label,
      status: 'fail-closed',
      code: r.error.code,
      detail: r.error.detail ?? {},
    };
  }
  const rep = r.value.report;
  const minSj = Math.min(...r.value.faceQuality.map((f) => f.minSj));
  const folded = r.value.faceQuality.reduce((n, f) => n + f.foldedPairs, 0);
  const tris = r.value.faceQuality.reduce((n, f) => n + f.triangles, 0);
  const split3Faces = r.value.faceQuality.filter((f) => f.split3).length;
  const views = renderShape([r.value.mesh], {
    name: `${id}-${label}`,
    modes: ['shaded', 'network'],
    views: ['iso', 'top'],
    outDir,
    colorBy: 'face',
  });
  return {
    id,
    mode: label,
    rowMode: mode,
    density: r.value.curvedDensity,
    status: 'ok',
    quads: rep.quads,
    tris,
    minSj,
    open: rep.openEdges,
    nm: rep.nonManifoldEdges,
    folded,
    split3Faces,
    pngs: views.ok ? views.value.views.map((v) => v.path) : String(views.error),
  };
}

writeFileSync(`${outDir}summary.json`, JSON.stringify(rows, null, 2));
for (const r of rows)
  console.log(
    JSON.stringify({
      id: r.id,
      mode: r.mode,
      density: r.density,
      status: r.status,
      quads: r.quads,
      tris: r.tris,
      minSj: r.minSj,
      open: r.open,
      nm: r.nm,
      folded: r.folded,
      code: r.code,
    }),
  );
