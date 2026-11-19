import { Entity, type EntityHandle, FixedTime, type World } from '@forgeax/engine-ecs';
import { type Vec3, vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  type CharacterSynchronization,
  ColliderShapeValue,
  type ColliderSnapshot,
  colliderShapeFromF32,
  type DerivedPhysicsCandidateInput,
  DerivedPhysicsError,
  finitePhysicsVector,
  type NativePhysicsStepTiming,
  type PhysicsBodyDynamics,
  type PhysicsBodyObbQuery,
  type PhysicsColliderPrimitives,
  type PhysicsContactObservation,
  type PhysicsFixedError,
  type PhysicsSensorOverlap,
  type PhysicsSensorOverlaps,
  type PhysicsSweepError,
  type PhysicsVector,
  type RaycastHit,
  type RaycastOptions,
  RigidBody,
  RigidBodyTypeValue,
  type SphereSweepHit,
} from '@forgeax/engine-physics';
import { err, ok, type Result, type RigidBodyType } from '@forgeax/engine-types';
import type { ColliderDesc, Collider as RapierCollider } from '../pkg/rapier.mjs';
import { characterSynchronizationSource } from './character-motion.js';
import {
  aggregateColliderCount,
  intersectsBodyObb,
  readColliderPrimitives,
  validBodyObbQuery,
} from './collider-primitives.js';
import { retainedDerivedGeometryCurrent } from './derived-body-type.js';
import {
  type DerivedBodyRecord,
  type DerivedBodySource,
  type DerivedCandidateRecord,
  derivedShapeHandles,
} from './derived-candidate-records.js';
import type {
  IsolatedPair,
  Rapier3DCollisionEvent,
  RapierEventQueue,
  RapierRigidBody,
  RapierWorld,
} from './physics-entity-records.js';
import {
  hasZeroColliderScale,
  type PhysicsSyncDescriptor,
  type PhysicsSyncState,
  type PhysicsTransform3D,
} from './physics-sync-descriptor.js';
import type { SharedCollisionGeometry } from './shared-collision-geometry.js';
import type { SourceOwnedTypeRejection } from './source-owned-shape.js';
import type { Rapier3DModule } from './wasm-loader.js';

export function runPublishNativeStepTiming(
  nativeStepTimingEnabled: boolean,
  nativeStepTimingListeners: Set<
    (timing: import('@forgeax/engine-physics').NativePhysicsStepTiming) => void
  >,
  readRaw: () => RapierWorld,
  readSyncState: () => PhysicsSyncState | undefined,
  readFixedStep: () => number,
  deltaSeconds: number,
  nativeStepIndex: number,
): void {
  if (!nativeStepTimingEnabled || nativeStepTimingListeners.size === 0) return;
  const raw = readRaw();
  let timing: NativePhysicsStepTiming;
  try {
    timing = Object.freeze({
      nativeStepIndex,
      fixedStep: readSyncState()?.world.getResource(FixedTime).tick ?? readFixedStep() + 1,
      deltaSeconds,
      timingMs: Object.freeze({
        step: raw.timingStep(),
        userChanges: raw.timingUserChanges(),
        islandConstruction: raw.timingIslandConstruction(),
        broadPhase: raw.timingBroadPhase(),
        narrowPhase: raw.timingNarrowPhase(),
        collisionDetection: raw.timingCollisionDetection(),
        solver: raw.timingSolver(),
        velocityAssembly: raw.timingVelocityAssembly(),
        velocityResolution: raw.timingVelocityResolution(),
        velocityUpdate: raw.timingVelocityUpdate(),
        velocityWriteback: raw.timingVelocityWriteback(),
        ccd: raw.timingCcd(),
        ccdToiComputation: raw.timingCcdToiComputation(),
        ccdBroadPhase: raw.timingCcdBroadPhase(),
        ccdNarrowPhase: raw.timingCcdNarrowPhase(),
        ccdSolver: raw.timingCcdSolver(),
      }),
    });
  } catch {
    // A broken diagnostic getter cannot turn an already successful native step into failure.
    return;
  }
  const listeners = [...nativeStepTimingListeners];
  for (const listener of listeners) {
    try {
      listener(timing);
    } catch {
      // Diagnostics must never fail or poison an otherwise completed solve.
    }
  }
}

export function runPreparePairIsolation(
  readWorldIdentity: () => World | undefined,
  isolatedPairs: Map<string, import('./physics-entity-records.js').IsolatedPair>,
  readBackendGeneration: () => number,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  retireIsolatedPair: (key: string, pair: IsolatedPair) => void,
  dirtyPairPolicies: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  readRaw: () => RapierWorld,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  syncIsolationCollider: (collider: RapierCollider, entity: number) => void,
  refreshContacts: boolean,
): void {
  const world = readWorldIdentity();
  for (const [key, pair] of isolatedPairs) {
    if (
      pair.input.worldIdentity !== world ||
      pair.generation !== readBackendGeneration() ||
      entityMap.get(pair.input.entityA) !== pair.bodyA ||
      entityMap.get(pair.input.entityB) !== pair.bodyB ||
      world === undefined ||
      !world.hasComponent(pair.input.entityA as EntityHandle, Entity) ||
      !world.hasComponent(pair.input.entityB as EntityHandle, Entity)
    )
      retireIsolatedPair(key, pair);
  }
  if (!refreshContacts) return;
  for (const [entity, record] of dirtyPairPolicies) {
    if (entityMap.get(entity) !== record) {
      dirtyPairPolicies.delete(entity);
      continue;
    }
    const body = readRaw().getRigidBody(record.bodyHandle);
    if (body === undefined || body === null) continue;
    for (const collider of bodyColliders(body)) {
      syncIsolationCollider(collider, entity);
      if (collider.isEnabled()) {
        // Mark position dirty without changing geometry or authored groups.
        // Rapier reruns narrow-phase filters for this collider on the next step.
        collider.setTranslation(collider.translation());
      }
    }
    body.wakeUp();
    if (dirtyPairPolicies.get(entity) === record) dirtyPairPolicies.delete(entity);
  }
}

