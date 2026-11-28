// M-QF5 preview: the cross field of B-rep faces under their feature constraints.
// Run: node --experimental-strip-types examples/qf-field/render.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filletBox } from '../../src/brep/fillet-box.ts';
import type { Shape } from '../../src/brep/types.ts';
import { constrainedFaceField } from '../../src/quad/constrained-field.ts';
import {
  contactSheet,
  drawLegend,
  type Image,
  type RGB,
  renderScene,
  toPng,
} from '../brep-kit/index.ts';
import type { P3, Scene, SceneLine, SceneMarker, SceneTri } from '../brep-kit/scene.ts';
import { holedPlate, wavyPatch } from '../trimmed-faces/models.ts';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 300));
  return r.value;
};

const OUT = process.argv[2] ?? join(tmpdir(), 'forgeax-qf-m5');
const LOOP: RGB = [255, 150, 40];
const ZONE: RGB = [70, 90, 130];
const BASE: RGB = [104, 108, 116];
const FIELD_A: RGB = [90, 230, 255];
const FIELD_B: RGB = [120, 255, 150];
const SING: RGB = [255, 60, 90];

function build(shape: Shape): { scene: Scene; text: string; numbers: Record<string, unknown> } {
  const r = must(constrainedFaceField(shape));
  const m = r.field.mesh;
  const p = (v: number): P3 => [
    m.positions[3 * v] as number,
    m.positions[3 * v + 1] as number,
    m.positions[3 * v + 2] as number,
  ];
  const tris: SceneTri[] = [];
  const lines: SceneLine[] = [];
  const markers: SceneMarker[] = [];
  let edge = 0;
  const cells: { cen: P3; q: P3; s: P3 }[] = [];
  const count = m.triangles.length / 3;
  for (let t = 0; t < count; t++) {
    const a = p(m.triangles[3 * t] as number);
    const b = p(m.triangles[3 * t + 1] as number);
    const c = p(m.triangles[3 * t + 2] as number);
    tris.push({ a, b, c, color: r.zone[t] === 1 ? ZONE : BASE });
    const cen: P3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    edge += Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);
    const q: P3 = [
      r.field.direction[3 * t] as number,
      r.field.direction[3 * t + 1] as number,
      r.field.direction[3 * t + 2] as number,
    ];
    const n: P3 = [
      r.field.normal[3 * t] as number,
      r.field.normal[3 * t + 1] as number,
      r.field.normal[3 * t + 2] as number,
    ];
    const s: P3 = [n[1] * q[2] - n[2] * q[1], n[2] * q[0] - n[0] * q[2], n[0] * q[1] - n[1] * q[0]];
    cells.push({ cen, q, s });
  }
  const h = (edge / count) * 0.42;
  for (const { cen, q, s } of cells) {
    const seg = (d: P3, color: RGB): SceneLine => ({
      points: [
        [cen[0] - d[0] * h, cen[1] - d[1] * h, cen[2] - d[2] * h],
        [cen[0] + d[0] * h, cen[1] + d[1] * h, cen[2] + d[2] * h],
      ],
      color,
      width: 1,
      bias: 3,
    });
    lines.push(seg(q, FIELD_A), seg(s, FIELD_B));
  }
  for (const [a, b] of r.hardLoops)
    lines.push({ points: [p(a), p(b)], color: LOOP, width: 3, bias: 4 });
  for (const s of r.field.singularities) markers.push({ p: p(s.at), color: SING, radius: 6 });
  const numbers = {
    triangles: count,
    zoneTriangles: r.report.zoneTriangles,
    hardSegments: r.report.hardSegments,
    alignedEdges: r.report.alignedEdges,
    singularities: r.report.singularities,
    singularitiesInZone: r.report.singularitiesInZone,
    zoneDistance: r.report.zoneDistance,
    maxPinJumpDegrees: r.report.maxPinJumpDegrees,
    featureAngleErrorMax: r.report.cross.featureAngleError.max,
    indices: r.field.singularities.map((s) => s.index),
  };
  return {
    scene: { tris, lines, markers },
    text: `${count} tris, zone ${r.report.zoneTriangles}, sing ${r.report.singularities}`,
    numbers,
  };
}
const cases: Record<string, { shape: Shape; views: ('top' | 'iso')[] }> = {
  'holed-plate': { shape: holedPlate().shape, views: ['top'] },
  'wavy-patch': { shape: wavyPatch(), views: ['top', 'iso'] },
  'fillet-box': { shape: must(filletBox({ size: [2, 3, 4], radius: 0.25 })), views: ['iso'] },
};

mkdirSync(OUT, { recursive: true });
const sheetCells: { image: Image; caption: string }[] = [];
const summary: Record<string, unknown> = {};
for (const [name, c] of Object.entries(cases)) {
  const t0 = performance.now();
  const built = build(c.shape);
  const ms = Math.round(performance.now() - t0);
  for (const view of c.views) {
    const image = renderScene(built.scene, view, { size: 720 });
    drawLegend(image, 8, 8, `preview: ${name}`, [
      { label: 'field axis 1', color: FIELD_A, style: 'line' },
      { label: 'field axis 2', color: FIELD_B, style: 'line' },
      { label: 'hard trim loop', color: LOOP, style: 'line' },
      { label: 'no-singularity zone', color: ZONE, style: 'line' },
      { label: 'singularity', color: SING, style: 'line' },
    ]);
    writeFileSync(join(OUT, `${name}-${view}.png`), toPng(image));
    sheetCells.push({ image, caption: `preview ${name} (${view}): ${built.text}` });
  }
  summary[name] = { ...built.numbers, runMs: ms };
}
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
writeFileSync(
  join(OUT, 'sheet.png'),
  toPng(
    contactSheet(sheetCells, {
      columns: 2,
      cell: 720,
      title: 'preview: M-QF5 constrained cross field',
    }),
  ),
);
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
