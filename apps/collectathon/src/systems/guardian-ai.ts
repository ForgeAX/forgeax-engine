// apps/collectathon -- guardian-ai: per-entity patrol / chase / attack sub-state
// machine (plan-strategy D-1 / F-08 sub-machine, OOS-3 waypoint patrol + straight
// chase, no nav-mesh / A*).
//
// IMPORTANT: the Guardian sub-machine is a PER-ENTITY COMPONENT mode (the
// Guardian component's `mode` enum), NOT a global defineState. The global state
// machine is GameState (Title/Play/Win/Lose); each Guardian carries its own mode
// so N Guardians run independent AI in one system via a switch on Guardian.mode.
//
// Per frame, for each Guardian:
//   (1) measure planar distance to the player parent
//   (2) decideMode(current, dist, timer) picks the next mode:
//         patrol  -> chase  when dist < CHASE_RADIUS
//         chase   -> attack when dist < ATTACK_RADIUS
//         chase   -> patrol when dist > CHASE_RADIUS (player escaped)
//         attack  -> chase  when the attack hold elapses (retreat to re-approach)
//         attack  -> chase/patrol immediately if the player left attack reach
//   (3) move with moveAndSlide: patrol walks the waypoint loop (pausing at each),
//       chase steers straight at the player, attack holds position
//   (4) arm the attack sensor (GuardianAttack.armed) only in attack mode, so a
//       chase fly-by does not damage -- only a committed attack lands (guardian-hit)
//
// decideMode / planarStep / advanceWaypoint are pure so the transition + steering
// math is reviewable; the system fn wires them to the live PhysicsWorld + the
// captured Guardian/player handles (mirrors player-move's factory closure form).

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';

import { Guardian, GuardianAttack, GuardianModeValue } from '../components';
import type { GuardianHandles } from '../spawn/spawn-guardian';
import { readDt } from './frame-time';

/**
 * Planar distance (m) within which a Guardian leaves patrol to chase.
 *
 * Kept strictly BELOW the nearest Guardian-to-player-spawn distance so the run
 * does not open with a spawn-camp: the player spawns at the origin and the three
 * GUARDIAN_SPAWNS sit at planar distances 7.28 / 7.28 / 8.0, so a chase radius of
 * 8 aggroed every Guardian on frame 1 -- three KCC bodies (GUARDIAN_SPEED 3 <
 * player MOVE_SPEED 4, but the player starts still) converged on the stationary
 * spawn and drained all 3 hearts in ~3s (3 distinct attackers each land one
 * un-invul'd first hit). At 5 the spawn sits safely outside every aggro ring, so
 * the player roams first and only pulls a Guardian by closing within 5m.
 */
export const CHASE_RADIUS = 5;
/** Planar distance (m) within which a chasing Guardian commits to attack. */
export const ATTACK_RADIUS = 2;
/** Guardian move speed (units/second), a touch below the player's MOVE_SPEED=4. */
export const GUARDIAN_SPEED = 3;
/** Seconds a Guardian pauses on reaching a patrol waypoint. */
export const PATROL_PAUSE_SECONDS = 1.5;
/** Seconds a Guardian holds the attack pose before retreating to chase. */
export const ATTACK_HOLD_SECONDS = 0.5;
/** Distance (m) under which a patrol waypoint counts as reached. */
export const WAYPOINT_REACH = 0.6;

/**
 * A Guardian's patrol path: a small square loop centred on its spawn position.
 * OOS-3 keeps this a fixed waypoint ring (no path-finding). Offsets are added to
 * the spawn XZ at wiring time.
 */
export const PATROL_OFFSETS: ReadonlyArray<{ readonly x: number; readonly z: number }> = [
  { x: 3, z: 0 },
  { x: 0, z: 3 },
  { x: -3, z: 0 },
  { x: 0, z: -3 },
];

/** Mode + per-mode bookkeeping a Guardian carries between frames. */
export interface GuardianAIState {
  readonly mode: number;
  readonly waypoint: number;
  readonly timer: number;
}

export interface DecideModeInput {
  readonly state: GuardianAIState;
  /** Planar distance from the Guardian to the player this frame. */
  readonly distToPlayer: number;
  /** True once the Guardian has reached its current patrol waypoint. */
  readonly waypointReached: boolean;
  readonly dt: number;
}

