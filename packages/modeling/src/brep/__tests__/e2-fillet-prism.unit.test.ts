import { describe, expect, it } from 'vitest';
import { atan2, cos, sin } from '../../dmath';
import { filletPrism } from '../fillet-prism';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import type { P2 } from '../vec';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function polygonArea(pts: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as P2;
    const q = pts[(i + 1) % pts.length] as P2;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s) / 2;
}

function perimeter(pts: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as P2;
    const q = pts[(i + 1) % pts.length] as P2;
    s += Math.sqrt((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]));
  }
  return s;
}

// Each rounded corner with turn angle delta and radius r removes r^2 (tan(delta/2) - delta/2)
// from the profile and adds a band; the tangent-length term subtracts 2t from the perimeter and
// the arc adds r |delta|. Volume = H A, area = 2A + H (P - 2 sum t + sum r |delta|).
function closedForm(pts: readonly P2[], radii: readonly number[], H: number) {
  const ccw = polygonArea(pts) > 0 ? pts : [...pts].reverse();
  const rs = polygonArea(pts) > 0 ? radii : [...radii].reverse();
  const n = ccw.length;
  let A = polygonArea(pts);
  let sumT = 0;
  let sumArc = 0;
  for (let i = 0; i < n; i++) {
    const r = rs[i] as number;
    if (r === 0) continue;
    const a = ccw[(i + n - 1) % n] as P2;
    const v = ccw[i] as P2;
    const b = ccw[(i + 1) % n] as P2;
    const e1: P2 = [v[0] - a[0], v[1] - a[1]];
    const e2: P2 = [b[0] - v[0], b[1] - v[1]];
    const delta = atan2(e1[0] * e2[1] - e1[1] * e2[0], e1[0] * e2[0] + e1[1] * e2[1]);
    const d = Math.abs(delta);
    const t = (r * sin(d / 2)) / cos(d / 2);
    const signed = delta > 0 ? 1 : -1;
    A -= signed * r * r * (sin(d / 2) / cos(d / 2) - d / 2);
    sumT += t;
    sumArc += r * d;
  }
  const P = perimeter(pts);
  return {
    volume: H * A,
    area: 2 * A + H * (P - 2 * sumT + sumArc),
  };
}

const RECT: P2[] = [
  [0, 0],
  [3, 0],
  [3, 2],
  [0, 2],
];
const L: P2[] = [
  [0, 0],
  [3, 0],
  [3, 1],
  [1, 1],
  [1, 3],
  [0, 3],
];

describe('filletPrism: closed-form volume and area', () => {
  it('rectangle with all four corners rounded by one radius', () => {
    const radii = [0.5, 0.5, 0.5, 0.5];
    const shape = must(filletPrism({ profile: RECT, height: 4, radii }));
    const m = must(measure(shape));
    const want = closedForm(RECT, radii, 4);
    expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
  });

  it('rectangle with mixed radii on two corners only', () => {
    const radii = [0.4, 0, 0.7, 0];
    const shape = must(filletPrism({ profile: RECT, height: 2.5, radii }));
    const m = must(measure(shape));
    const want = closedForm(RECT, radii, 2.5);
    expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
  });

  it('L-bracket with one reflex corner rounded concavely and one convex corner', () => {
    const radii = [0, 0, 0.3, 0, 0.5, 0];
    const shape = must(filletPrism({ profile: L, height: 1.5, radii }));
    const m = must(measure(shape));
    const want = closedForm(L, radii, 1.5);
    expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
  });

  it('zero radii reproduce the sharp prism', () => {
    const radii = [0, 0, 0, 0];
    const m = must(measure(must(filletPrism({ profile: RECT, height: 4, radii }))));
    expect(Math.abs(m.volume - 3 * 2 * 4)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - (2 * 6 + 2 * 5 * 4))).toBeLessThan(1e-9);
  });
});

describe('filletPrism: reflex corner is rounded, not sharp', () => {
  it('the top ring keeps no vertex at the sharp reflex corner (1, 1)', () => {
    const shape = must(filletPrism({ profile: L, height: 1.5, radii: [0, 0, 0, 0.3, 0, 0] }));
    const mesh = must(tessellate(shape));
    const top: P2[] = [];
    for (const f of mesh.faces()) {
      for (const v of mesh.faceVertices(f)) {
        const p = mesh.position(v);
        if (Math.abs(p[2] - 1.5) < 1e-9) top.push([p[0], p[1]]);
      }
    }
    const nearest = Math.min(...top.map((p) => Math.hypot(p[0] - 1, p[1] - 1)));
    // The band's arc is 0.3 from the sharp corner; a sharp reflex corner would give distance 0.
    expect(nearest).toBeGreaterThan(0.1);
  });
});

describe('filletPrism: watertight', () => {
  for (const [name, profile, radii] of [
    ['rectangle', RECT, [0.5, 0.5, 0.5, 0.5]],
    ['L-bracket', L, [0, 0, 0.3, 0, 0.5, 0]],
  ] as const) {
    it(`${name} tessellates with no boundary edges`, () => {
      const shape = must(filletPrism({ profile, height: 2, radii }));
      expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
    });
  }
});

describe('filletPrism: rejections', () => {
  it('rejects fillets that overlap along a shared edge', () => {
    const r = filletPrism({ profile: RECT, height: 2, radii: [1.6, 1.6, 0, 0] });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-finite radius', () => {
    const r = filletPrism({ profile: RECT, height: 2, radii: [Number.NaN, 0, 0, 0] });
    expect(r.ok).toBe(false);
  });

  it('rejects a radii list whose length differs from the profile', () => {
    const r = filletPrism({ profile: RECT, height: 2, radii: [0.2, 0.2] });
    expect(r.ok).toBe(false);
  });
});
