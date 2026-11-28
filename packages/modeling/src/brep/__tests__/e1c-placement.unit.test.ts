import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { tessellate } from '../tessellate';
import { axisRotation, IDENTITY_PLACEMENT, type Placement, transformShape } from '../transform';
import type { Shape } from '../types';
import { validate } from '../validate';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function volumeOf(shape: Shape): number {
  const t = tessellate(shape, { angle: Math.PI / 64 });
  if (!t.ok) throw new Error('tessellate');
  const m = t.value;
  let vol = 0;
  for (const f of m.faces()) {
    const vs = m.faceVertices(f).map((v) => m.position(v));
    const a = vs[0];
    if (a === undefined) continue;
    for (let i = 1; i + 1 < vs.length; i++) {
      const b = vs[i];
      const c = vs[i + 1];
      if (b === undefined || c === undefined) continue;
      vol +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
  }
  return Math.abs(vol);
}

const translate = (t: [number, number, number]): Placement => ({ rot: IDENTITY_PLACEMENT.rot, t });
const rotated = (axis: 0 | 1 | 2, angle: number, t: [number, number, number]): Placement => ({
  rot: axisRotation(axis, angle),
  t,
});

describe('E1c placement: rigid transform of a shape', () => {
  it('translation moves every vertex and keeps validity and volume', () => {
    const b = must(box({ size: [2.6, 1, 1] }));
    const moved = must(transformShape(b, translate([5, -3, 2])));
    expect(validate(moved).ok).toBe(true);
    expect(Math.abs(volumeOf(moved) - 2.6)).toBeLessThan(1e-3);
    const xs = moved.vertices.map((v) => v.p[0]);
    expect(Math.min(...xs)).toBeCloseTo(5 - 1.3, 9);
    expect(Math.max(...xs)).toBeCloseTo(5 + 1.3, 9);
  });

  it('a quarter turn about z swaps the x and y extents of a box', () => {
    const b = must(box({ size: [2.6, 1, 1] }));
    const turned = must(transformShape(b, rotated(2, Math.PI / 2, [0, 0, 0])));
    expect(validate(turned).ok).toBe(true);
    const ys = turned.vertices.map((v) => v.p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2.6, 9);
  });

  it('refuses a reflection (det -1) rather than producing a mirrored shape', () => {
    const b = must(box({ size: [1, 1, 1] }));
    const mirror: Placement = {
      rot: [
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
    };
    expect(transformShape(b, mirror).ok).toBe(false);
  });

  it('a placed box minus a placed cylinder equals the same boolean at the origin', () => {
    const boxS = must(box({ size: [2.6, 1, 1] }));
    const cylS = must(cylinder({ radius: 0.3, height: 3 }));
    const at = must(booleanSolids(boxS, cylS, 'difference'));
    const offset: [number, number, number] = [4, 1, -2];
    const placedBox = must(transformShape(boxS, translate(offset)));
    const placedCyl = must(transformShape(cylS, translate(offset)));
    const placed = must(booleanSolids(placedBox, placedCyl, 'difference'));
    expect(validate(placed).ok).toBe(true);
    expect(placed.faces.length).toBe(at.faces.length);
    expect(Math.abs(volumeOf(placed) - volumeOf(at))).toBeLessThan(1e-3);
  });
});
