// Re-runs of older examples on the current trunk, so their stamped numbers and images are current:
//   qf-m1   boundary-row (blossom-row) cap statistics and front/network images (quad-feature-baseline/run.ts), run twice:
//           without a fallback and with QF_FALLBACK=split-3 (opt-in; closes the refused faces all-quad)
//   e1b     trim-curve classification of an arc on a box face (e1b-trim)
//   e1c     boolean in/out/on classification renders (e1c-boolean/render.ts, run as a child process)
// The older scripts keep their own output logic; this file only redirects, registers and condenses.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { contactSheet, mergeScenes, renderScene, STANDARD_VIEWS } from '../brep-kit/index.ts';
import { renderShape } from '../brep-kit/render.ts';
import type { SheetCell } from '../brep-kit/sheet.ts';
import { classifiedArc } from '../e1b-trim/arc.ts';
import { classifyArc } from '../e1b-trim/trim.ts';
import { finish, loadPng, OUT, record, refusalImage, registerPng, saveSheet } from './common.ts';

const here = new URL('../', import.meta.url).pathname;

function pngsUnder(rel: string): string[] {
  return readdirSync(join(OUT, rel))
    .filter((f) => f.endsWith('.png'))
    .map((f) => `${rel}/${f}`);
}

// ---- qf-m1 -----------------------------------------------------------------------------------------------------------
// Two variants per case, each in a child process: without a fallback (blossom-row fails closed where it cannot close
// all-quad, the #604/#611 contract) and with QF_FALLBACK=split-3 (the opt-in fallback that closes those faces all-quad).
interface QfRow {
  id: string;
  mode: string;
  status: string;
  code?: string;
  detail?: string;
  report?: Record<string, unknown>;
  caps?: Record<string, number | string>[];
}
const round = (v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const CAP_KEYS = [
  'cap',
  'quads',
  'triangles',
  'boundaryQuads',
  'cornerWithin10',
  'quadOrthoVertexWithin10',
  'rowOrthoVertexWithin10',
  'rowParallelWithin10',
  'worstCornerDevDeg',
];
const qfByVariant: Record<string, QfRow[]> = {};
for (const variant of [
  { rel: 'reruns/qf-m1', fallback: 'none' },
  { rel: 'reruns/qf-m1-split3', fallback: 'split-3' },
] as const) {
  mkdirSync(join(OUT, variant.rel), { recursive: true });
  execFileSync(
    process.execPath,
    [
      '--import',
      new URL('./register-entry.mjs', import.meta.url).pathname,
      '--experimental-strip-types',
      join(here, 'quad-feature-baseline', 'run.ts'),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      env: {
        ...process.env,
        QF_OUT: `${join(OUT, variant.rel)}/`,
        ...(variant.fallback === 'split-3' ? { QF_FALLBACK: 'split-3' } : {}),
      },
    },
  );
  const rows = JSON.parse(readFileSync(join(OUT, variant.rel, 'summary.json'), 'utf8')) as QfRow[];
  qfByVariant[variant.fallback] = rows;
  for (const r of rows)
    record({
      row: 'qf-m1-rerun',
      fallback: variant.fallback,
      id: r.id,
      mode: r.mode,
      status: r.status,
      code: r.code,
      detail: r.detail,
      totals: r.report,
      caps: r.caps?.map((c) => Object.fromEntries(CAP_KEYS.map((k) => [k, round(c[k])]))),
    });
  for (const rel of pngsUnder(variant.rel)) registerPng(rel);
}

// Side by side per case: blossom-row without a fallback (refusal reason) and with split-3 (all-quad closure).
function qfCompareSheet(view: 'iso' | 'top'): void {
  const cells: SheetCell[] = [];
  const none = qfByVariant.none ?? [];
  const split = qfByVariant['split-3'] ?? [];
  for (const a of none.filter((r) => r.mode === 'blossom-row')) {
    const b = split.find((r) => r.id === a.id && r.mode === 'blossom-row');
    const stat = (r: QfRow | undefined): string => {
      const rep = r?.report as
        | { quads?: number; triangles?: number; scaledJacobian?: { min: number } }
        | undefined;
      return rep === undefined
        ? 'no mesh'
        : `q${rep.quads} t${rep.triangles} minSJ ${round(rep.scaledJacobian?.min)}`;
    };
    if (a.status === 'ok') {
      cells.push({
        image: loadPng(`reruns/qf-m1/${a.id}-blossom-rownetwork-${view}.png`),
        caption: `${a.id} no fallback: ${stat(a)}`,
      });
    } else {
      const reason = /"reason":"([^"]+)"/.exec(a.detail ?? '')?.[1] ?? 'unknown';
      cells.push({
        image: refusalImage([`REFUSED ${a.code ?? ''}`, reason]),
        caption: `${a.id} no fallback: REFUSED ${reason}`,
      });
    }
    cells.push(
      b?.status === 'ok'
        ? {
            image: loadPng(`reruns/qf-m1-split3/${a.id}-blossom-rownetwork-${view}.png`),
            caption: `${a.id} split-3 fallback: ${stat(b)}`,
          }
        : {
            image: refusalImage(['REFUSED', String(b?.code)]),
            caption: `${a.id} split-3 fallback: REFUSED`,
          },
    );
  }
  saveSheet(`sheets/qf-m1-blossom-fallback-${view}.png`, cells, {
    columns: 2,
    cell: 460,
    title: `qf-m1 blossom-row ${view}: no fallback (all-quad contract) vs QF_FALLBACK=split-3`,
  });
}
qfCompareSheet('iso');
qfCompareSheet('top');

