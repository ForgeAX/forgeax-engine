import type { Component, EntityHandle, System, World } from '@forgeax/engine-ecs';
import { Disabled, defineSystem, FixedTime, FixedUpdate } from '@forgeax/engine-ecs';
import { type DerivedRangeWriter, getDerivedWriter } from '@forgeax/engine-ecs/internal';
import {
  CollidingEntities,
  PhysicsSet,
  PhysicsSimulation,
  PhysicsSync,
  PhysicsWritebackPhase,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { PropagateTransformsFixed, type Transform } from '@forgeax/engine-scene';
import { PHYSICS_DT_MAX } from './physics-sync-descriptor.js';
import type { RapierPhysicsWorld3D } from './rapier-physics-world-3d.js';
import { requireRapierPhysicsWorld3D } from './rapier-physics-world-3d.js';

// ── System name constants ──
const PHYSICS_SYNC_BACKEND = 'physicsSyncBackend' as const;
const PHYSICS_STEP_SIMULATION = 'physicsStepSimulation' as const;
const PHYSICS_WRITEBACK = 'physicsWriteback' as const;
const PHYSICS_COLLISION_SYNC = 'physicsCollisionSync' as const;

/**
 * Resolve the runtime `Transform` component token from the World-local ECS
 * registry (M2 — full resource-ification, D-3). physics already depends on
 * `@forgeax/engine-ecs`, so the catalog introduces no new dependency
 * and replaces the closure-captured `transformComponent` second parameter.
 * Returns `undefined` when Transform is not yet defined (the runtime package
 * defines it on import); callers early-out.
 */
function resolveTransform(world: World): Component | undefined {
  return world.components.resolve('Transform');
}

/**
 * `physicsSyncBackend` system token (M2 — full resource-ification, D-4).
 *
 * After propagateTransforms, bootstrap/recovery performs one complete Collider
 * reconcile. Warm ticks poll the existing ECS projection and identity-read only
 * final changed rows. Bare Colliders remain implicit static bodies; Transform-less
 * fixed bodies are retained only as a migration defense and are never created.
 * Reads `world` from its first parameter; resolves Transform via the global
 * registry. Labelled `'physics'`.
 */
export const PhysicsSyncBackend: System<readonly []> = defineSystem({
  sets: [PhysicsSync],
  name: PHYSICS_SYNC_BACKEND,
  queries: [],
  after: [PropagateTransformsFixed],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    const globalTransformComponent = world.components.resolve('GlobalTransform');
    if (transformComponent === undefined || globalTransformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = requireRapierPhysicsWorld3D(world);
    } catch {
      return; // C-2: PhysicsWorld resource not yet ready — safe early out
    }

    pw._syncFromEcs(world, transformComponent, globalTransformComponent);
  },
});

/**
 * `physicsStepSimulation` system token (M2 — full resource-ification, D-4).
 *
 * After physicsSyncBackend — read FixedTime.delta and call pw.step() with dt-gating.
 */
export const PhysicsStepSimulation: System<readonly []> = defineSystem({
  sets: [PhysicsSimulation],
  name: PHYSICS_STEP_SIMULATION,
  queries: [],
  after: [PhysicsSyncBackend],
  fn: (world) => {
    let pw: RapierPhysicsWorld3D;
    try {
      pw = requireRapierPhysicsWorld3D(world);
    } catch {
      return; // C-2: safe early out
    }

    const dt = world.getResource(FixedTime).delta;
    if (dt <= 0 || dt > PHYSICS_DT_MAX) return; // D-4: skip abnormal delta

    pw.step(dt);
  },
});

/**
 * `physicsWriteback` system token (M2 — full resource-ification, D-4).
 *
 * After physicsStepSimulation — call pw.writebackDynamicBodies() and write
 * exact poses through the ECS numeric write fence into the World-local Transform.
 */
export const PhysicsWriteback: System<readonly []> = defineSystem({
  sets: [PhysicsWritebackPhase],
  name: PHYSICS_WRITEBACK,
  queries: [],
  after: [PhysicsStepSimulation],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = requireRapierPhysicsWorld3D(world);
    } catch {
      return; // C-2: safe early out
    }

    const results = pw.writebackDynamicBodies();
    if (results.length === 0) return;
    let state = poseWriters.get(world);
    if (state === undefined || state.component !== transformComponent) {
      state = {
        component: transformComponent,
        active: createPoseWriter(world, transformComponent, false),
        unmatched: [],
      };
      poseWriters.set(world, state);
    }
    const unmatched = state.unmatched;
    unmatched.length = 0;
    try {
      publishPoses(state.active, results, unmatched);
      // Ordinary queries omit Disabled. Preserve pending poses for native
      // derived bodies that still exist while their ECS entity is disabled.
      if (unmatched.length > 0) {
        state.disabled ??= createPoseWriter(world, transformComponent, true);
        publishPoses(state.disabled, unmatched);
      }
    } finally {
      unmatched.length = 0;
    }
  },
});

type BodyPose = ReturnType<RapierPhysicsWorld3D['writebackDynamicBodies']>[number];
interface PoseWriter {
  readonly writer: DerivedRangeWriter<never, typeof Transform>;
  readonly cursor: { bindingIndex: number; row: number };
  readonly touched: number[];
}
interface PoseWriters {
  readonly component: Component;
  readonly active: PoseWriter;
  disabled?: PoseWriter;
  readonly unmatched: BodyPose[];
}
const poseWriters = new WeakMap<World, PoseWriters>();

