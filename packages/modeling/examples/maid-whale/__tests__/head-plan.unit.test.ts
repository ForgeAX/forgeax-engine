import { resolveDrawing } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { decalBoxes, FACE_SHEET, HEAD_DRAWING, HEAD_PLAN, headCage, MERIDIANS, planPoles, structureLines } from '../head-plan.ts';

/** C-200 G7 head topology plan: the drawing resolves, the cage is all quads on the neck's meridians and its poles stay under the hair. */
describe('C-200 G7 head plan', () => {
  it('resolves as a drawing with front, side and cheek-section views and linked structure lines', () => {
    const r = resolveDrawing(HEAD_DRAWING);
    if (!r.ok) throw r.error;
    expect(r.value.views.map((v) => v.id)).toEqual(['head-front', 'head-side', 'cheek-section']);
    for (const name of Object.keys(structureLines())) {
      const link = name.replace(/ /g, '-');
      const views = HEAD_DRAWING.items.filter((i) => i.link === link).map((i) => i.view);
      expect(views.sort()).toEqual(['head-front', 'head-side']);
    }
  });

  it('builds an all-quad cage open only at the throat ring, one edge per neck meridian', () => {
    const { quads } = headCage();
    const edges = new Set<string>();
    for (const q of quads)
      for (let k = 0; k < 4; k++) {
        const key = `${q.ids[k]}>${q.ids[(k + 1) % 4]}`;
        expect(edges.has(key)).toBe(false);
        edges.add(key);
      }
    const open = [...edges].filter((k) => !edges.has(k.split('>').reverse().join('>')));
    expect(open.length).toBe(MERIDIANS);
    expect(quads.filter((q) => q.region === 'face-plane').length).toBe(2 * HEAD_PLAN.columns * (HEAD_PLAN.rows[0] + HEAD_PLAN.rows[1]));
  });

  it('keeps the cage poles (the crown grid corners) out of the decal areas, under the hair', () => {
    const boxes = Object.values(decalBoxes());
    const inside = (p: readonly number[]) => boxes.some(([x0, y0, x1, y1]) => p[0]! >= x0 && p[0]! <= x1 && p[1]! >= y0 && p[1]! <= y1 && p[2]! > 0.03);
    const poles = planPoles();
    expect(poles.map((p) => p.valence)).toEqual([3, 3, 3, 3]);
    expect(poles.filter((p) => inside(p.position) || p.position[1] < HEAD_PLAN.cranium[0]! - 1e-6)).toEqual([]);
  });

  it('follows the sheet: chin, jaw corner and the visible face width', () => {
    const lines = structureLines();
    const jaw = lines['jaw line'] as readonly (readonly number[])[];
    const chin = jaw.find((p) => p[0] === 0) as readonly number[];
    expect(chin[1]).toBeCloseTo(FACE_SHEET.chin.y, 3);
    const border = lines['face border'] as readonly (readonly number[])[];
    expect(border[0]?.[0]).toBeCloseTo(FACE_SHEET.jawCorner[0], 3);
    // The border lies within 20 mm of the measured visible half-width where the sheet shows it (moved outward past x 0.10 so the blush decal clears the face/skin crease, audit 2026-10-26).
    for (const [y, half] of FACE_SHEET.visibleHalf.filter(([y]) => y >= FACE_SHEET.jawCorner[1])) {
      const x = border.reduce((best, p) => (Math.abs(p[1]! - y) < Math.abs(best[1]! - y) ? p : best))[0] as number;
      expect(Math.abs(x - half)).toBeLessThan(0.02);
    }
  });
});
