import { describe, expect, it } from 'vitest';
import { mat4, quat, vec3 } from '../index';

/** Test-only T * R * H * S: decomposeAffine reports shear, compose no longer authors it. */
function composeSheared(
  t: ArrayLike<number>,
  r: ArrayLike<number>,
  s: ArrayLike<number>,
  h: ArrayLike<number>,
): Float32Array {
  const rot = mat4.compose(mat4.create(), [0, 0, 0], r as never, [1, 1, 1]);
  const out = mat4.create();
  for (let row = 0; row < 3; row++) {
    out[row] = (rot[row] ?? 0) * (s[0] ?? 1);
    out[4 + row] = ((rot[4 + row] ?? 0) + (h[0] ?? 0) * (rot[row] ?? 0)) * (s[1] ?? 1);
    out[8 + row] =
      ((rot[8 + row] ?? 0) + (h[1] ?? 0) * (rot[row] ?? 0) + (h[2] ?? 0) * (rot[4 + row] ?? 0)) *
      (s[2] ?? 1);
  }
  out[12] = t[0] ?? 0;
  out[13] = t[1] ?? 0;
  out[14] = t[2] ?? 0;
  out[15] = 1;
  return out;
}

describe('affine transform composition', () => {
  it('round-trips shear, reflection and rotation without discarding the shear terms', () => {
    const rotation = quat.create();
    quat.fromEuler(rotation, 0.3, -0.7, 0.2, 'XYZ');
    for (const z of [0.25, -3]) {
      const source = composeSheared([3, -2, 1], rotation, [2, 4, z], [0.8, -0.4, 0.3]);
      const t = vec3.create(),
        r = quat.create(),
        s = vec3.create(),
        h = vec3.create();
      expect(mat4.decomposeAffine(t, r, s, h, source)).toBe(true);
      const result = composeSheared(t, r, s, h);
      source.forEach((value, index) => {
        expect(result[index]).toBeCloseTo(value, 5);
      });
      expect(Math.sign(s[2] ?? 0)).toBe(Math.sign(z));
    }
  });

  it('reconstructs an independently authored affine basis', () => {
    const source = new Float32Array([2, 1, 0, 0, -1, 3, 2, 0, 4, -2, 1, 0, 7, 8, 9, 1]);
    const t = vec3.create(),
      r = quat.create(),
      s = vec3.create(),
      h = vec3.create();
    expect(mat4.decomposeAffine(t, r, s, h, source)).toBe(true);
    const result = composeSheared(t, r, s, h);
    source.forEach((value, index) => {
      expect(result[index]).toBeCloseTo(value, 5);
    });
  });

  it('leaves output untouched when an affine decomposition is unavailable', () => {
    const t = vec3.create(7, 8, 9),
      r = quat.create(),
      s = vec3.create(1, 2, 3),
      h = vec3.create(4, 5, 6);
    const before = [...t, ...r, ...s, ...h];
    for (const source of [
      mat4.create(),
      mat4.perspectiveReverseZ(mat4.create(), 1, 1, 0.1, 10),
      mat4.fromScaling(mat4.create(), [1, 0, 1]),
    ]) {
      expect(mat4.decomposeAffine(t, r, s, h, source)).toBe(false);
      expect([...t, ...r, ...s, ...h]).toEqual(before);
    }
  });

  it('accepts homogeneous inversion roundoff only within native Float32 precision', () => {
    const source = Array.from(mat4.identity(mat4.create()));
    const t = vec3.create(),
      r = quat.create(),
      s = vec3.create(),
      h = vec3.create();
    for (const w of [1 - Number.EPSILON, 1 + Number.EPSILON]) {
      source[15] = w;
      expect(mat4.decomposeAffine(t, r, s, h, source)).toBe(true);
      expect(Array.from(composeSheared(t, r, s, h))).toEqual(
        Array.from(mat4.identity(mat4.create())),
      );
    }
    const before = [...t, ...r, ...s, ...h];
    source[15] = 1 + 1e-6;
    expect(mat4.decomposeAffine(t, r, s, h, source)).toBe(false);
    expect([...t, ...r, ...s, ...h]).toEqual(before);
  });

  it('allows outputs to borrow the input without reading overwritten coefficients', () => {
    const source = new Float32Array([2, 1, 0, 0, -1, 3, 2, 0, 4, -2, 1, 0, 7, 8, 9, 1]);
    const expected = source.slice();
    const t = source.subarray(12, 15) as ReturnType<typeof vec3.create>;
    const r = source.subarray(0, 4) as ReturnType<typeof quat.create>;
    const s = source.subarray(4, 7) as ReturnType<typeof vec3.create>;
    const h = source.subarray(8, 11) as ReturnType<typeof vec3.create>;
    expect(mat4.decomposeAffine(t, r, s, h, source)).toBe(true);
    const result = composeSheared(t, r, s, h);
    expected.forEach((value, index) => {
      expect(result[index]).toBeCloseTo(value, 5);
    });
  });
});
