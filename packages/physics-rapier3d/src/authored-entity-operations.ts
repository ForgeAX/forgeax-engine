import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { type Vec3, vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  type CharacterControllerData,
  Collider,
  ColliderShapeValue,
  type ColliderSnapshot,
  colliderShapeFromF32,
  type MoveAndSlideOptions,
  RigidBody,
  RigidBodyTypeValue,
  rigidBodyTypeFromF32,
  validateAdditionalSolverIterations,
} from '@forgeax/engine-physics';
import type { RigidBodyType } from '@forgeax/engine-types';
import type { ColliderDesc, Collider as RapierCollider } from '../pkg/rapier.mjs';
import { localPositionForWorld3D, translateAttachedColliders3D } from './body-pose.js';
import { applyKccTuning } from './character-controller-tuning.js';
import { requireCharacterBody } from './character-motion.js';
import type { DerivedBodyRecord } from './derived-candidate-records.js';
import type { RapierRigidBody, RapierWorld } from './physics-entity-records.js';
import {
  type PhysicsSyncDescriptor,
  type PhysicsSyncQueryRow,
  type PhysicsSyncState,
  type PhysicsTransform3D,
  physicsRowIsStatic,
  readPhysicsSyncDescriptor,
  sameColliderScale,
  samePhysicsValue,
} from './physics-sync-descriptor.js';
import type { RapierPhysicsWorld3D } from './rapier-physics-world-3d.js';
import type { SharedCollisionGeometry } from './shared-collision-geometry.js';
import type { SourceOwnedTypeRejection } from './source-owned-shape.js';
import type { Rapier3DModule } from './wasm-loader.js';

export function runComputeMove(
  rapierModule: Rapier3DModule,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  readCharacterController: (entity: number) => CharacterControllerData,
  ensureKcc: (
    entity: number,
    offset: number,
  ) => ReturnType<RapierPhysicsWorld3D['kccCache']['get']>,
  readRaw: () => RapierWorld,
  isolationColliderOwners: Map<number, number>,
  colliderPairIsolated: (a: number, b: number) => boolean,
  readMoveContext: () => { world: World; transform: Component } | undefined,
  entity: number,
  desiredDelta: Vec3,
  options: MoveAndSlideOptions | undefined,
  deltaTime: number | undefined,
): Vec3 {
  const RAPIER = rapierModule;
  const body = requireCharacterBody(entity, bodyForEntity(entity), RAPIER);
  const collider = body.collider(0); // D-4: zero-schema reverse lookup

  // ── Read CharacterController tuning + lazily build/configure the KCC ──
  const cc = readCharacterController(entity);
  const ctrl = ensureKcc(entity, cc.offset);
  applyKccTuning(ctrl, cc);
  if (deltaTime === 0 || options?.applyImpulsesToDynamicBodies === false)
    ctrl.setApplyImpulsesToDynamicBodies(false);

  const delta = { x: desiredDelta[0] ?? 0, y: desiredDelta[1] ?? 0, z: desiredDelta[2] ?? 0 };
  // The KCC consumes producer time synchronously under the native-execution
  // guard. Default live calls leave its World timestep untouched.
  const timestep = deltaTime === undefined ? 0 : readRaw().timestep;
  try {
    if (deltaTime !== undefined) readRaw().timestep = deltaTime;
    ctrl.computeColliderMovement(
      collider,
      delta,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      collider.collisionGroups(),
      // biome-ignore lint/suspicious/noExplicitAny: Rapier Collider in filter predicate
      (other: any) =>
        isolationColliderOwners.get(other.handle) !== entity &&
        !colliderPairIsolated(collider.handle, other.handle),
    );
  } finally {
    if (deltaTime !== undefined) readRaw().timestep = timestep;
  }

  // ── Step 2/3: read corrected movement + grounded ──
  const movement = ctrl.computedMovement() as { x: number; y: number; z: number };
  const grounded = ctrl.computedGrounded() as boolean;

  // ── Write back: push the kinematic body + ECS Transform + grounded ──
  const t = body.translation();
  const next = { x: t.x + movement.x, y: t.y + movement.y, z: t.z + movement.z };
  // setNextKinematicTranslation feeds the physics step pipeline; setTranslation
  // advances the body + its collider immediately so consecutive moveAndSlide
  // calls (without an intervening world.step) see the updated pose for the next
  // collision solve + grounded check. The query structures are refreshed so the
  // next computeColliderMovement reads the new position.
  body.setNextKinematicTranslation(next);
  body.setTranslation(next, true);
  // Translation-only KCC motion preserves each collider's parent-local pose.
  // Update this body's colliders directly instead of repeatedly propagating
  // the accumulating modified-body roster for every character in the frame.
  translateAttachedColliders3D(body, movement);

  const ctx = readMoveContext();
  if (ctx) {
    // D-6: writeback Result ignored — entry checks already guard liveness.
    ctx.world
      .set(entity as EntityHandle, ctx.transform, {
        pos: localPositionForWorld3D(ctx.world, entity as EntityHandle, next),
      })
      .unwrap();
    // An unchanged flag skips the checked write; the row already holds `grounded`.
    if (cc.grounded !== grounded)
      ctx.world.set(entity as EntityHandle, CharacterController, { grounded });
  }

  return vec3.create(movement.x, movement.y, movement.z);
}

