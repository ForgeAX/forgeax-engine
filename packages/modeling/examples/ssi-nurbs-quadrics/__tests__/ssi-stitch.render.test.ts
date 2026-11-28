import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { curvePoint as brepCurvePoint } from '../../../src/brep/curves.ts';
import { intersectSurfaces } from '../../../src/brep/intersect.ts';
import { type JoinBranch, joinBranches } from '../../../src/brep/query/stitch.ts';
import { makeFrame, surfacePoint } from '../../../src/brep/surfaces.ts';
import { surfaceDomain } from '../../../src/nurbs.ts';
import { toPng } from '../../brep-kit/image.ts';
import { renderScene } from '../../brep-kit/raster.ts';
import type { Scene, SceneLine, SceneMarker } from '../../brep-kit/scene.ts';
import { buildManifold, MANIFOLD } from '../../manifold/showcase.ts';
import { vizOutputDir } from '../../test-output.ts';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(here, 'renders-stitch');
const vizDir = vizOutputDir('ssi-stitch');
mkdirSync(outDir, { recursive: true });
mkdirSync(vizDir, { recursive: true });
const PALETTE: [number, number, number][] = [
  [230, 60, 60],
  [60, 140, 230],
  [60, 190, 90],
  [230, 170, 30],
  [170, 90, 220],
  [40, 200, 200],
];

it('renders transition-torus stitch chains and unmatched ends', { timeout: 240000 }, () => {
  const m = buildManifold();
  const part = m.parts[m.names.indexOf('transition')] as any;
  const faces: any[] = [];
  for (const f of part.faces) {
    const s = part.surfaces[f.surface];
    if (s !== undefined && s.kind === 'nurbs') faces.push(s);
  }
  let sum = [0, 0, 0];
  let n = 0;
  for (const f of faces)
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const [[u0, u1], [v0, v1]] = surfaceDomain(f.surface) as any;
        const p = surfacePoint(f, u0 + ((u1 - u0) * i) / 8, v0 + ((v1 - v0) * j) / 8);
        sum = [sum[0]! + p[0], sum[1]! + p[1], sum[2]! + p[2]];
        n++;
      }
  const centre = sum.map((v) => v / n) as [number, number, number];
  const torus: any = {
    kind: 'torus',
    frame: makeFrame([...centre], [0, 0, 1]),
    major: MANIFOLD.pipe * 2.2,
    minor: MANIFOLD.pipe * 0.35,
  };

  const branches: any[] = [];
  const joinIn: JoinBranch[] = [];
  faces.forEach((face, fi) => {
    const r = intersectSurfaces(face, torus, 1e-7);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    for (const b of r.value.branches) {
      branches.push({ fi, b });
      joinIn.push({
        closed: b.closed,
        ends: [
          [...brepCurvePoint(b.curve, b.t0)] as any,
          [...brepCurvePoint(b.curve, b.t1)] as any,
        ],
      });
    }
  });
  const chains = joinBranches(joinIn, 1e-6);

  const lines: SceneLine[] = [];
  const markers: SceneMarker[] = [];
  chains.forEach((c, ci) => {
    const col = PALETTE[ci % PALETTE.length]!;
    for (const bi of c.branches) {
      const { b } = branches[bi];
      const pts: any[] = [];
      for (let k = 0; k <= 64; k++)
        pts.push([...brepCurvePoint(b.curve, b.t0 + ((b.t1 - b.t0) * k) / 64)]);
      lines.push({ points: b.closed ? [...pts, pts[0]] : pts, color: col, width: 3 });
    }
    for (const e of c.ends) {
      if (e.reason === 'open') continue;
      markers.push({ p: e.point as any, color: [255, 255, 255], radius: 7, ring: true });
    }
  });
  const scene: Scene = { tris: [], lines, markers };
  const views = ['iso', 'front', 'top'] as const;
  const written: string[] = [];
  for (const v of views) {
    const file = `transition-torus-stitch-${v}.png`;
    writeFileSync(join(outDir, file), toPng(renderScene(scene, v, { size: 480 })));
    copyFileSync(join(outDir, file), join(vizDir, file));
    written.push(file);
  }
  const summary = chains.map(
    (c, i) =>
      `chain${i} branches=${c.branches.length} closed=${c.closed} ends=${c.ends.map((e) => e.reason + '/' + (e.gap ?? 'na').toString().slice(0, 7)).join(';')}`,
  );
  writeFileSync(
    join(vizDir, 'report.txt'),
    `${summary.join('\n')}\nwritten=${written.join(',')}\n`,
  );
});
