import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { curvePoint } from '../../src/brep/curves.ts';
import type { Defect, Repair } from '../../src/brep/heal.ts';
import { findDefects } from '../../src/brep/heal.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Curve, Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import {
  contactSheet,
  drawLegend,
  featureLines,
  type Image,
  type LegendEntry,
  renderScene,
  type Scene,
  type SceneLine,
  type SceneMarker,
  toPng,
  type ViewSpec,
} from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';
import { allCases, type HealCase, healed } from './cases.ts';
import { must } from './damage.ts';

type RGB = readonly [number, number, number];

const COLOR: Record<Defect['kind'], RGB> = {
  'duplicate-vertex': [255, 150, 40],
  'vertex-gap': [250, 220, 60],
  'edge-gap': [240, 80, 220],
  'free-edge': [255, 60, 60],
  'sliver-edge': [60, 220, 240],
  'sliver-face': [120, 240, 120],
};
const FIXED: RGB = [90, 235, 130];

function edgeMid(shape: Shape, e: number): P3 {
  const edge = shape.edges[e] as { curve: number; t0: number; t1: number; v0: number };
  if (edge.curve < 0) return (shape.vertices[edge.v0] as { p: P3 }).p;
  return curvePoint(shape.curves[edge.curve] as Curve, 0.5 * (edge.t0 + edge.t1));
}

function faceCentre(shape: Shape, f: number): P3 {
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  const face = shape.faces[f];
  if (face === undefined) throw new Error(`face ${f} missing`);
  for (const l of face.loops) {
    const loop = shape.loops[l];
    if (loop === undefined) throw new Error(`loop ${l} missing`);
    for (const c of loop.coedges) {
      const coedge = shape.coedges[c];
      if (coedge === undefined) throw new Error(`coedge ${c} missing`);
      const e = shape.edges[coedge.edge] as { v0: number };
      const p = (shape.vertices[e.v0] as { p: P3 }).p;
      sum[0] += p[0];
      sum[1] += p[1];
      sum[2] += p[2];
      n++;
    }
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

export function defectAt(shape: Shape, d: Defect): P3 {
  switch (d.kind) {
    case 'duplicate-vertex':
      return (shape.vertices[d.vertices[0]] as { p: P3 }).p;
    case 'vertex-gap':
      return (shape.vertices[d.vertex] as { p: P3 }).p;
    case 'edge-gap':
    case 'free-edge':
    case 'sliver-edge':
      return edgeMid(shape, d.edge);
    case 'sliver-face':
      return faceCentre(shape, d.face);
  }
}

function overlay(shape: Shape, defects: readonly Defect[], repairs: readonly Repair[]): Scene {
  const mesh = must(tessellate(shape, { angle: Math.PI / 32 }));
  const lines: SceneLine[] = featureLines(shape);
  const markers: SceneMarker[] = [];
  for (const d of defects) {
    const color = COLOR[d.kind];
    if (d.kind === 'free-edge' || d.kind === 'edge-gap') {
      const e = shape.edges[d.edge] as { curve: number; t0: number; t1: number };
      const c = shape.curves[e.curve] as Curve;
      const pts = Array.from({ length: 17 }, (_, k) =>
        curvePoint(c, e.t0 + ((e.t1 - e.t0) * k) / 16),
      );
      lines.push({ points: pts, color, width: 3.5, bias: 3, xray: true });
    }
    markers.push({ p: defectAt(shape, d), color, radius: 9, ring: true });
  }
  for (const r of repairs) markers.push({ p: r.at, color: FIXED, radius: 9, ring: true });
  return { tris: meshSurface(mesh, { dim: 0.42 }), lines, markers };
}

const LEGEND_KINDS: readonly Defect['kind'][] = [
  'duplicate-vertex',
  'vertex-gap',
  'edge-gap',
  'free-edge',
  'sliver-edge',
  'sliver-face',
];

function legend(
  image: Image,
  defects: readonly Defect[],
  fixed: boolean,
  repairs: number,
  resolved: number,
): void {
  const entries: LegendEntry[] = [];
  for (const k of LEGEND_KINDS) {
    const n = defects.filter((d) => d.kind === k).length;
    if (n > 0) entries.push({ label: `${k} ${n}`, color: COLOR[k], style: 'ring' });
  }
  if (fixed)
    entries.push({
      label: `${repairs} repairs cleared ${resolved} defects`,
      color: FIXED,
      style: 'ring',
    });
  if (entries.length === 0) entries.push({ label: 'no defects', color: FIXED, style: 'ring' });
  drawLegend(image, 8, 8, fixed ? 'after heal' : 'before heal', entries, 1);
}

export interface CaseRender {
  readonly name: string;
  readonly before: readonly Defect[];
  readonly after: readonly Defect[];
  readonly repairs: number;
  readonly valid: boolean;
  readonly sheet: string;
}

const VIEWS: readonly ViewSpec[] = ['iso', 'top'];

export function renderCase(c: HealCase, outDir: string, size = 560): CaseRender {
  mkdirSync(outDir, { recursive: true });
  const result = healed(c);
  const before = must(findDefects(c.damaged));
  const after = must(findDefects(result.shape));
  const cells: { image: Image; caption: string }[] = [];
  for (const [label, shape, defects, fixed] of [
    ['before', c.damaged, before, false],
    ['after', result.shape, after, true],
  ] as const) {
    const scene = overlay(shape, defects, fixed ? result.report.repairs : []);
    for (const view of VIEWS) {
      const image = renderScene(scene, view, { size });
      legend(image, defects, fixed, result.report.repairs.length, before.length);
      const viewName = typeof view === 'string' ? view : view.name;
      writeFileSync(join(outDir, `${c.name}-${label}-${viewName}.png`), toPng(image));
      cells.push({ image, caption: `${c.name} ${label} ${viewName}` });
    }
  }
  const sheet = join(outDir, `${c.name}-sheet.png`);
  contactSheet(cells, {
    columns: 2,
    cell: size,
    title: `${c.name}: ${before.length} defects, ${result.report.repairs.length} repairs (one repair can clear several), ${after.length} left`,
    path: sheet,
  });
  return {
    name: c.name,
    before,
    after,
    repairs: result.report.repairs.length,
    valid: result.report.valid,
    sheet,
  };
}

export function renderAll(outDir: string, size = 560): CaseRender[] {
  return allCases().map((c) => renderCase(c, outDir, size));
}
