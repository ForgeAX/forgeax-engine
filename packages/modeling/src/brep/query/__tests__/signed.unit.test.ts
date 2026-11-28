import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, sphere, torus } from '../../build';
import { len3 } from '../../vec';
import { signedDistance } from '../distance';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('signed distance', () => {
  const b = must(box({ size: [2, 3, 4] }));
  it('is negative inside and positive outside a box', () => {
    expect(must(signedDistance(b, [0, 0, 0])).value).toBeCloseTo(-1, 8);
    expect(must(signedDistance(b, [0.2, 0.1, 1.5])).value).toBeCloseTo(-0.5, 8);
    expect(must(signedDistance(b, [3, 0, 0])).value).toBeCloseTo(2, 8);
    // Nearest feature is an edge: the pseudo-normal still gives the sign.
    expect(must(signedDistance(b, [2, 2.5, 0])).value).toBeCloseTo(Math.sqrt(2), 8);
  });

  it('matches the analytic distance of a sphere inside and outside', () => {
    const s = must(sphere({ radius: 1.2 }));
    for (const p of [
      [0.3, 0.2, 0.1],
      [1, 0.5, 0.2],
      [2, -1, 1.5],
      [0, 0.1, -3],
    ] as const)
      expect(must(signedDistance(s, p)).value).toBeCloseTo(len3(p) - 1.2, 7);
  });

  it('handles a torus tube centre, hole and exterior', () => {
    const t = must(torus({ major: 3, minor: 1 }));
    expect(must(signedDistance(t, [3, 0, 0])).value).toBeCloseTo(-1, 7);
    expect(must(signedDistance(t, [0.5, 0, 0])).value).toBeCloseTo(1.5, 7);
    expect(must(signedDistance(t, [6, 0, 0.5])).value).toBeCloseTo(Math.sqrt(9.25) - 1, 7);
  });

  it('cylinder and cone interiors are negative', () => {
    const c = must(cylinder({ radius: 1.5, height: 3 }));
    expect(must(signedDistance(c, [0.3, 0.2, 0.1])).value).toBeCloseTo(-(1.5 - Math.sqrt(0.13)), 7);
    expect(must(signedDistance(c, [0.3, 0.2, 5])).value).toBeCloseTo(3.5, 7);
    const k = must(cone({ radius: 2, height: 3 }));
    expect(must(signedDistance(k, [0.3, 0.2, -1.2])).value).toBeLessThan(0);
    expect(must(signedDistance(k, [3, 0.2, 0])).value).toBeGreaterThan(0);
  });

  it('resolves a vertex foot by nudging the probe inside its clear ball', () => {
    // Box corner (1, 1.5, 2): the probe sees only that vertex.
    const out = must(signedDistance(b, [2, 2.5, 3]));
    expect(out.foot.kind).toBe('vertex');
    expect(out.value).toBeCloseTo(Math.sqrt(3), 8);
    const far = must(signedDistance(b, [-9, -9, -9]));
    expect(far.value).toBeCloseTo(Math.sqrt(8 ** 2 + 7.5 ** 2 + 7 ** 2), 8);
  });

  it('fails closed on an open shape', () => {
    const open = { ...b, coedges: b.coedges.slice(1) };
    const r = signedDistance(open, [0, 0, 0]);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect((r.error.detail as { reason?: string }).reason).toBe('containment-open-shape');
  });

  it('is zero on the surface', () => {
    expect(must(signedDistance(b, [1, 0.3, 0.4])).value).toBe(0);
  });
});
