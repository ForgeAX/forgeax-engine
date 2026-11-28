import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { measure } from '../measure';
import { makeFrame } from '../surfaces';
import type { Shape } from '../types';
import { validate } from '../validate';

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function block(size: [number, number, number], origin: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(origin, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
}

function volume(shape: Shape): number {
  return must(measure(shape)).volume;
}

function assertVolume(actual: number, expected: number, name: string): void {
  expect(Math.abs(actual - expected) / expected, name).toBeLessThan(1e-9);
}

const cases = [
  {
    name: 'stepped L-bracket',
    a: block([4, 1, 1], [0, 0, 0]),
    b: block([1, 2, 1.3], [1.45, 1, 0.17]),
    expectedIntersection: 0.49,
    expectedUnion: 6.11,
  },
  {
    name: 'T-shaped block',
    a: block([4, 1, 1], [0, 0, 0]),
    b: block([1, 2, 1.3], [0.13, 1.2, 0.17]),
    expectedIntersection: 0.294,
    expectedUnion: 6.306,
  },
  {
    name: 'crossed bars',
    a: block([4, 1, 1], [0, 0, 0]),
    b: block([1, 4, 1.3], [0.13, -0.17, 0.21]),
    expectedIntersection: 0.94,
    expectedUnion: 8.26,
  },
] as const;

describe('planar crossing solid union and intersection', () => {
  it('applies the regularized rule to overlapping coplanar faces', () => {
    const a = block([4, 1, 1], [0, 0, 0]);
    const b = block([1, 2, 1], [0.13, 1, 0]);
    const expected = { union: 5.5, intersect: 0.5, difference: 3.5 } as const;
    for (const op of ['union', 'intersect', 'difference'] as const) {
      const result = must(booleanSolids(a, b, op));
      expect(validate(result).ok, op).toBe(true);
      assertVolume(volume(result), expected[op], `coplanar ${op}`);
    }
  });

  it('fails closed on a curved operand', () => {
    const a = block([4, 1, 1], [0, 0, 0]);
    const rod = must(
      cylinder({
        radius: 0.3,
        height: 2,
        frame: makeFrame([1.3, 0.1, 0.2], [0, 1, 0], [1, 0, 0]),
        tol: 1e-8,
      }),
    );
    for (const op of ['union', 'intersect'] as const) {
      const result = booleanSolids(a, rod, op);
      expect(result.ok, op).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('model-partial');
    }
  });

  it('accepts a face with a hole as an operand', () => {
    const host = block([4, 4, 2], [0, 0, 0]);
    const pocket = must(booleanSolids(host, block([1, 1, 1], [0, 0, 1]), 'difference'));
    const crossing = block([1, 6, 1], [0.13, 0.17, 0.3]);
    for (const op of ['union', 'intersect'] as const) {
      const result = booleanSolids(pocket, crossing, op);
      expect(result.ok, op).toBe(true);
      if (result.ok) expect(validate(result.value).ok).toBe(true);
    }
  });

  it('fails closed on disjoint or merely touching solids instead of returning a shell', () => {
    const a = block([4, 1, 1], [0, 0, 0]);
    const separate = block([1, 1, 1], [0.2, 5, 0.1]);
    const touching = block([1, 1, 1], [0.2, 1, 0.1]);
    for (const other of [separate, touching]) {
      const result = booleanSolids(a, other, 'intersect');
      if (result.ok) expect(volume(result.value)).toBeLessThan(1e-12);
      else expect(['model-partial', 'model-precondition']).toContain(result.error.code);
    }
  });

  for (const testCase of cases) {
    it(`${testCase.name}: preserves exact volumes and inclusion-exclusion`, () => {
      const union = booleanSolids(testCase.a, testCase.b, 'union');
      const intersection = booleanSolids(testCase.a, testCase.b, 'intersect');
      expect(union.ok, JSON.stringify(union.ok ? null : union.error)).toBe(true);
      expect(intersection.ok, JSON.stringify(intersection.ok ? null : intersection.error)).toBe(
        true,
      );
      if (!union.ok || !intersection.ok) return;
      expect(validate(union.value).ok).toBe(true);
      expect(validate(intersection.value).ok).toBe(true);
      const unionVolume = volume(union.value);
      const intersectionVolume = volume(intersection.value);
      assertVolume(unionVolume, testCase.expectedUnion, `${testCase.name} union`);
      assertVolume(
        intersectionVolume,
        testCase.expectedIntersection,
        `${testCase.name} intersection`,
      );
      assertVolume(
        unionVolume + intersectionVolume,
        volume(testCase.a) + volume(testCase.b),
        `${testCase.name} inclusion-exclusion`,
      );
      const broken = {
        ...union.value,
        shells: union.value.shells.map((shell) => ({ faces: shell.faces.slice(1) })),
      };
      expect(validate(broken).ok).toBe(false);
    });
  }
});