export function runReconcilePhysicsEntity(
  removeEntity: (entity: number) => void,
  reconcileTransformlessCompatibility: (entity: number, staticByEcs: boolean) => void,
  hasBody: (entity: number) => boolean,
  syncAuthoredEcsMutation: (
    entity: number,
    descriptor: PhysicsSyncDescriptor,
    sourceOwnedTypeRejections: SourceOwnedTypeRejection[],
  ) => PhysicsSyncDescriptor,
  ensureBody: (
    entity: number,
    transform: PhysicsTransform3D,
    rigidBody: {
      type: number;
      mass: number;
      linearDamping: number;
      angularDamping: number;
      gravityScale: number;
      ccdEnabled: number;
      lockRotation?: boolean;
      additionalSolverIterations?: number;
    },
    collider: ColliderSnapshot | undefined,
  ) => void,
  kccOffsets: Map<number, number>,
  kccCache: RapierPhysicsWorld3D['kccCache'],
  removeKccController: (entity: number) => void,
  ensureKcc: (
    entity: number,
    offset: number,
  ) => ReturnType<RapierPhysicsWorld3D['kccCache']['get']>,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  syncAuthoredPose: (
    entity: number,
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot | undefined,
    bodyType: 'static' | 'kinematic',
  ) => void,
  solverAuthoredPoseChanges: Set<number>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  motionReadback: import('./body-motion-readback.js').BodyMotionReadback,
  state: PhysicsSyncState,
  entity: EntityHandle,
  previous: PhysicsSyncDescriptor | undefined,
  sourceOwnedTypeRejections: SourceOwnedTypeRejection[],
): PhysicsSyncDescriptor | undefined {
  let row: PhysicsSyncQueryRow | undefined;
  for (const query of state.queries) {
    row = query.at(entity);
    if (row !== undefined) break;
  }
  if (row === undefined) {
    removeEntity(entity);
    return;
  }
  if (!row.has(state.transformComponent)) {
    // A lifecycle mutation cannot be applied without a pose. Keep only the
    // narrow migration case where Transform alone disappeared from an already
    // committed fixed body; never create or reshape a Transform-less row.
    if (state.projection.changed(entity, Collider) || state.projection.changed(entity, RigidBody)) {
      removeEntity(entity);
      return;
    }
    reconcileTransformlessCompatibility(entity, physicsRowIsStatic(row));
    return hasBody(entity) ? previous : undefined;
  }

  let descriptor = readPhysicsSyncDescriptor(row, state, previous);
  if (descriptor === undefined) {
    removeEntity(entity);
    return;
  }

  // Keep the accepted native scale as the tolerance baseline. A sequence of
  // small authored edits must accumulate until it changes actual geometry.
  if (
    previous !== undefined &&
    (descriptor.collider?.shape === ColliderShapeValue.convexHull ||
      descriptor.collider?.shape === ColliderShapeValue.trimesh) &&
    sameColliderScale(previous.transform.scale, descriptor.transform.scale)
  ) {
    descriptor = {
      ...descriptor,
      transform: { ...descriptor.transform, scale: previous.transform.scale },
    };
  }

  const colliderChanged =
    !samePhysicsValue(previous?.collider, descriptor.collider) ||
    // Scale changes geometry even when Rapier owns a dynamic body's pose.
    ((descriptor.collider?.shape === ColliderShapeValue.convexHull ||
      descriptor.collider?.shape === ColliderShapeValue.trimesh) &&
      !sameColliderScale(previous?.transform.scale, descriptor.transform.scale));
  if (
    hasBody(entity) &&
    (colliderChanged || !samePhysicsValue(previous?.rigidBody, descriptor.rigidBody))
  ) {
    // Authored properties share one native-body mutation path with derived
    // shapes, preserving motion and joint identity through ordinary edits.
    descriptor = syncAuthoredEcsMutation(entity, descriptor, sourceOwnedTypeRejections);
  }
  if (!hasBody(entity)) {
    ensureBody(entity, descriptor.transform, descriptor.rigidBody, descriptor.collider);
    return descriptor;
  }

  return reconcileExistingPhysicsEntity(
    kccOffsets,
    kccCache,
    removeKccController,
    ensureKcc,
    derivedBodies,
    syncAuthoredPose,
    solverAuthoredPoseChanges,
    bodyForEntity,
    motionReadback,
    entity,
    previous,
    descriptor,
  );
}

