// quat.lookat.test.ts — value tests for quat.fromLookAt (solo round 20260713-141636)
//
// Regression guard for the friction that motivated the helper: aiming a camera required
// hand-wiring `mat4.lookAt → invert → mat3.fromMat4 → quat.fromRotationMatrix`, and because
// `Mat4Like` ≡ `Mat3Like` ≡ ArrayLike<number>, feeding the mat4 straight into fromRotationMatrix
// typechecks but reads garbage columns → NaN → nothing renders. These tests pin:
//   1. fromLookAt matches the correct hand-wired chain,
//   2. the resulting rotation actually points local -z at the target,
//   3. the buggy mat4-into-fromRotationMatrix path yields a DIFFERENT (wrong) quaternion,
//   4. the documented degrade cases (eye≈target, up‖forward).

import { describe, expect, it } from 'vitest';
import * as mat3 from '../mat3';
import * as mat4 from '../mat4';
import * as quat from '../quat';
import type { Vec3Like } from '../types';
import * as vec3 from '../vec3';

const EPS = 1e-5;

/** The correct hand-wired chain the helper replaces (round-3 apps/hello/3d-scene lookAtQuat). */
function handWired(eye: Vec3Like, target: Vec3Like, up: Vec3Like): Float32Array {
  const view = mat4.lookAt(mat4.create(), eye, target, up);
  const camWorld = mat4.invert(mat4.create(), view);
  const rot3 = mat3.fromMat4(mat3.create(), camWorld);
  return quat.normalize(quat.create(), quat.fromRotationMatrix(quat.create(), rot3));
}

/** quat double-cover: q and -q are the same rotation. Compare via |dot| ≈ 1. */
function sameRotation(a: Float32Array, b: Float32Array): boolean {
  const d =
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number) +
    (a[3] as number) * (b[3] as number);
  return Math.abs(Math.abs(d) - 1) < EPS;
}

describe('quat.fromLookAt', () => {
  const cases: Array<{ name: string; eye: Vec3Like; target: Vec3Like; up: Vec3Like }> = [
    { name: '3d_scene camera', eye: [-2.5, 4.5, 9], target: [0, 0, 0], up: [0, 1, 0] },
    { name: 'axis-aligned +x view', eye: [5, 0, 0], target: [0, 0, 0], up: [0, 1, 0] },
    { name: 'above looking down', eye: [0, 10, 0.001], target: [0, 0, 0], up: [0, 1, 0] },
    { name: 'off-axis', eye: [3, 2, -4], target: [1, 0, 1], up: [0, 1, 0] },
  ];

  for (const c of cases) {
    it(`matches the hand-wired lookAt→invert→mat3→fromRotationMatrix chain (${c.name})`, () => {
      const helper = quat.fromLookAt(quat.create(), c.eye, c.target, c.up);
      const chain = handWired(c.eye, c.target, c.up);
      expect(sameRotation(helper, chain)).toBe(true);
    });

    it(`rotates local -z to point from eye toward target (${c.name})`, () => {
      const q = quat.fromLookAt(quat.create(), c.eye, c.target, c.up);
      // world direction the camera faces = rotation applied to local forward (-z)
      const facing = quat.transformVec3(vec3.create(), q, [0, 0, -1]);
      const want = vec3.normalize(
        vec3.create(),
        vec3.sub(
          vec3.create(),
          vec3.create(c.target[0] as number, c.target[1] as number, c.target[2] as number),
          vec3.create(c.eye[0] as number, c.eye[1] as number, c.eye[2] as number),
        ),
      );
      expect(facing[0]).toBeCloseTo(want[0] as number, 4);
      expect(facing[1]).toBeCloseTo(want[1] as number, 4);
      expect(facing[2]).toBeCloseTo(want[2] as number, 4);
    });
  }

  it('produces no NaN components (the friction was NaN→black)', () => {
    const q = quat.fromLookAt(quat.create(), [-2.5, 4.5, 9], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 4; i++) expect(Number.isNaN(q[i] as number)).toBe(false);
  });

  it('WITNESS: feeding a mat4 to fromRotationMatrix (the trap) gives a DIFFERENT, wrong result', () => {
    // This is the exact footgun fromLookAt exists to remove. Mat4Like≡Mat3Like≡ArrayLike<number>,
    // so this typechecks; it reads mat4 elements 0..8 (garbage columns) instead of a real mat3.
    const eye: Vec3Like = [-2.5, 4.5, 9];
    const target: Vec3Like = [0, 0, 0];
    const up: Vec3Like = [0, 1, 0];
    const view = mat4.lookAt(mat4.create(), eye, target, up);
    const camWorld = mat4.invert(mat4.create(), view);
    // BUG path: pass the 16-element mat4 where a 9-element mat3 is expected.
    const trap = quat.normalize(quat.create(), quat.fromRotationMatrix(quat.create(), camWorld));
    const correct = quat.fromLookAt(quat.create(), eye, target, up);
    expect(sameRotation(trap, correct)).toBe(false);
  });

  it('degrade: eye ≈ target → identity (no throw)', () => {
    const q = quat.fromLookAt(quat.create(), [1, 1, 1], [1, 1, 1], [0, 1, 0]);
    expect(sameRotation(q, quat.identity(quat.create()))).toBe(true);
  });

  it('degrade: up collinear with forward → still a valid (non-NaN) unit quaternion', () => {
    // looking straight down with up=(0,1,0): up ‖ forward, alternative-up path engages.
    const q = quat.fromLookAt(quat.create(), [0, 5, 0], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 4; i++) expect(Number.isNaN(q[i] as number)).toBe(false);
    const len = Math.hypot(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
    expect(len).toBeCloseTo(1, 4);
  });
});