function createPoseWriter(world: World, component: Component, disabled: boolean): PoseWriter {
  const transform = component as typeof Transform;
  const query = world
    .query({ write: [transform], ...(disabled ? { with: [Disabled] } : {}) })
    .unwrap();
  return {
    writer: getDerivedWriter(query, transform).unwrap(),
    cursor: { bindingIndex: 0, row: 0 },
    touched: [],
  };
}

/** Commit exact f32 poses and publish only changed rows through the ECS fence. */
function publishPoses(state: PoseWriter, poses: readonly BodyPose[], unmatched?: BodyPose[]): void {
  const { writer, cursor, touched } = state;
  touched.length = 0;
  try {
    writer
      .writeRows(touched, () => {
        for (const pose of poses) {
          if (!writer.locateEntity(pose.entity as EntityHandle, cursor)) {
            unmatched?.push(pose);
            continue;
          }
          const columns = writer.bindings[cursor.bindingIndex]?.write;
          if (columns === undefined) continue;
          const pos = columns.pos,
            rotation = columns.quat;
          const p = cursor.row * 3,
            q = cursor.row * 4;
          const x = Math.fround(pose.pos.x),
            y = Math.fround(pose.pos.y),
            z = Math.fround(pose.pos.z);
          const rx = Math.fround(pose.rotation.x),
            ry = Math.fround(pose.rotation.y);
          const rz = Math.fround(pose.rotation.z),
            rw = Math.fround(pose.rotation.w);
          if (
            pos[p] === x &&
            pos[p + 1] === y &&
            pos[p + 2] === z &&
            rotation[q] === rx &&
            rotation[q + 1] === ry &&
            rotation[q + 2] === rz &&
            rotation[q + 3] === rw
          )
            continue;
          pos[p] = x;
          pos[p + 1] = y;
          pos[p + 2] = z;
          rotation[q] = rx;
          rotation[q + 1] = ry;
          rotation[q + 2] = rz;
          rotation[q + 3] = rw;
          touched.push(cursor.bindingIndex, cursor.row);
        }
      })
      .unwrap();
  } finally {
    touched.length = 0;
  }
}

/**
 * `physicsCollisionSync` system token — writes the drained overlap set into each
 * entity's `CollidingEntities` component (the contact/sensor set-query path).
 *
 * Runs after writeback so the component reflects this step's contacts. Without
 * it the `CollidingEntities` component documented in the physics README never
 * updates (the event queue was drained-on-overflow only), so sensor pickup +
 * proximity queries silently saw an empty set.
 */
export const PhysicsCollisionSync: System<readonly []> = defineSystem({
  sets: [PhysicsWritebackPhase],
  name: PHYSICS_COLLISION_SYNC,
  queries: [],
  after: [PhysicsWriteback],
  fn: (world) => {
    let pw: RapierPhysicsWorld3D;
    try {
      pw = requireRapierPhysicsWorld3D(world);
    } catch {
      return; // C-2: safe early out
    }
    pw.writebackCollidingEntities(world, CollidingEntities as unknown as Component);
    pw.finalizeDerivedFixedStep();
  },
});

/**
 * Register the physics tick systems into an ECS World.
 *
 * The systems ({@link PhysicsSyncBackend} / {@link PhysicsStepSimulation} /
 * {@link PhysicsWriteback} / {@link PhysicsCollisionSync}) are module-level
 * `defineSystem` tokens; this helper wires the moveAndSlide context + despawn
 * cleanup hook, then adds the tokens to the schedule.
 *
 * Transform is resolved from the World-local ECS component catalog,
 * D-3) — the previous `transformComponent` second parameter was redundant once
 * the system fns and moveContext resolve Transform themselves, so it is gone.
 *
 * @param world ECS World instance.
 */
export function registerPhysicsSystems(world: World): () => void {
  const releaseComponents = registerPhysicsComponents(world);
  // ── moveAndSlide context + despawn cleanup wiring (D-1/D-3) ──
  // Wire the World + Transform/CharacterController components into the backend
  // so moveAndSlide can read tuning and write pose/grounded back, and register
  // the backend for the global Collider.onRemove dispatch (despawn cleanup).
  const transformComponent = resolveTransform(world);
  try {
    const pw = requireRapierPhysicsWorld3D(world);
    if (transformComponent !== undefined) {
      pw.setMoveContext(world, transformComponent);
    }
  } catch {
    // PhysicsWorld resource not yet inserted — moveAndSlide falls back to
    // CharacterController schema defaults until a later registration wires it.
  }

  world
    .addSystems(FixedUpdate, PhysicsSet, [
      PhysicsSyncBackend,
      PhysicsStepSimulation,
      PhysicsWriteback,
      PhysicsCollisionSync,
    ])
    .unwrap();
  return () => {
    world.removeSystem(FixedUpdate, PhysicsCollisionSync);
    world.removeSystem(FixedUpdate, PhysicsWriteback);
    world.removeSystem(FixedUpdate, PhysicsStepSimulation);
    world.removeSystem(FixedUpdate, PhysicsSyncBackend);
    try {
      requireRapierPhysicsWorld3D(world).clearEcsContext(world);
    } catch {
      // PhysicsWorld may already have been removed as part of outer teardown.
    }
    poseWriters.delete(world);
    releaseComponents();
  };
}
