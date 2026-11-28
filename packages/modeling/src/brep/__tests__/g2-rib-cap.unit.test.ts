import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { measure } from '../measure';
import { transformShape } from '../transform';
import type { Face, Shape } from '../types';
import { validate } from '../validate';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`build failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

function moved(shape: Shape, t: [number, number, number]): Shape {
  return must(transformShape(shape, { rot: IDENTITY, t }));
}

const R = 60;
const TOL = 1e-9;
const RIB = { x0: 16, x1: 36, y: 2, z0: 0, z1: 10 };

// G2 repro (examples/brep-stress/gaps.ts): cylinder(h=8) is centred, so its cap sits at z=4 and the
// rib (z 0..10) keeps the part above it. Union = plate + rib above z=4 = 28800*pi + 20*4*6.
const REPRO_UNION = Math.PI * R * R * 8 + 20 * 4 * (RIB.z1 - 4);

function volume(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error('measure failed');
  return m.value.volume;
}

describe('G2 rib gusset on a cylinder cap (section cap seam, union)', () => {
  const rib = moved(must(box({ size: [20, 4, 10] })), [26, 0, 5]);

  it('repro: union is a valid closed solid with the analytic volume', () => {
    const plate = must(cylinder({ radius: R, height: 8 }));
    const r = booleanSolids(plate, rib, 'union');
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    expect(validate(r.value).ok).toBe(true);
    expect(Math.abs(volume(r.value) - REPRO_UNION)).toBeLessThan(TOL * REPRO_UNION);
  });

  it('coplanar bottom: plate z 0..8 and rib z 0..10 keep one bottom face without a hole', () => {
    const plate = moved(must(cylinder({ radius: R, height: 8 })), [0, 0, 4]);
    const r = booleanSolids(plate, rib, 'union');
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    expect(validate(r.value).ok).toBe(true);
    const expected = Math.PI * R * R * 8 + 20 * 4 * 2;
    expect(Math.abs(volume(r.value) - expected)).toBeLessThan(TOL * expected);
    // The bottom disc (z=0) is one face with a single outer loop; the rib bottom merged into it.
    const bottoms = r.value.faces.filter((f: Face) => {
      const plane = r.value.surfaces[f.surface];
      return plane?.kind === 'plane' && Math.abs(plane.frame.o[2]) < TOL && f.loops.length === 1;
    });
    expect(bottoms.length).toBe(1);
    expect(r.value.faces.some((f: Face) => f.loops.length > 1)).toBe(true);
  });
});

describe('G2 section cap: deliberate break and fail-closed scope', () => {
  it('a hole loop with a dropped coedge is caught by validate', () => {
    const plate = must(cylinder({ radius: R, height: 8 }));
    const rib = moved(must(box({ size: [20, 4, 10] })), [26, 0, 5]);
    const r = booleanSolids(plate, rib, 'union');
    if (!r.ok) throw new Error('expected ok');
    const shape = r.value;
    const holeLoop = shape.loops.findIndex((l) => l.outer === false);
    expect(holeLoop).toBeGreaterThanOrEqual(0);
    const loops = shape.loops.map((l, i) =>
      i === holeLoop ? { ...l, coedges: l.coedges.slice(1) } : l,
    );
    expect(validate({ ...shape, loops }).ok).toBe(false);
  });

  it('difference keeps the existing refusal (not in this slice)', () => {
    const plate = must(cylinder({ radius: R, height: 8 }));
    const rib = moved(must(box({ size: [20, 4, 10] })), [26, 0, 5]);
    const r = booleanSolids(plate, rib, 'difference');
    expect(r.ok).toBe(false);
  });
});

describe('G2 gap entry (examples/brep-stress/gaps.ts)', () => {
  it('the GAPS G2 run builds with the analytic repro volume', async () => {
    const { GAPS } = await import('../../../examples/brep-stress/gaps.ts');
    const g2 = GAPS.find((g) => g.id === 'G2');
    if (!g2) throw new Error('G2 gap missing');
    const r = g2.run();
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    expect(validate(r.value).ok).toBe(true);
    expect(Math.abs(volume(r.value) - REPRO_UNION)).toBeLessThan(TOL * REPRO_UNION);
  });
});
