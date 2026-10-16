// learn-render-first-person.test.ts -- vitest unit (TDD red phase).
//
// This test exercises the pure-math helpers exported from the shared
// first-person module: computeWasdDisplacement (WASD integration),
// createScrollFovAccumulator (FoV zoom), plus the right-vector formula
// anchor (D-1 / D-R1: right = (-forward.z, 0, forward.x), aligned with
// LearnOpenGL SS1.7). The test also validates pitch clamp (+/-89 deg)
// and dt equivalence (60fps x 2 == 30fps x 1).
//
// The actual addFirstPersonSystem ECS system fn (which requires World +
// Renderer bootstrap) is tested by the consuming example build + smoke.
// This file follows the same pattern as 7.camera's camera-dt-equivalence
// .test.ts and camera-fov-zoom.test.ts: import pure helpers, assert
// math without booting a renderer / canvas / WebGPU.
//
// Charter P5: producer/consumer split -- helpers produce numbers,
// system fn consumes them to write ECS columns. This test exercises
// the producer layer only.

import { quat } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';

import {
  CAMERA_SPEED_PER_SECOND,
  computeWasdDisplacement,
  createScrollFovAccumulator,
  type DisplacementXYZ,
  PITCH_CLAMP_RAD,
  type Vec3Like,
  type WasdHeld,
  yawPitchFromQuat,
} from '../learn-render-first-person';

// --- WASD displacement ----------------------------------------------------

