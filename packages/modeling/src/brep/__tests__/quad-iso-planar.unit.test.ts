import { describe, expect, it } from 'vitest';
import { must } from '../../../examples/brep-heal/damage';
import { bore, PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { holeBoundaryMetrics } from '../../../examples/qf-curved-baseline/metrics';
import { boxWithThroughHole } from '../boolean-hole';
import { box } from '../build';
import { applyPattern, linearPattern } from '../pattern';
import { quadrangulate } from '../quad';
import { discGrid } from '../quad-iso-disc';
import type { Shape } from '../types';

// The summary run meshes the full 12-hole grid3x4 (building it alone takes ~100 s); the unit gate uses two holes
// (build ~1.5 s, each mesh run under 0.1 s).
function holesRow(width = 30, height = 16, pitch = 10): Shape {
  const tools = must(
    linearPattern(bore(2, [-pitch / 2, 0, 0], 4), {
      direction: [1, 0, 0],
      spacing: pitch,
      count: 2,
    }),
  );
  return must(applyPattern(must(box({ size: [width, height, 2] })), tools));
}

const reasonOf = (r: ReturnType<typeof quadrangulate>): string | undefined =>
  r.ok ? undefined : (r.error.detail as { reason?: string }).reason;

describe('isoQuadric on holed planar faces', () => {
  const plate = must(boxWithThroughHole({ size: [3, 3, 1], radius: 0.75, label: 'plate' }));
  const opts = { size: 0.25, trimmed: 'quad-dominant', isoQuadric: true } as const;

  it('lays the plate hole out as a strict all-quad O-grid row', () => {
    const r = quadrangulate(plate, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.triangles).toBe(0);
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
    expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
    const m = holeBoundaryMetrics(plate, r.value);
    expect(m.coverage).toBe(1);
    expect(m.rowOnly).toBe(1);
  });

  it('metric falsifier: the trimmed route without iso leaves the hole short of a row', () => {
    const r = quadrangulate(plate, { size: 0.25, trimmed: 'quad-dominant' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = holeBoundaryMetrics(plate, r.value);
    expect(m.rowOnly).toBeLessThan(1);
    expect(r.value.report.triangles).toBeGreaterThan(0);
  });

  it('rows every hole of a two-hole plate and grades the far field coarser than the holes (size 0.5)', () => {
    const shape = holesRow();
    const r = quadrangulate(shape, { size: 0.5, trimmed: 'quad-dominant', isoQuadric: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.triangles).toBe(0);
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
    expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
    const m = holeBoundaryMetrics(shape, r.value);
    expect(m.coverage).toBe(1);
    expect(m.rowOnly).toBe(1);
    // A far field sampled at the element size gave 5296 quads here; the graded one gives 1760 (measured).
    expect(r.value.report.quads).toBeLessThan(2000);
  });

  it('fails closed when the plate edge is under a cell from the hole strip (12 x 4.3 plate, size 1)', () => {
    // 4.6 and 4.4 lay out on a finer far field (minSJ 0.354, 0.347); 4.3 and below do not (measured).
    const r = quadrangulate(holesRow(12, 4.3, 6), {
      size: 1,
      trimmed: 'quad-dominant',
      isoQuadric: true,
    });
    expect(reasonOf(r)).toBe('iso-strip-distorted');
  });

  describe('minimum hole spacing (size 0.5, radius 1): the gap must reach one cell', () => {
    const spaced = (gap: number) => {
      const pitch = 2 + gap;
      const tools = must(
        linearPattern(bore(1, [-pitch / 2, 0, 0], 4), {
          direction: [1, 0, 0],
          spacing: pitch,
          count: 2,
        }),
      );
      return applyPattern(must(box({ size: [12, 8, 1] })), tools);
    };
    const run = (gap: number) => {
      const shape = must(spaced(gap));
      return {
        shape,
        r: quadrangulate(shape, { size: 0.5, trimmed: 'quad-dominant', isoQuadric: true }),
      };
    };

    it('lays out at a gap of 1.0 and fails closed below 0.5', () => {
      const ok = run(1);
      expect(ok.r.ok).toBe(true);
      if (ok.r.ok) {
        expect(ok.r.value.report.triangles).toBe(0);
        expect(holeBoundaryMetrics(ok.shape, ok.r.value).rowOnly).toBe(1);
      }
      for (const gap of [0.1, 0.4]) expect(reasonOf(run(gap).r)).toBe('iso-hole-blocks-overlap');
    });
  });

  describe('circular outer loop (flange): a lattice disc, a sheared strip and bolt rings', () => {
    const flange = (name: string): Shape => {
      const shape = PATTERN_CASES[name]?.().shape;
      if (shape === undefined) throw new Error(`${name} missing`);
      return shape;
    };
    const iso = (size: number) => ({ size, trimmed: 'quad-dominant', isoQuadric: true }) as const;

    for (const [name, size] of [
      ['bolt6', 0.8],
      ['bolt12', 0.5],
    ] as const) {
      it(`${name} at size ${size} is all quads with every bolt hole rowed`, () => {
        const shape = flange(name);
        const r = quadrangulate(shape, iso(size));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.report.triangles).toBe(0);
        expect(r.value.report.openEdges).toBe(0);
        expect(r.value.report.nonManifoldEdges).toBe(0);
        // Without the belt relaxation the last strip row folds (measured minSJ -0.3 to -0.9).
        expect(r.value.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
        const m = holeBoundaryMetrics(shape, r.value);
        expect(m.coverage).toBe(1);
        expect(m.rowOnly).toBe(1);
      });
    }

    it('fails closed with iso-hole-no-room when a bolt block would touch the staircase (bolt6, size 2)', () => {
      // Without the one-cell disc clearance this size meshes a folded strip (iso-strip-folded) instead; size 1 now
      // lays out on a finer circle (20696 quads, minSJ 0.547).
      expect(reasonOf(quadrangulate(flange('bolt6'), iso(2)))).toBe('iso-hole-no-room');
    });

    it('fails closed with iso-outer-count-odd when the circle count is not a multiple of 4', () => {
      const ring = Array.from({ length: 18 }, (_, k): [number, number] => [k, 0]);
      const made = discGrid(ring, [0, 0], 10);
      expect(made.ok).toBe(false);
      if (!made.ok) expect(made.error).toBe('iso-outer-count-odd');
    });

    it('a disc too small for its strip band fails closed with iso-outer-disc-unfit', () => {
      const ring = Array.from({ length: 16 }, (_, k): [number, number] => [k, 0]);
      const made = discGrid(ring, [0, 0], 1);
      expect(made.ok).toBe(false);
      if (!made.ok) expect(made.error).toBe('iso-outer-disc-unfit');
    });
  });

  it('without the opt-in a holed plane is unchanged (the trimmed route)', () => {
    const r = quadrangulate(plate, { size: 0.25, trimmed: 'reject' });
    expect(r.ok).toBe(false);
  });
});
