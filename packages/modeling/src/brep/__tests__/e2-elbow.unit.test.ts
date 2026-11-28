import { describe, expect, it } from 'vitest';
import { pipeElbow } from '../elbow';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const PI = Math.PI;

// Pappus: annulus area A times the centroid path length (two legs of L, quarter bend of R pi/2).
// Area: two outer and two bore cylinder legs, the quarter torus wall (pi^2 R r per wall), and two
// annular caps.
function closedForm(R: number, ro: number, ri: number, L: number) {
  const annulus = PI * (ro * ro - ri * ri);
  return {
    volume: annulus * (2 * L + (PI / 2) * R),
    area: 4 * PI * (ro + ri) * L + PI * PI * R * (ro + ri) + 2 * annulus,
  };
}

describe('pipeElbow: closed-form volume and area', () => {
  for (const [R, ro, ri, L] of [
    [3, 1, 0.6, 2],
    [2.5, 0.8, 0.3, 1.5],
  ] as const) {
    it(`bend ${R} outer ${ro} inner ${ri} leg ${L}: Pappus volume and closed-form area`, () => {
      const shape = must(pipeElbow({ bend: R, outer: ro, inner: ri, leg: L }));
      const m = must(measure(shape));
      const want = closedForm(R, ro, ri, L);
      expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
      expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
    });

    it(`bend ${R} outer ${ro} inner ${ri} leg ${L}: tessellates watertight`, () => {
      const shape = must(pipeElbow({ bend: R, outer: ro, inner: ri, leg: L }));
      expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
    });
  }

  it('rejects an outer radius that reaches the bend radius', () => {
    expect(pipeElbow({ bend: 1, outer: 1, inner: 0.5, leg: 1 }).ok).toBe(false);
  });

  it('rejects a bore not smaller than the outer radius', () => {
    expect(pipeElbow({ bend: 3, outer: 1, inner: 1, leg: 1 }).ok).toBe(false);
  });
});
