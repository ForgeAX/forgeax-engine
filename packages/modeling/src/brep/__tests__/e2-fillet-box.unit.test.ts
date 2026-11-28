import { describe, expect, it } from 'vitest';
import { filletBox } from '../fillet-box';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const PI = Math.PI;

function steiner(size: [number, number, number], r: number) {
  const [a, b, c] = size.map((s) => s - 2 * r) as [number, number, number];
  const volume =
    a * b * c +
    2 * r * (a * b + b * c + a * c) +
    PI * r * r * (a + b + c) +
    (4 / 3) * PI * r * r * r;
  const area = 2 * (a * b + b * c + a * c) + 2 * PI * r * (a + b + c) + 4 * PI * r * r;
  return { volume, area };
}

describe('filletBox: all twelve edges', () => {
  for (const [size, r] of [
    [[2, 3, 4], 0.25],
    [[1, 1, 1], 0.4],
  ] as const) {
    it(`size ${size.join('x')} r=${r}: volume and area match the Steiner closed form`, () => {
      const shape = must(filletBox({ size: [...size], radius: r }));
      const m = must(measure(shape));
      const want = steiner([...size], r);
      expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
      expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
    });

    it(`size ${size.join('x')} r=${r}: tessellates watertight`, () => {
      const shape = must(filletBox({ size: [...size], radius: r }));
      expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
    });
  }

  it('rejects a radius that reaches the box centre', () => {
    expect(filletBox({ size: [2, 2, 2], radius: 1 }).ok).toBe(false);
  });
});