export function runRaycast(
  assertCommittedReadable: (operation: string) => void,
  recoveryBlocked: () => boolean,
  rapierModule: Rapier3DModule,
  readRaw: () => RapierWorld,
  origin: Vec3,
  direction: Vec3,
  maxDist: number,
  filterMask?: number,
  options?: RaycastOptions,
): RaycastHit | undefined {
  assertCommittedReadable('raycast');
  if (recoveryBlocked()) {
    throw new DerivedPhysicsError(
      'derived-recovery-invalid',
      'raycasts observe a complete healthy physics state',
      'rebuild the PhysicsWorld before querying after an unrecoverable admission',
      {},
    );
  }
  const excluded = options?.excludeEntities ? new Set(options.excludeEntities) : undefined;
  const RAPIER = rapierModule;
  // biome-ignore lint/suspicious/noExplicitAny: Rapier Ray constructor comes from a namespace module
  const RayCtor = (RAPIER as any).Ray as new (
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ) => { pointAt(t: number): { x: number; y: number; z: number } };
  const ray = new RayCtor(
    { x: origin[0] ?? 0, y: origin[1] ?? 0, z: origin[2] ?? 0 },
    { x: direction[0] ?? 0, y: direction[1] ?? 0, z: direction[2] ?? 0 },
  );
  // biome-ignore lint/suspicious/noExplicitAny: Rapier World castRayAndGetNormal
  const hit = (readRaw() as any).castRayAndGetNormal(
    ray,
    maxDist,
    true,
    undefined,
    filterMask,
    undefined,
    undefined,
    excluded
      ? (collider: RapierCollider) => {
          const parent = collider.parent();
          return parent === null || !excluded.has(parent.userData as number);
        }
      : undefined,
  ) as {
    collider: { parent(): { userData: number } | null };
    timeOfImpact: number;
    normal: { x: number; y: number; z: number };
  } | null;

  if (hit === null) return undefined;

  const point = ray.pointAt(hit.timeOfImpact);
  // `hit.collider.parent()` already returns the owning RigidBody OBJECT (compat
  // build), whose userData holds the ECS entity — read it directly, mirroring
  // `colliderHandleToEntity` (the proven CollidingEntities path). The prior code
  // treated the object as a body HANDLE and re-resolved it via `bodies.get(...)`,
  // which returned a DIFFERENT body → raycast reported the wrong entity.
  const colliderParentBody = hit.collider.parent();
  const entity = colliderParentBody !== null ? colliderParentBody.userData : 0;

  return {
    entity,
    point: vec3.create(point.x, point.y, point.z),
    normal: vec3.create(hit.normal.x, hit.normal.y, hit.normal.z),
    timeOfImpact: hit.timeOfImpact,
  };
}

export function runSweepSphereAll(
  readDisposed: () => boolean,
  recoveryBlocked: () => boolean,
  readNativeExecuting: () => boolean,
  readSolverPending: () => boolean,
  readActiveDerivedAdmission: () => DerivedCandidateRecord | undefined,
  rapierModule: Rapier3DModule,
  readRaw: () => RapierWorld,
  startM: Vec3,
  endM: Vec3,
  radiusM: number,
  filterMask?: number,
): Result<readonly SphereSweepHit[], PhysicsSweepError> {
  const invalid = (field: string, actual?: unknown): Result<never, PhysicsSweepError> =>
    err({
      code: 'sweep-input-invalid',
      expected:
        'finite 3D sphere endpoints, positive radius in meters and an unsigned packed collision mask',
      hint: 'repair the named sphere sweep input and retry',
      detail: { field, actual },
    });
  const startX = startM[0];
  const startY = startM[1];
  const startZ = startM[2];
  const endX = endM[0];
  const endY = endM[1];
  const endZ = endM[2];
  if (
    startM.length !== 3 ||
    startX === undefined ||
    startY === undefined ||
    startZ === undefined ||
    ![startX, startY, startZ].every(Number.isFinite)
  )
    return invalid('startM', Array.from(startM));
  if (
    endM.length !== 3 ||
    endX === undefined ||
    endY === undefined ||
    endZ === undefined ||
    ![endX, endY, endZ].every(Number.isFinite)
  )
    return invalid('endM', Array.from(endM));
  if (!Number.isFinite(radiusM) || radiusM <= 0) return invalid('radiusM', radiusM);
  if (
    filterMask !== undefined &&
    (!Number.isInteger(filterMask) || filterMask < 0 || filterMask > 0xffff_ffff)
  )
    return invalid('filterMask', filterMask);
  const refuseUnavailableSweep = (): Result<never, PhysicsSweepError> | undefined => {
    if (
      readDisposed() ||
      recoveryBlocked() ||
      (readNativeExecuting() && !readSolverPending()) ||
      readActiveDerivedAdmission() !== undefined
    )
      return err({
        code: 'sweep-unavailable',
        expected: 'a complete healthy physics state outside native execution and admission',
        hint: 'query after physics synchronization or rebuild a recovery-blocked PhysicsWorld',
        detail: { field: 'physicsState' },
      });
    return undefined;
  };
  const unavailableSweep = refuseUnavailableSweep();
  if (unavailableSweep !== undefined) return unavailableSweep;
  const sphere = new rapierModule.Ball(radiusM);
  const velocity = { x: endX - startX, y: endY - startY, z: endZ - startZ };
  const origin = { x: startX, y: startY, z: startZ };
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  const center = { x: (startX + endX) * 0.5, y: (startY + endY) * 0.5, z: (startZ + endZ) * 0.5 };
  const halfExtents = {
    x: Math.abs(velocity.x) * 0.5 + radiusM,
    y: Math.abs(velocity.y) * 0.5 + radiusM,
    z: Math.abs(velocity.z) * 0.5 + radiusM,
  };
  const hits: SphereSweepHit[] = [];
  // The swept sphere AABB includes starting overlaps and every linear TOI.
  readRaw().collidersWithAabbIntersectingAabb(center, halfExtents, (collider: RapierCollider) => {
    if (!collider.isEnabled()) return true;
    const groups = collider.collisionGroups() >>> 0;
    if (
      filterMask !== undefined &&
      (((groups >>> 16) & filterMask & 0xffff) === 0 ||
        ((filterMask >>> 16) & groups & 0xffff) === 0)
    )
      return true;
    const parent = collider.parent();
    if (parent === null || typeof parent.userData !== 'number') return true;
    const hit = collider.castShape(
      { x: 0, y: 0, z: 0 },
      sphere,
      origin,
      rotation,
      velocity,
      0,
      1,
      true,
    );
    if (hit === null) {
      // A stationary contained shape may have no cast TOI; native contact still
      // provides the exact starting overlap and world-space witness.
      const contact = collider.contactShape(sphere, origin, rotation, 0);
      if (contact !== null && contact.distance <= 0) {
        hits.push(
          Object.freeze({
            entity: parent.userData,
            colliderId: collider.handle,
            timeOfImpact: 0,
            point: vec3.create(contact.point1.x, contact.point1.y, contact.point1.z),
            normal: vec3.create(contact.normal1.x, contact.normal1.y, contact.normal1.z),
            initialOverlap: true,
          }),
        );
      }
      return true;
    }
    const toi = Math.min(1, Math.max(0, hit.time_of_impact));
    const q = collider.rotation();
    const rotate = (value: { x: number; y: number; z: number }) => {
      const tx = 2 * (q.y * value.z - q.z * value.y);
      const ty = 2 * (q.z * value.x - q.x * value.z);
      const tz = 2 * (q.x * value.y - q.y * value.x);
      return {
        x: value.x + q.w * tx + q.y * tz - q.z * ty,
        y: value.y + q.w * ty + q.z * tx - q.x * tz,
        z: value.z + q.w * tz + q.x * ty - q.y * tx,
      };
    };
    const normal = rotate(hit.normal1);
    const witness = rotate(hit.witness1);
    const translation = collider.translation();
    hits.push(
      Object.freeze({
        entity: parent.userData,
        colliderId: collider.handle,
        timeOfImpact: toi,
        point: vec3.create(
          witness.x + translation.x,
          witness.y + translation.y,
          witness.z + translation.z,
        ),
        normal: vec3.create(normal.x, normal.y, normal.z),
        initialOverlap: toi === 0,
      }),
    );
    return true;
  });
  hits.sort((a, b) => a.timeOfImpact - b.timeOfImpact || a.colliderId - b.colliderId);
  return ok(Object.freeze(hits));
}