// ---- e1b-trim --------------------------------------------------------------------------------------------------------
const e1bRel = 'reruns/e1b-trim';
const e1bDir = join(OUT, e1bRel);
mkdirSync(e1bDir, { recursive: true });
const arc = classifyArc();
const views = (['iso', 'front', 'top'] as const).filter((v) => STANDARD_VIEWS.includes(v));
const shaped = renderShape([arc.top, arc.side], {
  outDir: e1bDir,
  name: 'pair-',
  modes: ['features', 'network'],
  views,
});
if (!shaped.ok) throw new Error('e1b render failed');
const arcScene = classifiedArc(arc.top, arc.topFace, arc.branch);
const cells = views.flatMap((v) => {
  const feat = shaped.value.views.find((x) => x.mode === 'features' && x.view === v);
  const arcView = renderScene(mergeScenes(arcScene), v, { size: 640 });
  return [
    { image: feat?.image ?? arcView, caption: `features ${v}` },
    { image: arcView, caption: `classified arc ${v}` },
  ];
});
contactSheet(cells, { columns: 2, path: join(e1bDir, 'sheet.png') });
record({
  row: 'e1b-trim-rerun',
  arcSamples: arc.arcSamples,
  in: arc.inCount,
  out: arc.outCount,
  on: arc.onCount,
  seamCuts: arc.seamCuts,
  spans: arc.spans,
});
for (const rel of pngsUnder(e1bRel)) registerPng(rel);

// ---- e1c-boolean -----------------------------------------------------------------------------------------------------
const e1cRel = 'reruns/e1c-boolean';
const e1cOut = join(here, 'e1c-boolean', 'out');
const stdout = execFileSync(
  process.execPath,
  [
    '--import',
    new URL('./register-entry.mjs', import.meta.url).pathname,
    '--experimental-strip-types',
    join(here, 'e1c-boolean', 'render.ts'),
  ],
  { encoding: 'utf8', maxBuffer: 1 << 24 },
);
mkdirSync(join(OUT, e1cRel), { recursive: true });
cpSync(e1cOut, join(OUT, e1cRel), { recursive: true });
rmSync(e1cOut, { recursive: true, force: true });
record({ row: 'e1c-boolean-rerun', report: JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') });
for (const rel of pngsUnder(e1cRel)) registerPng(rel);

finish('rows-reruns');
