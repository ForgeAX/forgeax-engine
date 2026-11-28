import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { tessellate } from '../tessellate';
import { IDENTITY_PLACEMENT, transformShape } from '../transform';
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

const SIZE: [number, number, number] = [2.6, 1, 1];
const R1 = 0.3;
const R2 = 0.2;
const H = 3;
const TOL = 1e-3;
const PI = Math.PI;

describe('chained booleans: a second operand against an already-trimmed face', () => {
  const body = () => must(box({ size: SIZE, label: 'box' }));
  const bore1 = () => must(cylinder({ radius: R1, height: H, label: 'bore1' }));
  const bore2At = (x: number) =>
    must(
      transformShape(must(cylinder({ radius: R2, height: H, label: 'bore2' })), {
        ...IDENTITY_PLACEMENT,
        t: [x, 0, 0],
      }),
    );

  it('union then a second through-hole: valid, and volume equals union minus the in-box part', () => {
    const united = must(booleanSolids(body(), bore1(), 'union'));
    const chained = must(booleanSolids(united, bore2At(0.8), 'difference'));
    expect(validate(chained).ok).toBe(true);
    // union = box + cylinder - (cylinder inside box); the second bore removes only its in-box part.
    const union = 2.6 + PI * R1 * R1 * H - PI * R1 * R1 * 1;
    const expected = union - PI * R2 * R2 * 1;
    expect(Math.abs(volumeOf(chained) - expected)).toBeLessThan(TOL);
  });

  it('a second bore that crosses the first bore is reported as model-partial, not a shape', () => {
    const united = must(booleanSolids(body(), bore1(), 'union'));
    const crossing = booleanSolids(united, bore2At(0.4), 'difference');
    expect(crossing.ok).toBe(false);
    if (!crossing.ok) expect(crossing.error.code).toBe('model-partial');
  });
});