export function runSynchronizeCharacter(
  assertActive: (operation: string) => void,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  readSyncState: () => PhysicsSyncState | undefined,
  rapierModule: Rapier3DModule,
  reconcilePhysicsEntity: (
    state: PhysicsSyncState,
    entity: EntityHandle,
    previous: PhysicsSyncDescriptor | undefined,
    sourceOwnedTypeRejections: SourceOwnedTypeRejection[],
  ) => PhysicsSyncDescriptor | undefined,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  rememberSourceOwnedTypeRefusal: (
    entity: number,
    committed: DerivedBodyRecord,
    requestedType: number,
    normalizationFailure?: unknown,
  ) => void,
  teleport: (entity: number, position: Vec3) => void,
  entity: number,
  character: CharacterSynchronization,
): void {
  assertActive('synchronizeCharacter');
  const { state, handle, index, previous } = characterSynchronizationSource(
    entity,
    character,
    bodyForEntity(entity),
    readSyncState(),
    rapierModule,
  );
  // Reuse the same single-entity owner as PhysicsSyncBackend. Do not accept
  // its global projection: other pending bodies still belong to normal sync.
  const sourceOwnedTypeRejections: SourceOwnedTypeRejection[] = [];
  const descriptor = reconcilePhysicsEntity(state, handle, previous, sourceOwnedTypeRejections);
  for (const rejection of sourceOwnedTypeRejections) {
    const normalized = state.world.set(rejection.entity, RigidBody, {
      type: RigidBodyTypeValue.static,
    });
    if (!normalized.ok) {
      const committed = derivedBodies.get(rejection.entity);
      if (committed?.candidateId === rejection.candidateId)
        rememberSourceOwnedTypeRefusal(
          rejection.entity,
          committed,
          rejection.requestedType,
          normalized.error,
        );
    }
  }
  if (descriptor) state.accepted.set(index, descriptor);
  teleport(entity, character.position);
  state.world.set(handle, CharacterController, { grounded: character.grounded }).unwrap();
}

export function runGetCommittedBodyDynamics(
  fixedOperationAvailable: (access?: 'read' | 'write') => boolean,
  fixedFailure: (
    entity: number,
    code: PhysicsFixedError['code'],
    reason: string,
    extra?: {
      expected?: number;
      actual?: number;
      recovery?: NonNullable<PhysicsFixedError['detail']['recovery']>;
    },
  ) => import('@forgeax/engine-types').ResultErr<
    import('@forgeax/engine-physics').PhysicsFixedError
  >,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  solverRetiredEntities: Set<number>,
  awaitingNativeBodySynchronization: (entity: number) => boolean,
  readFixedStep: () => number,
  readSyncState: () => PhysicsSyncState | undefined,
  entity: number,
): Result<PhysicsBodyDynamics, PhysicsFixedError> {
  if (!fixedOperationAvailable('read'))
    return fixedFailure(
      entity,
      'fixed-operation-unavailable',
      'native execution or admission is in progress',
    );
  const record = entityMap.get(entity),
    body = bodyForEntity(entity);
  if (!record || !body || solverRetiredEntities.has(entity)) {
    const pending =
      !record &&
      !body &&
      !solverRetiredEntities.has(entity) &&
      awaitingNativeBodySynchronization(entity);
    return fixedFailure(
      entity,
      'fixed-body-missing',
      pending ? 'new authored body has not synchronized' : 'body is missing or was retired',
      pending ? { recovery: 'await-native-sync' } : {},
    );
  }
  const tuple = (v: { x: number; y: number; z: number }): PhysicsVector =>
    Object.freeze([v.x, v.y, v.z]);
  const q = body.rotation();
  const iq = body.principalInertiaLocalFrame();
  return ok(
    Object.freeze({
      entity,
      generation: record.generation,
      completedStep: readFixedStep(),
      nextFixedStep: readSyncState()?.world.getResource(FixedTime).tick ?? readFixedStep() + 1,
      massKg: body.mass(),
      positionM: tuple(body.translation()),
      rotation: Object.freeze([q.x, q.y, q.z, q.w]) as readonly [number, number, number, number],
      centerOfMassM: tuple(body.worldCom()),
      localCenterOfMassM: tuple(body.localCom()),
      linearVelocityMps: tuple(body.linvel()),
      angularVelocityRadps: tuple(body.angvel()),
      principalInertiaKgM2: tuple(body.principalInertia()),
      principalInertiaLocalRotation: Object.freeze([iq.x, iq.y, iq.z, iq.w]) as readonly [
        number,
        number,
        number,
        number,
      ],
    }),
  );
}

