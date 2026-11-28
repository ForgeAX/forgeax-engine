import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawingSvg, type Model, model, resolveDrawing, sel, sheet } from '@forgeax/engine-modeling';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { createCaseRenderer, frameModel } from '../../case/render';
import { wireMesh } from '../../quality-body/views';
import { bracketSpec, buildSheetBracket } from '../body';

/**
 * Case evidence on the real Renderer (Dawn). With FORGEAX_CASE_OUT set it writes the folded
 * bracket (shaded and wireframe), the unfolding sequence (flat, 30, 60, 90 degrees) and the flat
 * pattern as an SVG and DXF from the same drawing.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 900;
const HEIGHT = OUT === undefined ? 160 : 700;
const SLOTS = {
  Default: [0.62, 0.64, 0.68],
  sheet: [0.7, 0.72, 0.76],
  bend: [0.9, 0.5, 0.2],
  edge: [0.5, 0.52, 0.56],
} as const;
const DIRECTION = [0.55, 0.7, 0.6];

function flatBody(): Model {
  const spec = bracketSpec();
  const outline = spec.outline;
  if (Array.isArray(outline)) throw new Error('the bracket outline is one shape with holes');
  const shape = outline as { outer: [number, number][]; holes?: [number, number][][] };
  const m = model();
  m.extrudePolygon({
    points: shape.outer,
    ...(shape.holes === undefined ? {} : { holes: shape.holes }),
    depth: spec.thickness,
    label: 'bracket',
  });
  return m;
}

function shown(m: Model): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  for (const l of m.inspect().labels) {
    if ((l.roles.sheet ?? 0) > 0) view.assign(sel.createdBy(l.label, 'sheet'), 'sheet');
    if ((l.roles.bend ?? 0) > 0) view.assign(sel.createdBy(l.label, 'bend'), 'bend');
    if ((l.roles['sheet-edge'] ?? 0) > 0) view.assign(sel.createdBy(l.label, 'sheet-edge'), 'edge');
  }
  view.uv.project({ mode: 'box', scale: 0.05 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (out.ok === false) throw out.error;
  return out.value.mesh;
}

const png = (image: PNG) => PNG.sync.write(image);

describe('sheet-bracket case evidence on the real renderer (Dawn)', () => {
  it('renders the folded bracket and the unfolding sequence', { timeout: 900000 }, async () => {
    const folded = buildSheetBracket();
    const sequence: [string, Model][] = [
      ['flat', flatBody()],
      ['30', buildSheetBracket(30)],
      ['60', buildSheetBracket(60)],
      ['90', folded],
    ];
    const main = frameModel(sequence[0]?.[1] as Model, DIRECTION);
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: main });
    try {
      const images: Record<string, PNG> = {};
      for (const [name, m] of sequence) {
        r.aim(main);
        images[`fold-${name}`] = await r.render(shown(m));
      }
      r.aim(frameModel(folded, DIRECTION));
      images.shaded = await r.render(shown(folded));
      images.wire = await r.render(shown(folded), [], 3, [wireMesh(folded)]);
      const empty = Object.entries(images).filter(([, image]) => r.covered(image) === 0);
      expect(empty.map(([name]) => name)).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(OUT, { recursive: true });
      for (const [name, image] of Object.entries(images)) writeFileSync(join(OUT, `${name}.png`), png(image));
      const drawing = sheet.drawing(bracketSpec());
      if (!drawing.ok) throw drawing.error;
      const resolved = resolveDrawing(drawing.value);
      if (!resolved.ok) throw resolved.error;
      const svg = drawingSvg(resolved.value, { sheet: { size: 'A4', title: { number: 'SHEET-BRACKET' } } });
      if (!svg.ok) throw svg.error;
      writeFileSync(join(OUT, 'flat-pattern.svg'), svg.value);
      const dxf = sheet.dxf(bracketSpec());
      if (!dxf.ok) throw dxf.error;
      writeFileSync(join(OUT, 'flat-pattern.dxf'), dxf.value);
    } finally {
      await r.dispose();
    }
  });
});
