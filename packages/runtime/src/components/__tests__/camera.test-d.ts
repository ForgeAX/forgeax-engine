// M2 / w11: Camera factory type-level tests
// (feat-20260525-boilerplate-reduction-pod-defaults-factories)
//
// Covers AC-05 type-level requirements: perspective() fov/aspect
// required, type-only checks. Plan-strategy section 5.2 type-test requirement.
//
// Charter P3: required-field omission must produce compile-time error,
// not runtime silent fallback.

import { describe, expectTypeOf, it } from 'vitest';
import { orthographic, perspective } from '../../../../render/src/components/camera';

describe('perspective factory type-level', () => {
  it('perspective({ fov: 60, aspect: 4/3 }) type-checks OK', () => {
    // Positive: fov + aspect present => compile OK.
    const pod = perspective({ fov: 60, aspect: 4 / 3 });
    expectTypeOf(pod.fov).toBeNumber();
  });

  it('perspective({ fov: 60 }) should be a TS error (aspect required)', () => {
    // @ts-expect-error aspect is required
    const _pod = perspective({ fov: 60 });
    // If this line is reached without TS error, the assertion fails.
    expectTypeOf(_pod).toBeObject();
  });

  it('perspective({}) should be a TS error (fov + aspect required)', () => {
    // @ts-expect-error fov + aspect required
    const _pod = perspective({});
    expectTypeOf(_pod).toBeObject();
  });

  it('perspective return value is assignable to world.spawn data slot', () => {
    // The factory returns a plain object matching Camera column shape.
    const pod = perspective({ fov: 60, aspect: 4 / 3 });
    // All 12 Camera fields present with correct types.
    expectTypeOf(pod.fov).toBeNumber();
    expectTypeOf(pod.aspect).toBeNumber();
    expectTypeOf(pod.near).toBeNumber();
    expectTypeOf(pod.far).toBeNumber();
    expectTypeOf(pod.projection).toBeNumber();
    expectTypeOf(pod.left).toBeNumber();
    expectTypeOf(pod.right).toBeNumber();
    expectTypeOf(pod.bottom).toBeNumber();
    expectTypeOf(pod.top).toBeNumber();
    expectTypeOf(pod.tonemap).toBeNumber();
    expectTypeOf(pod.exposure).toBeNumber();
    expectTypeOf(pod.whitePoint).toBeNumber();
  });
});

describe('orthographic factory type-level', () => {
  it('orthographic({ left: -1, right: 1, bottom: -1, top: 1 }) type-checks OK', () => {
    const pod = orthographic({ left: -1, right: 1, bottom: -1, top: 1 });
    expectTypeOf(pod.projection).toBeNumber();
  });
});