export function runGetCommittedColliderPrimitives(
  getCommittedBodyDynamics: (entity: number) => Result<PhysicsBodyDynamics, PhysicsFixedError>,
  fixedFailure: (
    entity: number,
    code: PhysicsFixedError['code'],
    reason: string,
    extra?: {
      expected?: number;
      actual?: number;
      recovery?: NonNullable<PhysicsFixedError['detail']['recovery']>;
    },
  ) => import('@forgeax/engine-types').ResultErr<
    import('@forgeax/engine-physics').PhysicsFixedError
  >,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  acceptedBodyColliders: (entity: number, body: RapierRigidBody) => RapierCollider[],
  rapierModule: Rapier3DModule,
  sensorIdentity: (collider: RapierWorld) => PhysicsSensorOverlap | undefined,
  entity: number,
  filterMask = 0xffffffff,
): Result<PhysicsColliderPrimitives, PhysicsFixedError> {
  const dynamics = getCommittedBodyDynamics(entity);
  if (!dynamics.ok) return dynamics;
  if (!Number.isInteger(filterMask) || filterMask < 0 || filterMask > 0xffffffff)
    return fixedFailure(
      entity,
      'fixed-input-invalid',
      'collider filter must be packed u32 collision groups',
    );
  const body = bodyForEntity(entity);
  const record = entityMap.get(entity);
  if (body === undefined || record === undefined)
    return fixedFailure(
      entity,
      'fixed-body-missing',
      'native body retired during collider snapshot',
    );
  const elements: PhysicsColliderPrimitives['elements'][number][] = [];
  try {
    const accepted = acceptedBodyColliders(entity, body);
    const rawAggregateCount = accepted.reduce(
      (count, collider) => count + aggregateColliderCount(collider, rapierModule.ShapeType),
      0,
    );
    for (const collider of accepted) {
      if (!body.isEnabled() || !collider.isEnabled()) continue;
      const groups = collider.collisionGroups() >>> 0;
      if (
        ((groups >>> 16) & filterMask & 0xffff) === 0 ||
        ((filterMask >>> 16) & groups & 0xffff) === 0
      )
        continue;
      const geometry = readColliderPrimitives(collider, rapierModule.ShapeType);
      if (geometry === undefined)
        return fixedFailure(
          entity,
          'fixed-input-invalid',
          'this accepted native shape needs finite primitive dimensions or supported local bounds',
        );
      const identity = sensorIdentity(collider);
      if (!identity)
        return fixedFailure(
          entity,
          'fixed-body-missing',
          'native collider retired during snapshot',
        );
      for (const primitive of geometry)
        elements.push(
          Object.freeze({
            colliderId: identity.colliderId,
            generation: identity.generation,
            collisionGroups: groups,
            ...primitive,
          }),
        );
    }
    const scale = record.scale;
    const d = dynamics.value;
    return ok(
      Object.freeze({
        entity,
        generation: d.generation,
        completedStep: d.completedStep,
        motionDiscontinuity: record.motionDiscontinuity,
        positionM: d.positionM,
        rotation: d.rotation,
        scale,
        centerOfMassM: d.centerOfMassM,
        linearVelocityMps: d.linearVelocityMps,
        angularVelocityRadps: d.angularVelocityRadps,
        rawAggregateCount,
        elements: Object.freeze(elements),
      }),
    );
  } catch (cause) {
    return fixedFailure(entity, 'fixed-backend-failed', String(cause));
  }
}

export function runIntersectsCommittedBodyObb(
  getCommittedBodyDynamics: (entity: number) => Result<PhysicsBodyDynamics, PhysicsFixedError>,
  fixedFailure: (
    entity: number,
    code: PhysicsFixedError['code'],
    reason: string,
    extra?: {
      expected?: number;
      actual?: number;
      recovery?: NonNullable<PhysicsFixedError['detail']['recovery']>;
    },
  ) => import('@forgeax/engine-types').ResultErr<
    import('@forgeax/engine-physics').PhysicsFixedError
  >,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  rapierModule: Rapier3DModule,
  acceptedBodyColliders: (entity: number, body: RapierRigidBody) => RapierCollider[],
  input: PhysicsBodyObbQuery,
): Result<boolean, PhysicsFixedError> {
  const accepted = getCommittedBodyDynamics(input.entity);
  if (!accepted.ok) return accepted;
  if (!validBodyObbQuery(input))
    return fixedFailure(
      input.entity,
      'fixed-input-invalid',
      'OBB pose, nonnegative full extents and optional local bounds must be finite',
    );
  if (accepted.value.generation !== input.generation)
    return fixedFailure(input.entity, 'fixed-generation-stale', 'OBB query body was replaced', {
      expected: accepted.value.generation,
      actual: input.generation,
    });
  if (accepted.value.completedStep !== input.completedStep)
    return fixedFailure(
      input.entity,
      'fixed-step-stale',
      'OBB query must use the exact captured completed step',
      { expected: accepted.value.completedStep, actual: input.completedStep },
    );
  const record = entityMap.get(input.entity);
  const body = bodyForEntity(input.entity);
  if (record === undefined || body === undefined)
    return fixedFailure(input.entity, 'fixed-body-missing', 'native body retired during OBB query');
  const scale = record.scale;
  if (!finitePhysicsVector(scale, 3) || scale.some((value) => value <= 0))
    return fixedFailure(
      input.entity,
      'fixed-input-invalid',
      'accepted component scale must be finite and positive',
    );
  try {
    return ok(
      intersectsBodyObb(
        rapierModule,
        body,
        acceptedBodyColliders(input.entity, body),
        scale,
        input,
      ),
    );
  } catch (cause) {
    return fixedFailure(input.entity, 'fixed-backend-failed', String(cause));
  }
}

