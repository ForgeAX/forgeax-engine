// ssi-nurbs-plane: NURBS x plane and NURBS x cylinder sections rendered with brep-kit. The manifold
// S-bend and lofted round-to-rectangle transition are cut by a mid-plane and by a cross-bore cylinder
// through their wall. Every cut goes through the public intersectSurfaces route with the default
// window (the NURBS control-net box). Section curves are drawn over the shaded part in iso, front and
// top views. PNGs and a report go to examples/ssi-nurbs-plane/renders/ and, copied, to the viz-out
// folder.
//
//   pnpm vitest run examples/ssi-nurbs-plane/__tests__/render.test.ts
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { intersectSurfaces } from '../../../src/brep/intersect.ts';
import { makeFrame, surfacePoint } from '../../../src/brep/surfaces.ts';
import type { Surface } from '../../../src/brep/types.ts';
import type { P3 } from '../../../src/brep/vec.ts';
import { curvePoint, surfaceDomain } from '../../../src/nurbs.ts';
import type { ViewSpec } from '../../brep-kit/camera.ts';
import { PART_PALETTE, paletteAt } from '../../brep-kit/colors.ts';
import { type Image, toPng } from '../../brep-kit/image.ts';
import { renderScene } from '../../brep-kit/raster.ts';
import type { Scene, SceneLine, SceneTri } from '../../brep-kit/scene.ts';
import { contactSheet } from '../../brep-kit/sheet.ts';
import { buildManifold, MANIFOLD } from '../../manifold/showcase.ts';
import { vizOutputDir } from '../../test-output.ts';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(here, 'renders');
const vizDir = vizOutputDir('ssi-nurbs-plane');
mkdirSync(outDir, { recursive: true });
mkdirSync(vizDir, { recursive: true });

const GRID = 40;
const SAMPLES = 64;
const TOL = 1e-7;
const VIEWS: readonly ViewSpec[] = ['iso', 'front', 'top'];
const PLANE_HALF = 6;
const CUT_COLOR: readonly [number, number, number] = [220, 30, 30];
const BORE_COLOR: readonly [number, number, number] = [30, 120, 230];
type Box = [[number, number], [number, number]];
type Analytic = Extract<Surface, { kind: 'plane' | 'cylinder' }>;

/** One cut of a manifold part: a mid-plane (normal x) or a cross-bore cylinder (axis z). */
interface Cut {
  readonly name: 'mid-plane' | 'bore';
  readonly analytic: Analytic;
  readonly color: readonly [number, number, number];
}

interface Part {
  readonly name: 's-bend' | 'transition';
  readonly origin: readonly [number, number, number];
}

const PARTS: readonly Part[] = [
  { name: 's-bend', origin: [-3, 0, 0] },
  { name: 'transition', origin: [7.15, 0, 0] },
];

/** Centre of the part's mid-plane section: the mean of its sampled section points. */
function sectionCentre(part: Part): P3 {
  const plane: Analytic = { kind: 'plane', frame: makeFrame([...part.origin], [1, 0, 0]) };
  let sum: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (const face of nurbsFaces(part.name)) {
    const r = intersectSurfaces(face, plane, TOL);
    if (!r.ok) throw new Error(`${part.name} section centre: ${JSON.stringify(r.error)}`);
    for (const b of r.value.branches)
      for (const p of sampleCurve(b.curve, b.t0, b.t1)) {
        sum = [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]];
        count++;
      }
  }
  if (count === 0) throw new Error(`${part.name}: empty mid-plane section`);
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

/** Mid-plane (normal x) at the part origin; cross-bore (axis z, radius bore) through the section centre. */
function cutsFor(part: Part): Cut[] {
  const centre = sectionCentre(part);
  return [
    {
      name: 'mid-plane',
      analytic: { kind: 'plane', frame: makeFrame([...part.origin], [1, 0, 0]) },
      color: CUT_COLOR,
    },
    {
      name: 'bore',
      analytic: {
        kind: 'cylinder',
        frame: makeFrame([...centre], [0, 0, 1]),
        radius: MANIFOLD.bore,
      },
      color: BORE_COLOR,
    },
  ];
}

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

