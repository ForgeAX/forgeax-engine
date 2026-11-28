import { describe, expect, it } from 'vitest';
import { boxWithThroughHole } from '../boolean-hole';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

const SIZE: [number, number, number] = [2.6, 1, 1];
const R = 0.3;
const CLOSED_VOLUME = SIZE[0] * SIZE[1] * SIZE[2] - Math.PI * R * R * SIZE[2];

function built(): Shape {
  const r = boxWithThroughHole({ size: SIZE, radius: R });
  if (!r.ok) throw new Error(`build failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('E1c slice 1: box minus cylinder through-hole', () => {
  it('builds a validated shape with 7 faces (box sides, top, bottom, bore)', () => {
    const shape = built();
    expect(shape.faces).toHaveLength(7);
    const v = validate(shape);
    expect(v.ok).toBe(true);
  });

  it('is a closed manifold: every mesh edge is shared by exactly two faces', () => {
    const t = tessellate(built(), { angle: Math.PI / 32 });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
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
    const bad = [...uses.values()].filter((n) => n !== 2).length;
    expect(bad).toBe(0);
  });

  it('tessellated volume matches the closed form within 1e-3 (interim gate until measure lands)', () => {
    const t = tessellate(built(), { angle: Math.PI / 64 });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
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
    expect(Math.abs(vol - CLOSED_VOLUME)).toBeLessThan(1e-3);
  });

  it('rejects a hole radius that does not fit the footprint', () => {
    const r = boxWithThroughHole({ size: [1, 1, 1], radius: 0.6 });
    expect(r.ok).toBe(false);
  });

  it('a bore tangent to a side face returns model-partial, not a shape', () => {
    const r = boxWithThroughHole({ size: [1, 1, 1], radius: 0.5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
  });
});
