import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import type { NurbsCurve, NurbsSurface } from '../nurbs';
import { checkSurface, curvePoint, domain, surfacePoint } from '../nurbs';
import { birailSurface, sweepSurface } from '../nurbs-sweep';

const H = Math.SQRT1_2;
const samples = (count: number) => Array.from({ length: count + 1 }, (_, i) => i / count);
const distance = (a: Tuple3, b: Tuple3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

function line(a: Tuple3, b: Tuple3): NurbsCurve {
  return { degree: 1, points: [a, b], knots: [0, 0, 1, 1] };
}

function quarterArc(radius: number, z = 0): NurbsCurve {
  return {
    degree: 2,
    points: [
      [radius, 0, z],
      [radius, radius, z],
      [0, radius, z],
    ],
    weights: [1, H, 1],
    knots: [0, 0, 0, 1, 1, 1],
  };
}

function controlArc(
  start: Tuple3,
  end: Tuple3,
  middle: Tuple3,
  middleWeight = H,
  endWeight = 1,
): NurbsCurve {
  return {
    degree: 2,
    points: [start, middle, end],
    weights: [1, middleWeight, endWeight],
    knots: [0, 0, 0, 1, 1, 1],
  };
}

function straightRail(from: Tuple3, to: Tuple3): NurbsCurve {
  return line(from, to);
}

function assertChecked(surface: NurbsSurface): void {
  expect(checkSurface(surface).ok).toBe(true);
}

describe('NURBS rail sweeps', () => {
  it('sweeps a rational quarter-circle section into an exact cylinder with minimum stations', () => {
    const radius = 2.75;
    const rail = straightRail([0, 0, 0], [0, 0, 4]);
    const result = unwrap(sweepSurface(rail, [quarterArc(radius)], { tolerance: 1e-5 }));
    assertChecked(result.surface);
    expect(result.stations).toBe(4);
    expect(result.deviation).toBeLessThanOrEqual(1e-9);
    expect(result.converged).toBe(true);
    for (const u of samples(24)) {
      for (const v of samples(12)) {
        const p = surfacePoint(result.surface, u, v);
        expect(Math.abs(Math.hypot(p[0], p[1]) - radius)).toBeLessThan(1e-9);
      }
    }
  });

  it('transports a straight radial section around a planar quarter-circle rail', () => {
    const railRadius = 5;
    const rail = quarterArc(railRadius);
    const section = line([railRadius + 1, 0, 0], [railRadius + 2, 0, 0]);
    const result = unwrap(sweepSurface(rail, [section], { tolerance: 2e-3 }));
    assertChecked(result.surface);
    expect(result.converged, `stations=${result.stations}, deviation=${result.deviation}`).toBe(
      true,
    );
    expect(result.deviation).toBeLessThanOrEqual(2e-3);
    let worst = 0;
    for (const u of samples(20)) {
      for (const v of samples(100)) {
        const p = surfacePoint(result.surface, u, v);
        worst = Math.max(worst, Math.abs(Math.hypot(p[0], p[1]) - (railRadius + 1 + u)));
      }
    }
    expect(worst).toBeLessThanOrEqual(3e-4);
  });

  it('birails a curved section exactly between parallel straight rails', () => {
    const a = straightRail([0, 0, 0], [0, 0, 3]);
    const b = straightRail([2, 0, 0], [2, 0, 3]);
    const section = controlArc([0, 0, 0], [2, 0, 0], [1, 1, 0]);
    const result = unwrap(birailSurface(a, b, [section], { tolerance: 1e-9 }));
    assertChecked(result.surface);
    expect(result.converged).toBe(true);
    expect(result.deviation).toBeLessThanOrEqual(1e-9);
    expect(result.railGap[0]).toBeLessThanOrEqual(1e-9);
    expect(result.railGap[1]).toBeLessThanOrEqual(1e-9);
    for (const u of samples(18)) {
      for (const v of samples(11)) {
        expect(
          distance(surfacePoint(result.surface, u, v), [
            curvePoint(section, domain(section)[0])[0] + 2 * 0 + curvePoint(section, u)[0],
            curvePoint(section, u)[1],
            3 * v,
          ]),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it('forms a planar annulus sector between concentric quarter-circle rails', () => {
    const r1 = 3;
    const r2 = 6;
    const result = unwrap(
      birailSurface(quarterArc(r1), quarterArc(r2), [line([r1, 0, 0], [r2, 0, 0])], {
        tolerance: 1e-9,
        scale: 'width',
      }),
    );
    assertChecked(result.surface);
    expect(result.railGap[0]).toBeLessThanOrEqual(1e-6);
    expect(result.railGap[1]).toBeLessThanOrEqual(2e-6);
    for (const u of samples(12)) {
      for (const v of samples(16)) {
        const p = surfacePoint(result.surface, u, v);
        expect(Math.abs(p[2])).toBeLessThan(1e-12);
        expect(Math.hypot(p[0], p[1])).toBeCloseTo(r1 + (r2 - r1) * u, 9);
      }
    }
  });

  it('scales section height uniformly or preserves it in width-only mode', () => {
    const a = straightRail([0, 0, 0], [0, 0, 2]);
    const b = straightRail([2, 0, 0], [2 * Math.SQRT2, 0, 2]);
    const section = controlArc([0, 0, 0], [2, 0, 0], [1, 1, 0]);
    const uniform = unwrap(birailSurface(a, b, [section], { scale: 'uniform', tolerance: 1e-9 }));
    const width = unwrap(birailSurface(a, b, [section], { scale: 'width', tolerance: 1e-9 }));
    assertChecked(uniform.surface);
    assertChecked(width.surface);
    const heightAt = (surface: typeof uniform.surface, v: number) => {
      const point = surfacePoint(surface, 0.5, v);
      const chordStart = surfacePoint(surface, 0, v);
      const chordEnd = surfacePoint(surface, 1, v);
      const chord: [number, number, number] = [
        chordEnd[0] - chordStart[0],
        chordEnd[1] - chordStart[1],
        chordEnd[2] - chordStart[2],
      ];
      const offset: [number, number, number] = [
        point[0] - chordStart[0],
        point[1] - chordStart[1],
        point[2] - chordStart[2],
      ];
      const chordLength = Math.hypot(chord[0], chord[1], chord[2]);
      const projection =
        (offset[0] * chord[0] + offset[1] * chord[1] + offset[2] * chord[2]) / chordLength;
      const offsetLength = Math.hypot(offset[0], offset[1], offset[2]);
      return Math.sqrt(Math.max(0, offsetLength * offsetLength - projection * projection));
    };
    const startHeight = heightAt(width.surface, 0);
    expect(heightAt(uniform.surface, 1)).toBeCloseTo(startHeight * Math.SQRT2, 9);
    expect(heightAt(width.surface, 1)).toBeCloseTo(startHeight, 9);
  });

  it('reproduces different authored sections at the two rail endpoints', () => {
    const rail = straightRail([0, 0, 0], [0, 0, 2]);
    const first = controlArc([0, 0, 0], [2, 0, 0], [1, 1, 0]);
    const second = controlArc([0, 0, 2], [2, 0, 2], [1, 0.5, 2]);
    const result = unwrap(sweepSurface(rail, [first, second], { tolerance: 1e-9 }));
    assertChecked(result.surface);
    for (const [station, section] of [
      [0, first],
      [1, second],
    ] as const) {
      for (const u of samples(20)) {
        expect(
          distance(surfacePoint(result.surface, u, station), curvePoint(section, u)),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it('reports non-convergence when a curved rail exhausts its station budget', () => {
    const result = unwrap(
      sweepSurface(quarterArc(4), [line([4, 0, 0], [5, 0, 0])], {
        tolerance: 1e-12,
        maxStations: 4,
      }),
    );
    assertChecked(result.surface);
    expect(result.stations).toBe(4);
    expect(result.deviation).toBeGreaterThan(1e-12);
    expect(result.converged).toBe(false);
  });

  it('reports the requested invalid-curve, section, station, tolerance and rail errors', () => {
    const validRail = straightRail([0, 0, 0], [0, 0, 1]);
    const validSection = line([1, 0, 0], [2, 0, 0]);
    const expectCode = (result: { ok: boolean; error?: { code: string } }, code: string) => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error?.code).toBe(code);
    };

    expectCode(
      sweepSurface({ ...validRail, knots: [0, 0, 1] }, [validSection]),
      'model-invalid-argument',
    );
    expectCode(sweepSurface(validRail, []), 'model-invalid-argument');
    expectCode(
      sweepSurface(validRail, [validSection, validSection], { parameters: [0, 0] }),
      'model-invalid-argument',
    );
    expectCode(
      sweepSurface(validRail, [validSection], { parameters: [1.1] }),
      'model-invalid-argument',
    );
    expectCode(
      sweepSurface(validRail, [validSection, validSection], { parameters: [0] }),
      'model-invalid-argument',
    );
    expectCode(sweepSurface(validRail, [validSection], { tolerance: 0 }), 'model-invalid-argument');
    expectCode(sweepSurface(line([1, 1, 1], [1, 1, 1]), [validSection]), 'model-degenerate');

    const railA = straightRail([0, 0, 0], [0, 0, 1]);
    const railB = straightRail([2, 0, 0], [2, 0, 1]);
    const missA = line([0.1, 0, 0], [2, 0, 0]);
    const missB = line([0, 0, 0], [1.9, 0, 0]);
    const preconditionA = birailSurface(railA, railB, [missA], { tolerance: 0.01 });
    const preconditionB = birailSurface(railA, railB, [missB], { tolerance: 0.01 });
    expectCode(preconditionA, 'model-precondition');
    expectCode(preconditionB, 'model-precondition');
    if (!preconditionA.ok)
      expect(preconditionA.error.detail).toMatchObject({
        section: 0,
        rail: 'A',
        gap: expect.any(Number),
      });
    if (!preconditionB.ok)
      expect(preconditionB.error.detail).toMatchObject({
        section: 0,
        rail: 'B',
        gap: expect.any(Number),
      });

    const touchA = straightRail([0, 0, 0], [0, 0, 1]);
    const touchB = straightRail([0, 0, 0], [1, 0, 1]);
    expectCode(birailSurface(touchA, touchB, [line([0, 0, 0], [0, 1, 0])]), 'model-degenerate');
  });
});
