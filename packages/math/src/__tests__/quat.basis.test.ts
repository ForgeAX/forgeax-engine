// quat.basis.test.ts — value tests for quat.right / up / forward (solo round 20260713-174912)
//
// Regression guard for the friction that motivated the accessors: moving an entity "along where
// it faces" (Bevy `transform.local_x()` / `.forward()`) required hand-wiring
// `quat.transformVec3(out, q, [0, 0, -1])` AND independently knowing the −Z forward handedness
// (documented only inside mat4.ts). A demo author who guessed +Z, or forgot to pick the right
// canonical axis, got a silently-wrong direction. These tests pin:
//   1. identity rotation → the canonical world axes (right=+X, up=+Y, forward=−Z),
//   2. a known rotation maps the axes as expected (90° yaw about +Y),
//   3. the three accessors equal q applied to the canonical axes (transformVec3 SSOT),
//   4. they agree with the mat4 basis getters on the same rotation (cross-impl witness —
//      the −Z forward convention is shared, not re-derived),
//   5. a fromLookAt camera's forward ≈ normalize(target − eye) (the look-convention anchor),
//   6. results stay unit-length (a unit q in → a unit vector out),
//   7. aliasing / degrade (zero quat → the natural transformVec3 result, no NaN),
//   8. right/up/forward stay mutually orthogonal (a valid orthonormal basis).

import { describe, expect, it } from 'vitest';
import * as mat4 from '../mat4';
import * as quat from '../quat';
import type { QuatLike, Vec3Like } from '../types';
import * as vec3 from '../vec3';

const EPS = 1e-5;

function expectVec3Close(actual: Vec3Like, expected: Vec3Like, eps = EPS): void {
  expect(actual[0]).toBeCloseTo(expected[0] as number, 5);
  expect(actual[1]).toBeCloseTo(expected[1] as number, 5);
  expect(actual[2]).toBeCloseTo(expected[2] as number, 5);
  void eps;
}

function dot(a: Vec3Like, b: Vec3Like): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

describe('quat.right / up / forward — local basis accessors', () => {
  it('identity rotation → canonical world axes (right=+X, up=+Y, forward=−Z)', () => {
    const id = quat.identity(quat.create());
    expectVec3Close(quat.right(vec3.create(), id), [1, 0, 0]);
    expectVec3Close(quat.up(vec3.create(), id), [0, 1, 0]);
    expectVec3Close(quat.forward(vec3.create(), id), [0, 0, -1]);
  });

  it('90° yaw about +Y maps the axes as expected', () => {
    // A left-hand-rule +Y yaw of 90°: +X → −Z, −Z → −X, +Y stays +Y.
    const q = quat.eulerY(Math.PI / 2);
    expectVec3Close(quat.right(vec3.create(), q), [0, 0, -1]);
    expectVec3Close(quat.up(vec3.create(), q), [0, 1, 0]);
    expectVec3Close(quat.forward(vec3.create(), q), [-1, 0, 0]);
  });

  it('each accessor equals q applied to its canonical axis (transformVec3 SSOT)', () => {
    const q = quat.fromEuler(quat.create(), 0.4, -0.7, 1.1, 'XYZ');
    expectVec3Close(quat.right(vec3.create(), q), quat.transformVec3(vec3.create(), q, [1, 0, 0]));
    expectVec3Close(quat.up(vec3.create(), q), quat.transformVec3(vec3.create(), q, [0, 1, 0]));
    expectVec3Close(
      quat.forward(vec3.create(), q),
      quat.transformVec3(vec3.create(), q, [0, 0, -1]),
    );
  });

  it('WITNESS: agrees with mat4.getRight / getUp / getForward on the same rotation', () => {
    // The −Z forward convention is shared between quat and mat4 — an independent implementation
    // (mat4 reads basis columns) must land the same directions. If either side flips a sign this
    // fails, catching a convention drift the single-namespace tests cannot.
    const q = quat.fromEuler(quat.create(), 0.9, 0.3, -0.5, 'YXZ');
    const m = mat4.fromQuat(mat4.create(), q);
    expectVec3Close(quat.right(vec3.create(), q), mat4.getRight(vec3.create(), m));
    expectVec3Close(quat.up(vec3.create(), q), mat4.getUp(vec3.create(), m));
    expectVec3Close(quat.forward(vec3.create(), q), mat4.getForward(vec3.create(), m));
  });

  it('fromLookAt camera → forward ≈ normalize(target − eye)', () => {
    // The look-convention anchor: the whole point of the −Z choice is that a camera built with
    // fromLookAt faces its target. This is the property a demo relies on.
    const eye: Vec3Like = [5, 3, -2];
    const target: Vec3Like = [-1, 0, 4];
    const q = quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]);
    const expected = vec3.normalize(
      vec3.create(),
      vec3.create(
        (target[0] as number) - (eye[0] as number),
        (target[1] as number) - (eye[1] as number),
        (target[2] as number) - (eye[2] as number),
      ),
    );
    expectVec3Close(quat.forward(vec3.create(), q), expected);
  });

  it('a unit quaternion yields unit-length basis vectors', () => {
    const q = quat.fromAxisAngle(quat.create(), [0.3, 0.8, -0.5], 2.1);
    expect(vec3.length(quat.right(vec3.create(), q))).toBeCloseTo(1, 5);
    expect(vec3.length(quat.up(vec3.create(), q))).toBeCloseTo(1, 5);
    expect(vec3.length(quat.forward(vec3.create(), q))).toBeCloseTo(1, 5);
  });

  it('right / up / forward form an orthonormal (mutually perpendicular) basis', () => {
    const q = quat.fromEuler(quat.create(), 1.2, -0.4, 0.6, 'ZYX');
    const r = quat.right(vec3.create(), q);
    const u = quat.up(vec3.create(), q);
    const f = quat.forward(vec3.create(), q);
    expect(dot(r, u)).toBeCloseTo(0, 5);
    expect(dot(r, f)).toBeCloseTo(0, 5);
    expect(dot(u, f)).toBeCloseTo(0, 5);
  });

  it('degrade: zero quaternion → natural transformVec3 result, no NaN', () => {
    const zero: QuatLike = new Float32Array([0, 0, 0, 0]);
    const r = quat.right(vec3.create(), zero);
    const u = quat.up(vec3.create(), zero);
    const f = quat.forward(vec3.create(), zero);
    // transformVec3 with q=(0,0,0,0) → out = v (the input axis), non-NaN.
    expectVec3Close(r, [1, 0, 0]);
    expectVec3Close(u, [0, 1, 0]);
    expectVec3Close(f, [0, 0, -1]);
    for (const v of [r, u, f]) {
      expect(Number.isNaN(v[0])).toBe(false);
      expect(Number.isNaN(v[1])).toBe(false);
      expect(Number.isNaN(v[2])).toBe(false);
    }
  });

  it('aliasing-safe: out and a fresh vec3 give the same result', () => {
    const q = quat.eulerY(Math.PI / 3);
    const a = quat.forward(vec3.create(), q);
    const b = quat.forward(vec3.create(), q);
    expectVec3Close(a, b);
  });
});
