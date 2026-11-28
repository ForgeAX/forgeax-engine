// M2 quad examples on boolean results: run the existing B-rep quad path on the e1c boolean shapes and report
// per-case quad count, open edges, folded pairs, minimum scaled Jacobian, and fail-closed faces with reasons.
import { mkdirSync, writeFileSync } from 'node:fs';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import { housing } from '../../src/brep/housing.ts';
import { type QuadSource, quadrangulate } from '../../src/brep/quad.ts';
import { IDENTITY_PLACEMENT, transformShape } from '../../src/brep/transform.ts';
import type { Shape } from '../../src/brep/types.ts';
import { renderShape } from '../brep-kit/render.ts';

const outDir = new URL('../../../../_scratch/viz-out/quad-boolean/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error).slice(0, 300)}`);
  return r.value;
}

function place(s: Shape, z: number, x = 0): Shape {
  return must(transformShape(s, { ...IDENTITY_PLACEMENT, t: [x, 0, z] }));
}

const boxS = must(box({ size: [2.6, 1, 1], label: 'box' }));
const cyl = must(cylinder({ radius: 0.3, height: 3, label: 'cyl' }));
const bossS = place(must(cylinder({ radius: 0.3, height: 1, label: 'boss' })), 0.5, 0.8);

const minus = must(booleanSolids(boxS, cyl, 'difference'));
const plus = must(booleanSolids(boxS, bossS, 'union'));
const bore1 = must(booleanSolids(boxS, cyl, 'difference'));
const bore2 = must(booleanSolids(bore1, place(cyl, 0, 0.8), 'difference'));
const house = must(
  housing({ size: [2.6, 1, 1], bossX: 0.8, bossRadius: 0.3, bossHeight: 1.6, boreRadius: 0.15 }),
);

const cases: { id: string; name: string; shape: Shape }[] = [
  { id: 'minus', name: 'box minus through cylinder', shape: minus },
  { id: 'plus', name: 'box plus through-rising boss', shape: plus },
  { id: 'chain', name: 'chained box + bore + second bore', shape: bore2 },
  { id: 'housing', name: 'placed housing', shape: house },
];

const rows: Record<string, unknown>[] = [];
const rendered: Record<string, string[]> = {};
for (const c of cases) {
  for (const mode of ['blossom', 'blossom-penalty', 'quad-dominant'] as const) {
    const source: QuadSource = 'boolean';
    const r = quadrangulate(c.shape, { size: 0.25, trimmed: mode, source });
    if (!r.ok) {
      rows.push({
        id: c.id,
        name: c.name,
        mode,
        status: 'fail-closed',
        code: r.error.code,
        reason: r.error.hint ?? '',
        detail: JSON.stringify(r.error.detail ?? {}).slice(0, 600),
      });
      continue;
    }
    const rep = r.value.report;
    if (mode === 'blossom-penalty' || mode === 'quad-dominant') {
      const prefix = mode === 'quad-dominant' ? 'qd-' : '';
      const views = renderShape([r.value.mesh], {
        name: `${prefix}${c.id}-quad-src-boolean-`,
        modes: ['network'],
        outDir,
        colorBy: 'face',
        label: true,
      });
      const feats = renderShape(c.shape, {
        name: `${prefix}${c.id}-feat-src-boolean-`,
        modes: ['features'],
        outDir,
        label: true,
      });
      rendered[c.id] = [
        ...(views.ok ? views.value.views.map((v) => v.path ?? '') : []),
        ...(feats.ok ? feats.value.views.map((v) => v.path ?? '') : []),
      ];
    }
    rows.push({
      id: c.id,
      name: c.name,
      mode,
      status: 'ok',
      quads: rep.quads,
      openEdges: rep.openEdges,
      nonManifoldEdges: rep.nonManifoldEdges,
      degenerate: rep.degenerate,
      minSj: rep.scaledJacobian.min,
      faceQuality: r.value.faceQuality,
      pngs: mode === 'blossom-penalty' || mode === 'quad-dominant' ? (rendered[c.id] ?? []) : [],
    });
  }
}
writeFileSync(`${outDir}summary.json`, JSON.stringify(rows, null, 2));
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
