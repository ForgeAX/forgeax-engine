// Renders every cross-field model from two sides and checks the pictures show what the report says.
// QUAD_FIELD_OUT=<dir> also writes `<model>-<view>.png` and `field-sheet.png` there.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CrossFieldOptions, crossField } from '../../../src/quad/cross-field';
import { featureEdges, type TriMesh, triTopology } from '../../../src/quad/trimesh';
import { contactSheet, type Image, type RGB, type SheetCell, toPng } from '../../brep-kit/index.ts';
import { COLORS, renderField } from '../field-scene';
import { bracket, brepSphere, brepTorus, chamferBox, flangedTee, lumpy } from '../models';

const OUT = process.env.QUAD_FIELD_OUT;

const MODELS: readonly (readonly [string, () => TriMesh, CrossFieldOptions])[] = [
  ['sphere', brepSphere, {}],
  ['torus-smooth', brepTorus, {}],
  ['torus-aligned', brepTorus, { curvatureAlignment: 1 }],
  ['lumpy', lumpy, {}],
  ['chamfer-box', chamferBox, {}],
  ['bracket', bracket, {}],
  ['flanged-tee', flangedTee, {}],
];

function countNear(image: Image, c: RGB): number {
  let n = 0;
  for (let i = 0; i < image.rgba.length; i += 4) {
    const d =
      Math.abs((image.rgba[i] as number) - c[0]) +
      Math.abs((image.rgba[i + 1] as number) - c[1]) +
      Math.abs((image.rgba[i + 2] as number) - c[2]);
    if (d < 30) n++;
  }
  return n;
}

function render(make: () => TriMesh, options: CrossFieldOptions) {
  const r = crossField(make(), options);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const { field, report } = r.value;
  const topo = triTopology(field.mesh);
  if (!topo.ok) throw new Error(JSON.stringify(topo.error));
  const marks = featureEdges(field.mesh, topo.value, options);
  if (!marks.ok) throw new Error(JSON.stringify(marks.error));
  const views = (['iso', 'iso-back'] as const).map((v) => ({
    view: v,
    image: renderField(field, marks.value, topo.value.twin, v),
  }));
  return { field, report, views };
}

describe('quad-field renders', () => {
  const cells: SheetCell[] = [];
  it.each(
    MODELS,
  )('%s: ticks everywhere, markers only where singularities are', (name, make, options) => {
    const { field, report, views } = render(make, options);
    const positive = field.singularities.filter((s) => s.index > 0).length;
    const negative = field.singularities.length - positive;
    const turns = (sign: number) =>
      field.singularities.reduce((s, x) => s + (Math.sign(x.index) === sign ? x.index : 0), 0);
    const sum = (c: RGB) => views.reduce((s, v) => s + countNear(v.image, c), 0);
    expect(sum(COLORS.tick)).toBeGreaterThan(500);
    if (positive === 0) expect(sum(COLORS.positive)).toBe(0);
    else expect(sum(COLORS.positive)).toBeGreaterThan(20);
    if (negative === 0) expect(sum(COLORS.negative)).toBe(0);
    else expect(sum(COLORS.negative)).toBeGreaterThan(20);
    if (report.featureEdges > 0) expect(sum(COLORS.feature)).toBeGreaterThan(50);
    const err = report.featureAngleError;
    const caption =
      `${name}: ${field.mesh.triangles.length / 3} tris, chi ${report.chi}, index sum ${report.indexSum}, ` +
      `${positive} sing. +${turns(1)}/4, ${negative} sing. ${turns(-1)}/4.` +
      (err.samples > 0 ? ` feature err ${err.max.toExponential(1)} rad` : '');
    for (const v of views) {
      cells.push({ image: v.image, caption: `${caption} [${v.view}]` });
      if (OUT !== undefined) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, `${name}-${v.view}.png`), toPng(v.image));
      }
    }
  });

  it('contact sheet', () => {
    expect(cells.length).toBe(2 * MODELS.length);
    const sheet = contactSheet(cells, {
      columns: 4,
      cell: 360,
      title: 'Cross fields (Knoeppel 2013): ticks = field, orange = features, red +1/4, blue -1/4',
      ...(OUT === undefined ? {} : { path: join(OUT, 'field-sheet.png') }),
    });
    expect(sheet.width).toBeGreaterThan(4 * 360);
  });
});
