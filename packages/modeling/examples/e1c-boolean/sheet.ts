import { mkdirSync, writeFileSync } from 'node:fs';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import { housing } from '../../src/brep/housing.ts';
import { IDENTITY_PLACEMENT, transformShape } from '../../src/brep/transform.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import {
  contactSheet,
  type RGB,
  renderScene,
  type Scene,
  type SceneLine,
  type SceneTri,
  featureLines,
  toPng,
} from '../brep-kit/index.ts';

const outDir = new URL('../../../../_scratch/viz-out/e1c-boolean/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const CELL = 360;
const COLOR: Record<'plane' | 'cylinder', RGB> = {
  plane: [150, 170, 200],
  cylinder: [200, 160, 110],
};

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error).slice(0, 300)}`);
  return r.value;
}

function place(s: Shape, z: number, x = 0): Shape {
  return must(transformShape(s, { ...IDENTITY_PLACEMENT, t: [x, 0, z] }));
}

/** Coloured triangles: axis-aligned normals are box planes, any other normal is a curved (cylinder) wall. */
function surfaceTris(shape: Shape): SceneTri[] {
  const t = must(tessellate(shape, { angle: Math.PI / 32 }));
  const out: SceneTri[] = [];
  const pos = (v: number) => t.position(v) as readonly [number, number, number];
  for (const f of t.faces()) {
    const vs = t.faceVertices(f).map(pos);
    for (let i = 1; i + 1 < vs.length; i++) {
      const a = vs[0];
      const b = vs[i];
      const c = vs[i + 1];
      if (!a || !b || !c) continue;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const len = Math.sqrt(n[0]! * n[0]! + n[1]! * n[1]! + n[2]! * n[2]!) || 1;
      const axial = Math.max(...n.map((x) => Math.abs(x) / len));
      const planar = axial > 0.999;
      out.push({ a, b, c, color: planar ? COLOR.plane : COLOR.cylinder });
    }
  }
  return out;
}

/** Trim arcs: each circle edge of the result in red (inside the other solid) or blue (outside). */
function trimArcs(result: Shape, other: Shape): SceneLine[] {
  const lines: SceneLine[] = [];
  void other;
  for (const e of result.edges) {
    if (e.curve < 0) continue;
    const c = result.curves[e.curve];
    if (c?.kind !== 'circle') continue;
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 64; i++) {
      const t = e.t0 + ((e.t1 - e.t0) * i) / 64;
      const p = c.frame.o;
      const r = c.radius;
      const ang = t;
      pts.push([
        p[0] + r * (c.frame.x[0] * Math.cos(ang) + c.frame.y[0] * Math.sin(ang)),
        p[1] + r * (c.frame.x[1] * Math.cos(ang) + c.frame.y[1] * Math.sin(ang)),
        p[2] + r * (c.frame.x[2] * Math.cos(ang) + c.frame.y[2] * Math.sin(ang)),
      ]);
    }
    lines.push({ points: pts, color: [255, 220, 90], width: 3, bias: 2 });
  }
  return lines;
}

function view(shape: Shape, arcs: SceneLine[]) {
  const scene: Scene = {
    tris: surfaceTris(shape),
    lines: [...featureLines(shape, {}), ...arcs],
    markers: [],
  };
  return renderScene(scene, 'iso', { size: CELL });
}

const boxS = must(box({ size: [2.6, 1, 1], label: 'box' }));
const cyl = must(cylinder({ radius: 0.3, height: 3, label: 'cyl' }));
const bossS = place(must(cylinder({ radius: 0.3, height: 1, label: 'boss' })), 0.5, 0.8);

type Case = { name: string; shape: Shape; arcs: SceneLine[] };
const cases: Case[] = [];

const minus = must(booleanSolids(boxS, cyl, 'difference'));
cases.push({
  name: 'box minus through cylinder',
  shape: minus,
  arcs: trimArcs(minus, cyl),
});

const plus = must(booleanSolids(boxS, bossS, 'union'));
cases.push({
  name: 'box plus through-rising boss',
  shape: plus,
  arcs: trimArcs(plus, bossS),
});

const bore1 = must(booleanSolids(boxS, cyl, 'difference'));
const bore2 = must(booleanSolids(bore1, place(cyl, 0, 0.8), 'difference'));
cases.push({
  name: 'chained box + bore + second bore',
  shape: bore2,
  arcs: trimArcs(bore2, cyl),
});

const house = must(
  housing({ size: [2.6, 1, 1], bossX: 0.8, bossRadius: 0.3, bossHeight: 1.6, boreRadius: 0.15 }),
);
cases.push({
  name: 'placed housing',
  shape: house,
  arcs: trimArcs(house, boxS),
});

const cells = cases.map((c) => ({
  image: view(c.shape, c.arcs),
  caption: `${c.name}\nplanes blue, curved walls tan; yellow = circle edges (in/out/on not yet drawn)`,
}));
const sheet = contactSheet(cells, { columns: 2, cell: CELL, title: 'E1c boolean results' });
writeFileSync(`${outDir}sheet.png`, toPng(sheet));
for (const [i] of cases.entries()) writeFileSync(`${outDir}case-${i + 1}.png`, toPng(cells[i]!.image));
process.stdout.write(`${outDir}sheet.png\n`);