export function runAdmitFixedForce(
  fixedOperationAvailable: (access?: 'read' | 'write') => boolean,
  fixedFailure: (
    entity: number,
    code: PhysicsFixedError['code'],
    reason: string,
    extra?: {
      expected?: number;
      actual?: number;
      recovery?: NonNullable<PhysicsFixedError['detail']['recovery']>;
    },
  ) => import('@forgeax/engine-types').ResultErr<
    import('@forgeax/engine-physics').PhysicsFixedError
  >,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  readSyncState: () => PhysicsSyncState | undefined,
  readFixedStep: () => number,
  input: {
    entity: number;
    generation: number;
    fixedStep: number;
  },
): Result<RapierRigidBody, PhysicsFixedError> {
  if (!fixedOperationAvailable())
    return fixedFailure(
      input.entity,
      'fixed-operation-unavailable',
      'native execution or admission is in progress',
    );
  const record = entityMap.get(input.entity),
    body = bodyForEntity(input.entity);
  if (!record || !body)
    return fixedFailure(
      input.entity,
      'fixed-body-missing',
      'body has not synchronized or was retired',
    );
  if (record.generation !== input.generation)
    return fixedFailure(input.entity, 'fixed-generation-stale', 'body was replaced', {
      expected: record.generation,
      actual: input.generation,
    });
  const step = readSyncState()?.world.getResource(FixedTime).tick ?? readFixedStep() + 1;
  if (input.fixedStep !== step || input.fixedStep <= readFixedStep())
    return fixedFailure(
      input.entity,
      'fixed-step-stale',
      'force does not target the next exact step',
      { expected: step, actual: input.fixedStep },
    );
  if (!body.isDynamic())
    return fixedFailure(
      input.entity,
      'fixed-input-invalid',
      'force requires an ordinary dynamic body',
    );
  return ok(body);
}

export function runPublishSensorOverlaps(
  readRaw: () => RapierWorld,
  sensorIdentity: (collider: RapierWorld) => PhysicsSensorOverlap | undefined,
  sensorColliderIdentities: Map<number, import('@forgeax/engine-physics').PhysicsSensorOverlap>,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  completedSensorRosters: Map<number, import('@forgeax/engine-physics').PhysicsSensorOverlaps>,
  readFixedStep: () => number,
): void {
  const live = new Set<number>();
  readRaw().forEachCollider((collider: RapierWorld) => {
    if (sensorIdentity(collider)) live.add(collider.handle);
  });
  for (const handle of sensorColliderIdentities.keys())
    if (!live.has(handle)) sensorColliderIdentities.delete(handle);
  for (const [entity, record] of entityMap) {
    const found = new Map<string, PhysicsSensorOverlap>();
    const body = bodyForEntity(entity);
    if (!body) continue;
    for (const root of bodyColliders(body))
      readRaw().intersectionPairsWith(root, (other: RapierWorld) => {
        if (!(root.isSensor() || other.isSensor()) || !readRaw().intersectionPair(root, other))
          return;
        const identity = sensorIdentity(other);
        if (identity && identity.entity !== entity) found.set(identity.colliderId, identity);
      });
    const previous = completedSensorRosters.get(entity);
    const prior = previous?.rootGeneration === record.generation ? previous.current : [];
    const oldIds = new Set(prior.map((value) => value.colliderId));
    const current = Object.freeze([
      ...prior.filter((value) => found.has(value.colliderId)),
      ...[...found.values()].filter((value) => !oldIds.has(value.colliderId)),
    ]);
    completedSensorRosters.set(
      entity,
      Object.freeze({
        rootEntity: entity,
        rootGeneration: record.generation,
        completedStep: readFixedStep(),
        current,
        entered: Object.freeze(current.filter((value) => !oldIds.has(value.colliderId))),
        exited: Object.freeze(prior.filter((value) => !found.has(value.colliderId))),
        stale: Object.freeze([]),
      }),
    );
  }
  for (const entity of completedSensorRosters.keys())
    if (!entityMap.has(entity)) completedSensorRosters.delete(entity);
}

