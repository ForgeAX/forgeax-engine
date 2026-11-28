import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { boxWithThroughHole } from '../boolean-hole';
import { box, cylinder } from '../build';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

const SIZE: [number, number, number] = [2.6, 1, 1];
const R = 0.3;
const BOX_VOLUME = SIZE[0] * SIZE[1] * SIZE[2];
// The cylinder is taller than the box, so its volume inside the box is the box height times the disc area.
const CYL_HEIGHT = SIZE[2] * 3;
const CYL_VOLUME_FULL = Math.PI * R * R * CYL_HEIGHT;
const CYL_VOLUME_IN_BOX = Math.PI * R * R * SIZE[2];
const DIFFERENCE_VOLUME = BOX_VOLUME - CYL_VOLUME_IN_BOX;
const UNION_VOLUME = BOX_VOLUME + CYL_VOLUME_FULL - CYL_VOLUME_IN_BOX;
const INTERSECT_VOLUME = CYL_VOLUME_IN_BOX;
// Interim gate: tessellated volume against the closed form. Switch to 1e-9 when the measure lane lands.
const TOL = 1e-3;

function must(r: { ok: true; value: Shape } | { ok: false; error: unknown }): Shape {
  if (!r.ok) throw new Error(`build failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function boxSolid(): Shape {
  return must(box({ size: SIZE }));
}

// A cylinder of height larger than the box so its wall pierces the top and bottom.
function cylSolid(): Shape {
  return must(cylinder({ radius: R, height: CYL_HEIGHT }));
}

function volumeOf(shape: Shape, angle = Math.PI / 64): number {
  const t = tessellate(shape, { angle });
  if (!t.ok) throw new Error('tessellate failed');
  const m = t.value;
  let vol = 0;
  for (const f of m.faces()) {
    const vs = m.faceVertices(f).map((v) => m.position(v));
    for (let i = 1; i + 1 < vs.length; i++) {
      const a = vs[0] as [number, number, number];
      const b = vs[i] as [number, number, number];
      const c = vs[i + 1] as [number, number, number];
      vol +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
  }
  return Math.abs(vol);
}

function nonManifoldEdges(shape: Shape): number {
  const t = tessellate(shape, { angle: Math.PI / 32 });
  if (!t.ok) throw new Error('tessellate failed');
  const m = t.value;
  const uses = new Map<string, number>();
  for (const f of m.faces()) {
    const vs = m.faceVertices(f);
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i] as number;
      const b = vs[(i + 1) % vs.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((n) => n !== 2).length;
}

describe('E1c slice 2: boolean of two input solids', () => {
  it('difference (box minus cylinder) matches the boxWithThroughHole oracle', () => {
    const r = booleanSolids(boxSolid(), cylSolid(), 'difference');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shape = r.value;
    expect(validate(shape).ok).toBe(true);
    expect(nonManifoldEdges(shape)).toBe(0);
    expect(Math.abs(volumeOf(shape) - DIFFERENCE_VOLUME)).toBeLessThan(TOL);

    const oracle = must(boxWithThroughHole({ size: SIZE, radius: R }));
    expect(shape.faces).toHaveLength(oracle.faces.length);
    expect(Math.abs(volumeOf(shape) - volumeOf(oracle))).toBeLessThan(TOL);
  });

  it('union (box plus cylinder boss) has the closed-form volume and is valid', () => {
    const r = booleanSolids(boxSolid(), cylSolid(), 'union');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validate(r.value).ok).toBe(true);
    expect(nonManifoldEdges(r.value)).toBe(0);
    expect(Math.abs(volumeOf(r.value) - UNION_VOLUME)).toBeLessThan(TOL);
  });

  it('intersect (box and cylinder) keeps only the cylinder inside the box', () => {
    const r = booleanSolids(boxSolid(), cylSolid(), 'intersect');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validate(r.value).ok).toBe(true);
    expect(nonManifoldEdges(r.value)).toBe(0);
    expect(Math.abs(volumeOf(r.value) - INTERSECT_VOLUME)).toBeLessThan(TOL);
  });

  it('a tangent cylinder returns model-partial rather than a shape', () => {
    const tangent = must(cylinder({ radius: 0.5, height: 3 }));
    const r = booleanSolids(boxSolid(), tangent, 'difference');
    expect(r.ok).toBe(false);
  });
});
