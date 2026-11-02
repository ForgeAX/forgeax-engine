import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { cuffGap, cuffLength, ruffleStandOff, ruffleSteps, sleeveOuter, sockInShoe } from '../garment-metrics.ts';
import { buildDressed, G3_GARMENT_TAGS } from '../garments.ts';
import { LANDMARK, part } from '../reference.ts';

const lm = (name: string) => LANDMARK[name] as number;

/** C-200 G3 (structure-first): every garment derives from the G2 body or the garment under it. */
describe('C-200 G3 clothing layers', () => {
  const m = buildDressed();
  const v = m.validate();
  const bounds = (tag: string) => {
    const b = m.bounds(sel.tag(tag));
    if (!b.ok) throw b.error;
    return b.value;
  };

  it('is closed, exports, and no garment crosses the body or another garment', () => {
    expect(m.poisoned).toBeUndefined();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
    expect(m.toMesh().ok).toBe(true);
    for (const tag of G3_GARMENT_TAGS) expect(m.count(sel.tag(tag)), tag).toBeGreaterThan(0);
  });

  it('makes bodice and sleeves one garment with the armhole seam on it', () => {
    const top = new Set(sel.tag('bodice').connected('any').evaluate(m.editMesh));
    for (const side of ['sleeve-l', 'sleeve-r']) expect(sel.tag(side).evaluate(m.editMesh).every((f) => top.has(f)), side).toBe(true);
    expect(m.count(sel.tag('bodice').boundary().and(sel.edges.seam()))).toBeGreaterThan(0);
  });

  it('covers the neck-base ridge with the collar up to under the chin', () => {
    const c = bounds('collar');
    expect(c.min[1]).toBeLessThanOrEqual(0.575);
    expect(c.max[1]).toBeGreaterThanOrEqual(lm('chin') - 0.012);
  });

  it('places skirt, hem band, waistband and apron at the sheet heights', () => {
    expect(Math.abs(bounds('skirt').min[1] - lm('hem'))).toBeLessThan(0.01);
    expect(Math.abs(bounds('skirt').max[0] - part('front', 'skirt').bounds[2])).toBeLessThan(0.02);
    const w = part('front', 'waistband');
    expect(Math.abs(bounds('waistband').min[1] - w.bounds[1])).toBeLessThan(0.003);
    expect(Math.abs(bounds('waistband').max[1] - w.bounds[3])).toBeLessThan(0.003);
    expect(Math.abs(bounds('apron-ruffle').min[1] - lm('apron-bottom'))).toBeLessThan(0.01);
  });

  it('stands the shoes on the ground at the sheet heel and toe', () => {
    const sd = part('right', 'shoes');
    for (const side of ['shoe-l', 'shoe-r']) {
      const b = bounds(side);
      expect(Math.abs(b.min[1]), side).toBeLessThan(0.001);
      expect(Math.abs(b.min[2] + sd.bounds[2]), side).toBeLessThan(0.005);
      expect(Math.abs(b.max[2] + sd.bounds[0]), side).toBeLessThan(0.005);
    }
  });

  it('puffs the sleeves to the sheet outline, gathered at the armhole', () => {
    for (const side of ['l', 'r'] as const) {
      // Sheet left-arm outline (the right one is hidden by hair): outer x 0.19 at y 0.44-0.52, 0.17 at 0.55.
      for (const [y, x] of [[0.48, 0.19], [0.52, 0.188], [0.55, 0.172]] as const) expect(Math.abs(sleeveOuter(m, side, y) - x), `${side} ${y}`).toBeLessThan(0.012);
      // Gathered at the armhole: the shoulder edge stays well inside the puff.
      expect(sleeveOuter(m, side, 0.5) - sleeveOuter(m, side, 0.585), side).toBeGreaterThan(0.01);
    }
  });

  it('rolls the cuffs onto the wrist and sleeve end', () => {
    for (const side of ['l', 'r'] as const) {
      expect(cuffGap(m, side), side).toBeLessThanOrEqual(0.005);
      // a tall roll along the forearm (sheet side view about 0.05 m).
      expect(cuffLength(m, side), side).toBeGreaterThan(0.04);
    }
  });

  it('reaches the socks into the shoes below the opening', () => {
    for (const side of ['l', 'r'] as const) {
      const { sockBottom, opening } = sockInShoe(m, side);
      expect(opening - sockBottom, side).toBeGreaterThan(0.005);
    }
  });

  it('lays the apron ruffle on the skirt', () => {
    expect(ruffleStandOff(m)).toBeLessThanOrEqual(0.005);
    // stepped box-pleat teeth read along the bottom (sheet about 14).
    expect(ruffleSteps(m)).toBeGreaterThanOrEqual(8);
  });
});
