import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import { measure } from '../../src/brep/measure.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Frame, Shape } from '../../src/brep/types.ts';
import { validate } from '../../src/brep/validate.ts';
import { must } from '../brep-heal/damage.ts';
import { contactSheet, featureLines, type Image, renderScene, toPng } from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';

const L = 0.24;
const W = 0.16;
const R = 0.008;
const yFrame = (o: [number, number, number]): Frame => ({
  o,
  x: [1, 0, 0],
  y: [0, 0, -1],
  z: [0, 1, 0],
});

function holeCenters(cols: number, rows: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++)
      out.push([((i + 1) * L) / (cols + 1) - L / 2, 0, ((j + 1) * W) / (rows + 1) - W / 2]);
  return out;
}

function plate(
  t: number,
  cols: number,
  rows: number,
): {
  shape: Shape;
  volume: number;
  closed: number;
  valid: boolean;
  holes: number;
} {
  const centers = holeCenters(cols, rows);
  let cur = must(box({ size: [L, t, W] }));
  for (const c of centers) {
    const hole = must(cylinder({ radius: R, height: 3 * t, frame: yFrame(c) }));
    const r = booleanSolids(cur, hole, 'difference');
    if (!r.ok) throw new Error(`hole failed: ${r.error.code}`);
    cur = r.value;
  }
  const volume = must(measure(cur)).volume;
  const closed = L * t * W - centers.length * Math.PI * R * R * t;
  return {
    shape: cur,
    volume,
    closed,
    valid: validate(cur).ok,
    holes: centers.length,
  };
}

const draw = (shape: Shape, size: number): Image =>
  renderScene(
    {
      tris: meshSurface(must(tessellate(shape, { angle: Math.PI / 32 })), {
        dim: 0.38,
      }),
      lines: featureLines(shape),
      markers: [],
    },
    'iso',
    { size },
  );

export function renderPlateHoles(outDir: string, size = 360) {
  mkdirSync(outDir, { recursive: true });
  const cases = [
    { name: 'flat 12 mm K=8', p: plate(0.012, 4, 2) },
    { name: 'flat 12 mm K=16', p: plate(0.012, 4, 4) },
    { name: 'flat 12 mm K=24', p: plate(0.012, 4, 6) },
    { name: 'thin 0.5 mm K=24', p: plate(0.0005, 4, 6) },
  ];
  const rows = cases.map((c) => ({
    name: c.name,
    holes: c.p.holes,
    valid: c.p.valid,
    relErr: Math.abs(c.p.volume - c.p.closed) / c.p.closed,
  }));
  const cells = cases.map((c, i) => ({
    image: draw(c.p.shape, size),
    caption: `${c.name}: valid ${rows[i]?.valid}, rel err ${rows[i]?.relErr.toExponential(1)}`,
  }));
  const sheet = contactSheet(cells, {
    columns: 2,
    cell: size,
    title: 'E1e chained cylinder holes through flat plates',
  });
  writeFileSync(join(outDir, 'plate-holes-sheet.png'), toPng(sheet));
  return rows;
}
