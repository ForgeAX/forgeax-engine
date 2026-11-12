import { type Drawing, type DrawingItem, resolveDrawing } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { REF, SHEET_VIEWS } from '../reference.ts';
import { checkTurnaround, headUnits, RUFFLE_TOOTH_WIDTH, TURNAROUND, viewDisagreements } from '../turnaround.ts';

/** C-200 turnaround drawing: proportion grid, shared landmark guides, structure lines and the facet plan. */
describe('C-200 turnaround drawing', () => {
  it('resolves as a drawing with front, right and back views', () => {
    const r = resolveDrawing(TURNAROUND);
    if (!r.ok) throw r.error;
    expect(r.value.views.map((v) => v.id)).toEqual([...SHEET_VIEWS]);
    for (const view of SHEET_VIEWS) {
      const roles = new Set(r.value.curves.filter((c) => c.view === view).map((c) => c.role));
      for (const role of ['silhouette', 'guide', 'structure', 'construction'] as const) expect(roles.has(role)).toBe(true);
    }
  });

  it('measures the head unit and a chibi head count', () => {
    const { head, headsTall, headsOverall } = headUnits();
    expect(head).toBeCloseTo(REF.proportions.headHeight, 4);
    expect(headsTall).toBeCloseTo(REF.proportions.headsTall, 2);
    // stylized-character: chibi (SD) 2-3.5 heads; measured 3.10 to the crown, 3.40 to the ahoge tip.
    for (const n of [headsTall, headsOverall]) {
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3.5);
    }
  });

  it('holds the alignment rule: every linked guide has one height in all views', () => {
    const check = checkTurnaround(TURNAROUND);
    expect(check.malformed).toEqual([]);
    expect(check.ok).toBe(true);
    const landmarks = check.guides.filter((g) => g.link.startsWith('landmark:'));
    expect(landmarks.length).toBe(REF.landmarks.length - 3);
    for (const g of check.guides) expect(Object.keys(g.heights).sort()).toEqual([...SHEET_VIEWS].sort());
    expect(check.heads.crown).toBeCloseTo(REF.proportions.headsTall, 2);
    expect(check.heads.chin).toBeCloseTo(REF.proportions.headsTall - 1, 2);
  });

  it('fails the alignment rule when one view moves its eye-line guide by 5 mm', () => {
    const moved: Drawing = {
      ...TURNAROUND,
      items: TURNAROUND.items.map((i): DrawingItem => {
        if (i.id !== 'eye-line (right)' || i.kind !== 'curve' || !('points' in i.curve)) return i;
        return { ...i, curve: { ...i.curve, points: i.curve.points.map((p) => [p[0], p[1] + 0.005] as const) } };
      }),
    };
    expect(resolveDrawing(moved).ok).toBe(true);
    const check = checkTurnaround(moved);
    expect(check.ok).toBe(false);
    const eye = check.guides.find((g) => g.link === 'landmark:eye-line');
    expect(eye?.ok).toBe(false);
    expect(eye?.spread).toBeCloseTo(0.005, 6);
    expect(check.guides.filter((g) => !g.ok).map((g) => g.link)).toEqual(['landmark:eye-line']);
  });

  it('draws the facet plan units and records their target edges', () => {
    const swatches = TURNAROUND.items.filter((i) => i.kind === 'dimension' && i.id.endsWith('target edge'));
    expect(swatches.length).toBe(19);
    const ruffle = TURNAROUND.items.find((i) => i.id === 'apron ruffle teeth (front)');
    expect(ruffle?.kind).toBe('curve');
    // About 0.022 m per tooth (facet plan) once the hand-skewed apron bounds are mirrored from the right half.
    expect(RUFFLE_TOOTH_WIDTH).toBeGreaterThan(0.02);
    expect(RUFFLE_TOOTH_WIDTH).toBeLessThan(0.024);
    expect(TURNAROUND.items.filter((i) => i.kind === 'note' && i.id.startsWith('facet plan ')).length).toBe(13);
  });

  it('reports where the reference views disagree with the sheet landmarks', () => {
    const d = viewDisagreements();
    const off = d.filter((x) => Math.abs(x.delta) > 0.01);
    // The hem band top and the back-view sock top are the known >1 cm disagreements.
    expect(off.some((x) => x.landmark === 'hem-band-top' && x.view === 'right')).toBe(true);
    expect(off.some((x) => x.landmark === 'sock-top' && x.view === 'back')).toBe(true);
  });
});
