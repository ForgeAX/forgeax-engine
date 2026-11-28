import { type Model, type Point2, region2d, sel, sketch } from '@forgeax/engine-modeling';
import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import {
  BRACKET_DEFAULTS,
  type BracketParameters,
  bracketSpec,
  buildBracket,
  solveBracket,
} from '../sketch-bracket';
import pack from '../sketch-bracket.pack';

const dist = (p: Point2, q: Point2) => Math.hypot(q[0] - p[0], q[1] - p[1]);

describe('sketch-bracket example', () => {
  it('solves the rough start into the stated profile', () => {
    const s = solveBracket();
    const { a, b, c, d, k1, k2, h, hr } = s.points as Record<string, Point2>;
    expect(Math.hypot((a as Point2)[0], (a as Point2)[1])).toBeLessThan(1e-9);
    expect(dist(a as Point2, b as Point2)).toBeCloseTo(BRACKET_DEFAULTS.length, 7);
    expect(dist(b as Point2, c as Point2)).toBeCloseTo(BRACKET_DEFAULTS.height, 7);
    expect((b as Point2)[1]).toBeCloseTo(0, 7);
    expect((c as Point2)[1]).toBeCloseTo(BRACKET_DEFAULTS.height, 7);
    const slant = (Math.atan2((d as Point2)[1], (d as Point2)[0]) * 180) / Math.PI;
    expect(slant).toBeCloseTo(BRACKET_DEFAULTS.slantDegrees, 5);
    expect(dist(k1 as Point2, k2 as Point2)).toBeCloseTo(BRACKET_DEFAULTS.slotSpan, 7);
    expect(dist(h as Point2, hr as Point2)).toBeCloseTo(BRACKET_DEFAULTS.boreRadius, 7);
    expect(s.residual).toBeLessThanOrEqual(1e-8);
  });

  it('reports its degrees of freedom: the slot and bore leave no point free', () => {
    const s = solveBracket();
    expect(s.dof).toBe(1);
    expect(s.free).toEqual(['hr']);
  });

  it('one outline with two holes; area is the trapezoid minus slot and bore', () => {
    const s = solveBracket();
    expect(s.region).toHaveLength(1);
    expect(s.region[0]?.holes).toHaveLength(2);
    const { length, height, slantDegrees, slotSpan, slotRadius, boreRadius } = BRACKET_DEFAULTS;
    const top = length - height / Math.tan((slantDegrees * Math.PI) / 180);
    const exact =
      ((length + top) / 2) * height -
      (2 * slotRadius * slotSpan + Math.PI * slotRadius ** 2) -
      Math.PI * boreRadius ** 2;
    expect(Math.abs(region2d.area(s.region) - exact) / exact).toBeLessThan(2e-3);
  });

  it('extrudes to a closed solid whose volume is area times thickness', () => {
    const m: Model = buildBracket();
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.volume).toBeCloseTo(
      region2d.area(solveBracket().region) * BRACKET_DEFAULTS.thickness,
      9,
    );
    expect(m.count(sel.tag('bracket'))).toBeGreaterThan(0);
  });

  it('stays a closed solid across the declared parameter range', () => {
    for (const p of pack.parameters as readonly {
      name: keyof BracketParameters;
      minimum: number;
      maximum: number;
    }[]) {
      for (const value of [p.minimum, p.maximum]) {
        const variant = buildBracket({ ...BRACKET_DEFAULTS, [p.name]: value });
        expect([p.name, value, variant.poisoned?.code]).toEqual([p.name, value, undefined]);
        expect(variant.validate().closed).toBe(true);
      }
    }
  });

  it('a contradicting dimension fails with model-solver-diverged', () => {
    const spec = bracketSpec();
    const r = sketch.solve({
      ...spec,
      constraints: [...spec.constraints, { kind: 'distance', a: 'a', b: 'b', value: 0.2 }],
    });
    expect(r.ok === false && r.error.code).toBe('model-solver-diverged');
  });

  it('is an ordinary Pack build with one mesh', async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c0501'),
      readByGuid: async () => {
        throw new Error('the bracket reads no other asset');
      },
      values: {
        length: BRACKET_DEFAULTS.length,
        height: BRACKET_DEFAULTS.height,
        slantDegrees: BRACKET_DEFAULTS.slantDegrees,
        thickness: BRACKET_DEFAULTS.thickness,
      },
    });
    expect(result.ok ? Object.keys(result.value) : result).toEqual(['mesh/bracket']);
  });
});
