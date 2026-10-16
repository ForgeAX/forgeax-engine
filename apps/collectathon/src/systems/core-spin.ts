// apps/collectathon -- core-spin: per-frame Y-rotation + vertical bob for every
// Core (plan-strategy AC-13 "floating spinning" collectibles).
//
// Two behaviors share this one system (AC-20: one defineSystem per domain file):
//   - spin: accumulate a Y-axis angle at SPIN_SPEED rad/s, written as a quaternion
//   - bob:  offset pos y by a sine wave (+/- BOB_AMPLITUDE) around CORE_BASE_Y
//
// The system queries every Core + Transform and writes each entity's
// Transform.local. The Cores are kinematic-position bodies, so writing Transform
// is the sanctioned way to move them (the physics sync reads it back) -- the
// sensor follows the visual.
//
// quatFromYRadians + bobOffset are pure so the rotation/bob math is testable;
// the system fn wires them to the captured Core entity list + frame dt.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';

import { CORE_BASE_Y } from '../spawn/spawn-core';
import { readDt } from './frame-time';

/** Spin rate (radians/second) about the world Y axis. */
export const SPIN_SPEED = 1.5;
/** Vertical bob amplitude (m) above/below the resting height. */
export const BOB_AMPLITUDE = 0.15;
/** Bob angular frequency (radians/second). */
export const BOB_FREQUENCY = 2.0;

/** Pure: the quaternion (xyzw) for a rotation of `angle` radians about +Y. */
export function quatFromYRadians(angle: number): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  const half = angle / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/** Pure: vertical bob offset (m) at phase `t` seconds. */
export function bobOffset(t: number): number {
  return Math.sin(t * BOB_FREQUENCY) * BOB_AMPLITUDE;
}

/**
 * Build the core-spin system bound to the live Core entity list. Factory form
 * (not a bare defineSystem) so the captured handles + the angle/phase
 * accumulators persist across frames, mirroring player-move/player-anim.
 *
 * The Core handles are captured at spawn time (main.ts passes the spawned list).
 * A despawned Core (collected) yields a failed world.get -> skipped, so the
 * system tolerates the set shrinking mid-run without re-querying.
 */
export function createSpinSystem(cores: ReadonlyArray<EntityHandle>): SystemHandle<readonly []> {
  let angle = 0;
  let phase = 0;
  return defineSystem({
    name: 'core-spin',
    queries: [],
    fn: (world: World) => {
      const dt = readDt(world);
      angle += SPIN_SPEED * dt;
      phase += dt;
      const quat = quatFromYRadians(angle);
      const y = CORE_BASE_Y + bobOffset(phase);
      for (const core of cores) {
        // Skip collected (despawned) Cores: world.set on a stale entity is a
        // no-op Result, but world.get gates it explicitly for clarity.
        if (!world.get(core, Transform).ok) continue;
        world.set(core, Transform, {
          pos: [0, y, 0],
          quat: [quat.x, quat.y, quat.z, quat.w],
        });
      }
    },
  });
}
