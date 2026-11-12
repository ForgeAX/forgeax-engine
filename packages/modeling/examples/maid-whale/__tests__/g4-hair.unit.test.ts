import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildHairOnFigure } from '../g4-hair.pack.ts';
import { ahoge, backEdge, bangCoverage, bangEnds, bangStandoff, bangsFront, bangTips, crownRidges, locks, sideMass, tipCount } from '../hair-metrics.ts';
import { LANDMARK, part } from '../reference.ts';

/** C-200 G4 (structure-first): the hair grown from the scalp, worn over the G3 figure. */
describe('C-200 G4 hair', () => {
  const m = buildHairOnFigure();
  const v = m.validate();
  const hair = m.bounds(sel.tag('hair'));
  if (!hair.ok) throw hair.error;
  const { min, max } = hair.value;

  it('is closed, exports, and the hair crosses neither itself nor the figure', () => {
    expect(m.poisoned).toBeUndefined();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
    expect(m.toMesh().ok).toBe(true);
  });

  it('grows every part from the scalp cap', () => {
    const labels = m.inspect().labels.map((l) => l.label);
    for (const l of ['hair-cap', 'hair-bangs-groove-3-floor', 'hair-ahoge', 'hair-lock-l0', 'hair-lock-r2', 'hair-back-inner', 'hair-back-outer', 'hair-side-l', 'hair-side-r']) expect(labels, l).toContain(l);
    expect(labels.filter((l) => l.startsWith('hair-tip-')).length).toBeGreaterThanOrEqual(5);
  });

  it('matches the sheet hair extents', () => {
    // Ahoge tip (1.0), back hair bottom (back view 0.279), width (front view about +-0.24 with the locks).
    expect(Math.abs(max[1] - (LANDMARK['ahoge-tip'] as number))).toBeLessThan(0.01);
    expect(Math.abs(min[1] - part('back', 'hair-total').bounds[1])).toBeLessThan(0.03);
    expect(max[0] - min[0]).toBeGreaterThan(0.44);
    // The bangs end above the eye line, all but the middle strand that falls between the eyes.
    for (const [i, y] of bangEnds(m).entries()) {
      if (i === 3) expect(y, 'middle').toBeLessThan(LANDMARK['eye-line'] as number);
      else expect(y, `clump ${i}`).toBeGreaterThan(LANDMARK['eye-line'] as number);
    }
  });

  it('lays the bang ends on the face', () => {
    expect(bangsFront(m)).toBeLessThanOrEqual(0.14);
  });

  it('drapes 3-4 wide flat locks per side', () => {
    for (const side of ['l', 'r'] as const) {
      const ls = locks(m, side);
      expect(ls.length, side).toBeGreaterThanOrEqual(3);
      expect(ls.length, side).toBeLessThanOrEqual(4);
      for (const l of ls) {
        expect(l.width, side).toBeGreaterThanOrEqual(0.04);
        expect(l.width, side).toBeGreaterThan(l.depth);
      }
    }
  });

  it('gives the back mass its side depth', () => {
    for (const [y, z] of [[0.6, -0.24], [0.5, -0.28], [0.45, -0.3]] as const) expect(Math.abs(backEdge(m, y) - z), `${y}`).toBeLessThan(0.03);
  });

  it('ends the back mass in 11-13 pointed clumps', () => {
    expect(tipCount(m)).toBeGreaterThanOrEqual(11);
    expect(tipCount(m)).toBeLessThanOrEqual(13);
  });

  it('makes the ahoge a fat crescent', () => {
    const a = ahoge(m);
    expect(a.width).toBeGreaterThanOrEqual(0.06);
    expect(a.depth).toBeGreaterThanOrEqual(0.1);
  });

  it('covers the forehead with long bang clumps (tips 0.72-0.75, the middle between the eyes)', () => {
    const ends = bangEnds(m);
    expect(ends.length).toBe(7);
    for (const [i, y] of ends.entries()) {
      if (i === 3) expect(y, 'middle').toBeLessThan(LANDMARK['eye-line'] as number);
      else expect(y, `clump ${i}`).toBeLessThanOrEqual(0.75);
    }
    // Hair over the whole forehead down to its notches (no bare band above the brows).
    expect(bangCoverage(m)).toBeLessThanOrEqual(0.765);
  });

  it('breaks the cap into clumps flowing from the crown', () => {
    expect(m.inspect().labels.some((l) => l.label.startsWith('hair-cap-clump'))).toBe(false);
    // The head's centre (G4 cap: centre height 0.775 over the skull).
    const cap = m.bounds(sel.createdBy('hair-cap', 'layer'));
    if (!cap.ok) throw cap.error;
    const c: [number, number, number] = [(cap.value.min[0] + cap.value.max[0]) / 2, 0.775, (cap.value.min[2] + cap.value.max[2]) / 2];
    // Raised clumps around the dome at two heights down from the crown: grooves between at least
    // seven of them (the front stays plain under the ahoge).
    for (const polar of [30, 50]) expect(crownRidges(m, c, polar), `${polar}`).toBeGreaterThanOrEqual(7);
  });

  it('frames the face with one wide mass per side split into wavy locks', () => {
    for (const side of ['l', 'r'] as const) {
      const s = sideMass(m, side);
      expect(s.mass, side).toBe(true);
      expect(s.locks, side).toBe(3);
      expect(s.outline, side).toBeGreaterThan(0.22);
    }
  });

  it('grows the bangs out of the cap, varied, the outer ones sweeping out', () => {
    // Their grooves run up the cap from the notches (no start edge on the forehead).
    for (let k = 1; k <= 6; k++) {
      const g = m.bounds(sel.createdBy(`hair-bangs-groove-${k}-floor`).or(sel.createdBy(`hair-bangs-groove-${k}-deep`)));
      if (!g.ok) throw g.error;
      expect(g.value.max[1], `groove ${k}`).toBeGreaterThan(0.84);
    }
    const tips = bangTips(m);
    const ws = tips.map((t) => t.width);
    expect(Math.max(...ws) / Math.min(...ws)).toBeGreaterThanOrEqual(1.4);
    const [first, last] = [tips[0], tips.at(-1)] as [(typeof tips)[number], (typeof tips)[number]];
    expect(first.drift).toBeLessThan(0);
    expect(last.drift).toBeGreaterThan(0);
  });

  it('makes the bangs the front of the cap itself, close on the forehead', () => {
    // No separate bang pieces and no rim across the forehead: the cap reaches down to the tips,
    // its underside at most 4 mm off the skin there.
    expect(m.inspect().labels.some((l) => /^hair-bangs-(tip-)?\d+$/.test(l.label))).toBe(false);
    expect(bangStandoff(m)).toBeLessThanOrEqual(0.0045);
  });
});
