import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder } from '../../src/brep/build.ts';
import {
  type ConstraintOrigin,
  type FeatureConstraint,
  inspectConstraints,
} from '../../src/brep/feature-constraints.ts';
import { filletBox } from '../../src/brep/fillet-box.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import {
  contactSheet,
  drawLegend,
  type Image,
  type LegendEntry,
  type RGB,
  renderScene,
  toPng,
} from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';
import type { SceneLine } from '../brep-kit/scene.ts';
import { classifyEdges } from '../brep-kit/shape-lines.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 300));
  return r.value;
};

const OUT = process.argv[2] ?? join(tmpdir(), 'forgeax-qf-m2');

const COLORS: Record<string, RGB> = {
  'trim-loop align': [255, 150, 40],
  'trim-loop even-count (hard)': [255, 70, 200],
  'sharp-edge align': [70, 210, 255],
  'g1-chain continue': [110, 230, 120],
};

function styleOf(c: FeatureConstraint): { key: string; line: Partial<SceneLine> } {
  if (c.kind === 'even-count')
    return { key: 'trim-loop even-count (hard)', line: { width: 2, dash: [6, 5], bias: 2 } };
  if (c.kind === 'continue-across')
    return { key: 'g1-chain continue', line: { width: 3, bias: 1.5 } };
  return {
    key: c.origin === ('trim-loop' as ConstraintOrigin) ? 'trim-loop align' : 'sharp-edge align',
    line: { width: 3, bias: 1.5 },
  };
}

function overlay(shape: Shape, constraints: readonly FeatureConstraint[], size: number): Image[] {
  const points = new Map(classifyEdges(shape).map((e) => [e.edge, e.points]));
  const lines: SceneLine[] = [];
  for (const c of constraints) {
    const { key, line } = styleOf(c);
    for (const e of c.edges) {
      const p = points.get(e);
      if (p !== undefined) lines.push({ points: p, color: COLORS[key] as RGB, width: 3, ...line });
    }
  }
  const tris = meshSurface(must(tessellate(shape, { angle: Math.PI / 32 })), { dim: 0.32 });
  const legend: LegendEntry[] = Object.entries(COLORS).map(([label, color]) => ({
    label,
    color,
    style: label.includes('even') ? 'dash' : 'line',
  }));
  return (['iso', 'top'] as const).map((view) => {
    const image = renderScene({ tris, lines, markers: [] }, view, { size });
    drawLegend(image, 8, 8, 'constraints', legend);
    return image;
  });
}

const cases: Record<string, Shape> = {
  'plate-grid3x4': PATTERN_CASES.grid3x4?.().shape as Shape,
  'flange-bolt6': PATTERN_CASES.bolt6?.().shape as Shape,
  'fillet-box': must(filletBox({ size: [2, 3, 4], radius: 0.25 })),
  'box-minus-cyl': must(
    booleanSolids(
      must(box({ size: [2.6, 1, 1] })),
      must(cylinder({ radius: 0.3, height: 3 })),
      'difference',
    ),
  ),
};

mkdirSync(OUT, { recursive: true });
const cells: { image: Image; caption: string }[] = [];
const summary: Record<string, unknown> = {};
for (const [name, shape] of Object.entries(cases)) {
  const t = performance.now();
  const r = must(inspectConstraints(shape));
  const ms = Math.round(performance.now() - t);
  writeFileSync(join(OUT, `${name}.constraints.json`), `${JSON.stringify(r, null, 1)}\n`);
  const [iso, top] = overlay(shape, r.constraints, 520) as [Image, Image];
  writeFileSync(join(OUT, `${name}-iso.png`), toPng(iso));
  writeFileSync(join(OUT, `${name}-top.png`), toPng(top));
  const caption = `${name}: ${shape.faces.length} faces, trimmed ${r.trimmedFaces.length}, kinds ${JSON.stringify(r.byKind)}`;
  cells.push({ image: iso, caption: `${caption} (iso)` }, { image: top, caption: `${name} (top)` });
  summary[name] = {
    faces: shape.faces.length,
    trimmedFaces: r.trimmedFaces,
    byKind: r.byKind,
    byOrigin: r.byOrigin,
    deriveMs: ms,
  };
}
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
writeFileSync(
  join(OUT, 'sheet.png'),
  toPng(contactSheet(cells, { columns: 2, cell: 520, title: 'M-QF2 feature constraints' })),
);
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