export function runSyncAuthoredEcsMutation(
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  rapierModule: Rapier3DModule,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  rememberSourceOwnedTypeRefusal: (
    entity: number,
    committed: DerivedBodyRecord,
    requestedType: number,
    normalizationFailure?: unknown,
  ) => void,
  authoredColliderDesc: (
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot,
    bodyType: RigidBodyType,
  ) => ColliderDesc,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  createAuthoredCollider: (
    desc: ColliderDesc,
    body: RapierRigidBody,
    collider: ColliderSnapshot,
  ) => RapierCollider,
  syncIsolationCollider: (collider: RapierCollider, entity: number) => void,
  derivedColliderToShape: Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >,
  terrainColliders: Map<number, { asset: number; collider: number; body: number }>,
  retiredColliderOwners: Map<number, number>,
  isolationColliderOwners: Map<number, number>,
  readRaw: () => RapierWorld,
  readSharedGeometry: () => SharedCollisionGeometry | undefined,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  retireRemovedColliderPairs: (entity: number) => void,
  syncAuthoredPose: (
    entity: number,
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot | undefined,
    bodyType: 'static' | 'kinematic',
  ) => void,
  restoreAutomaticMass: (body: RapierRigidBody, additionalMass: number) => void,
  syncRotationLock: (entity: number, body: RapierRigidBody, locked: boolean) => void,
  restoreCommittedMass: (
    body: RapierRigidBody,
    previous: DerivedBodyRecord | undefined,
    automaticAdditionalMass: number,
  ) => void,
  entity: number,
  descriptor: PhysicsSyncDescriptor,
  sourceOwnedTypeRejections: SourceOwnedTypeRejection[],
): PhysicsSyncDescriptor {
  const body = bodyForEntity(entity);
  if (body === undefined) return descriptor;
  const RAPIER = rapierModule as RapierWorld;
  const committed = derivedBodies.get(entity);
  const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
  if (committed?.sourceTransform !== undefined && bodyType !== 'static') {
    body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    sourceOwnedTypeRejections.push({
      entity: entity as EntityHandle,
      candidateId: committed.candidateId,
      revision: committed.revision,
      requestedType: descriptor.rigidBody.type,
    });
    rememberSourceOwnedTypeRefusal(entity, committed, descriptor.rigidBody.type);
    // The rest of this sync pass must use the accepted pose owner too. In
    // particular, a simultaneous Transform write cannot enqueue a kinematic
    // target or make the fixed source body eligible for dynamic writeback.
    return {
      ...descriptor,
      rigidBody: { ...descriptor.rigidBody, type: RigidBodyTypeValue.static },
    };
  }
  const solverIterations = validateAdditionalSolverIterations(
    descriptor.rigidBody.additionalSolverIterations ?? 0,
  );
  const prepared =
    descriptor.collider === undefined
      ? undefined
      : authoredColliderDesc(descriptor.transform, descriptor.collider, bodyType);
  // The native body is shared, but authored and derived colliders have
  // distinct owners. Never address an authored collider by array position.
  const oldColliders = bodyColliders(body);
  if (prepared !== undefined && descriptor.collider !== undefined) {
    const collider = createAuthoredCollider(
      prepared.setDensity(
        committed?.massProperties?.mode === 'explicit' ? 0 : descriptor.collider.density,
      ),
      body,
      descriptor.collider,
    );
    syncIsolationCollider(collider, entity);
  }
  const retireAuthoredColliders = () => {
    let removedAuthoredCollider = false;
    for (const collider of oldColliders) {
      if (
        !derivedColliderToShape.has(collider.handle) &&
        terrainColliders.get(entity)?.collider !== collider.handle
      ) {
        retiredColliderOwners.set(collider.handle, entity);
        isolationColliderOwners.delete(collider.handle);
        (readRaw() as RapierWorld).removeCollider(collider, true);
        readSharedGeometry()?.detach(collider.handle);
        removedAuthoredCollider = true;
      }
    }
    return removedAuthoredCollider;
  };
  const removedAuthoredCollider = retireAuthoredColliders();
  const record = entityMap.get(entity);
  if (record !== undefined) record.authoredDensity = descriptor.collider?.density;
  if (descriptor.collider === undefined && removedAuthoredCollider) {
    retireRemovedColliderPairs(entity);
  }
  const synchronizeAuthoredBodyType = () => {
    if (bodyType === 'static') {
      body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      if (committed?.sourceTransform === undefined)
        syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'static');
    } else if (bodyType === 'kinematic') {
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'kinematic');
    } else {
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      if (record !== undefined) record.additionalMass = Math.max(0, descriptor.rigidBody.mass);
      if (committed?.massProperties?.mode !== 'explicit') {
        restoreAutomaticMass(body, record?.additionalMass ?? 0);
        if (record !== undefined) record.automaticAdditionalMass = record.additionalMass;
      }
      body.setGravityScale(descriptor.rigidBody.gravityScale, true);
      body.setLinearDamping(descriptor.rigidBody.linearDamping);
      body.setAngularDamping(descriptor.rigidBody.angularDamping);
    }
  };
  synchronizeAuthoredBodyType();
  body.setAdditionalSolverIterations(solverIterations);
  body.enableCcd(Boolean(descriptor.rigidBody.ccdEnabled));
  syncRotationLock(entity, body, Boolean(descriptor.rigidBody.lockRotation));
  if (committed?.massProperties?.mode === 'explicit') {
    restoreCommittedMass(body, committed, 0);
  }
  if (record !== undefined && committed?.sourceTransform === undefined)
    record.scale = Object.freeze([
      Math.abs(descriptor.transform.scale.x),
      Math.abs(descriptor.transform.scale.y),
      Math.abs(descriptor.transform.scale.z),
    ]);
  return descriptor;
}