/**
 * Pure mode transition + bookkeeping for one Guardian frame. Returns the next
 * GuardianAIState (mode / waypoint / timer). The transitions are deterministic
 * and hysteresis-free except for the timed dwells (patrol pause, attack hold),
 * so the AI does not flicker between modes on a stable distance.
 */
export function decideMode(input: DecideModeInput): GuardianAIState {
  const { state, distToPlayer, waypointReached, dt } = input;
  switch (state.mode) {
    case GuardianModeValue.chase:
      return decideFromChase(state, distToPlayer, dt);
    case GuardianModeValue.attack:
      return decideFromAttack(state, distToPlayer, dt);
    default:
      return decideFromPatrol(state, distToPlayer, waypointReached, dt);
  }
}

function decideFromPatrol(
  state: GuardianAIState,
  distToPlayer: number,
  waypointReached: boolean,
  dt: number,
): GuardianAIState {
  if (distToPlayer < CHASE_RADIUS) {
    return { mode: GuardianModeValue.chase, waypoint: state.waypoint, timer: 0 };
  }
  if (!waypointReached) {
    return { mode: GuardianModeValue.patrol, waypoint: state.waypoint, timer: 0 };
  }
  // Reached the waypoint: pause, then advance to the next one.
  const timer = state.timer + dt;
  if (timer < PATROL_PAUSE_SECONDS) {
    return { mode: GuardianModeValue.patrol, waypoint: state.waypoint, timer };
  }
  return {
    mode: GuardianModeValue.patrol,
    waypoint: advanceWaypoint(state.waypoint, PATROL_OFFSETS.length),
    timer: 0,
  };
}

function decideFromChase(
  state: GuardianAIState,
  distToPlayer: number,
  _dt: number,
): GuardianAIState {
  if (distToPlayer < ATTACK_RADIUS) {
    return { mode: GuardianModeValue.attack, waypoint: state.waypoint, timer: 0 };
  }
  if (distToPlayer > CHASE_RADIUS) {
    return { mode: GuardianModeValue.patrol, waypoint: state.waypoint, timer: 0 };
  }
  return { mode: GuardianModeValue.chase, waypoint: state.waypoint, timer: 0 };
}

function decideFromAttack(
  state: GuardianAIState,
  distToPlayer: number,
  dt: number,
): GuardianAIState {
  // The player escaped attack reach: drop straight back to chase (or patrol).
  if (distToPlayer > ATTACK_RADIUS) {
    const next = distToPlayer < CHASE_RADIUS ? GuardianModeValue.chase : GuardianModeValue.patrol;
    return { mode: next, waypoint: state.waypoint, timer: 0 };
  }
  // Hold the attack briefly, then retreat to chase so the attack re-arms (the
  // invul window in guardian-hit gates the actual damage cadence).
  const timer = state.timer + dt;
  if (timer < ATTACK_HOLD_SECONDS) {
    return { mode: GuardianModeValue.attack, waypoint: state.waypoint, timer };
  }
  return { mode: GuardianModeValue.chase, waypoint: state.waypoint, timer: 0 };
}

/** Pure: next waypoint index, wrapping the ring. */
export function advanceWaypoint(current: number, count: number): number {
  if (count <= 0) return 0;
  return (current + 1) % count;
}

/**
 * Pure: a planar step (dx, dz) of at most `speed * dt` toward (tx, tz) from
 * (x, z). Returns {dx:0, dz:0} when already within `speed * dt` of the target so
 * the mover never overshoots.
 */
export function planarStep(
  x: number,
  z: number,
  tx: number,
  tz: number,
  speed: number,
  dt: number,
): { dx: number; dz: number } {
  const toX = tx - x;
  const toZ = tz - z;
  const dist = Math.hypot(toX, toZ);
  const maxStep = speed * dt;
  if (dist <= 1e-6 || dist <= maxStep) return { dx: 0, dz: 0 };
  return { dx: (toX / dist) * maxStep, dz: (toZ / dist) * maxStep };
}

interface AISystemApp {
  readonly world: World;
}