export function runGetSensorOverlaps(
  fixedOperationAvailable: (access?: 'read' | 'write') => boolean,
  fixedFailure: (
    entity: number,
    code: PhysicsFixedError['code'],
    reason: string,
    extra?: {
      expected?: number;
      actual?: number;
      recovery?: NonNullable<PhysicsFixedError['detail']['recovery']>;
    },
  ) => import('@forgeax/engine-types').ResultErr<
    import('@forgeax/engine-physics').PhysicsFixedError
  >,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  completedSensorRosters: Map<number, import('@forgeax/engine-physics').PhysicsSensorOverlaps>,
  sensorColliderIdentities: Map<number, import('@forgeax/engine-physics').PhysicsSensorOverlap>,
  rootEntity: number,
  filterMask = 0xffffffff,
): Result<PhysicsSensorOverlaps, PhysicsFixedError> {
  if (!fixedOperationAvailable())
    return fixedFailure(
      rootEntity,
      'fixed-operation-unavailable',
      'native execution or admission is in progress',
    );
  const record = entityMap.get(rootEntity);
  if (!record) return fixedFailure(rootEntity, 'fixed-body-missing', 'root body was retired');
  if (!Number.isInteger(filterMask) || filterMask < 0 || filterMask > 0xffffffff)
    return fixedFailure(
      rootEntity,
      'fixed-input-invalid',
      'mask must be a packed unsigned 32-bit collision group',
    );
  const roster = completedSensorRosters.get(rootEntity);
  if (!roster || roster.rootGeneration !== record.generation)
    return fixedFailure(
      rootEntity,
      'fixed-operation-unavailable',
      'root has no completed sensor step yet',
    );
  const accepts = (value: PhysicsSensorOverlap) =>
    ((filterMask >>> 16) & (value.collisionGroups & 0xffff)) !== 0 &&
    ((value.collisionGroups >>> 16) & (filterMask & 0xffff)) !== 0;
  const identities = new Set(sensorColliderIdentities.values());
  const live = (value: PhysicsSensorOverlap) =>
    identities.has(value) && entityMap.get(value.entity)?.generation === value.bodyGeneration;
  return ok(
    Object.freeze({
      ...roster,
      current: Object.freeze(roster.current.filter((value) => accepts(value) && live(value))),
      entered: Object.freeze(roster.entered.filter((value) => accepts(value) && live(value))),
      exited: Object.freeze(roster.exited.filter(accepts)),
      stale: Object.freeze(roster.current.filter((value) => accepts(value) && !live(value))),
    }),
  );
}

export function runDrainRapierCollisionEvents(
  colliderHandleToEntity: (colliderHandle: number) => number | undefined,
  derivedColliderToShape: Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >,
  groupedContactEvents: import('./grouped-contact-events.js').GroupedContactEvents,
  recordContactObservation: (
    observation: PhysicsContactObservation,
    handleA: number,
    handleB: number,
  ) => void,
  readFixedStep: () => number,
  addPair: (a: number, b: number) => boolean,
  collisionPairs: Map<number, Set<number>>,
  bodiesShareCollision: (entityA: number, entityB: number) => boolean,
  removePair: (a: number, b: number) => boolean,
  pushCollisionEvent: (event: Rapier3DCollisionEvent) => void,
  readEventQueue: () => RapierEventQueue,
  retiredColliderOwners: Map<number, number>,
  workerEvents?: readonly (readonly [number, number, boolean])[],
): void {
  const consume = (handle1: number, handle2: number, started: boolean) => {
    const a = colliderHandleToEntity(handle1);
    const b = colliderHandleToEntity(handle2);
    const shapeA = derivedColliderToShape.get(handle1);
    const shapeB = derivedColliderToShape.get(handle2);
    const grouped =
      groupedContactEvents.active || shapeA?.grouped || shapeB?.grouped
        ? groupedContactEvents.consume(
            handle1,
            handle2,
            started,
            a === undefined ? undefined : { entity: a, ...shapeA },
            b === undefined ? undefined : { entity: b, ...shapeB },
          )
        : false;
    if (a === undefined || b === undefined) return;
    if (!grouped)
      recordContactObservation(
        {
          phase: started ? 'started' : 'stopped',
          fixedStep: readFixedStep(),
          entityA: a,
          entityB: b,
          ...(shapeA === undefined ? {} : { shapeA: shapeA.id }),
          ...(shapeB === undefined ? {} : { shapeB: shapeB.id }),
        },
        handle1,
        handle2,
      );
    const changed = started
      ? addPair(a, b)
      : collisionPairs.get(a)?.has(b) === true && !bodiesShareCollision(a, b) && removePair(a, b);
    if (!changed) return;
    pushCollisionEvent({
      type: started ? 'started' : 'stopped',
      entityA: a,
      entityB: b,
      fixedStep: readFixedStep(),
      ...(shapeA === undefined ? {} : { shapeA: shapeA.id }),
      ...(shapeB === undefined ? {} : { shapeB: shapeB.id }),
    });
  };
  if (workerEvents === undefined) readEventQueue().drainCollisionEvents(consume);
  else for (const [a, b, started] of workerEvents) consume(a, b, started);
  groupedContactEvents.drain(readFixedStep(), (observation, a, b) =>
    recordContactObservation(observation, a, b),
  );
  retiredColliderOwners.clear();
}

export function runBodiesShareCollision(
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  readRaw: () => RapierWorld,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  colliderHandleToEntity: (colliderHandle: number) => number | undefined,
  entityA: number,
  entityB: number,
): boolean {
  const bodyA = bodyForEntity(entityA);
  const bodyB = bodyForEntity(entityB);
  if (bodyA === undefined || bodyB === undefined) return false;
  const raw = readRaw() as RapierWorld;
  // Symmetric contact existence only needs the smaller collider roster.
  const smaller = bodyA.numColliders() <= bodyB.numColliders() ? bodyA : bodyB;
  const otherEntity = smaller === bodyA ? entityB : entityA;
  for (const colliderA of bodyColliders(smaller)) {
    let hasContact = false;
    raw.intersectionPairsWith(colliderA, (other: RapierWorld) => {
      if (
        !hasContact &&
        colliderHandleToEntity(other.handle) === otherEntity &&
        raw.intersectionPair(colliderA, other)
      )
        hasContact = true;
    });
    if (hasContact) return true;
    raw.contactPairsWith(colliderA, (other: RapierWorld) => {
      if (hasContact || colliderHandleToEntity(other.handle) !== otherEntity) return;
      raw.contactPair(colliderA, other, () => {
        hasContact = true;
      });
    });
    if (hasContact) return true;
  }
  return false;
}

