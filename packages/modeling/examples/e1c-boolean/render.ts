import { mkdirSync, writeFileSync } from 'node:fs';
import { type BooleanOp, booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import { curvePoint } from '../../src/brep/curves.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import {
  featureLines,
  renderScene,
  type Scene,
  type SceneLine,
  STANDARD_VIEWS,
  toPng,
  viewBasis,
} from '../brep-kit/index.ts';

const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const SIZE: [number, number, number] = [2.6, 1, 1];
const R = 0.3;
const CYL_HEIGHT = 3;

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`build failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

const COLOR_IN: [number, number, number] = [255, 90, 90];
const COLOR_OUT: [number, number, number] = [90, 200, 255];
const COLOR_ON: [number, number, number] = [255, 220, 90];

/**
 * Coloured in/out/on arcs: every cut circle of the boolean is sampled and classified against the other
 * solid by ray parity. Arcs inside the other solid are red, outside are blue, and arcs exactly on a
 * boundary are yellow. The classification is recomputed here from the input solids, not read from the
 * kernel, so the overlay checks the kernel's keep decisions.
 */
function classifiedArcs(result: Shape, a: Shape, b: Shape): SceneLine[] {
  const lines: SceneLine[] = [];
  for (const e of result.edges) {
    if (e.curve < 0) continue;
    const curve = result.curves[e.curve];
    if (curve?.kind !== 'circle') continue;
    const pts: [number, number, number][] = [];
    const steps = 96;
    for (let i = 0; i <= steps; i++)
      pts.push([...curvePoint(curve, e.t0 + ((e.t1 - e.t0) * i) / steps)]);
    // An arc of the result lies on the boundary of one input solid and inside or outside the other.
    const cls = pts.map((p) => classifyPoint(a, p));
    const cls2 = pts.map((p) => classifyPoint(b, p));
    const label = (c: readonly ('in' | 'out' | 'on')[]) =>
      c.every((x) => x === 'in') ? 'in' : c.every((x) => x === 'out') ? 'out' : 'on';
    const k = label(cls) === 'on' ? label(cls2) : label(cls);
    const color = k === 'in' ? COLOR_IN : k === 'out' ? COLOR_OUT : COLOR_ON;
    lines.push({ points: pts, color, width: 2.6, bias: 2 });
  }
  return lines;
}

/** 'on' when the point lies within the tessellation tolerance of the other solid's boundary, else parity. */
type P3t = readonly [number, number, number];

/** Triangle fan of one tessellated face, as vertex triples. */
function fan(
  m: { faceVertices(f: number): number[]; position(v: number): P3t },
  f: number,
): [P3t, P3t, P3t][] {
  const vs = m.faceVertices(f).map((v) => m.position(v));
  const out: [P3t, P3t, P3t][] = [];
  const first = vs[0];
  if (first === undefined) return out;
  for (let i = 1; i + 1 < vs.length; i++) {
    const b = vs[i];
    const c = vs[i + 1];
    if (b !== undefined && c !== undefined) out.push([first, b, c]);
  }
  return out;
}

function classifyPoint(shape: Shape, p: readonly [number, number, number]): 'in' | 'out' | 'on' {
  const t = tessellate(shape, { angle: Math.PI / 32 });
  if (!t.ok) throw new Error('tessellate failed');
  const m = t.value;
  let near = false;
  for (const f of m.faces()) {
    for (const [a, b, c] of fan(m, f)) {
      if (pointTriDistance(p, a, b, c) < ON_TOL) near = true;
    }
  }
  if (near) return 'on';
  return rayParityInside(shape, p);
}

const ON_TOL = 2e-3;

type V = { x: number; y: number; z: number };

const vec = (p: P3t): V => ({ x: p[0], y: p[1], z: p[2] });
const sub = (p: V, q: V): V => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const dotV = (p: V, q: V): number => p.x * q.x + p.y * q.y + p.z * q.z;
const crossV = (p: V, q: V): V => ({
  x: p.y * q.z - p.z * q.y,
  y: p.z * q.x - p.x * q.z,
  z: p.x * q.y - p.y * q.x,
});

function pointTriDistance(p: P3t, a: P3t, b: P3t, c: P3t): number {
  const pa = sub(vec(p), vec(a));
  const e1 = sub(vec(b), vec(a));
  const e2 = sub(vec(c), vec(a));
  const n = crossV(e1, e2);
  const nl = Math.sqrt(dotV(n, n));
  if (nl === 0) return Number.POSITIVE_INFINITY;
  const d = dotV(pa, n) / nl;
  const d00 = dotV(e2, e2);
  const d01 = dotV(e2, e1);
  const d02 = dotV(e2, pa);
  const d11 = dotV(e1, e1);
  const d12 = dotV(e1, pa);
  const den = d00 * d11 - d01 * d01;
  if (den === 0) return Number.POSITIVE_INFINITY;
  const u = (d11 * d02 - d01 * d12) / den;
  const v = (d00 * d12 - d01 * d02) / den;
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9 ? Math.abs(d) : Number.POSITIVE_INFINITY;
}

function rayHitsTri(o: P3t, d: P3t, a: P3t, b: P3t, c: P3t): boolean {
  const e1 = sub(vec(b), vec(a));
  const e2 = sub(vec(c), vec(a));
  const dv = vec(d);
  const p = crossV(dv, e2);
  const det = dotV(e1, p);
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const s = sub(vec(o), vec(a));
  const u = dotV(s, p) * inv;
  if (u < 0 || u > 1) return false;
  const q = crossV(s, e1);
  const v = dotV(dv, q) * inv;
  if (v < 0 || u + v > 1) return false;
  return dotV(e2, q) * inv > 1e-12;
}

function rayParityInside(shape: Shape, p: readonly [number, number, number]): 'in' | 'out' {
  const t = tessellate(shape, { angle: Math.PI / 32 });
  if (!t.ok) throw new Error('tessellate failed');
  const m = t.value;
  const ray = [0.2672612419124244, 0.5345224838248488, 0.8017837257372732] as const;
  let hits = 0;
  for (const f of m.faces()) {
    for (const [a, b, c] of fan(m, f)) {
      if (rayHitsTri(p, ray, a, b, c)) hits++;
    }
  }
  return hits % 2 === 1 ? 'in' : 'out';
}

const ops: readonly BooleanOp[] = ['difference', 'union', 'intersect'];
const views = (['iso', 'front', 'top'] as const).filter((v) => STANDARD_VIEWS.includes(v));
const report: Record<string, unknown> = {};

const a = must(box({ size: SIZE, label: 'box' }));
const b = must(cylinder({ radius: R, height: CYL_HEIGHT, label: 'cyl' }));

for (const op of ops) {
  const result = booleanSolids(a, b, op);
  if (!result.ok) throw new Error(`${op} failed: ${JSON.stringify(result.error)}`);
  const shape = result.value;
  const feature: SceneLine[] = [...featureLines(shape, {})];
  const arcs = classifiedArcs(shape, a, b);
  for (const view of views) {
    const scene: Scene = { tris: [], lines: [...feature, ...arcs], markers: [] };
    const img = renderScene(scene, view, { size: 640 });
    writeFileSync(`${outDir}boolean-${op}-${view}.png`, toPng(img));
  }
  report[op] = { faces: shape.faces.length };
}
void viewBasis;
process.stdout.write(`${JSON.stringify(report)}\n`);
