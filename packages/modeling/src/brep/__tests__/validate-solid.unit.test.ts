import { describe, expect, it } from 'vitest';
import { measure } from '../measure';
import { measureVolume } from '../measure-volume';
import type { Shape } from '../types';
import { validate } from '../validate';
import { primitives } from './support';

const cases = primitives();
const first = cases[0];
if (first === undefined) throw new Error('no primitives');

function exactVolume(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error('measure failed');
  return m.value.volume;
}

describe('validate: exact solid facts for a Shape input', () => {
  for (const c of cases) {
    it(`${c.name}: solid.source is exact and the volume equals measure`, () => {
      const report = validate(c.shape);
      expect(report.ok).toBe(true);
      expect(report.solid?.source).toBe('exact');
      expect(report.solid?.volume).toBe(exactVolume(c.shape));
      expect(report.solid?.mass).toBeUndefined();
    });

    it(`${c.name}: with a density, mass is volume times density`, () => {
      const report = validate(c.shape, { density: 2700 });
      expect(report.solid?.source).toBe('exact');
      expect(report.solid?.mass).toBeCloseTo(exactVolume(c.shape) * 2700, 9);
    });
  }

  it('a density that is not a finite number above 0 is brep-bad-argument and no solid', () => {
    for (const density of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = validate(first.shape, { density });
      expect(report.ok).toBe(false);
      expect(report.issues.map((i) => i.code)).toContain('brep-bad-argument');
      expect(report.solid).toBeUndefined();
    }
  });

  it('falsifier: a Shape that fails validation reports no solid', () => {
    const copy = JSON.parse(JSON.stringify(first.shape)) as typeof first.shape;
    const edge = copy.edges[0];
    if (edge === undefined) throw new Error('no edge');
    (edge as { v1: number }).v1 = edge.v0;
    const report = validate(copy);
    expect(report.ok).toBe(false);
    expect(report.solid).toBeUndefined();
  });
});

describe('measureVolume: the volume-only path agrees bit-for-bit with measure', () => {
  for (const c of cases) {
    it(`${c.name}: per-shell and total volume are identical`, () => {
      const full = measure(c.shape);
      const lean = measureVolume(c.shape);
      if (!full.ok || !lean.ok) throw new Error('measure failed');
      expect(lean.value.volume).toBe(full.value.volume);
      expect(lean.value.shells).toEqual(full.value.shells.map((s) => s.volume));
    });
  }
});

describe('validate: an immutable Shape is validated once', () => {
  it('repeats the identical report for a frozen kernel result', () => {
    expect(Object.isFrozen(first.shape)).toBe(true);
    expect(validate(first.shape)).toBe(validate(first.shape));
  });

  it('never caches a Shape whose tables are mutable', () => {
    const thawed: Shape = { ...first.shape, faces: [...first.shape.faces] };
    const a = validate(thawed);
    expect(a.ok).toBe(true);
    expect(validate(thawed)).not.toBe(a);
  });

  it('is not shared with a density request', () => {
    const base = validate(first.shape);
    const withMass = validate(first.shape, { density: 2 });
    expect(withMass).not.toBe(base);
    expect(withMass.solid?.mass).toBe(2 * (base.solid?.volume ?? Number.NaN));
  });
});