export function runDerivedRecordRejection(
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  readRaw: () => RapierWorld,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  derivedPoisonedEntities: Set<number>,
  validateDerivedAdmission: (
    input: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ) => DerivedPhysicsError | undefined,
  record: DerivedCandidateRecord,
  sources: ReadonlyMap<number, DerivedBodySource>,
): DerivedPhysicsError | undefined {
  const entity = record.input.entity;
  const projected = sources.get(entity);
  if (projected !== undefined && record.input.revision < projected.revision)
    return new DerivedPhysicsError(
      'derived-candidate-stale',
      'fixed-step admission publishes the final queued body revisions',
      'discard the older group and prepare a complete replacement',
      { entity },
    );
  if (
    (record.retainedGeometry !== undefined || record.sharedGeometry !== undefined) &&
    !retainedDerivedGeometryCurrent(
      record,
      derivedBodies.get(entity),
      readRaw(),
      bodyForEntity(entity)?.handle,
    )
  )
    return new DerivedPhysicsError(
      'derived-candidate-stale',
      'admission retains the exact accepted geometry owner',
      'read its new publication and prepare again',
      { entity },
    );
  if (derivedPoisonedEntities.has(entity))
    return new DerivedPhysicsError(
      'derived-recovery-invalid',
      'every batch body has recoverable native state',
      'rebuild the PhysicsWorld before retrying',
      { entity },
    );
  if (bodyForEntity(entity) === undefined)
    return new DerivedPhysicsError(
      'derived-body-not-found',
      'every batch body remains live through admission',
      'reconcile entities and prepare again',
      { entity },
    );
  return validateDerivedAdmission(record.input, sources);
}

export function runAuthoredColliderDesc(
  rapierModule: Rapier3DModule,
  colliderFailure: (reason: string) => never,
  meshGeometry: (collider: ColliderSnapshot) => ReturnType<SharedCollisionGeometry['prepare']>,
  transform: PhysicsTransform3D,
  collider: ColliderSnapshot,
  bodyType: RigidBodyType,
): ColliderDesc | undefined {
  const RAPIER = rapierModule;
  const x = Math.abs(transform.scale.x),
    y = Math.abs(transform.scale.y),
    z = Math.abs(transform.scale.z);
  const dimensions =
    collider.shape === ColliderShapeValue.cuboid
      ? collider.halfExtents
      : collider.shape === ColliderShapeValue.sphere
        ? [collider.radius]
        : collider.shape <= ColliderShapeValue.cone
          ? [collider.radius, collider.halfHeight]
          : [];
  if (
    !dimensions.every((v) => Number.isFinite(v) && v > 0) ||
    ![x, y, z].every((v) => Number.isFinite(v) && (bodyType === 'static' || v > 0))
  )
    return colliderFailure('collider dimensions and world scale must be finite and positive');
  // A collapsed static shape has no collision volume. Keep its body for restoration.
  if (hasZeroColliderScale(transform.scale)) return undefined;
  let desc: ColliderDesc;
  switch (colliderShapeFromF32(collider.shape)) {
    case 'cuboid':
      desc = RAPIER.ColliderDesc.cuboid(
        collider.halfExtents[0] * x,
        collider.halfExtents[1] * y,
        collider.halfExtents[2] * z,
      );
      break;
    case 'sphere':
      desc = RAPIER.ColliderDesc.ball(collider.radius * Math.max(x, y, z));
      break;
    case 'capsule':
      desc = RAPIER.ColliderDesc.capsule(collider.halfHeight * y, collider.radius * Math.max(x, z));
      break;
    case 'cylinder':
      desc = RAPIER.ColliderDesc.cylinder(
        collider.halfHeight * y,
        collider.radius * Math.max(x, z),
      );
      break;
    case 'cone':
      desc = RAPIER.ColliderDesc.cone(collider.halfHeight * y, collider.radius * Math.max(x, z));
      break;
    case 'convexHull':
    case 'trimesh': {
      if (collider.shape === ColliderShapeValue.trimesh && bodyType === 'dynamic')
        return colliderFailure(
          'concave trimesh is static/kinematic only; use convexHull for dynamic bodies',
        );
      desc = new RAPIER.ColliderDesc({
        type: 'shared',
        geometry: meshGeometry(collider).native,
        scale: { x, y, z },
      });
      break;
    }
  }
  return desc
    .setFriction(collider.friction)
    .setRestitution(collider.restitution)
    .setDensity(collider.density)
    .setCollisionGroups(collider.collisionGroups)
    .setSolverGroups(collider.solverGroups)
    .setSensor(Boolean(collider.isSensor))
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
}

export function runRememberSourceOwnedTypeRefusal(
  derivedFailures: Map<number, import('@forgeax/engine-physics').DerivedPhysicsFailure>,
  readFixedStep: () => number,
  entity: number,
  committed: DerivedBodyRecord,
  requestedType: number,
  normalizationFailure?: unknown,
): void {
  const error = new DerivedPhysicsError(
    'derived-candidate-invalid',
    'an accepted source-owned body stays static until a complete replacement transfers pose ownership',
    'keep its ECS RigidBody static, or first retire the source with an empty static candidate',
    {
      entity,
      candidateId: committed.candidateId,
      actual: requestedType,
      ...(normalizationFailure === undefined
        ? {}
        : {
            reason:
              normalizationFailure instanceof Error
                ? normalizationFailure.message
                : String(normalizationFailure),
          }),
    },
    normalizationFailure === undefined ? undefined : { cause: normalizationFailure },
  );
  derivedFailures.set(
    entity,
    Object.freeze({
      candidateId: committed.candidateId,
      entity,
      revision: committed.revision,
      fixedStep: readFixedStep(),
      error,
      recovery: 'old-state-retained',
    }),
  );
}

