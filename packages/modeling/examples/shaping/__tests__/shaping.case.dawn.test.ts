import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coloredMesh, type Model } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, frame, frameModel, type View } from '../../case/render';
import { curvatureMesh, wireMesh, zebraMesh } from '../../quality-body/views';
import {
  buildGradientPlate,
  buildHood,
  buildInsert,
  buildMixedCorner,
  draftColors,
  SHAPING,
} from '../shaping';

/**
 * The shaping example on the real Renderer (Dawn): the saw plate's bevel width gradient
 * and a three-width box corner (shaded and V-wire), the mould insert before and after its
 * draft (shaded and draft analysis) and the rippled hood before and after fairing (zebra
 * and mean curvature). In CI it renders small frames and checks they are non-empty; with
 * FORGEAX_CASE_OUT set it writes each view and a before/after sheet per pair.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 180 : 900;
const SLOTS = { Default: [0.62, 0.64, 0.68], highlight: [0.95, 0.2, 0.55] } as const;
const { teeth, pitch, body, tooth, depth } = SHAPING.plate;
const PLATE: View = frame(
  { min: [0, 0, 0], max: [teeth * pitch, body + tooth, depth] },
  CASE_FOV,
  [0.15, 0.35, 1],
);
const toothBox = (k: number) =>
  [(k + 0.1) * pitch, body - 0.02, -0.01, (k + 0.9) * pitch, body + tooth + 0.01, depth + 0.01] as const;
const toothView = (k: number): View => {
  const b = toothBox(k);
  return frame({ min: b.slice(0, 3), max: b.slice(3) }, CASE_FOV, [0.2, 0.45, 1]);
};
const CORNER_BOX = [0.06, 0.06, 0.06, 0.21, 0.21, 0.21] as const;
const CORNER: View = frame(
  { min: CORNER_BOX.slice(0, 3), max: CORNER_BOX.slice(3) },
  CASE_FOV,
  [1, 0.8, 0.9],
);
const HOOD: View = frame({ min: [0, 0.5, 0], max: [1.2, 0.62, 0.3] }, CASE_FOV, [-0.35, 0.8, 0.6]);
const RANGE = 1.5;

const png = (image: PNG) => PNG.sync.write(image);

function sheet(images: readonly PNG[]): PNG {
  const first = images[0] as PNG;
  const out = new PNG({ width: first.width * images.length, height: first.height });
  for (const [k, image] of images.entries())
    for (let y = 0; y < image.height; y++)
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * out.width + k * first.width) * 4,
      );
  return out;
}

describe('shaping example on the real renderer (Dawn)', () => {
  it('renders bevel widths, draft and fairing before and after', { timeout: 900000 }, async () => {
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: SLOTS, view: PLATE });
    try {
      const projected = new WeakSet<Model>();
      const shaded = (m: Model) => {
        if (!projected.has(m)) {
          m.uv.project({ mode: 'box', scale: 0.1 });
          projected.add(m);
        }
        const exported = m.toMesh({ normals: { mode: 'weighted' } });
        if (!exported.ok) throw exported.error;
        return exported.value.mesh;
      };
      const views: Record<string, PNG> = {};
      const plate = buildGradientPlate();
      r.aim(PLATE);
      views['bevel-plate'] = await r.render(shaded(plate));
      views['bevel-plate-wire'] = await r.render(shaded(plate), [], 3, [wireMesh(plate)]);
      for (const [name, k] of [
        ['bevel-tooth-first', 0],
        ['bevel-tooth-last', teeth - 1],
      ] as const) {
        r.aim(toothView(k));
        views[name] = await r.render(shaded(plate), [], 3, [wireMesh(plate, toothBox(k))]);
      }
      const corner = buildMixedCorner();
      r.aim(CORNER);
      views['bevel-corner'] = await r.render(shaded(corner));
      views['bevel-corner-wire'] = await r.render(shaded(corner), [], 3, [wireMesh(corner, CORNER_BOX)]);

      const insert = buildInsert();
      const drafted = buildInsert(undefined, { drafted: true });
      r.aim(frameModel(insert, [0.75, 0.55, 0.9]));
      for (const [name, m] of [
        ['draft-before', insert],
        ['draft-after', drafted],
      ] as const) {
        views[name] = await r.render(shaded(m), [], 3, [wireMesh(m)]);
        const analysis = coloredMesh(draftColors(m));
        if (!analysis.ok) throw analysis.error;
        views[`${name}-analysis`] = await r.render(undefined, [], 3, [analysis.value, wireMesh(m)]);
      }

      const hoods = { 'fair-before': buildHood(), 'fair-after': buildHood(undefined, { faired: true }) };
      r.aim(HOOD);
      for (const [name, m] of Object.entries(hoods)) {
        views[`${name}-zebra`] = await r.render(zebraMesh(m, HOOD));
        views[`${name}-curvature`] = await r.render(curvatureMesh(m, RANGE));
      }

      expect(
        Object.entries(views)
          .filter(([, image]) => r.covered(image) === 0)
          .map(([view]) => view),
      ).toEqual([]);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;
      mkdirSync(OUT, { recursive: true });
      for (const [view, image] of Object.entries(views)) writeFileSync(join(OUT, `${view}.png`), png(image));
      const sheets: Record<string, readonly string[]> = {
        'sheet-bevel-teeth': ['bevel-tooth-first', 'bevel-tooth-last'],
        'sheet-draft': ['draft-before-analysis', 'draft-after-analysis'],
        'sheet-fair-zebra': ['fair-before-zebra', 'fair-after-zebra'],
        'sheet-fair-curvature': ['fair-before-curvature', 'fair-after-curvature'],
      };
      for (const [name, parts] of Object.entries(sheets))
        writeFileSync(join(OUT, `${name}.png`), png(sheet(parts.map((p) => views[p] as PNG))));
    } finally {
      await r.dispose();
    }
  });
});
