import { resolveCurveSpec, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { classify, cleanMask, polygonArea, simplifyClosed, traceOutline } from '../calibrate/segment.mjs';
import { buildCalibration } from '../g1-calibration.pack.ts';
import { LANDMARK, part, REF, SHEET_VIEWS, silhouette } from '../reference.ts';

/** C-200 G1: the derived calibration data and the segmentation that produced it. */
describe('C-200 G1 calibration', () => {
  it('keeps the scale, landmark order and view agreement of the sheet', () => {
    expect(REF.scale.totalHeightM).toBe(1);
    expect(LANDMARK['ahoge-tip']).toBe(1);
    const order = ['ground', 'sole-top', 'sock-top', 'hem', 'apron-bottom', 'wrist', 'waist', 'shoulder', 'chin', 'eye-line', 'crown', 'headdress-top', 'ahoge-tip'];
    for (let i = 1; i < order.length; i++) {
      expect(LANDMARK[order[i] as string]).toBeGreaterThan(LANDMARK[order[i - 1] as string] as number);
    }
    // One scale for the three views: the ahoge tips agree within 1.5 % of the height.
    for (const view of SHEET_VIEWS) expect(Math.abs(part(view, 'ahoge').bounds[3] - 1)).toBeLessThan(0.015);
    expect(REF.findings.map((f) => f.id)).toEqual(['R-1', 'R-2', 'R-3']);
  });

  it('resolves every silhouette as a fitted contour enclosing the measured area', () => {
    for (const view of SHEET_VIEWS) {
      const contour = resolveCurveSpec({ kind: 'fit', points: silhouette(view) }, { closed: true, tolerance: 0.002 });
      if (!contour.ok) throw contour.error;
      expect(contour.value.deviation).toBeLessThanOrEqual(0.002);
      const s = REF.views[view].silhouette;
      expect(Math.abs(s.polygonAreaM2 - s.areaM2) / s.areaM2).toBeLessThan(0.01);
    }
  });

  it('classifies backdrop, floor shadow and warm cloth whites apart', () => {
    expect(classify(222, 222, 224)).toBe('bg');
    expect(classify(145, 145, 145)).toBe('bg');
    expect(classify(221, 211, 209)).toBe('white');
    expect(classify(252, 219, 192)).toBe('skin');
    expect(classify(23, 34, 59)).toBe('navy');
  });

  it('traces the exact pixel outline of a mask with a filled pocket and a bump', () => {
    const width = 12;
    const height = 10;
    const fg = new Uint8Array(width * height);
    for (let y = 3; y < 8; y++) for (let x = 2; x < 9; x++) fg[y * width + x] = 1;
    fg[2 * width + 5] = 1;
    fg[5 * width + 5] = 0;
    const mask = cleanMask(fg, width, height, { minIsland: 2, maxHole: 4 });
    expect(mask[5 * width + 5]).toBe(1);
    const outline = traceOutline(mask, width, height, [0, width - 1]);
    expect(outline.area).toBe(36);
    expect(polygonArea(outline.points)).toBe(36);
    expect(polygonArea(simplifyClosed(outline.points, 0.1))).toBe(36);
  });

  it('builds the gauge with one plate per body landmark and validates clean', () => {
    const m = buildCalibration();
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues).toEqual([]);
    expect(m.count(sel.tag('landmark-chin'))).toBe(6);
    expect(m.count(sel.tag('head-unit'))).toBeGreaterThan(0);
  });
});
