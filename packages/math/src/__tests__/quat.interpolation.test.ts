import { describe, expect, it } from 'vitest';
import { quat } from '../index';

function expectQuatClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  for (let i = 0; i < 4; i++) {
    expect(actual[i]).toBeCloseTo(expected[i] as number, 6);
  }
}

describe('quat.slerp endpoint fallback', () => {
  it('matches nlerp for coincident and anti-parallel inputs', () => {
    const a = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.3);
    const near = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.3000001);
    const opposite = new Float32Array([
      -(a[0] as number),
      -(a[1] as number),
      -(a[2] as number),
      -(a[3] as number),
    ]);
    const slerpNear = quat.slerp(quat.create(), a, near, 0.25);
    const nlerpNear = quat.nlerp(quat.create(), a, near, 0.25);
    const slerpOpposite = quat.slerp(quat.create(), a, opposite, 0.25);
    const nlerpOpposite = quat.nlerp(quat.create(), a, opposite, 0.25);

    expectQuatClose(slerpNear, nlerpNear);
    expectQuatClose(slerpOpposite, nlerpOpposite);
  });

  it('preserves aliasing-safe endpoint behavior', () => {
    const a = quat.fromAxisAngle(quat.create(), [1, 0, 0], 0.4);
    const b = quat.fromAxisAngle(quat.create(), [1, 0, 0], 0.4000001);
    const expected = quat.slerp(quat.create(), a, b, 0.5);
    const inPlace = quat.clone(a);

    expect(quat.slerp(inPlace, inPlace, b, 0.5)).toBe(inPlace);
    expectQuatClose(inPlace, expected);
  });

  it('keeps the zero-result fallback owned by nlerp', () => {
    const b = Float32Array.of(1.000001, 0, 0, 0);
    const result = quat.slerp(quat.create(), [1, 0, 0, 0], b, -1_048_576);

    expect(result).toEqual(quat.identity(quat.create()));
  });
});