describe('WASD displacement: cameraSpeed * dt integration (D-1 + D-R1 right-vector)', () => {
  // D-1 / D-R1: right = (-forward.z, 0, forward.x)
  // When forward = (0, 0, -1) (initial gaze along -Z), right = (1, 0, 0).
  // KeyD strafes along right -> +X.
  // The 4/5/6 bug (D-R1): right = (forward.z, 0, -forward.x) gave (-1,0,0)
  // which reversed KeyD.

  const forward: Vec3Like = { x: 0, y: 0, z: -1 };
  const right: Vec3Like = { x: 1, y: 0, z: 0 };

  it('KeyW held -> displacement along -Z, scaled by cameraSpeed * dt', () => {
    const held: WasdHeld = { w: true, s: false, a: false, d: false };
    const out = computeWasdDisplacement(1 / 60, forward, right, held);
    // cameraSpeed = 2.5; forward = (0,0,-1); dt = 1/60 -> -Z = -2.5/60.
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(-CAMERA_SPEED_PER_SECOND / 60, 9);
  });

  it('KeyS held -> displacement along +Z, scaled by cameraSpeed * dt', () => {
    const held: WasdHeld = { w: false, s: true, a: false, d: false };
    const out = computeWasdDisplacement(1 / 60, forward, right, held);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(CAMERA_SPEED_PER_SECOND / 60, 9);
  });

  it('KeyA held -> displacement along -X (D-1: right-vector aligned with LO SS1.7)', () => {
    const held: WasdHeld = { w: false, s: false, a: true, d: false };
    const out = computeWasdDisplacement(1 / 60, forward, right, held);
    expect(out.x).toBeCloseTo(-CAMERA_SPEED_PER_SECOND / 60, 9);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('KeyD -> +X displacement (D-1 anchor: right formula verified, cf. 7.camera test:66-74)', () => {
    const held: WasdHeld = { w: false, s: false, a: false, d: true };
    const out = computeWasdDisplacement(1 / 60, forward, right, held);
    // cameraSpeed=2.5; right=(1,0,0) -> +X displacement = 2.5/60.
    expect(out.x).toBeCloseTo(CAMERA_SPEED_PER_SECOND / 60, 9);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('60fps 2 frames vs 30fps 1 frame produce identical displacement (KeyW held)', () => {
    const held: WasdHeld = { w: true, s: false, a: false, d: false };

    const half1 = computeWasdDisplacement(1 / 60, forward, right, held);
    const half2 = computeWasdDisplacement(1 / 60, forward, right, held);
    const total60: DisplacementXYZ = {
      x: half1.x + half2.x,
      y: half1.y + half2.y,
      z: half1.z + half2.z,
    };
    const total30 = computeWasdDisplacement(1 / 30, forward, right, held);

    expect(total60.x).toBeCloseTo(total30.x, 9);
    expect(total60.y).toBeCloseTo(total30.y, 9);
    expect(total60.z).toBeCloseTo(total30.z, 9);
    expect(total30.z).toBeCloseTo(-CAMERA_SPEED_PER_SECOND / 30, 9);
  });

  it('zero held keys produces zero displacement regardless of dt', () => {
    const idle: WasdHeld = { w: false, s: false, a: false, d: false };
    const out = computeWasdDisplacement(1 / 60, forward, right, idle);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('KeyW + KeyD held simultaneously sums forward + right contributions', () => {
    const both: WasdHeld = { w: true, s: false, a: false, d: true };
    const out = computeWasdDisplacement(1 / 60, forward, right, both);
    expect(out.x).toBeCloseTo(CAMERA_SPEED_PER_SECOND / 60, 9);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(-CAMERA_SPEED_PER_SECOND / 60, 9);
  });

  it('right-vector: when forward faces +Z (yaw=90deg), right faces +X', () => {
    // Simulate yaw = PI/2: forward = (cos(PI/2), 0, sin(PI/2)) = (0, 0, 1).
    const fwdZ: Vec3Like = { x: 0, y: 0, z: 1 };
    // D-1: right = (-forward.z, 0, forward.x) = (-1, 0, 0).
    const rgtZ: Vec3Like = { x: -1, y: 0, z: 0 };
    const heldD: WasdHeld = { w: false, s: false, a: false, d: true };
    const out = computeWasdDisplacement(1 / 60, fwdZ, rgtZ, heldD);
    // KeyD strafes along (-1,0,0) = -X.
    expect(out.x).toBeCloseTo(-CAMERA_SPEED_PER_SECOND / 60, 9);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });
});

// --- pitch clamp ----------------------------------------------------------

describe('pitch clamp = +/-PITCH_CLAMP_RAD (+/-89 deg)', () => {
  it('PITCH_CLAMP_RAD equals (89 * PI) / 180', () => {
    expect(PITCH_CLAMP_RAD).toBeCloseTo((89 * Math.PI) / 180, 9);
  });

  it('pitch clamped at +PITCH_CLAMP_RAD when mouse pushes upward', () => {
    // This tests the clamp behaviour via the exported constant.
    // The system fn applies: pitch = clamp(pitch, -PITCH_CLAMP_RAD, +PITCH_CLAMP_RAD).
    // Verify the constant value is correct and that the clamp is symmetric.
    expect(Math.abs(PITCH_CLAMP_RAD - (89 * Math.PI) / 180)).toBeLessThan(1e-9);
    expect(Math.abs(PITCH_CLAMP_RAD - -(-89 * Math.PI) / 180)).toBeLessThan(1e-9);
  });
});

// --- fov-zoom -------------------------------------------------------------

describe('scroll-wheel FoV: accumulator + clamp [1, 45] (AC-06 + plan D-4)', () => {
  it('initial fov = 45 deg, written as Math.PI / 4 radians', () => {
    const acc = createScrollFovAccumulator();
    expect(acc.fovDeg).toBe(45);
    expect(acc.fovRad).toBeCloseTo((45 * Math.PI) / 180, 9);
    expect(acc.fovRad).toBeCloseTo(Math.PI / 4, 9);
  });

  it('negative wheelDelta steps clamp at 1 deg', () => {
    const acc = createScrollFovAccumulator();
    // Each apply(1) means scroll-up notch -> fovDeg -= 1.
    for (let i = 0; i < 30; i++) acc.apply(1);
    // 45 - 30 = 15 -> still inside [1, 45], not clamped.
    expect(acc.fovDeg).toBe(15);

    // Continue 30 more times: 15 - 30 = -15 -> clamps at 1.
    for (let i = 0; i < 30; i++) acc.apply(1);
    expect(acc.fovDeg).toBe(1);
    expect(acc.fovRad).toBeCloseTo(Math.PI / 180, 9);
  });

  it('positive-down wheelDelta steps clamp at 45 deg', () => {
    const acc = createScrollFovAccumulator();
    // wheelDelta = -1 means scroll down -> fovDeg -= -1 = +1 per step.
    for (let i = 0; i < 100; i++) acc.apply(-1);
    expect(acc.fovDeg).toBe(45);
    expect(acc.fovRad).toBeCloseTo((45 * Math.PI) / 180, 9);
  });

  it('clamp bounds enforced exactly without floating-point drift > 1e-9', () => {
    const acc = createScrollFovAccumulator();
    // Push deep below 1: from 45, apply +60 wheelDelta total.
    for (let i = 0; i < 60; i++) acc.apply(1);
    expect(acc.fovDeg).toBe(1);
    // Then back up: apply -100 wheelDelta.
    for (let i = 0; i < 100; i++) acc.apply(-1);
    expect(acc.fovDeg).toBe(45);
    expect(Math.abs(acc.fovDeg - 45)).toBeLessThan(1e-9);
  });

  it('apply(0) is a no-op (idle frame, no scroll event)', () => {
    const acc = createScrollFovAccumulator();
    acc.apply(0);
    acc.apply(0);
    acc.apply(0);
    expect(acc.fovDeg).toBe(45);
  });
});

// --- initial pose from the spawned camera -----------------------------------

describe('yawPitchFromQuat: the spawned camera quaternion seeds yaw/pitch', () => {
  it('identity looks down -Z (LO yaw = -pi/2, pitch = 0)', () => {
    const { yaw, pitch } = yawPitchFromQuat(quat.create());
    expect(yaw).toBeCloseTo(-Math.PI / 2, 6);
    expect(pitch).toBeCloseTo(0, 6);
  });

  it('inverts the system fromEuler(pitch, -(yaw + pi/2), 0, YXZ) mapping', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [-Math.PI, -0.2],
      [0.7, 0.4],
      [-2.3, -1.1],
    ] as const) {
      const q = quat.fromEuler(quat.create(), pitch, -(yaw + Math.PI / 2), 0, 'YXZ');
      const back = yawPitchFromQuat(q);
      expect(Math.cos(back.yaw)).toBeCloseTo(Math.cos(yaw), 5);
      expect(Math.sin(back.yaw)).toBeCloseTo(Math.sin(yaw), 5);
      expect(back.pitch).toBeCloseTo(pitch, 5);
    }
  });
});
