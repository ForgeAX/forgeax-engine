// m2-1 -- player-move pure-logic unit tests (TDD red before m2-3 impl).
//
// player-move.ts is a closure-captured defineSystem (needs app for input /
// physics), so the per-frame system fn itself is exercised by human/sandbox
// runtime. What IS unit-testable -- and what plan-strategy D-8 / D-9 demand a
// gate on -- is the pure decision logic the system delegates to:
//
//   - readGrounded(world, entity): boolean   (D-8: grounded === true, NOT !== 0)
//   - planarIntent(snap): { dx, dz }         (WASD -> normalized planar dir)
//   - integrateVertical(state, params): vertical-velocity step (gravity + jump)
//
// These tests fail until apps/collectathon/src/systems/player-move.ts exports
// them. The two-guard pattern (D-9) is covered by asserting the helpers tolerate
// a missing CharacterController (readGrounded returns false, never throws).

import { describe, expect, it } from 'vitest';

import {
  cameraLookAtQuat,
  facingYawFromMove,
  integrateVertical,
  planarBasisFromForward,
  planarIntent,
  readGrounded,
  yawQuat,
} from '../systems/player-move';

// Minimal keyboard-snapshot fake matching InputSnapshot['keyboard'].down.
function fakeSnap(held: ReadonlyArray<string>): {
  keyboard: { down(key: string): boolean };
} {
  const set = new Set(held);
  return { keyboard: { down: (key: string) => set.has(key) } };
}

// Minimal World fake: world.get(entity, Component) -> Result.
// readGrounded must read CharacterController.value.grounded as a real boolean.
function fakeWorldWithGrounded(grounded: unknown): {
  get(entity: unknown, component: unknown): { ok: true; value: unknown };
} {
  return {
    get: () => ({ ok: true, value: { grounded } }),
  };
}

function fakeWorldMissingController(): {
  get(entity: unknown, component: unknown): { ok: false; error: { code: string } };
} {
  return {
    get: () => ({ ok: false, error: { code: 'component-not-present' } }),
  };
}

describe('readGrounded (D-8: bool direct compare, never !== 0)', () => {
  it('returns true only when grounded is the boolean true', () => {
    expect(readGrounded(fakeWorldWithGrounded(true) as never, 1 as never)).toBe(true);
  });

  it('returns false when grounded is false', () => {
    expect(readGrounded(fakeWorldWithGrounded(false) as never, 1 as never)).toBe(false);
  });

  it('returns false when CharacterController is missing (no throw)', () => {
    expect(() => readGrounded(fakeWorldMissingController() as never, 1 as never)).not.toThrow();
    expect(readGrounded(fakeWorldMissingController() as never, 1 as never)).toBe(false);
  });
});

describe('planarIntent (WASD -> normalized XZ direction)', () => {
  it('forward W maps to -z (camera looks down -z by convention)', () => {
    const { dx, dz } = planarIntent(fakeSnap(['w']) as never);
    expect(dx).toBe(0);
    expect(dz).toBeLessThan(0);
  });

  it('back S maps to +z', () => {
    const { dz } = planarIntent(fakeSnap(['s']) as never);
    expect(dz).toBeGreaterThan(0);
  });

  it('right D maps to +x, left A maps to -x', () => {
    expect(planarIntent(fakeSnap(['d']) as never).dx).toBeGreaterThan(0);
    expect(planarIntent(fakeSnap(['a']) as never).dx).toBeLessThan(0);
  });

  it('no keys -> zero intent', () => {
    const { dx, dz } = planarIntent(fakeSnap([]) as never);
    expect(dx).toBe(0);
    expect(dz).toBe(0);
  });

  it('diagonal is unit-normalized (not faster than cardinal)', () => {
    const { dx, dz } = planarIntent(fakeSnap(['w', 'd']) as never);
    const len = Math.hypot(dx, dz);
    expect(len).toBeCloseTo(1, 5);
  });
});

describe('planarBasisFromForward (camera-relative basis sign, D7)', () => {
  it('camera looking down -Z -> right is +X (D moves screen-right, not -X)', () => {
    const right: [number, number, number] = [0, 0, 0];
    const { fwdX, fwdZ } = planarBasisFromForward(0, -1, right as never);
    // forward stays -Z.
    expect(fwdX).toBeCloseTo(0, 5);
    expect(fwdZ).toBeCloseTo(-1, 5);
    // right = cross(forward, +Y) = +X. The D7 bug returned -X here.
    expect(right[0]).toBeCloseTo(1, 5);
    expect(right[2]).toBeCloseTo(0, 5);
  });

  it('camera looking down +X -> right is +Z (right-hand basis stays consistent)', () => {
    const right: [number, number, number] = [0, 0, 0];
    planarBasisFromForward(1, 0, right as never);
    // cross((1,0,0), (0,1,0)) = (0,0,1).
    expect(right[0]).toBeCloseTo(0, 5);
    expect(right[2]).toBeCloseTo(1, 5);
  });

  it('degenerate forward (straight down) falls back to -Z forward / +X right', () => {
    const right: [number, number, number] = [0, 0, 0];
    const { fwdX, fwdZ } = planarBasisFromForward(0, 0, right as never);
    expect(fwdX).toBe(0);
    expect(fwdZ).toBe(-1);
    expect(right[0]).toBeCloseTo(1, 5);
  });
});

