// camera-dt-equivalence.test.ts -- vitest unit (T-M5-1 red phase).
//
// AC-05 (requirements §4): the LO §1.7 first-person camera consumes the
// engine-app `Time` resource `dt` and integrates `cameraPos += cameraSpeed
// * dt * forward` on each tick. The math contract is that 60fps for 2
// frames (dt=1/60 each) and 30fps for 1 frame (dt=1/30) accumulate
// identical world displacement; the test fails red if the demo still
// uses a frame-fixed `KEYBOARD_SPEED` constant or any non-dt formula.
//
// Plan-strategy D-1 + research finding g3.A: the LO source uses
// `cameraSpeed = 2.5f * deltaTime` verbatim (LearnOpenGL/src/1.getting_
// started/7.4.camera_class/camera_class.cpp ProcessKeyboard). forgeax
// reproduces the SAME numeric SSOT (cameraSpeed = 2.5) and consumes dt
// from `world.getResource(Time).delta` (ECS-owned Time
// resource is the dt SSOT, not an extra fn-callback parameter).
//
// Charter P5: this test does NOT bootstrap a renderer / canvas / WebGPU.
// It exercises the dt-driven WASD integration math in isolation. The
// SUT is the demo's `computeWasdDisplacement(dt, fwd, right, held)`
// pure helper (extracted in T-M5-3 alongside the createApp migration);
// the test imports the helper directly. AI users on AC-05 grep for the
// single literal `cameraSpeed * dt` to discover the integration site.

import { describe, expect, it } from 'vitest';

import { computeWasdDisplacement } from '../first-person-controls';

describe("7.camera dt equivalence: cameraSpeed * dt 60fps vs 30fps (AC-05 + plan D-1)", () => {
  it('60fps 2 frames vs 30fps 1 frame produce identical displacement (KeyW held)', () => {
    // LO 1.7 first-person test fixture: forward direction = -Z (initial
    // gaze), right = +X (cross(forward, world-up)).
    const forward = { x: 0, y: 0, z: -1 } as const;
    const right = { x: 1, y: 0, z: 0 } as const;
    const heldW = { w: true, s: false, a: false, d: false } as const;

    // 60fps over 2 frames: dt = 1/60 each.
    const half1 = computeWasdDisplacement(1 / 60, forward, right, heldW);
    const half2 = computeWasdDisplacement(1 / 60, forward, right, heldW);
    const total60 = {
      x: half1.x + half2.x,
      y: half1.y + half2.y,
      z: half1.z + half2.z,
    };

    // 30fps over 1 frame: dt = 1/30.
    const total30 = computeWasdDisplacement(1 / 30, forward, right, heldW);

    expect(total60.x).toBeCloseTo(total30.x, 9);
    expect(total60.y).toBeCloseTo(total30.y, 9);
    expect(total60.z).toBeCloseTo(total30.z, 9);
    // Sanity: KeyW held + forward=-Z drives -Z; cameraSpeed=2.5 (LO
    // SSOT) so 1/30s of W = -2.5 / 30 ≈ -0.0833.
    expect(total30.z).toBeCloseTo(-2.5 / 30, 9);
  });

  it('zero held keys produces zero displacement regardless of dt', () => {
    const forward = { x: 0, y: 0, z: -1 } as const;
    const right = { x: 1, y: 0, z: 0 } as const;
    const idle = { w: false, s: false, a: false, d: false } as const;
    const out = computeWasdDisplacement(1 / 60, forward, right, idle);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('KeyD strafes along right vector, scaled by cameraSpeed * dt', () => {
    const forward = { x: 0, y: 0, z: -1 } as const;
    const right = { x: 1, y: 0, z: 0 } as const;
    const heldD = { w: false, s: false, a: false, d: true } as const;
    const out = computeWasdDisplacement(1 / 60, forward, right, heldD);
    // cameraSpeed=2.5; right=(1,0,0) -> +X displacement = 2.5/60.
    expect(out.x).toBeCloseTo(2.5 / 60, 9);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('KeyW + KeyD held simultaneously sums forward + right contributions', () => {
    const forward = { x: 0, y: 0, z: -1 } as const;
    const right = { x: 1, y: 0, z: 0 } as const;
    const both = { w: true, s: false, a: false, d: true } as const;
    const out = computeWasdDisplacement(1 / 60, forward, right, both);
    expect(out.x).toBeCloseTo(2.5 / 60, 9);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(-2.5 / 60, 9);
  });
});
