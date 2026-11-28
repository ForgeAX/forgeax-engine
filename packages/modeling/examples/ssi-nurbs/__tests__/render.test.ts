// ssi-nurbs: NURBS surface vs analytic surface intersections, rendered with brep-kit.
//
//   pnpm vitest run examples/ssi-nurbs/__tests__/render.test.ts
//
// Each case shades the NURBS patch and the analytic patch on a grid and overlays the marched
// intersection branches as bold red polylines. PNGs and a report go to examples/ssi-nurbs/renders/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { type SsiPair, ssiCorpus } from '../../../src/brep/__tests__/ssi/corpus.ts';
import type { Patch } from '../../../src/brep/__tests__/ssi/wrap.ts';
import { intersectFaces } from '../../../src/brep/ssi/index.ts';
import { surfacePoint } from '../../../src/brep/surfaces.ts';
import type { P3 } from '../../../src/brep/vec.ts';
import { surfaceDomain } from '../../../src/nurbs.ts';
import type { ViewSpec } from '../../brep-kit/camera.ts';
import { PART_PALETTE, paletteAt } from '../../brep-kit/colors.ts';
import { type Image, toPng } from '../../brep-kit/image.ts';
import { renderScene } from '../../brep-kit/raster.ts';
import type { Scene, SceneLine, SceneTri } from '../../brep-kit/scene.ts';
import { contactSheet } from '../../brep-kit/sheet.ts';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(here, 'renders');
mkdirSync(outDir, { recursive: true });

const GRID = 40;
const VIEWS: readonly ViewSpec[] = ['iso', 'front', 'top'];
const CASES = [
  'plane-sphere',
  'plane-cylinder-oblique',
  'sphere-cylinder-through',
  'plane-torus-equator',
];
type Box = [[number, number], [number, number]];

function analyticBox(p: Patch): Box {
  return p.surface.kind === 'plane'
    ? [
        [-p.half, p.half],
        [-p.half, p.half],
      ]
    : [[0, 2 * Math.PI], [...p.v]];
}

/** Two-triangle-per-cell tessellation of a parametric patch over `box`. */
function tessellate(
  eval_: (u: number, v: number) => P3,
  box: Box,
  color: readonly [number, number, number],
): SceneTri[] {
  const [[u0, u1], [v0, v1]] = box;
  const at = (i: number, j: number): P3 =>
    eval_(u0 + ((u1 - u0) * i) / GRID, v0 + ((v1 - v0) * j) / GRID);
  const tris: SceneTri[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      tris.push({ a, b, c, color }, { a, b: c, c: d, color });
    }
  }
  return tris;
}

function nurbsBox(pair: SsiPair): Box {
  const [[u0, u1], [v0, v1]] = surfaceDomain(pair.a);
  return [
    [u0, u1],
    [v0, v1],
  ];
}

function renderCase(id: string): { views: Image[]; caption: string; summary: string } {
  const pair = ssiCorpus().find((p) => p.id === id);
  const patch = pair?.patches?.b;
  if (pair === undefined || patch === undefined)
    throw new Error(`${id}: no analytic patch in the corpus`);

  const boxB = analyticBox(patch);
  const boxA = nurbsBox(pair);
  const r = intersectFaces(
    { surface: { kind: 'nurbs', surface: pair.a } },
    { surface: patch.surface, bounds: boxB },
  );
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.error)}`);
  const res = r.value;

  const tris: SceneTri[] = [
    ...tessellate(
      (u, v) => surfacePoint({ kind: 'nurbs', surface: pair.a }, u, v),
      boxA,
      paletteAt(PART_PALETTE, 0),
    ),
    ...tessellate((u, v) => surfacePoint(patch.surface, u, v), boxB, paletteAt(PART_PALETTE, 1)),
  ];
  const lines: SceneLine[] = res.branches.map((b) => ({
    points: b.closed ? [...b.points, b.points[0] as P3] : b.points,
    color: [220, 30, 30],
    width: 3.5,
  }));
  const scene: Scene = { tris, lines, markers: [] };

  const views = VIEWS.map((v) => renderScene(scene, v, { size: 360 }));
  const summary = `${id}: status ${res.status}, branches ${res.branches.length}, closed ${res.branches.filter((b) => b.closed).length}, issues ${res.issues.length}, max bound ${Math.max(0, ...res.branches.map((b) => b.bound)).toExponential(2)}`;
  return { views, caption: id, summary };
}

it('renders NURBS vs analytic intersection pictures', () => {
  const cells: { image: Image; caption: string }[] = [];
  const report: string[] = [];
  for (const id of CASES) {
    const { views, caption, summary } = renderCase(id);
    report.push(summary);
    views.forEach((image, i) => {
      const view = VIEWS[i] as ViewSpec;
      writeFileSync(join(outDir, `${id}-${view}.png`), toPng(image));
      cells.push({ image, caption: `${caption} ${view}` });
    });
  }
  writeFileSync(
    join(outDir, 'contact-sheet.png'),
    toPng(contactSheet(cells, { columns: VIEWS.length })),
  );
  writeFileSync(join(outDir, 'report.txt'), `${report.join('\n')}\n`);
});
