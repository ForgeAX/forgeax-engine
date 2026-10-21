import {
  Entity,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { mat4, type Quat, quat, type Vec3, vec3 } from '@forgeax/engine-math';
import {
  type BodyMotion,
  Collider,
  ColliderShapeValue,
  type ManagedJointBinding,
  ManagedPhysicsError,
  type PhysicsWorld,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import type { Plugin } from '@forgeax/engine-plugin';
import { Transform } from '@forgeax/engine-scene';
import { type AnimationTargetIdValue, err, ok, type Result } from '@forgeax/engine-types';
import { AnimationPlayer } from './animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from './animation-target';
import {
  type PhysicalBone,
  type SkeletalMotionDefinition,
  SkeletalMotionError,
  type SkeletalMotionFailure,
  validateSkeletalMotionDefinition,
} from './skeletal-motion-definition';
import { SkeletonPose, SkeletonTransformReader } from './skeleton-pose';
import { AnimationBindingError } from './solver-errors';
import { SpringBoneSimulation } from './spring-bone';

export const RESTORE_SKELETAL_MOTION_BASE = 'restoreSkeletalMotionBase';
export type {
  PhysicalBone,
  PhysicalBoneJoint,
  SkeletalMotionDefinition,
  SkeletalMotionErrorCode,
  SkeletalMotionFailure,
  SpringBoneChain,
} from './skeletal-motion-definition';
export {
  SkeletalMotionError,
  validateSkeletalMotionDefinition,
} from './skeletal-motion-definition';

export const CAPTURE_SKELETAL_MOTION_BASE = 'captureSkeletalMotionBase';
export const COMPOSE_SKELETAL_MOTION = 'composeSkeletalMotion';
export const PREPARE_SKELETAL_MOTION_JOINTS = 'prepareSkeletalMotionJoints';
const RESOURCE = 'SkeletalMotion';

function bodyVolume(shape: PhysicalBone['shape']): number {
  return shape.kind === 'cuboid'
    ? 8 * shape.halfExtents[0] * shape.halfExtents[1] * shape.halfExtents[2]
    : (4 / 3) * Math.PI * shape.radius ** 3 +
        (shape.kind === 'capsule' ? 2 * shape.halfHeight * Math.PI * shape.radius ** 2 : 0);
}

interface PhysicalBinding {
  readonly definition: PhysicalBone;
  readonly joint: number;
  readonly entity: EntityHandle;
  readonly scale: number;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly previousPosition: Vec3;
  readonly previousRotation: Quat;
  readonly linearVelocity: Vec3;
  readonly angularVelocity: Vec3;
  history: boolean;
  simulated: boolean;
  requested: boolean;
  handoff: boolean;
}

/** One player lease owns simulation state, bodies and the final local pose commit. */
export interface SkeletalMotionBinding {
  readonly status: 'bound' | 'waiting-physics' | 'active' | 'failed' | 'disposed';
  readonly failure: SkeletalMotionFailure | undefined;
  readonly fixedSteps: number;
  readonly bodyEntities: readonly EntityHandle[];
  /** Detached current Scene writer snapshot; ancestors and collision inputs are not writers. */
  readonly writerEntities: readonly EntityHandle[];
  readonly springEvidence: readonly {
    readonly lengthError: number;
    readonly penetration: number;
  }[];
  simulate(targets: readonly AnimationTargetIdValue[]): Result<void, SkeletalMotionFailure>;
  setPhysicsWeight(weight: number): Result<void, SkeletalMotionFailure>;
  setSpringWeight(index: number, weight: number): Result<void, SkeletalMotionFailure>;
  reset(): void;
  dispose(): void;
}

class ManagedSkeletalMotion implements SkeletalMotionBinding {
  status: SkeletalMotionBinding['status'] = 'bound';
  failure: SkeletalMotionFailure | undefined;
  fixedSteps = 0;
  private readonly pose: SkeletonPose;
  private readonly writers: number[];
  private readonly referencePositions: Vec3[];
  private readonly referenceRotations: Quat[];
  private readonly physical: PhysicalBinding[] = [];
  private readonly springs: SpringBoneSimulation[];
  private joints: ManagedJointBinding | undefined;
  private physics: PhysicsWorld | undefined;
  private weight = 1;
  private resetting = true;
  private readonly inverse = mat4.create();
  private readonly rotation = quat.create();
  private readonly delta = quat.create();
  private readonly position = vec3.create();
  private readonly offset = vec3.create();
  private readonly matrix = mat4.create();
  private readonly basePositions: Vec3[];
  private readonly baseRotations: Quat[];

  constructor(
    readonly world: World,
    readonly player: EntityHandle,
    readonly definition: SkeletalMotionDefinition,
    private readonly poseReader: SkeletonTransformReader,
  ) {
    if (!world.hasComponent(player, AnimationPlayer))
      throw new SkeletalMotionError('animation-motion-invalid', {
        reason: 'player needs AnimationPlayer',
      });
    const map = new Map<string, EntityHandle>();
    const targets = world.get(player, AnimationTargets).unwrap().targets;
    for (const entity of targets) {
      const target = world.get(entity as EntityHandle, AnimationTargetId);
      if (target.ok) map.set(target.value.value, entity as EntityHandle);
    }
    const resolve = (id: string): EntityHandle => {
      const entity = map.get(id);
      if (entity === undefined || world.get(entity, AnimatedBy).unwrap().player !== player)
        throw new SkeletalMotionError('animation-motion-stale', {
          target: id,
          reason: 'target is not bound to this player',
        });
      return entity;
    };
    const allIds = new Set<string>();
    for (const chain of definition.springs ?? []) {
      for (const target of chain.targets) allIds.add(target);
      for (const collision of chain.collisions ?? []) allIds.add(collision.target);
    }
    for (const bone of definition.physical?.bones ?? []) allIds.add(bone.target);
    this.pose = new SkeletonPose(world, [...allIds].map(resolve), null, poseReader);
    const index = (id: string): number => this.pose.indices.get(resolve(id)) as number;
    this.springs = (definition.springs ?? []).map((chain) => {
      const indices = chain.targets.map(index);
      for (let i = 1; i < indices.length; i++) {
        const child = indices[i] as number;
        if (
          this.pose.parents[child] !== indices[i - 1] ||
          vec3.length(this.pose.positions[child] as (typeof this.pose.positions)[number]) < 1e-5
        )
          throw new SkeletalMotionError('animation-motion-invalid', {
            reason: 'spring requires continuous nonzero-length bones',
          });
      }
      return new SpringBoneSimulation(
        chain,
        indices,
        (chain.collisions ?? []).map((c) => index(c.target)),
      );
    });
    const bodyIndices = (definition.physical?.bones ?? []).map((bone) => index(bone.target));
    if (bodyIndices.some((value, i) => i > 0 && value <= (bodyIndices[i - 1] as number)))
      throw new SkeletalMotionError('animation-motion-invalid', {
        reason: 'physical bones must be in parent-first scene order',
      });
    this.writers = [
      ...new Set([
        ...this.springs.flatMap((spring) => spring.segments.map((segment) => segment.joint)),
        ...(definition.physical?.bones ?? []).map((bone) => index(bone.target)),
      ]),
    ].sort((a, b) => a - b);
    for (const writer of this.writers) {
      const entity = this.pose.entities[writer] as EntityHandle;
      if (world.hasComponent(entity, RigidBody))
        throw new SkeletalMotionError('animation-motion-conflict', {
          target: String(entity),
          reason: 'bone Transform cannot also be a Physics writeback target',
        });
    }
    this.referencePositions = this.pose.positions.map((value) => vec3.clone(value));
    this.referenceRotations = this.pose.rotations.map((value) => quat.clone(value));
    this.basePositions = this.pose.positions.map((value) => vec3.clone(value));
    this.baseRotations = this.pose.rotations.map((value) => quat.clone(value));
    // Validate every scaled shape and density before allocating the first body entity.
    for (const bone of definition.physical?.bones ?? []) {
      const m = this.pose.matrices[index(bone.target)] as Float32Array;
      const scale = Math.hypot(m[0] as number, m[1] as number, m[2] as number);
      const shape = bone.shape;
      const dimensions =
        shape.kind === 'cuboid'
          ? shape.halfExtents
          : [shape.radius, ...(shape.kind === 'capsule' ? [shape.halfHeight] : [])];
      const volume = bodyVolume(shape);
      const density = bone.mass / (volume * scale ** 3);
      if (
        !Number.isFinite(Math.fround(density)) ||
        Math.fround(density) <= 0 ||
        dimensions.some(
          (v) => !Number.isFinite(Math.fround(v * scale)) || (v > 0 && Math.fround(v * scale) <= 0),
        )
      )
        throw new SkeletalMotionError('animation-motion-invalid', {
          reason: 'scaled shape and mass density must fit finite positive Float32 values',
        });
    }
    try {
      for (const bone of definition.physical?.bones ?? []) {
        const joint = index(bone.target),
          m = this.pose.matrices[joint] as Float32Array;
        const scale = Math.hypot(m[0] as number, m[1] as number, m[2] as number);
        mat4.transformPoint(this.position, m, bone.offset);
        quat.multiply(
          this.rotation,
          this.pose.globalRotations[joint] as (typeof this.pose.globalRotations)[number],
          bone.rotation,
        );
        const shape = bone.shape;
        const volume = bodyVolume(shape);
        const entity = world
          .spawn(
            {
              component: Transform,
              data: { pos: this.position, quat: this.rotation, scale: [scale, scale, scale] },
            },
            {
              component: RigidBody,
              data: {
                type: RigidBodyTypeValue.kinematic,
                mass: 0,
                linearDamping: 0.15,
                angularDamping: 0.2,
                ccdEnabled: true,
                additionalSolverIterations: bone.additionalSolverIterations ?? 0,
              },
            },
            {
              component: Collider,
              data: {
                shape: ColliderShapeValue[shape.kind],
                ...(shape.kind === 'cuboid'
                  ? { halfExtents: shape.halfExtents }
                  : {
                      radius: shape.radius,
                      ...(shape.kind === 'capsule' ? { halfHeight: shape.halfHeight } : {}),
                    }),
                density: bone.mass / (volume * scale ** 3),
                collisionGroups: bone.collisionGroups ?? 0x0001ffff,
              },
            },
          )
          .unwrap();
        this.physical.push({
          definition: bone,
          joint,
          entity,
          scale,
          position: vec3.clone(this.position),
          rotation: quat.clone(this.rotation),
          previousPosition: vec3.clone(this.position),
          previousRotation: quat.clone(this.rotation),
          linearVelocity: vec3.create(),
          angularVelocity: vec3.create(),
          history: false,
          simulated: false,
          requested: false,
          handoff: false,
        });
      }
    } catch (cause) {
      for (const body of this.physical) world.despawn(body.entity);
      throw cause;
    }
    this.poseReader.register(this.pose.entities);
  }

  get bodyEntities(): readonly EntityHandle[] {
    return this.physical.map((body) => body.entity);
  }
  get writerEntities(): readonly EntityHandle[] {
    if (this.status === 'disposed' || this.status === 'failed') return [];
    return this.writers.map((writer) => this.pose.entities[writer] as EntityHandle);
  }
  get springEvidence(): readonly { readonly lengthError: number; readonly penetration: number }[] {
    return this.springs.map((s) => ({
      lengthError: s.maxLengthError,
      penetration: s.maxPenetration,
    }));
  }

  /** Explicit exact subset; empty stops every body. No descendant expansion. */
  simulate(targets: readonly AnimationTargetIdValue[]): Result<void, SkeletalMotionFailure> {
    const failure = this.admission();
    if (failure) return err(failure);
    const selected = new Set(targets);
    if (
      selected.size !== targets.length ||
      targets.some((target) => !this.physical.some((body) => body.definition.target === target))
    )
      return err(
        new SkeletalMotionError('animation-motion-invalid', {
          reason: 'simulate accepts unique physical targets from this definition',
        }),
      );
    for (const body of this.physical) body.requested = selected.has(body.definition.target);
    return ok(undefined);
  }

  private admission(): SkeletalMotionFailure | undefined {
    return this.status === 'disposed' || this.status === 'failed'
      ? new SkeletalMotionError('animation-motion-unavailable', {
          reason: `binding is ${this.status}`,
        })
      : undefined;
  }

  setPhysicsWeight(weight: number): Result<void, SkeletalMotionFailure> {
    const failure = this.admission();
    if (failure) return err(failure);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1)
      return err(
        new SkeletalMotionError('animation-motion-invalid', {
          reason: 'weight must be finite in [0,1]',
        }),
      );
    this.weight = weight;
    return ok(undefined);
  }
  setSpringWeight(index: number, weight: number): Result<void, SkeletalMotionFailure> {
    const failure = this.admission();
    if (failure) return err(failure);
    const spring = this.springs[index];
    if (spring === undefined || !Number.isFinite(weight) || weight < 0 || weight > 1)
      return err(
        new SkeletalMotionError('animation-motion-invalid', {
          reason: 'valid chain index and finite weight in [0,1] required',
        }),
      );
    spring.weight = weight;
    return ok(undefined);
  }
  /** Teleport, clip/rest discontinuity or collision relocation: reset at next fixed step. */
  reset(): void {
    if (this.admission()) return;
    this.resetting = true;
    for (const spring of this.springs) spring.needsReset = true;
  }

  dispose(): void {
    this.retire(true);
  }

  private retire(restore: boolean): void {
    if (this.status === 'disposed') return;
    if (restore && this.world.get(this.player, Entity).ok) {
      try {
        this.poseReader.refresh();
        this.pose.readInputs();
        for (const writer of this.writers) {
          (this.pose.positions[writer] as (typeof this.pose.positions)[number]).set(
            this.basePositions[writer] as (typeof this.basePositions)[number],
          );
          (this.pose.rotations[writer] as (typeof this.pose.rotations)[number]).set(
            this.baseRotations[writer] as (typeof this.baseRotations)[number],
          );
        }
        this.pose.update(0);
        this.pose.write(this.writers, true);
      } catch (cause) {
        if (!(cause instanceof AnimationBindingError)) throw cause;
      }
    }
    this.joints?.dispose();
    this.joints = undefined;
    for (const body of this.physical)
      if (this.world.get(body.entity, Entity).ok) this.world.despawn(body.entity).unwrap();
    this.poseReader.unregister(this.pose.entities);
    this.status = 'disposed';
    if (this.world.hasResource(RESOURCE)) {
      const bindings = this.world.getResource<MotionOwner>(RESOURCE).bindings;
      if (bindings.get(this.player) === this) bindings.delete(this.player);
    }
  }

  private validateOwner(): void {
    if (
      this.physics &&
      (!this.world.hasResource('PhysicsWorld') ||
        this.world.getResource('PhysicsWorld') !== this.physics)
    )
      throw new SkeletalMotionError('animation-motion-stale', {
        target: String(this.player),
        reason: 'PhysicsWorld generation changed; rebind',
      });
    const reader = this.world[worldRead];
    for (const writer of this.writers) {
      const entity = this.pose.entities[writer] as EntityHandle;
      const player =
        reader.getFieldValue(entity, AnimatedBy, 'player') ??
        this.world.get(entity, AnimatedBy).unwrap().player;
      if (player !== this.player)
        throw new SkeletalMotionError('animation-motion-stale', {
          target: String(entity),
          reason: 'animation target rebound',
        });
    }
  }

  private validateBodies(): void {
    for (const body of this.physical) {
      const m = this.pose.matrices[body.joint] as Float32Array;
      if (Math.abs(Math.hypot(m[0] as number, m[1] as number, m[2] as number) - body.scale) > 1e-4)
        throw new SkeletalMotionError('animation-motion-stale', {
          target: body.definition.target,
          reason: 'physical scale changed; rebind before changing body dimensions',
        });
      if (!this.world.get(body.entity, Entity).ok)
        throw new SkeletalMotionError('animation-motion-stale', {
          target: body.definition.target,
          reason: 'managed body was removed',
        });
    }
  }

  private validate(): void {
    this.validateOwner();
    this.pose.readInputs(); // The owner refreshed the shared view at the batch boundary.
    this.pose.update(0);
    this.pose.validate(); // Entire hierarchy and finite TRS checked before any write.
    this.validateBodies();
  }

  restore(): void {
    this.validateOwner();
    this.pose.readInputs();
    for (const writer of this.writers) {
      (this.pose.positions[writer] as (typeof this.pose.positions)[number]).set(
        this.referencePositions[writer] as (typeof this.referencePositions)[number],
      );
      (this.pose.rotations[writer] as (typeof this.pose.rotations)[number]).set(
        this.referenceRotations[writer] as (typeof this.referenceRotations)[number],
      );
    }
    this.pose.update(0);
    this.pose.validate();
    this.validateBodies();
    this.pose.write(this.writers, true);
  }

  capture(): void {
    this.validate();
    for (const writer of this.writers) {
      (this.basePositions[writer] as (typeof this.basePositions)[number]).set(
        this.pose.positions[writer] as (typeof this.pose.positions)[number],
      );
      (this.baseRotations[writer] as (typeof this.baseRotations)[number]).set(
        this.pose.rotations[writer] as (typeof this.pose.rotations)[number],
      );
    }
    const dt = this.world.getResource(FixedTime).delta;
    for (const body of this.physical) {
      const m = this.pose.matrices[body.joint] as Float32Array;
      mat4.transformPoint(body.position, m, body.definition.offset);
      quat.multiply(
        body.rotation,
        this.pose.globalRotations[body.joint] as (typeof this.pose.globalRotations)[number],
        body.definition.rotation,
      );
      body.linearVelocity.fill(0);
      body.angularVelocity.fill(0);
      if (body.history && !this.resetting) {
        vec3.sub(body.linearVelocity, body.position, body.previousPosition);
        vec3.scale(body.linearVelocity, body.linearVelocity, 1 / dt);
        quat.invert(this.delta, body.previousRotation);
        quat.multiply(this.delta, body.rotation, this.delta);
        if ((this.delta[3] as number) < 0)
          for (let i = 0; i < 4; i++) this.delta[i] = -(this.delta[i] as number);
        const sin = Math.hypot(
          this.delta[0] as number,
          this.delta[1] as number,
          this.delta[2] as number,
        );
        const factor =
          sin < 1e-8 ? 2 / dt : (2 * Math.atan2(sin, this.delta[3] as number)) / (sin * dt);
        vec3.set(
          body.angularVelocity,
          (this.delta[0] as number) * factor,
          (this.delta[1] as number) * factor,
          (this.delta[2] as number) * factor,
        );
      }
      body.previousPosition.set(body.position);
      body.previousRotation.set(body.rotation);
      body.history = true;
      body.handoff = body.requested && (!body.simulated || this.resetting);
      if (body.requested !== body.simulated)
        this.world
          .set(body.entity, RigidBody, {
            type: body.requested ? RigidBodyTypeValue.dynamic : RigidBodyTypeValue.kinematic,
          })
          .unwrap();
      if (!body.requested || body.handoff)
        this.world
          .set(body.entity, Transform, { pos: body.position, quat: body.rotation })
          .unwrap();
      body.simulated = body.requested;
    }
    this.resetting = false;
  }

  prepare(): void {
    if (this.physical.length === 0) return;
    if (!this.world.hasResource('PhysicsWorld')) {
      this.status = 'waiting-physics';
      return;
    }
    const physics = this.world.getResource<PhysicsWorld>('PhysicsWorld');
    if (!physics.createManagedJoints || !physics.getBodyMotion || !physics.setBodyMotion)
      throw new SkeletalMotionError('animation-motion-unavailable', {
        reason: 'backend lacks ordinary managed joint/motion capability',
      });
    this.physics = physics;
    if (this.physical.some((body) => !physics.hasBody(body.entity))) {
      this.status = 'waiting-physics';
      return;
    }
    if (this.joints === undefined) {
      const joints = (this.definition.physical?.joints ?? []).map((joint) => {
        const a = this.physical[joint.bodyA] as PhysicalBinding,
          b = this.physical[joint.bodyB] as PhysicalBinding;
        return {
          kind: 'hinge' as const,
          bodyA: a.entity as number,
          bodyB: b.entity as number,
          anchorA: joint.anchorA.map((v) => v * a.scale) as [number, number, number],
          anchorB: joint.anchorB.map((v) => v * b.scale) as [number, number, number],
          axisA: joint.axisA,
          axisB: joint.axisB,
          limits: joint.limits,
        };
      });
      this.joints = physics.createManagedJoints(joints).unwrap();
    }
    for (const body of this.physical)
      if (body.handoff)
        physics
          .setBodyMotion(body.entity, {
            position: [...body.position] as [number, number, number],
            rotation: [...body.rotation] as [number, number, number, number],
            linearVelocity: [...body.linearVelocity] as [number, number, number],
            angularVelocity: [...body.angularVelocity] as [number, number, number],
          })
          .unwrap();
    this.status = 'active';
  }

  compose(): void {
    // Capture already read the animated base; Physics writes only detached body entities.
    for (const body of this.physical) {
      if (!body.simulated || this.weight === 0 || this.status === 'waiting-physics') continue;
      const motion = this.physics?.getBodyMotion?.(body.entity).unwrap();
      if (motion === undefined) continue;
      this.composeBody(body, motion);
    }
    for (const spring of this.springs)
      spring.step(this.pose, this.world.getResource(FixedTime).delta);
    this.pose.write(this.writers, true);
    this.fixedSteps += 1;
    if (this.physical.length === 0) this.status = 'active';
  }

  private composeBody(body: PhysicalBinding, motion: BodyMotion): void {
    quat.invert(this.rotation, body.definition.rotation);
    quat.multiply(this.rotation, motion.rotation, this.rotation);
    mat4.compose(this.matrix, [0, 0, 0], this.rotation, [body.scale, body.scale, body.scale]);
    mat4.transformPoint(this.offset, this.matrix, body.definition.offset);
    vec3.set(
      this.position,
      motion.position[0] - (this.offset[0] as number),
      motion.position[1] - (this.offset[1] as number),
      motion.position[2] - (this.offset[2] as number),
    );
    const parent = this.pose.parents[body.joint] as number;
    if (parent >= 0) {
      mat4.invert(this.inverse, this.pose.matrices[parent] as Float32Array);
      mat4.transformPoint(this.position, this.inverse, this.position);
      quat.invert(
        this.delta,
        this.pose.globalRotations[parent] as (typeof this.pose.globalRotations)[number],
      );
      quat.multiply(this.rotation, this.delta, this.rotation);
    }
    vec3.lerp(
      this.pose.positions[body.joint] as (typeof this.pose.positions)[number],
      this.basePositions[body.joint] as (typeof this.basePositions)[number],
      this.position,
      this.weight,
    );
    quat.slerp(
      this.pose.rotations[body.joint] as (typeof this.pose.rotations)[number],
      this.baseRotations[body.joint] as (typeof this.baseRotations)[number],
      this.rotation,
      this.weight,
    );
    this.pose.update(body.joint);
  }

  run(operation: 'restore' | 'capture' | 'prepare' | 'compose'): void {
    if (this.status === 'disposed' || this.status === 'failed') return;
    try {
      this[operation]();
    } catch (cause) {
      const failure =
        cause instanceof SkeletalMotionError
          ? (cause as SkeletalMotionFailure)
          : new SkeletalMotionError('animation-motion-failed', {
              reason: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof AnimationBindingError || cause instanceof ManagedPhysicsError
                ? { cause: cause.code }
                : {}),
              recovery:
                cause instanceof AnimationBindingError &&
                cause.code !== 'animation-solver-write-failed'
                  ? 'rebind'
                  : cause instanceof ManagedPhysicsError &&
                      cause.code === 'managed-physics-failed' &&
                      cause.detail.recovery === 'old-state-retained'
                    ? 'rebind'
                    : 'rebuild-world',
            });
      if (
        cause instanceof AnimationBindingError &&
        cause.code === 'animation-solver-write-failed'
      ) {
        this.status = 'failed';
        this.failure = failure;
        throw cause; // Partial World writes must poison the enclosing ECS update.
      }
      this.status = 'failed';
      this.failure = failure;
      try {
        this.retire(false);
      } catch (cleanup) {
        this.status = 'failed';
        this.failure = new SkeletalMotionError('animation-motion-failed', {
          reason: `binding cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
          recovery: 'rebuild-world',
          ...(cleanup instanceof ManagedPhysicsError ? { cause: cleanup.code } : {}),
        });
        throw cleanup; // Unconfirmed native cleanup must fail the enclosing World update.
      }
      this.status = 'failed';
    }
  }
}

interface MotionOwner {
  readonly physics: boolean;
  readonly bindings: Map<EntityHandle, ManagedSkeletalMotion>;
  readonly poseReader: SkeletonTransformReader;
}

/** Current World-local Scene writers, including zero-weight and waiting-physics bindings.
 * Query before an external pose write; the detached snapshot is not a retained reservation.
 */
export function skeletalMotionWriterEntities(world: World): readonly EntityHandle[] {
  if (!world.hasResource(RESOURCE)) return [];
  const owner = world.getResource<MotionOwner>(RESOURCE);
  return [...new Set([...owner.bindings.values()].flatMap((binding) => binding.writerEntities))];
}

export function bindSkeletalMotion(
  world: World,
  player: EntityHandle,
  definition: SkeletalMotionDefinition,
): Result<SkeletalMotionBinding, SkeletalMotionFailure> {
  const valid = validateSkeletalMotionDefinition(definition);
  if (!valid.ok) return valid;
  if (!world.hasResource(RESOURCE))
    return err(
      new SkeletalMotionError('animation-motion-unavailable', {
        reason: 'install skeletalMotionPlugin and fixed animation playback first',
      }),
    );
  const owner = world.getResource<MotionOwner>(RESOURCE);
  if (definition.physical && !owner.physics)
    return err(
      new SkeletalMotionError('animation-motion-unavailable', {
        reason: 'physical definitions require skeletalMotionPlugin({ physics: true })',
      }),
    );
  if (
    !world
      .scheduleData()
      .some(
        (scope) =>
          scope.name === 'FixedUpdate' &&
          scope.systems.some((system) => system.name === 'advanceAnimationPlayer'),
      )
  )
    return err(
      new SkeletalMotionError('animation-motion-unavailable', {
        reason: 'motion requires animation playback in FixedUpdate',
      }),
    );
  const previous = owner.bindings.get(player);
  if (previous && previous.status !== 'disposed' && previous.status !== 'failed')
    return err(
      new SkeletalMotionError('animation-motion-conflict', {
        target: String(player),
        reason: 'one motion binding per player; dispose before rebinding',
      }),
    );
  try {
    // Own a detached immutable authored snapshot, including plain JSON transport inputs.
    const owned = JSON.parse(JSON.stringify(definition)) as SkeletalMotionDefinition;
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(owned);
    const binding = new ManagedSkeletalMotion(world, player, owned, owner.poseReader);
    owner.bindings.set(player, binding);
    return ok(binding);
  } catch (cause) {
    if (cause instanceof SkeletalMotionError) return err(cause as SkeletalMotionFailure);
    if (cause instanceof AnimationBindingError)
      return err(
        new SkeletalMotionError('animation-motion-failed', {
          reason: cause.message,
          cause: cause.code,
          recovery: 'rebind',
        }),
      );
    throw cause;
  }
}

/** Install once in the same realm as fixed animation, Scene and optional Physics. */
export function skeletalMotionPlugin(options: { readonly physics?: boolean } = {}): Plugin {
  return {
    name: 'skeletal-motion',
    inject: options.physics ? ['world', 'physics'] : ['world'],
    apply(ctx) {
      ctx.effect(() => {
        const world = ctx.world;
        if (world.hasResource(RESOURCE))
          throw new SkeletalMotionError('animation-motion-conflict', {
            target: RESOURCE,
            reason: 'owner already installed',
          });
        const owner: MotionOwner = {
          physics: options.physics === true,
          bindings: new Map(),
          poseReader: new SkeletonTransformReader(world),
        };
        const run = (operation: 'restore' | 'capture' | 'prepare' | 'compose') => () => {
          const readsPose = operation === 'restore' || operation === 'capture';
          if (readsPose) owner.poseReader.refresh();
          for (const [player, binding] of owner.bindings) {
            if (!world.get(player, Entity).ok) binding.dispose();
            binding.run(operation);
            const retired = binding.status === 'disposed' || binding.status === 'failed';
            if (retired) {
              owner.bindings.delete(player);
              if (readsPose) owner.poseReader.refresh();
            }
          }
        };
        world.insertResource(RESOURCE, owner);
        const names: string[] = [];
        try {
          const systems = [
            {
              name: RESTORE_SKELETAL_MOTION_BASE,
              before: ['evaluateAnimationGraph', 'advanceAnimationPlayer'],
              fn: run('restore'),
            },
            {
              name: CAPTURE_SKELETAL_MOTION_BASE,
              after: ['advanceAnimationPlayer'],
              before: ['propagateTransformsFixed'],
              fn: run('capture'),
            },
            {
              name: PREPARE_SKELETAL_MOTION_JOINTS,
              after: ['physicsSyncBackend'],
              before: ['physicsStepSimulation'],
              fn: run('prepare'),
            },
            { name: COMPOSE_SKELETAL_MOTION, after: ['physicsWriteback'], fn: run('compose') },
          ];
          // Spring-only worlds use the same pose cadence without requiring a physics backend.
          const hasPhysicalSystems = options.physics === true;
          for (const system of systems) {
            if (!hasPhysicalSystems && system.name === PREPARE_SKELETAL_MOTION_JOINTS) continue;
            const registered =
              system.name === COMPOSE_SKELETAL_MOTION && !hasPhysicalSystems
                ? { ...system, after: [CAPTURE_SKELETAL_MOTION_BASE] }
                : system;
            world.addSystem(FixedUpdate, { ...registered, queries: [] }).unwrap();
            names.push(system.name);
          }
          world
            .addSystem(Update, {
              name: 'presentSkeletalMotion',
              queries: [],
              after: [FixedUpdate],
              before: ['propagateTransforms'],
              fn: () => {},
            })
            .unwrap();
        } catch (cause) {
          for (const name of names.reverse()) world.removeSystem(FixedUpdate, name);
          world.removeResource(RESOURCE);
          throw cause;
        }
        return () => {
          for (const binding of owner.bindings.values()) binding.dispose();
          owner.bindings.clear();
          world.removeSystem(Update, 'presentSkeletalMotion');
          for (const name of names.reverse()) world.removeSystem(FixedUpdate, name);
          world.removeResource(RESOURCE);
        };
      }, 'skeletal-motion/runtime');
    },
  };
}