/** The NURBS faces of one manifold part, from the same build the showcase example uses. */
function nurbsFaces(name: string): Extract<Surface, { kind: 'nurbs' }>[] {
  const m = buildManifold();
  const part = m.parts[m.names.indexOf(name)];
  if (part === undefined) throw new Error(`manifold part ${name} missing`);
  const out: Extract<Surface, { kind: 'nurbs' }>[] = [];
  for (const f of part.faces) {
    const s = part.surfaces[f.surface];
    if (s !== undefined && s.kind === 'nurbs') out.push(s);
  }
  return out;
}

/** Sampled 3D points of a marched branch curve over its parameter range. */
function sampleCurve(curve: { kind: string; curve?: unknown }, t0: number, t1: number): P3[] {
  if (curve.kind !== 'nurbs') return [];
  const nurbs = curve.curve as Parameters<typeof curvePoint>[0];
  const pts: P3[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = t0 + ((t1 - t0) * i) / SAMPLES;
    const p = curvePoint(nurbs, t);
    pts.push([p[0], p[1], p[2]]);
  }
  return pts;
}

/** Render one part with one cut: every NURBS face tessellated, the cut's section curves drawn over it. */
function renderCut(part: Part, cut: Cut): { views: Image[]; summary: string } {
  const faces = nurbsFaces(part.name);
  const tris: SceneTri[] = [];
  const lines: SceneLine[] = [];
  let branches = 0;
  let closed = 0;
  let partials = 0;
  let facesClean = 0;
  let maxBound = 0;
  for (const face of faces) {
    const r = intersectSurfaces(face, cut.analytic, TOL);
    if (!r.ok) throw new Error(`${part.name} ${cut.name}: ${JSON.stringify(r.error)}`);
    const res = r.value;
    branches += res.branches.length;
    closed += res.branches.filter((b) => b.closed).length;
    partials += res.partials.length;
    if (res.partials.length === 0) facesClean++;
    for (const b of res.branches) {
      if (b.receipt !== undefined && typeof b.receipt === 'object')
        maxBound = Math.max(maxBound, b.receipt.bound);
      const pts = sampleCurve(b.curve, b.t0, b.t1);
      if (pts.length === 0) continue;
      lines.push({
        points: b.closed ? [...pts, pts[0] as P3] : pts,
        color: cut.color,
        width: 3.5,
      });
    }
    tris.push(
      ...tessellate(
        (u, v) => surfacePoint(face, u, v),
        surfaceDomain(face.surface) as Box,
        paletteAt(PART_PALETTE, 0),
      ),
    );
  }
  if (cut.analytic.kind === 'plane') {
    const plane = cut.analytic;
    const box: Box = [
      [-PLANE_HALF, PLANE_HALF],
      [-PLANE_HALF, PLANE_HALF],
    ];
    tris.push(...tessellate((u, v) => surfacePoint(plane, u, v), box, paletteAt(PART_PALETTE, 1)));
  }
  const scene: Scene = { tris, lines, markers: [] };
  const views = VIEWS.map((v) => renderScene(scene, v, { size: 360 }));
  const summary =
    `${part.name}-${cut.name}: faces ${faces.length}, faces without partials ${facesClean}, ` +
    `branches ${branches}, closed ${closed}, partials ${partials}, max bound ${maxBound.toExponential(2)}`;
  return { views, summary };
}

it('renders the manifold NURBS parts cut by a mid-plane and a cross-bore', {
  timeout: 600000,
}, () => {
  const cells: { image: Image; caption: string }[] = [];
  const report: string[] = [];
  const written: string[] = [];
  for (const part of PARTS) {
    for (const cut of cutsFor(part)) {
      const label = `${part.name}-${cut.name}`;
      const { views, summary } = renderCut(part, cut);
      report.push(summary);
      views.forEach((image, i) => {
        const view = VIEWS[i] as ViewSpec;
        const file = `${label}-${view}.png`;
        writeFileSync(join(outDir, file), toPng(image));
        written.push(file);
        cells.push({ image, caption: `${label} ${view}` });
      });
    }
  }
  writeFileSync(
    join(outDir, 'contact-sheet.png'),
    toPng(contactSheet(cells, { columns: VIEWS.length })),
  );
  writeFileSync(join(outDir, 'report.txt'), `${report.join('\n')}\n`);
  for (const file of ['contact-sheet.png', 'report.txt', ...written])
    copyFileSync(join(outDir, file), join(vizDir, file));
});
