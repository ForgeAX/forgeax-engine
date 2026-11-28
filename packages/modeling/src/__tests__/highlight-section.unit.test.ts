import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type HighlightOptions, highlightLines } from '../highlight-lines';
import { curveCurvature, curvePoint, interpolateGrid, type NurbsSurface } from '../nurbs';
import { checkSurfaceQuality } from '../surface-quality';

/** Exact rational quarter-cylinder patch, parameterized along x and around the arc. */
function quarterCylinder(x0: number, x1: number, radius: number): NurbsSurface {
  const h = Math.SQRT1_2;
  const arc: readonly (readonly [number, number])[] = [
    [radius, 0],
    [radius, radius],
    [0, radius],
  ];
  const points = arc.map(([y, z]) => [[x0, y, z] as Tuple3, [x1, y, z] as Tuple3]);
  return {
    degreeU: 2,
    degreeV: 1,
    points,
    weights: [1, h, 1].map((w) => [w, w]),
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

function sectionLines(surfaces: readonly NurbsSurface[], options: HighlightOptions) {
  const result = highlightLines(surfaces, options);
  if (!result.ok) throw result.error;
  return result.value.lines;
}

/** Interpolated 0.6 m x 0.4 m crowned panel, optionally with a local Gaussian bump. */
function crownedPanel(bump: number): NurbsSurface {
  const samples = Array.from({ length: 31 }, (_, i) =>
    Array.from({ length: 21 }, (_, j): Tuple3 => {
      const x = (0.6 * i) / 30;
      const y = (0.4 * j) / 20;
      const crown = 0.02 * (1 - ((x - 0.3) / 0.3) ** 2) + 0.012 * (1 - ((y - 0.2) / 0.2) ** 2);
      const g = bump * Math.exp(-((x - 0.33) ** 2 + (y - 0.21) ** 2) / (2 * 0.02 * 0.02));
      return [x, y, crown + g];
    }),
  );
  const fit = interpolateGrid(samples);
  if (!fit.ok) throw fit.error;
  return fit.value;
}

const section = (normal: Tuple3, step: number, origin?: number): HighlightOptions => ({
  field: 'section',
  normal,
  step,
  ...(origin === undefined ? {} : { origin }),
});

describe('plane-section highlight lines', () => {
  it('extracts exact rational quarter-cylinder stations with the expected curvature', () => {
    const length = 0.5;
    const radius = 0.2;
    const lines = sectionLines(
      [quarterCylinder(0, length, radius)],
      section([1, 0, 0], length / 5),
    );
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line.level).toBeGreaterThan(0);
      expect(line.level).toBeLessThanOrEqual(length);
      for (const t of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
        const p = curvePoint(line.curve, t);
        expect(Math.abs(p[0] - line.level)).toBeLessThan(1e-6);
        expect(Math.abs(Math.hypot(p[1], p[2]) - radius)).toBeLessThan(1e-5);
        expect(Math.abs(curveCurvature(line.curve, t).curvature - 1 / radius)).toBeLessThan(
          0.01 / radius,
        );
      }
    }
  });

  it('extracts straight axis-parallel sections at their z offsets', () => {
    const length = 0.5;
    const radius = 0.2;
    const lines = sectionLines(
      [quarterCylinder(0, length, radius)],
      section([0, 0, 1], radius / 5),
    );
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const p = curvePoint(line.curve, t);
        expect(Math.abs(p[2] - line.level)).toBeLessThan(1e-6);
        expect(Math.abs(curveCurvature(line.curve, t).curvature)).toBeLessThan(1e-5);
      }
    }
  });

  it('shifts plane levels by the requested origin', () => {
    const length = 0.5;
    const step = length / 5;
    const s = quarterCylinder(0, length, 0.2);
    const regular = sectionLines([s], section([1, 0, 0], step));
    const shifted = sectionLines([s], section([1, 0, 0], step, step / 2));
    expect(regular).toHaveLength(5);
    expect(shifted).toHaveLength(5);
    for (let i = 0; i < shifted.length; i++) {
      const level = (shifted[i] as (typeof shifted)[number]).level;
      expect(level).toBeCloseTo((i + 0.5) * step, 12);
      expect(Math.abs(level / step - Math.floor(level / step) - 0.5)).toBeLessThan(1e-12);
    }
  });

  it('chains a section across adjacent patches in crossing order', () => {
    const radius = 0.2;
    const lines = sectionLines(
      [quarterCylinder(0, 0.25, radius), quarterCylinder(0.25, 0.5, radius)],
      section([0, 0, 1], radius / 4),
    );
    const crossing = lines.find((line) => line.level === radius / 2);
    expect(crossing).toBeDefined();
    expect(crossing?.patches).toEqual([0, 1]);
    expect(curvePoint(crossing?.curve as NonNullable<typeof crossing>['curve'], 0)[0]).toBeCloseTo(
      0,
      5,
    );
    expect(curvePoint(crossing?.curve as NonNullable<typeof crossing>['curve'], 1)[0]).toBeCloseTo(
      0.5,
      5,
    );
  });

  it('uses section lines for the surface-quality fairness gate', () => {
    const options = { highlights: section([1, 0, 0], 0.05), isoparms: 0 } as const;
    const smooth = checkSurfaceQuality(
      { surfaces: [{ name: 'crowned-panel', surface: crownedPanel(0) }] },
      options,
    );
    if (!smooth.ok) throw smooth.error;
    expect(smooth.value.issues.filter((issue) => issue.code === 'highlight')).toEqual([]);

    const bumpOptions = { highlights: section([1, 0, 0], 0.05, 0.33), isoparms: 0 } as const;
    const bumped = checkSurfaceQuality(
      { surfaces: [{ name: 'crowned-panel', surface: crownedPanel(0.0003) }] },
      bumpOptions,
    );
    if (!bumped.ok) throw bumped.error;
    const findings = bumped.value.issues.filter((issue) => issue.code === 'highlight');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((issue) => Math.abs((issue.detail.level as number) - 0.33) < 0.05)).toBe(
      true,
    );
  });

  it('rejects zero and non-finite normals, invalid steps, and non-finite origins', () => {
    const s = quarterCylinder(0, 0.5, 0.2);
    const invalid: HighlightOptions[] = [
      section([0, 0, 0], 0.1),
      section([Number.NaN, 0, 1], 0.1),
      section([0, Number.POSITIVE_INFINITY, 1], 0.1),
      section([1, 0, 0], 0),
      section([1, 0, 0], -0.1),
      section([1, 0, 0], Number.NaN),
      section([1, 0, 0], Number.POSITIVE_INFINITY),
      section([1, 0, 0], 0.1, Number.NaN),
      section([1, 0, 0], 0.1, Number.POSITIVE_INFINITY),
    ];
    for (const options of invalid) {
      const result = highlightLines([s], options);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('model-invalid-argument');
    }
    const quality = checkSurfaceQuality(
      { surfaces: [{ name: 'panel', surface: s }] },
      { highlights: section([0, 0, 0], 0.1) },
    );
    expect(quality.ok).toBe(false);
    expect(!quality.ok && quality.error.code).toBe('model-invalid-argument');
  });
});
