import { describe, expect, it } from 'vitest';
import { draftedPrism } from '../draft';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import type { P2 } from '../vec';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function regular(n: number, radius: number): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [radius * Math.cos(a), radius * Math.sin(a)];
  });
}

// Regular n-gon with inradius rho: area n rho^2 tan(pi/n), side 2 rho tan(pi/n). Under a mitred
// inward offset d the inradius becomes rho - d, so the area at height z is K (rho - z t)^2 with
// t = tan(angle), K = n tan(pi/n). Volume integrates that square; the side faces are trapezoids of
// slant height h / cos(angle).
function polygonDraft(n: number, radius: number, h: number, angle: number) {
  const rho = radius * Math.cos(Math.PI / n);
  const k = n * Math.tan(Math.PI / n);
  const t = Math.tan(angle);
  const top = rho - h * t;
  const volume = (k * (rho * rho * rho - top * top * top)) / (3 * t);
  const sides = n * (rho + top) * Math.tan(Math.PI / n) * (h / Math.cos(angle));
  const area = k * rho * rho + k * top * top + sides;
  return { volume, area };
}

// Rectangle a x b, mitred top inset by d on every side. Cross-section area at height z is
// (a - 2 d z')(b - 2 d z') with z' = z / h, a quadratic in z, so Simpson's rule over [0, h] is
// exact: V = h/6 (A0 + 4 Am + A1) with Am the mid-height area. (Not a pyramidal frustum: the
// rectangle does not scale uniformly.)
function rectDraft(a: number, b: number, h: number, angle: number) {
  const d = h * Math.tan(angle);
  const a0 = a * b;
  const am = (a - d) * (b - d);
  const a1 = (a - 2 * d) * (b - 2 * d);
  const volume = (h / 6) * (a0 + 4 * am + a1);
  const slant = h / Math.cos(angle);
  // Two faces of each length, each a trapezoid with bottom and top edge lengths averaged.
  const sides = (a + (a - 2 * d) + (b + (b - 2 * d))) * slant;
  return { volume, area: a0 + a1 + sides };
}

describe('draftedPrism: closed-form volume and area', () => {
  it('rectangle 2x3, height 4, draft 0.2 rad matches the frustum closed form', () => {
    const shape = must(
      draftedPrism({
        profile: [
          [0, 0],
          [2, 0],
          [2, 3],
          [0, 3],
        ],
        height: 4,
        angle: 0.2,
      }),
    );
    const m = must(measure(shape));
    const want = rectDraft(2, 3, 4, 0.2);
    expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
  });

  for (const [n, radius, h, angle] of [
    [6, 1.5, 2.5, 0.25],
    [3, 2, 1.5, 0.4],
    [5, 1, 3, 0.1],
  ] as const) {
    it(`regular ${n}-gon R=${radius} h=${h} draft=${angle} matches the closed form`, () => {
      const shape = must(draftedPrism({ profile: regular(n, radius), height: h, angle }));
      const m = must(measure(shape));
      const want = polygonDraft(n, radius, h, angle);
      expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
      expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
    });
  }

  it('zero draft is a plain prism: volume A0 h, area 2 A0 + perimeter h', () => {
    const shape = must(
      draftedPrism({
        profile: [
          [0, 0],
          [2, 0],
          [2, 3],
          [0, 3],
        ],
        height: 4,
        angle: 0,
      }),
    );
    const m = must(measure(shape));
    expect(Math.abs(m.volume - 24)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - (12 + 10 * 4))).toBeLessThan(1e-9);
  });

  it('accepts either winding of the profile', () => {
    const cw = must(draftedPrism({ profile: regular(6, 1.5).reverse(), height: 2.5, angle: 0.25 }));
    const ccw = must(draftedPrism({ profile: regular(6, 1.5), height: 2.5, angle: 0.25 }));
    expect(Math.abs(must(measure(cw)).volume - must(measure(ccw)).volume)).toBeLessThan(1e-9);
  });
});

describe('draftedPrism: watertight topology', () => {
  it('hexagon draft tessellates with no boundary edges', () => {
    const shape = must(draftedPrism({ profile: regular(6, 1.5), height: 2.5, angle: 0.25 }));
    expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
  });

  it('rectangle draft tessellates with no boundary edges', () => {
    const shape = must(
      draftedPrism({
        profile: [
          [0, 0],
          [2, 0],
          [2, 3],
          [0, 3],
        ],
        height: 4,
        angle: 0.2,
      }),
    );
    expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
  });
});

describe('draftedPrism: rejection', () => {
  const square: P2[] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];

  it('rejects a concave profile', () => {
    const lShape: P2[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ];
    expect(draftedPrism({ profile: lShape, height: 1, angle: 0.1 }).ok).toBe(false);
  });

  it('rejects an angle at or beyond pi/2', () => {
    expect(draftedPrism({ profile: square, height: 1, angle: Math.PI / 2 }).ok).toBe(false);
  });

  it('rejects a draft that collapses the top outline', () => {
    expect(draftedPrism({ profile: square, height: 2, angle: 0.8 }).ok).toBe(false);
  });
});
