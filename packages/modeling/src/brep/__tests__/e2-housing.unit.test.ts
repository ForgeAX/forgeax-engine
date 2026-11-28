import { describe, expect, it } from 'vitest';
import { housing } from '../housing';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { validate } from '../validate';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

// Base X Y H centred on the origin, boss radius rb height Hb (> H) on axis x = bx, bore rh (< rb)
// through the same axis. Volume: base + boss outside the base - bore column through the solid.
function closedForm(X: number, Y: number, H: number, rb: number, Hb: number, rh: number): number {
  const PI = Math.PI;
  return X * Y * H + PI * rb * rb * (Hb - H) - PI * rh * rh * Hb;
}

describe('housing: placed boss union then bore difference', () => {
  const cases = [
    { size: [4, 2, 1] as const, bossX: 1, rb: 0.3, Hb: 3, rh: 0.2 },
    { size: [3, 2, 1.2] as const, bossX: 0.8, rb: 0.35, Hb: 3.2, rh: 0.15 },
  ];
  for (const c of cases) {
    it(`base ${c.size.join('x')} boss r${c.rb} bore r${c.rh}: closed-form volume at 1e-9`, () => {
      const shape = must(
        housing({
          size: c.size,
          bossX: c.bossX,
          bossRadius: c.rb,
          bossHeight: c.Hb,
          boreRadius: c.rh,
        }),
      );
      expect(validate(shape).ok).toBe(true);
      const m = must(measure(shape));
      const want = closedForm(c.size[0], c.size[1], c.size[2], c.rb, c.Hb, c.rh);
      expect(Math.abs(m.volume - want)).toBeLessThan(1e-9);
    });

    it(`base ${c.size.join('x')}: tessellates watertight`, () => {
      const shape = must(
        housing({
          size: c.size,
          bossX: c.bossX,
          bossRadius: c.rb,
          bossHeight: c.Hb,
          boreRadius: c.rh,
        }),
      );
      expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
    });
  }
});

describe('housing: rejections', () => {
  it('rejects a bore not smaller than the boss', () => {
    const r = housing({
      size: [4, 2, 1],
      bossX: 1,
      bossRadius: 0.3,
      bossHeight: 3,
      boreRadius: 0.3,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a boss that does not extend past both faces', () => {
    const r = housing({
      size: [4, 2, 1],
      bossX: 1,
      bossRadius: 0.3,
      bossHeight: 0.8,
      boreRadius: 0.2,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a boss footprint outside the base', () => {
    const r = housing({
      size: [4, 2, 1],
      bossX: 1.9,
      bossRadius: 0.3,
      bossHeight: 3,
      boreRadius: 0.2,
    });
    expect(r.ok).toBe(false);
  });
});
