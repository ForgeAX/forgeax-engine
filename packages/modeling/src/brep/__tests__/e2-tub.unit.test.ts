import { describe, expect, it } from 'vitest';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { tub } from '../tub';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

// Outer box X x Y x H minus the cavity (X - wl - wr) x (Y - wb - wt) x (H - f) from the floor up.
// Surface: outer bottom and four sides, cavity floor and four cavity walls, and the top rim
// annulus XY - cx*cy. The open top adds no outer face.
function closedForm(
  X: number,
  Y: number,
  H: number,
  walls: readonly [number, number, number, number],
  f: number,
) {
  const [wl, wb, wr, wt] = walls;
  const cx = X - wl - wr;
  const cy = Y - wb - wt;
  const ch = H - f;
  const outerArea = X * Y + 2 * (X + Y) * H;
  const cavityArea = cx * cy + 2 * (cx + cy) * ch;
  const rimArea = X * Y - cx * cy;
  return {
    volume: X * Y * H - cx * cy * ch,
    area: outerArea + cavityArea + rimArea,
  };
}

describe('tub: closed-form volume and area', () => {
  const cases = [
    { outer: [0, 0, 4, 3], H: 2.5, f: 0.4, walls: [0.5, 0.3, 0.5, 0.3] },
    { outer: [0, 0, 5, 2], H: 3, f: 0.5, walls: [0.2, 0.6, 0.4, 0.3] },
  ] as const;
  for (const { outer, H, f, walls } of cases) {
    const [x0, y0, x1, y1] = outer;
    it(`outer ${x1 - x0}x${y1 - y0}x${H} walls ${walls.join(',')} floor ${f}`, () => {
      const X = x1 - x0;
      const Y = y1 - y0;
      const shape = must(tub({ outer: [x0, y0, x1, y1], height: H, walls, floor: f }));
      const m = must(measure(shape));
      const want = closedForm(X, Y, H, walls, f);
      expect(Math.abs(m.volume - want.volume)).toBeLessThan(1e-9);
      expect(Math.abs(m.area - want.area)).toBeLessThan(1e-9);
    });
  }
});

describe('tub: watertight', () => {
  it('tessellates with no boundary edges', () => {
    const shape = must(
      tub({ outer: [0, 0, 4, 3], height: 2.5, walls: [0.5, 0.3, 0.5, 0.3], floor: 0.4 }),
    );
    expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
  });
});

describe('tub: rejections', () => {
  it('rejects walls that leave no cavity', () => {
    const r = tub({ outer: [0, 0, 1, 1], height: 2, walls: [0.6, 0.1, 0.6, 0.1], floor: 0.2 });
    expect(r.ok).toBe(false);
  });

  it('rejects a floor at or above the height', () => {
    const r = tub({ outer: [0, 0, 4, 3], height: 2, walls: [0.5, 0.5, 0.5, 0.5], floor: 2 });
    expect(r.ok).toBe(false);
  });
});