// Per-Guardian patrol ring resolved at wiring time (spawn XZ + PATROL_OFFSETS).
interface GuardianRuntime extends GuardianHandles {
  readonly waypoints: ReadonlyArray<{ readonly x: number; readonly z: number }>;
}

/**
 * Build the guardian-ai system bound to the live app + the spawned Guardians +
 * the player parent entity. Factory form so the captured handles + per-Guardian
 * patrol rings persist across frames (the descriptor fn reaches world only).
 *
 * Two guards mirror player-move (D-9): the PhysicsWorld resource appears only
 * after Rapier WASM loads, and a body may not exist on the first tick -- both
 * no-op rather than throw.
 */
export function createGuardianAISystem(
  _app: AISystemApp,
  guardians: ReadonlyArray<GuardianRuntime>,
  player: EntityHandle,
): SystemHandle<readonly []> {
  return defineSystem({
    name: 'guardian-ai',
    after: ['player-move'],
    queries: [],
    fn: (world: World) => {
      let pw: PhysicsWorld;
      try {
        pw = world.getResource<PhysicsWorld>('PhysicsWorld');
      } catch {
        return;
      }
      const playerTf = world.get(player, Transform);
      if (!playerTf.ok) return;
      const px = playerTf.value.pos[0] ?? 0;
      const pz = playerTf.value.pos[2] ?? 0;
      const dt = readDt(world);

      for (const g of guardians) {
        stepGuardian(world, pw, g, px, pz, dt);
      }
    },
  });
}

// One Guardian's frame: measure, decide, move, arm. Skips a despawned Guardian
// (stale handle) and the pre-physics window (no body yet).
function stepGuardian(
  world: World,
  pw: PhysicsWorld,
  g: GuardianRuntime,
  px: number,
  pz: number,
  dt: number,
): void {
  const tf = world.get(g.body, Transform);
  const guardianState = world.get(g.body, Guardian);
  if (!tf.ok || !guardianState.ok) return;
  if (!pw.hasBody(g.body)) return;

  const gx = tf.value.pos[0] ?? 0;
  const gz = tf.value.pos[2] ?? 0;
  const distToPlayer = Math.hypot(px - gx, pz - gz);

  const state: GuardianAIState = {
    mode: guardianState.value.mode,
    waypoint: guardianState.value.waypoint,
    timer: guardianState.value.timer,
  };
  const wp = g.waypoints[state.waypoint] ?? { x: gx, z: gz };
  const waypointReached = Math.hypot(wp.x - gx, wp.z - gz) < WAYPOINT_REACH;

  const next = decideMode({ state, distToPlayer, waypointReached, dt });
  world.set(g.body, Guardian, { mode: next.mode, waypoint: next.waypoint, timer: next.timer });

  // Steering target by mode: patrol -> waypoint, chase -> player, attack -> hold.
  const step = steerStep(next.mode, gx, gz, wp, px, pz, dt);
  if (step.dx !== 0 || step.dz !== 0) {
    pw.moveAndSlide(g.body, vec3.create(step.dx, 0, step.dz));
  }

  // Arm the attack sensor only in attack mode (chase fly-by deals no damage).
  world.set(g.attackSensor, GuardianAttack, { armed: next.mode === GuardianModeValue.attack });
}

// Resolve the planar step for the current mode.
function steerStep(
  mode: number,
  gx: number,
  gz: number,
  wp: { readonly x: number; readonly z: number },
  px: number,
  pz: number,
  dt: number,
): { dx: number; dz: number } {
  if (mode === GuardianModeValue.chase) {
    return planarStep(gx, gz, px, pz, GUARDIAN_SPEED, dt);
  }
  if (mode === GuardianModeValue.attack) {
    return { dx: 0, dz: 0 };
  }
  return planarStep(gx, gz, wp.x, wp.z, GUARDIAN_SPEED, dt);
}

/** Resolve a Guardian's patrol ring (spawn XZ + PATROL_OFFSETS) for wiring. */
export function guardianWaypoints(spawn: {
  readonly x: number;
  readonly z: number;
}): ReadonlyArray<{ readonly x: number; readonly z: number }> {
  return PATROL_OFFSETS.map((o) => ({ x: spawn.x + o.x, z: spawn.z + o.z }));
}

export type { GuardianRuntime };