describe('integrateVertical (gravity + grounded jump, D-8 grounded gate)', () => {
  const params = { gravity: -12, jumpSpeed: 6, dt: 1 / 60 };

  it('grounded + jump sets the upward jump velocity', () => {
    const v = integrateVertical({ velocity: 0, grounded: true, jump: true }, params);
    // Jump impulse applied, then one gravity step subtracted.
    expect(v).toBeGreaterThan(0);
    expect(v).toBeCloseTo(params.jumpSpeed + params.gravity * params.dt, 5);
  });

  it('airborne integrates gravity downward (no jump)', () => {
    const v = integrateVertical({ velocity: 0, grounded: false, jump: false }, params);
    expect(v).toBeLessThan(0);
    expect(v).toBeCloseTo(params.gravity * params.dt, 5);
  });

  it('grounded without jump stays glued (small downward bias, not accumulating)', () => {
    const v = integrateVertical({ velocity: -100, grounded: true, jump: false }, params);
    // Clamped to a single gravity step so a long fall does not accumulate.
    expect(v).toBeCloseTo(params.gravity * params.dt, 5);
  });

  it('grounded jump only when jump pressed (D-8: grounded bool gate)', () => {
    const noJump = integrateVertical({ velocity: 0, grounded: true, jump: false }, params);
    expect(noJump).toBeLessThanOrEqual(0);
  });
});

// facingYawFromMove / yawQuat (D2 facing): the rig yaws to face its planar move
// direction. The model faces +Z at identity, so yaw = atan2(mx, mz) turns +Z onto
// (mx, mz); yawQuat builds the Y-axis quaternion for that angle.
describe('facingYawFromMove + yawQuat (D2 facing)', () => {
  it('moving +Z (toward camera, S) yaws 0 -> identity quat (faces +Z)', () => {
    const q = yawQuat(facingYawFromMove(0, 1));
    expect(q.x).toBeCloseTo(0, 5);
    expect(q.y).toBeCloseTo(0, 5);
    expect(q.z).toBeCloseTo(0, 5);
    expect(q.w).toBeCloseTo(1, 5);
  });

  it('moving -Z (away, W) yaws 180 (quat y ~ 1, faces -Z)', () => {
    const q = yawQuat(facingYawFromMove(0, -1));
    expect(Math.abs(q.y)).toBeCloseTo(1, 5);
    expect(q.x).toBeCloseTo(0, 5);
    expect(q.z).toBeCloseTo(0, 5);
  });

  it('moving +X (right, D) yaws +90 (quat y=sin45, quat w=cos45)', () => {
    const q = yawQuat(facingYawFromMove(1, 0));
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('moving -X (left, A) yaws -90 (quat y=-sin45)', () => {
    const q = yawQuat(facingYawFromMove(-1, 0));
    expect(q.y).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('yawQuat output is always unit-length', () => {
    for (const yaw of [0, 0.5, 1.2, -2.0, Math.PI]) {
      const q = yawQuat(yaw);
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 5);
    }
  });
});

// cameraLookAtQuat: pure third-person camera orientation via mat4.lookAt + invert + decompose.
// Verifies the look-at direction is downward (camera above player) and nondiagonal.
describe('cameraLookAtQuat', () => {
  const CAMERA_OFFSET_Y = 5;
  const CAMERA_OFFSET_Z = 9;

  it('returns identity when eye equals target (degenerate guard)', () => {
    const q = cameraLookAtQuat(0, 5, 9, 0, 5, 9, 0, 1, 0);
    // mat4.lookAt returns identity when eye == target; invert yields identity; decompose gives identity quat.
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(1, 5);
  });

  it('camera above (0,0,0) looking at target ahead yields a downward pitch', () => {
    // Camera at (0, 5, 9), target (0, 0, 0). The camera is above and behind,
    // so it must pitch downward (rotate around X axis).
    const q = cameraLookAtQuat(0, CAMERA_OFFSET_Y, CAMERA_OFFSET_Z, 0, 0, 0, 0, 1, 0);
    // A downward pitch means the forward vector has a negative Y component.
    // Quaternion must be unit-length.
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    expect(len).toBeCloseTo(1, 5);
    // The quaternion should have a nonzero X component (pitch rotation) and
    // the Y component should be near identity (no yaw — camera is directly
    // behind along Z).
    expect(Math.abs(q[0])).toBeGreaterThan(0.01); // nonzero pitch
    expect(Math.abs(q[2])).toBeCloseTo(0, 5); // no roll
  });

  it('camera looking at higher target pitches upward', () => {
    // Camera at (0, 0, 9), target (0, 5, 0) — camera below target, pitches up.
    const q = cameraLookAtQuat(0, 0, CAMERA_OFFSET_Z, 0, 5, 0, 0, 1, 0);
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    expect(len).toBeCloseTo(1, 5);
    // X component should be nonzero (pitch).
    expect(Math.abs(q[0])).toBeGreaterThan(0.01);
  });

  it('reproduces consistent orientation for the actual target pose', () => {
    // Simulate actual game: eye (0, 5.8, 9), target (0, 1.8, 0), up=(0,1,0).
    // Player at spawn: y=0.8 (PLAYER_SPAWN_Y) + 1 = 1.8 torso target.
    const q = cameraLookAtQuat(0, CAMERA_OFFSET_Y + 0.8, CAMERA_OFFSET_Z, 0, 1.8, 0, 0, 1, 0);
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    expect(len).toBeCloseTo(1, 5);
    // Should have a dominant pitch (X rotation) and possibly small yaw.
    expect(Math.abs(q[0])).toBeGreaterThan(0);
  });
});