export function runRemoveEntity(
  readSolverPending: () => boolean,
  solverRetiredEntities: Set<number>,
  groupedContactEvents: import('./grouped-contact-events.js').GroupedContactEvents,
  isolatedPairs: Map<string, import('./physics-entity-records.js').IsolatedPair>,
  retireIsolatedPair: (key: string, pair: IsolatedPair) => void,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  isolationColliderOwners: Map<number, number>,
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  rejectPreparedCandidate: (record: DerivedCandidateRecord, error: DerivedPhysicsError) => void,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  removeNativeCollider: (handle: number) => void,
  derivedPublications: Map<number, import('@forgeax/engine-physics').DerivedPhysicsPublication>,
  derivedFailures: Map<number, import('@forgeax/engine-physics').DerivedPhysicsFailure>,
  derivedPoisonedEntities: Set<number>,
  derivedConstraints: Map<string, import('./derived-candidate-records.js').DerivedConstraintRecord>,
  removeNativeConstraint: (handle: number) => void,
  pendingDerivedCandidates: Set<string>,
  releaseDerivedCandidate: (candidateId: string) => void,
  collisionPairs: Map<number, Set<number>>,
  removePair: (a: number, b: number) => boolean,
  pushCollisionEvent: (event: Rapier3DCollisionEvent) => void,
  removeKccController: (entity: number) => void,
  readRaw: () => RapierWorld,
  readSharedGeometry: () => SharedCollisionGeometry | undefined,
  terrainColliders: Map<number, { asset: number; collider: number; body: number }>,
  dirtyPairPolicies: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  derivedBodySources: Map<number, import('./derived-candidate-records.js').DerivedBodySource>,
  motionReadback: import('./body-motion-readback.js').BodyMotionReadback,
  entity: number,
): void {
  if (readSolverPending()) {
    solverRetiredEntities.add(entity);
    return;
  }
  groupedContactEvents.removeEntity(entity);
  for (const [key, pair] of isolatedPairs) {
    if (pair.input.entityA === entity || pair.input.entityB === entity)
      retireIsolatedPair(key, pair);
  }
  const record = entityMap.get(entity);
  if (!record) return;
  const removedBody = bodyForEntity(entity);
  const removedColliders = removedBody === undefined ? [] : bodyColliders(removedBody);
  if (removedBody !== undefined)
    for (const collider of removedColliders) isolationColliderOwners.delete(collider.handle);
  const rejectRemovedBodyCandidates = () => {
    for (const candidate of derivedCandidates.values()) {
      if (
        candidate.input.entity !== entity ||
        candidate.batch === undefined ||
        (candidate.state !== 'ready' && candidate.state !== 'queued')
      )
        continue;
      rejectPreparedCandidate(
        candidate,
        new DerivedPhysicsError(
          'derived-body-not-found',
          'all grouped bodies remain live until admission',
          'prepare a new complete group after entity reconciliation',
          { entity },
        ),
      );
    }
  };
  rejectRemovedBodyCandidates();
  retireRemovedPhysicsEntity(
    entityMap,
    derivedCandidates,
    derivedBodies,
    removeNativeCollider,
    derivedPublications,
    derivedFailures,
    derivedPoisonedEntities,
    derivedConstraints,
    removeNativeConstraint,
    pendingDerivedCandidates,
    releaseDerivedCandidate,
    collisionPairs,
    removePair,
    pushCollisionEvent,
    removeKccController,
    readRaw,
    readSharedGeometry,
    terrainColliders,
    dirtyPairPolicies,
    derivedBodySources,
    motionReadback,
    entity,
    record,
    removedColliders,
  );
}

function retireRemovedPhysicsEntity(
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  removeNativeCollider: (handle: number) => void,
  derivedPublications: Map<number, import('@forgeax/engine-physics').DerivedPhysicsPublication>,
  derivedFailures: Map<number, import('@forgeax/engine-physics').DerivedPhysicsFailure>,
  derivedPoisonedEntities: Set<number>,
  derivedConstraints: Map<string, import('./derived-candidate-records.js').DerivedConstraintRecord>,
  removeNativeConstraint: (handle: number) => void,
  pendingDerivedCandidates: Set<string>,
  releaseDerivedCandidate: (candidateId: string) => void,
  collisionPairs: Map<number, Set<number>>,
  removePair: (a: number, b: number) => boolean,
  pushCollisionEvent: (event: Rapier3DCollisionEvent) => void,
  removeKccController: (entity: number) => void,
  readRaw: () => RapierWorld,
  readSharedGeometry: () => SharedCollisionGeometry | undefined,
  terrainColliders: Map<number, { asset: number; collider: number; body: number }>,
  dirtyPairPolicies: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  derivedBodySources: Map<number, import('./derived-candidate-records.js').DerivedBodySource>,
  motionReadback: import('./body-motion-readback.js').BodyMotionReadback,
  entity: number,
  record: import('./physics-entity-records.js').PhysicsEntityRecord,
  removedColliders: RapierWorld[],
): void {
  const derived = derivedBodies.get(entity);
  if (derived !== undefined) {
    for (const handle of derived.shapes.flatMap(derivedShapeHandles)) removeNativeCollider(handle);
    derivedBodies.delete(entity);
    derivedPublications.delete(entity);
  }
  derivedFailures.delete(entity);
  derivedPoisonedEntities.delete(entity);
  for (const [id, constraint] of derivedConstraints) {
    if (constraint.input.bodyA === entity || constraint.input.bodyB === entity) {
      removeNativeConstraint(constraint.handle);
      derivedConstraints.delete(id);
    }
  }
  for (const [id, candidate] of derivedCandidates) {
    if (candidate.input.entity !== entity) continue;
    for (const collider of candidate.nativeColliders) removeNativeCollider(collider.handle);
    pendingDerivedCandidates.delete(id);
    releaseDerivedCandidate(id);
  }
  const ownPairs = [...(collisionPairs.get(entity) ?? [])];
  for (const other of ownPairs) {
    if (removePair(entity, other)) {
      pushCollisionEvent({ type: 'stopped', entityA: entity, entityB: other });
    }
  }
  removeKccController(entity); // D-3: clear cached KCC before body removal
  // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeRigidBody
  (readRaw() as any).removeRigidBody({ handle: record.bodyHandle } as RapierRigidBody);
  for (const collider of removedColliders) readSharedGeometry()?.detach(collider.handle);
  terrainColliders.delete(entity);
  entityMap.delete(entity);
  dirtyPairPolicies.delete(entity);
  derivedBodySources.delete(entity);
  motionReadback.notify(entity);
  // Clear the despawned entity from every overlap set so a collected Core does
  // not linger in the player's CollidingEntities (Rapier emits no `stopped`
  // event when a collider is removed mid-overlap).
  const own = collisionPairs.get(entity);
  if (own) {
    for (const other of own) collisionPairs.get(other)?.delete(entity);
    collisionPairs.delete(entity);
  }
}
