// ssi-nurbs-nurbs: two bicubic NURBS blades that cross each other, intersected through the public
// intersectSurfaces route (NURBS x NURBS, no window). Each blade is a tapered, bulged cubic patch;
// the section curves the marcher returns are drawn over the shaded blades in iso, front and top
// views. PNGs and a report go to examples/ssi-nurbs-nurbs/renders/ and, copied, to the viz-out folder.
//
//   pnpm vitest run examples/ssi-nurbs-nurbs/__tests__/render.test.ts
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { intersectSurfaces } from '../../../src/brep/intersect.ts';
import { surfacePoint } from '../../../src/brep/surfaces.ts';
import type { Surface } from '../../../src/brep/types.ts';
import type { P3 } from '../../../src/brep/vec.ts';
import { curvePoint, surfaceDomain } from '../../../src/nurbs.ts';
import type { ViewSpec } from '../../brep-kit/camera.ts';
import { PART_PALETTE, paletteAt } from '../../brep-kit/colors.ts';
import { type Image, toPng } from '../../brep-kit/image.ts';
import { renderScene } from '../../brep-kit/raster.ts';
import type { Scene, SceneLine, SceneTri } from '../../brep-kit/scene.ts';
import { contactSheet } from '../../brep-kit/sheet.ts';
import { vizOutputDir } from '../../test-output.ts';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(here, 'renders');
const vizDir = vizOutputDir('ssi-nurbs-nurbs');
mkdirSync(outDir, { recursive: true });
mkdirSync(vizDir, { recursive: true });

const GRID = 40;
const SAMPLES = 64;
const TOL = 1e-7;
const VIEWS: readonly ViewSpec[] = ['iso', 'front', 'top'];
const CUT_COLOR: readonly [number, number, number] = [220, 30, 30];
type Box = [[number, number], [number, number]];

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V): V => {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  return mul(a, 1 / l);
};

/**
 * A cubic blade: the span runs along `span` (length `len`), the chord along `chord` (width `wid`).
 * The width tapers from the root to the tip and the middle bulges along the blade normal, so the
 * patch is genuinely curved rather than a plane.
 */
function blade(origin: V, span: V, chord: V, len: number, wid: number, bulge: number): Surface {
  const n = norm(cross(span, chord));
  const points: V[][] = [];
  for (let i = 0; i < 4; i++) {
    const s = i / 3;
    const taper = 1 - 0.55 * s;
    const row: V[] = [];
    for (let j = 0; j < 4; j++) {
      const c = (j / 3 - 0.5) * wid * taper;
      const lift = bulge * Math.sin(Math.PI * s) * (1 - 4 * (j / 3 - 0.5) ** 2);
      row.push(add(add(add(origin, mul(span, s * len)), mul(chord, c)), mul(n, lift)));
    }
    points.push(row);
  }
  return {
    kind: 'nurbs',
    surface: {
      degreeU: 3,
      degreeV: 3,
      points: points as unknown as Extract<Surface, { kind: 'nurbs' }>['surface']['points'],
      knotsU: [0, 0, 0, 0, 1, 1, 1, 1],
      knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
    },
  } as Surface;
}

type Nurbs = Extract<Surface, { kind: 'nurbs' }>;

const BLADES: readonly { name: string; face: Nurbs }[] = [
  {
    name: 'blade-a',
    face: blade([-4, -2.2, -0.6], [1, 0, 0.35], [0, 1, 0], 8, 4.4, 0.9) as Nurbs,
  },
  {
    name: 'blade-b',
    face: blade([-0.4, -3.4, -0.2], [0.1, 1, 0.5], [1, 0, 0.1], 6.8, 4.2, 0.8) as Nurbs,
  },
];

function tessellate(face: Nurbs, color: readonly [number, number, number]): SceneTri[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(face.surface) as Box;
  const at = (i: number, j: number): P3 =>
    surfacePoint(face, u0 + ((u1 - u0) * i) / GRID, v0 + ((v1 - v0) * j) / GRID);
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

/** Sampled 3D points of a marched branch curve over its parameter range. */
function sampleCurve(curve: { kind: string; curve?: unknown }, t0: number, t1: number): P3[] {
  if (curve.kind !== 'nurbs') return [];
  const nurbs = curve.curve as Parameters<typeof curvePoint>[0];
  const pts: P3[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const p = curvePoint(nurbs, t0 + ((t1 - t0) * i) / SAMPLES);
    pts.push([p[0], p[1], p[2]]);
  }
  return pts;
}

it('renders two crossing NURBS blades and their marched intersection curves', {
  timeout: 600000,
}, () => {
  const a = BLADES[0]!;
  const b = BLADES[1]!;
  const r = intersectSurfaces(a.face, b.face, TOL, { ids: [1, 2] });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const res = r.value;
  const lines: SceneLine[] = [];
  let maxBound = 0;
  for (const br of res.branches) {
    if (typeof br.receipt === 'object') maxBound = Math.max(maxBound, br.receipt.bound);
    const pts = sampleCurve(br.curve, br.t0, br.t1);
    if (pts.length === 0) continue;
    lines.push({ points: br.closed ? [...pts, pts[0] as P3] : pts, color: CUT_COLOR, width: 3.5 });
  }
  const tris = [
    ...tessellate(a.face, paletteAt(PART_PALETTE, 0)),
    ...tessellate(b.face, paletteAt(PART_PALETTE, 1)),
  ];
  const scene: Scene = { tris, lines, markers: [] };
  const cells: { image: Image; caption: string }[] = [];
  const written: string[] = [];
  for (const view of VIEWS) {
    const image = renderScene(scene, view, { size: 360 });
    const file = `blade-blade-${view}.png`;
    writeFileSync(join(outDir, file), toPng(image));
    written.push(file);
    cells.push({ image, caption: `blade x blade ${view}` });
  }
  const summary =
    `blade-a x blade-b: branches ${res.branches.length}, closed ${res.branches.filter((x) => x.closed).length}, ` +
    `partials ${res.partials.length} (${res.partials.map((p) => p.code).join(',') || 'none'}), ` +
    `max bound ${maxBound.toExponential(2)}`;
  writeFileSync(
    join(outDir, 'contact-sheet.png'),
    toPng(contactSheet(cells, { columns: VIEWS.length })),
  );
  writeFileSync(join(outDir, 'report.txt'), `${summary}\n`);
  for (const file of ['contact-sheet.png', 'report.txt', ...written])
    copyFileSync(join(outDir, file), join(vizDir, file));
});