export function runEnsureBody(
  assertActive: (operation: string) => void,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  rapierModule: Rapier3DModule,
  authoredColliderDesc: (
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot,
    bodyType: RigidBodyType,
  ) => ColliderDesc,
  readRaw: () => RapierWorld,
  registerBody: (
    entity: number,
    bodyHandle: number,
    additionalMass?: number,
    authoredDensity?: number,
  ) => void,
  syncRotationLock: (entity: number, body: RapierRigidBody, locked: boolean) => void,
  createAuthoredCollider: (
    desc: ColliderDesc,
    body: RapierRigidBody,
    collider: ColliderSnapshot,
  ) => RapierCollider,
  syncIsolationCollider: (collider: RapierCollider, entity: number) => void,
  removeEntity: (entity: number) => void,
  restoreAutomaticMass: (body: RapierRigidBody, additionalMass: number) => void,
  entity: number,
  transform: PhysicsTransform3D,
  rigidBody: {
    type: number;
    mass: number;
    linearDamping: number;
    angularDamping: number;
    gravityScale: number;
    ccdEnabled: number;
    lockRotation?: boolean;
    additionalSolverIterations?: number;
  },
  collider: ColliderSnapshot | undefined,
): void {
  assertActive('ensureBody');
  const solverIterations = validateAdditionalSolverIterations(
    rigidBody.additionalSolverIterations ?? 0,
  );
  if (entityMap.has(entity)) return; // M1 idempotent guard (D-2)
  const RAPIER = rapierModule;
  // ── Create RigidBodyDesc ──
  const rbType = rigidBodyTypeFromF32(rigidBody.type);
  const prepared =
    collider === undefined ? undefined : authoredColliderDesc(transform, collider, rbType);
  let body: RapierRigidBody;
  switch (rbType) {
    case 'dynamic': {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
      const desc = (RAPIER as any).RigidBodyDesc.dynamic()
        .setTranslation(transform.position.x, transform.position.y, transform.position.z)
        .setRotation(transform.rotation)
        .setLinearDamping(rigidBody.linearDamping)
        .setAngularDamping(rigidBody.angularDamping)
        .setGravityScale(rigidBody.gravityScale);
      if (rigidBody.mass > 0) {
        desc.setAdditionalMass(rigidBody.mass);
      }
      if (rigidBody.ccdEnabled) {
        desc.setCcdEnabled(true);
      }
      // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
      body = (readRaw() as any).createRigidBody(desc);
      break;
    }
    case 'static': {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
      const desc = (RAPIER as any).RigidBodyDesc.fixed()
        .setTranslation(transform.position.x, transform.position.y, transform.position.z)
        .setRotation(transform.rotation);
      // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
      body = (readRaw() as any).createRigidBody(desc);
      break;
    }
    case 'kinematic': {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
      const desc = (RAPIER as any).RigidBodyDesc.kinematicPositionBased()
        .setTranslation(transform.position.x, transform.position.y, transform.position.z)
        .setRotation(transform.rotation);
      // CCD sweeps the collider along its per-step kinematic translation so a
      // fast mover (player, bullet) reliably contacts dynamics instead of
      // tunneling through them on discrete steps.
      if (rigidBody.ccdEnabled) {
        desc.setCcdEnabled(true);
      }
      // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
      body = (readRaw() as any).createRigidBody(desc);
      break;
    }
    // No default — rigidBodyTypeFromF32 ensures only 3 arms; TS guards completeness.
  }
  body.setAdditionalSolverIterations(solverIterations);
  body.userData = entity;
  registerBody(
    entity,
    body.handle,
    rbType === 'dynamic' ? Math.max(0, rigidBody.mass) : 0,
    collider?.density,
  );
  syncRotationLock(entity, body, Boolean(rigidBody.lockRotation));
  if (prepared !== undefined && collider !== undefined) {
    try {
      const nativeCollider = createAuthoredCollider(prepared, body, collider);
      syncIsolationCollider(nativeCollider, entity);
    } catch (cause) {
      removeEntity(entity);
      throw cause;
    }
  }
  // Rapier defers descriptor additional mass, including when a collider is
  // already attached. Same-step impulses and derived admission must both see
  // the complete authored mass as soon as synchronization publishes the body.
  const record = entityMap.get(entity);
  restoreAutomaticMass(body, record?.additionalMass ?? 0);
  if (record !== undefined) {
    record.automaticAdditionalMass = record.additionalMass;
    record.scale = Object.freeze([
      Math.abs(transform.scale.x),
      Math.abs(transform.scale.y),
      Math.abs(transform.scale.z),
    ]);
  }
}

