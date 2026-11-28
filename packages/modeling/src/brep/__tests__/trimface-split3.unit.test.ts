import { describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { buildLoftShowcase } from '../../../examples/loft/showcase.ts';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { housing } from '../housing';
import { measure } from '../measure';
import { quadrangulate } from '../quad';
import type { Shape } from '../types';

const once = <T>(build: () => T): (() => T) => {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: build() };
    return cached.value;
  };
};
const pattern = (k: string): Shape => (PATTERN_CASES[k] as () => { shape: Shape })().shape;
const plateGrid = once(() => pattern('grid3x4'));
const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const boxMinusCyl = (): Shape =>
  must(
    booleanSolids(
      must(box({ size: [2.6, 1, 1], label: 'box' })),
      must(cylinder({ radius: 0.3, height: 3, label: 'cyl' })),
      'difference',
    ),
  );
const housed = (): Shape =>
  must(
    housing({
      size: [2.6, 1, 1],
      bossX: 0.8,
      bossRadius: 0.3,
      bossHeight: 1.6,
      boreRadius: 0.15,
    }),
  );
const loftSize = (shape: Shape): number => {
  const m = measure(shape);
  if (!m.ok) throw new Error(JSON.stringify(m.error));
  return Math.sqrt(m.value.area) / 10;
};

const CASES: { id: string; size: number; shape: () => Shape }[] = [
  { id: 'plate-grid3x4', size: 5, shape: plateGrid },
  { id: 'box-minus-cyl', size: 0.25, shape: once(boxMinusCyl) },
  { id: 'housing', size: 0.25, shape: once(housed) },
  { id: 'loft-0', size: 0, shape: once(() => buildLoftShowcase()[0] as Shape) },
];

describe('split-3 fallback closes trimmed faces that have no perfect matching', () => {
  it.each(CASES)('$id: all-quad, closed, non-manifold free, no folds', {
    timeout: 600_000,
  }, (c) => {
    const shape = c.shape();
    const size = c.size > 0 ? c.size : loftSize(shape);
    const r = quadrangulate(shape, {
      size,
      trimmed: 'blossom-row',
      source: 'boolean',
      fallback: 'split-3',
    });
    expect(r.ok, r.ok ? '' : `code=${r.error.code}`).toBe(true);
    if (!r.ok) return;
    const rep = r.value.report;
    const triangles = r.value.faceQuality.reduce((n, f) => n + f.triangles, 0);
    const folded = r.value.faceQuality.reduce((n, f) => n + f.foldedPairs, 0);
    expect(triangles).toBe(0);
    expect(rep.openEdges).toBe(0);
    expect(rep.nonManifoldEdges).toBe(0);
    expect(folded).toBe(0);
  });
});

describe('split-3 is opt-in and only runs after matching fails', () => {
  it('without fallback, plate-grid3x4 keeps its named failure', { timeout: 600_000 }, () => {
    const r = quadrangulate(plateGrid(), {
      size: 5,
      trimmed: 'blossom-row',
      source: 'boolean',
    });
    expect(r.ok).toBe(false);
  });

  it('with fallback, a face that already matches is unchanged (no split faces)', {
    timeout: 600_000,
  }, () => {
    const r = quadrangulate(pattern('bolt6'), {
      size: 5,
      trimmed: 'blossom-row',
      source: 'boolean',
      fallback: 'split-3',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.faceQuality.some((f) => f.split3)).toBe(false);
  });

  it('split-3 faces are counted in faceQuality (the counter is wired, not 0 by default)', {
    timeout: 600_000,
  }, () => {
    const withFallback = quadrangulate(boxMinusCyl(), {
      size: 0.25,
      trimmed: 'blossom-row',
      source: 'boolean',
      fallback: 'split-3',
    });
    expect(withFallback.ok).toBe(true);
    if (!withFallback.ok) return;
    expect(withFallback.value.faceQuality.filter((f) => f.split3).length).toBeGreaterThan(0);
  });

  it('split-3 interior relaxation raises box-minus-cyl minimum SJ above the unrelaxed 0.163', {
    timeout: 600_000,
  }, () => {
    const r = quadrangulate(boxMinusCyl(), {
      size: 0.25,
      trimmed: 'blossom-row',
      source: 'boolean',
      fallback: 'split-3',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const minSj = Math.min(...r.value.faceQuality.map((f) => f.minSj));
    expect(minSj).toBeGreaterThan(0.2);
  });
});
