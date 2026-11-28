import { describe, expect, it } from 'vitest';
import { filletCylinder } from '../fillet-cylinder';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const PI = Math.PI;

// Profile rectangle [0, R] x [0, H] minus two corner regions. Each corner has area
// r^2 (1 - pi/4) and first moment about the axis a r^2 (1 - pi/4) + r^3 / 6 with a = R - r.
// Pappus: V = 2 pi times the first moment. Area: two flat disks of radius a, the straight side
// 2 pi R (H - 2 r), and two quarter-torus bands 2 pi r (a pi / 2 + r) each.
function closedForm(R: number, H: number, r: number) {
  const a = R - r;
  const corner = a * r * r * (1 - PI / 4) + (r * r * r) / 6;
  return {
    volume: PI * R * R * H - 2 * 2 * PI * corner,
    area: 2 * PI * a * a + 2 * PI * R * (H - 2 * r) + 4 * PI * r * (a * (PI / 2) + r),
  };
}

describe('filletCylinder: closed-form volume and area', () => {
  for (const [R, H, r] of [
    [2, 3, 0.5],
    [1, 2, 0.3],
  ] as const) {
    it(`radius ${R} height ${H} fillet ${r}: Pappus volume and closed-form area`, () => {
      const m = must(measure(must(filletCylinder({ radius: R, height: H, fillet: r }))));
      const want = closedForm(R, H, r);
      expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
      expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
    });

    it(`radius ${R} height ${H} fillet ${r}: tessellates watertight`, () => {
      const shape = must(filletCylinder({ radius: R, height: H, fillet: r }));
      expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
    });
  }

  it('rejects a fillet that reaches the axis', () => {
    expect(filletCylinder({ radius: 1, height: 3, fillet: 1 }).ok).toBe(false);
  });

  it('rejects fillets that meet on the side', () => {
    expect(filletCylinder({ radius: 2, height: 1, fillet: 0.5 }).ok).toBe(false);
  });
});