export function runSyncAuthoredPose(
  assertActive: (operation: string) => void,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  readRaw: () => RapierWorld,
  motionReadback: import('./body-motion-readback.js').BodyMotionReadback,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  derivedColliderToShape: Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >,
  terrainColliders: Map<number, { asset: number; collider: number; body: number }>,
  entity: number,
  transform: PhysicsTransform3D,
  collider: ColliderSnapshot | undefined,
  bodyType: 'static' | 'kinematic',
): void {
  assertActive('syncAuthoredPose');
  const record = entityMap.get(entity);
  if (!record) return;
  // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
  const body = (readRaw() as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
  if (!body) return;
  if (bodyType === 'static') {
    body.setTranslation(transform.position, true);
    body.setRotation(transform.rotation, true);
  } else {
    body.setNextKinematicTranslation(transform.position);
    body.setNextKinematicRotation(transform.rotation);
  }
  motionReadback.enroll(entity, true);
  motionReadback.notify(entity);
  const scaleX = Math.abs(transform.scale.x);
  const scaleY = Math.abs(transform.scale.y);
  const scaleZ = Math.abs(transform.scale.z);
  record.scale = Object.freeze([scaleX, scaleY, scaleZ]);
  if (collider === undefined) return;
  const rapierCollider = bodyColliders(body).find(
    (shape) =>
      !derivedColliderToShape.has(shape.handle) &&
      terrainColliders.get(entity)?.collider !== shape.handle,
  );
  if (!rapierCollider) return;
  switch (colliderShapeFromF32(collider.shape)) {
    case 'cuboid': {
      const x = Math.fround(collider.halfExtents[0] * scaleX);
      const y = Math.fround(collider.halfExtents[1] * scaleY);
      const z = Math.fround(collider.halfExtents[2] * scaleZ);
      const current = rapierCollider.halfExtents();
      if (current?.x !== x || current.y !== y || current.z !== z)
        rapierCollider.setHalfExtents({ x, y, z });
      break;
    }
    case 'sphere': {
      const radius = Math.fround(collider.radius * Math.max(scaleX, scaleY, scaleZ));
      if (rapierCollider.radius() !== radius) rapierCollider.setRadius(radius);
      break;
    }
    case 'cone':
    case 'cylinder':
    case 'capsule': {
      const halfHeight = Math.fround(collider.halfHeight * scaleY);
      const radius = Math.fround(collider.radius * Math.max(scaleX, scaleZ));
      if (rapierCollider.halfHeight() !== halfHeight) rapierCollider.setHalfHeight(halfHeight);
      if (rapierCollider.radius() !== radius) rapierCollider.setRadius(radius);
      break;
    }
    case 'convexHull':
    case 'trimesh':
      // Source and scale changes use the same staged authored replacement above.
      break;
  }
}

function reconcileExistingPhysicsEntity(
  kccOffsets: Map<number, number>,
  kccCache: RapierPhysicsWorld3D['kccCache'],
  removeKccController: (entity: number) => void,
  ensureKcc: (
    entity: number,
    offset: number,
  ) => ReturnType<RapierPhysicsWorld3D['kccCache']['get']>,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  syncAuthoredPose: (
    entity: number,
    transform: PhysicsTransform3D,
    collider: ColliderSnapshot | undefined,
    bodyType: 'static' | 'kinematic',
  ) => void,
  solverAuthoredPoseChanges: Set<number>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  motionReadback: import('./body-motion-readback.js').BodyMotionReadback,
  entity: EntityHandle,
  previous: PhysicsSyncDescriptor | undefined,
  descriptor: PhysicsSyncDescriptor,
): PhysicsSyncDescriptor | undefined {
  const reconcileCharacterController = () => {
    if (
      previous?.characterControllerOffset !== descriptor.characterControllerOffset ||
      previous?.hasCharacterController !== descriptor.hasCharacterController
    ) {
      const cachedOffset = kccOffsets.get(entity);
      const hadCachedReceipt = kccCache.has(entity);
      const finalOffset = descriptor.characterControllerOffset;
      if (!descriptor.hasCharacterController) {
        removeKccController(entity);
      } else if (
        hadCachedReceipt &&
        (finalOffset === undefined || !Object.is(cachedOffset, finalOffset))
      ) {
        // Component removal is structural and reaches the full reconcile path.
        // A value change only rebuilds the receipt when its effective offset changed.
        removeKccController(entity);
        if (finalOffset !== undefined) ensureKcc(entity, finalOffset);
      }
    }
  };
  reconcileCharacterController();
  if (
    samePhysicsValue(previous?.transform, descriptor.transform) &&
    !(previous?.hasCharacterController && !descriptor.hasCharacterController)
  ) {
    return descriptor;
  }

  // Translation and rotation do not change primitive geometry. Rewriting the
  // dimensions marks Rapier's shape dirty and discards retained contact work.
  const scaledCollider = samePhysicsValue(previous?.transform.scale, descriptor.transform.scale)
    ? undefined
    : descriptor.collider;
  const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
  if (bodyType === 'static') {
    if (derivedBodies.get(entity)?.sourceTransform === undefined)
      syncAuthoredPose(entity, descriptor.transform, scaledCollider, 'static');
  } else if (bodyType === 'kinematic' && !descriptor.hasCharacterController) {
    syncAuthoredPose(entity, descriptor.transform, scaledCollider, 'kinematic');
  } else if (bodyType === 'dynamic') {
    if (solverAuthoredPoseChanges.delete(entity)) {
      const body = bodyForEntity(entity);
      body?.setTranslation(descriptor.transform.position, true);
      body?.setRotation(descriptor.transform.rotation, true);
    }
    motionReadback.enroll(entity);
  }
  return descriptor;
}
