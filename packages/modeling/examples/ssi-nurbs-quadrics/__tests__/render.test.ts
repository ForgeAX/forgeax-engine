// ssi-nurbs-quadrics: the manifold NURBS parts (S-bend pipe and lofted transition) cut by a sphere, a
// cone and a torus, each placed on the part. Every cut goes through intersectSurfaces with the default
// window (the NURBS control-net box). Section curves are drawn over the shaded part in iso, front and
// top views, with a report of branch, closed, partial and bound counts. PNGs and a report go to
// examples/ssi-nurbs-quadrics/renders/ and, copied, to the viz-out folder.
//
//   pnpm vitest run examples/ssi-nurbs-quadrics/__tests__/render.test.ts
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
const vizDir = vizOutputDir('ssi-nurbs-quadrics');
mkdirSync(outDir, { recursive: true });
mkdirSync(vizDir, { recursive: true });

const GRID = 40;
const SAMPLES = 64;
const TOL = 1e-7;
const VIEWS: readonly ViewSpec[] = ['iso', 'front', 'top'];
const CUT_COLOR: readonly [number, number, number] = [220, 30, 30];
type Box = [[number, number], [number, number]];
type Nurbs = Extract<Surface, { kind: 'nurbs' }>;

interface Part {
  readonly name: 's-bend' | 'transition';
}
const PARTS: readonly Part[] = [{ name: 's-bend' }, { name: 'transition' }];

/** The three quadric cutters, each centred on the part's section centre. */
function cutters(
  centre: P3,
): { name: string; surface: Surface; color: readonly [number, number, number] }[] {
  const frame = makeFrame([...centre], [0, 0, 1]);
  return [
    {
      name: 'sphere',
      surface: { kind: 'sphere', frame, radius: MANIFOLD.pipe * 1.6 },
      color: [30, 120, 230],
    },
    {
      name: 'cone',
      surface: { kind: 'cone', frame, radius: MANIFOLD.bore * 0.6, halfAngle: 0.35 },
      color: [40, 180, 90],
    },
    {
      name: 'torus',
      surface: { kind: 'torus', frame, major: MANIFOLD.pipe * 2.2, minor: MANIFOLD.pipe * 0.35 },
      color: [230, 170, 30],
    },
  ];
}

function nurbsFaces(name: string): Nurbs[] {
  const m = buildManifold();
  const part = m.parts[m.names.indexOf(name)];
  if (part === undefined) throw new Error(`manifold part ${name} missing`);
  const out: Nurbs[] = [];
  for (const f of part.faces) {
    const s = part.surfaces[f.surface];
    if (s !== undefined && s.kind === 'nurbs') out.push(s);
  }
  return out;
}

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

/** Centre of the part's own sampled section centre, used to place each cutter on the part. */
function partCentre(faces: Nurbs[]): P3 {
  let sum: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (const f of faces)
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const [[u0, u1], [v0, v1]] = surfaceDomain(f.surface) as Box;
        const p = surfacePoint(f, u0 + ((u1 - u0) * i) / 8, v0 + ((v1 - v0) * j) / 8);
        sum = [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]];
        count++;
      }
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

it('renders the manifold NURBS parts cut by a sphere, a cone and a torus', {
  timeout: 600000,
}, () => {
  const cells: { image: Image; caption: string }[] = [];
  const report: string[] = [];
  const written: string[] = [];
  for (const part of PARTS) {
    const faces = nurbsFaces(part.name);
    for (const cutter of cutters(partCentre(faces))) {
      const tris: SceneTri[] = [];
      const lines: SceneLine[] = [];
      let branches = 0;
      let closed = 0;
      let partials = 0;
      let maxBound = 0;
      faces.forEach((face, fi) => {
        const r = intersectSurfaces(face, cutter.surface, TOL);
        if (!r.ok) throw new Error(`${part.name} ${cutter.name}: ${JSON.stringify(r.error)}`);
        branches += r.value.branches.length;
        closed += r.value.branches.filter((b) => b.closed).length;
        partials += r.value.partials.length;
        for (const b of r.value.branches) {
          if (typeof b.receipt === 'object') maxBound = Math.max(maxBound, b.receipt.bound);
          const pts = sampleCurve(b.curve, b.t0, b.t1);
          if (pts.length === 0) continue;
          lines.push({
            points: b.closed ? [...pts, pts[0] as P3] : pts,
            color: CUT_COLOR,
            width: 3.5,
          });
        }
        tris.push(...tessellate(face, paletteAt(PART_PALETTE, fi % 2)));
      });
      const scene: Scene = { tris, lines, markers: [] };
      const label = `${part.name}-${cutter.name}`;
      report.push(
        `${label}: faces ${faces.length}, branches ${branches}, closed ${closed}, partials ${partials}, max bound ${maxBound.toExponential(2)}`,
      );
      for (const view of VIEWS) {
        const image = renderScene(scene, view, { size: 360 });
        const file = `${label}-${view}.png`;
        writeFileSync(join(outDir, file), toPng(image));
        written.push(file);
        cells.push({ image, caption: `${label} ${view}` });
      }
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
