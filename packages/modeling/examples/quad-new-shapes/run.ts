// Quad path over the newer tool shapes: pattern (bolt ring, hole grid), sweep, loft, and offset/fillet solids.
// Each shape runs quadrangulate in the default `blossom` mode and in `quad-dominant`; the summary records quads,
// triangles, open and non-manifold edges, folded pairs, degenerate quads and minimum scaled Jacobian, or the
// exact fail-closed error. Renders (network and feature lines, standard views) go to _scratch/viz-out/quad-new-shapes/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cylinder } from '../../src/brep/build.ts';
import { measure } from '../../src/brep/measure.ts';
import { applyPattern, circularPattern } from '../../src/brep/pattern.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { renderShape } from '../brep-kit/render.ts';
import { buildSolids } from '../brep-offset-solids/solids.ts';
import { bore, PATTERN_CASES } from '../brep-pattern/render.ts';
import { buildLoftShowcase } from '../loft/showcase.ts';
import { buildSweepShowcase } from '../sweep/showcase.ts';

const outDir = new URL('../../../../_scratch/viz-out/quad-new-shapes/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error).slice(0, 300)}`);
  return r.value;
}

const Z = { origin: [0, 0, 0] as P3, direction: [0, 0, 1] as P3 };

const flange8 = must(
  applyPattern(
    must(cylinder({ radius: 40, height: 8 })),
    must(circularPattern(bore(3.5, [30, 0, 0]), { axis: Z, count: 8 })),
  ),
);

const cases: { id: string; name: string; shape: Shape }[] = [
  { id: 'flange8', name: 'pattern: flange, 8-bolt ring', shape: flange8 },
  { id: 'grid3x4', name: 'pattern: plate, 3x4 hole grid', shape: patternShape('grid3x4') },
  {
    id: 'paired',
    name: 'pattern: flange, 6 bolts + half-turn pair',
    shape: patternShape('paired'),
  },
  ...buildSweepShowcase().map((s, i) => ({ id: `sweep-${i}`, name: `sweep ${i}`, shape: s })),
  ...buildLoftShowcase().map((s, i) => ({ id: `loft-${i}`, name: `loft ${i}`, shape: s })),
  ...buildSolids().map((s) => ({
    id: `solid-${s.name}`,
    name: `offset/fillet/draft: ${s.name}`,
    shape: s.shape,
  })),
];

function patternShape(key: string): Shape {
  const make = PATTERN_CASES[key];
  if (make === undefined) throw new Error(`unknown pattern case ${key}`);
  return make().shape;
}

/** The layout failure detail (brep code, face, surface kind, reason); the public code is a coarse mapping of it. */
function failReason(detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  if (d.brep === undefined) return JSON.stringify(d).slice(0, 300);
  return `${String(d.brep)} face ${String(d.face)} surface ${String(d.surface)} reason ${String(d.reason)}`;
}

interface Row {
  id: string;
  name: string;
  mode: string;
  status: 'ok' | 'fail-closed';
  quads?: number;
  triangles?: number;
  openEdges?: number;
  nonManifoldEdges?: number;
  folded?: number;
  degenerate?: number;
  minSj?: number;
  minSjAll?: number;
  minSjQuads?: number;
  allQuadClosed?: boolean;
  code?: string;
  reason?: string;
  pngs?: string[];
}

/** Scaled Jacobian over every face, quads and triangles alike, from the returned mesh (corner sine). */
function scaledJacobianOver(mesh: EditMesh): { all: number; quads: number } {
  const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: P3, b: P3): P3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: P3): number => Math.sqrt(dot(a, a));
  let all = Infinity;
  let quads = Infinity;
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const p = vs.map((v) => mesh.position(v) as P3);
    const n =
      vs.length === 4
        ? cross(sub(p[2] as P3, p[0] as P3), sub(p[3] as P3, p[1] as P3))
        : cross(sub(p[1] as P3, p[0] as P3), sub(p[2] as P3, p[0] as P3));
    const nl = len(n);
    for (let i = 0; i < vs.length; i++) {
      const prev = sub(p[(i + vs.length - 1) % vs.length] as P3, p[i] as P3);
      const next = sub(p[(i + 1) % vs.length] as P3, p[i] as P3);
      const sj = dot(cross(next, prev), n) / (nl * len(prev) * len(next));
      all = Math.min(all, sj);
      if (vs.length === 4) quads = Math.min(quads, sj);
    }
  }
  return { all, quads };
}

const rows: Row[] = [];
for (const c of cases) {
  const area = must(measure(c.shape)).area;
  const size = Math.sqrt(area) / 10;
  for (const mode of ['blossom', 'quad-dominant'] as const) {
    const r = quadrangulate(c.shape, { size, trimmed: mode });
    if (!r.ok) {
      rows.push({
        id: c.id,
        name: c.name,
        mode,
        status: 'fail-closed',
        code: r.error.code,
        reason: failReason(r.error.detail),
      });
      continue;
    }
    const rep = r.value.report;
    const folded = r.value.faceQuality.reduce((s, q) => s + q.foldedPairs, 0);
    const prefix = mode === 'quad-dominant' ? 'qd-' : '';
    const net = renderShape(r.value.mesh, {
      name: `${prefix}${c.id}-quad-`,
      modes: ['network'],
      outDir,
      colorBy: 'face',
      label: true,
    });
    const sj = scaledJacobianOver(r.value.mesh);
    const feat = renderShape(c.shape, {
      name: `${prefix}${c.id}-feat-`,
      modes: ['features'],
      outDir,
      label: true,
    });
    const pngs = [
      ...(net.ok ? net.value.views.map((v) => v.path ?? '') : []),
      ...(feat.ok ? feat.value.views.map((v) => v.path ?? '') : []),
    ];
    rows.push({
      id: c.id,
      name: c.name,
      mode,
      status: 'ok',
      quads: rep.quads,
      triangles: rep.triangles,
      openEdges: rep.openEdges,
      nonManifoldEdges: rep.nonManifoldEdges,
      folded,
      degenerate: rep.degenerate,
      minSj: rep.scaledJacobian.min,
      minSjAll: sj.all,
      minSjQuads: sj.quads,
      allQuadClosed:
        rep.triangles === 0 && rep.openEdges === 0 && rep.nonManifoldEdges === 0 && folded === 0,
      pngs,
    });
  }
}
writeFileSync(`${outDir}summary.json`, JSON.stringify(rows, null, 2));
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
