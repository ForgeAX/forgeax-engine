import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean.ts';
import { cylinder } from '../build.ts';
import { transformShape } from '../transform.ts';
import type { Shape } from '../types.ts';
import { validate } from '../validate.ts';

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

/** Cylinder of `height` on axis z, from `z0` to `z0 + height`, centred at (x, y). */
function cyl(radius: number, height: number, z0 = 0, x = 0, y = 0): Shape {
  const r = cylinder({ radius, height });
  if (!r.ok) throw new Error('fixture cylinder');
  const placed = transformShape(r.value, {
    rot: [...IDENTITY] as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ],
    t: [x, y, z0 + height / 2],
  });
  if (!placed.ok) throw new Error('fixture placement');
  return placed.value;
}

function plateWithBoss(): Shape {
  const r = booleanSolids(cyl(60, 8), cyl(16, 26, -6), 'union');
  if (!r.ok) throw new Error(`boss union failed: ${r.error.code}`);
  return r.value;
}

describe('planar cap with a coaxial hole: interior point comes from the trim', () => {
  it('G1: a bore coaxial with a boss on a plate builds a closed solid', () => {
    const bored = booleanSolids(plateWithBoss(), cyl(7, 40, -10), 'difference');
    expect(bored.ok).toBe(true);
    if (!bored.ok) return;
    expect(validate(bored.value).ok).toBe(true);
    expect(bored.value.faces.length).toBeGreaterThan(0);
  });

  it('G5: a boss unioned on a bored flange builds a closed solid', () => {
    const bored = booleanSolids(cyl(50, 10), cyl(26, 40, -20), 'difference');
    expect(bored.ok).toBe(true);
    if (!bored.ok) return;
    const boss = cyl(5, 18, -17, 0, 34);
    const joined = booleanSolids(bored.value, boss, 'union');
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(validate(joined.value).ok).toBe(true);
  });
});
