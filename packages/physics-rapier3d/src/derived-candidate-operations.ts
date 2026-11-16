import {
  DERIVED_PHYSICS_LIMITS,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  type DerivedPhysicsCollisionReceipt,
  DerivedPhysicsError,
  type DerivedPhysicsFailure,
  type DerivedPhysicsSnapshot,
  type DerivedPhysicsSourceTransform,
  type DerivedShapeInput,
  type ManagedJointBinding,
  type ManagedJointInput,
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
  type PhysicsConstraintInput,
  type PhysicsMassProperties,
  type PhysicsWorld,
  preserveCenterOfMassVelocity,
  validateManagedJoints,
} from '@forgeax/engine-physics';
import { canonicalJson, err, ok, type Result, sha256 } from '@forgeax/engine-types';
import type { Collider as RapierCollider } from '../pkg/rapier.mjs';
import { rapierBodyTypeFromString } from './body-type.js';
import { orderDerivedCandidateGroups } from './derived-admission-order.js';
import { applyDerivedMotion, type DerivedAdmissionUndo } from './derived-admission-undo.js';
import { candidateNativeColliders, candidateShapeRecords } from './derived-body-type.js';
import {
  type DerivedAdmissionBatch,
  type DerivedAdmissionProjection,
  type DerivedBodyRecord,
  type DerivedBodySource,
  type DerivedCandidateRecord,
  type DerivedConstraintRecord,
  type DerivedShapeRecord,
  derivedRosterRefusal,
} from './derived-candidate-records.js';
import { createDerivedColliderGroup } from './derived-collider.js';
import { createDerivedJointData, validateConstraintInput } from './derived-constraint.js';
import { restoreDerivedDensities } from './derived-density.js';
import { createManagedJointData } from './managed-joint-data.js';
import type { RapierRigidBody, RapierWorld } from './physics-entity-records.js';
import { primeGroupedContacts } from './prime-grouped-contacts.js';
import { projectSourceOwnedShape, sourceNativePose } from './source-owned-shape.js';
import type { Rapier3DModule } from './wasm-loader.js';

export function runAdmitDerivedShapeCandidates(
  pendingDerivedMutation: (operation: string) => DerivedPhysicsError | undefined,
  assertActive: (operation: string) => void,
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  physicsOwner: {},
  readBackendGeneration: () => number,
  pendingDerivedSources: () => Map<number, DerivedBodySource>,
  admitDerivedShapeCandidateInternal: (
    candidate: DerivedPhysicsCandidate,
    projection?: DerivedAdmissionProjection,
    validateOnly?: boolean,
  ) => ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>>,
  rejectPreparedCandidate: (record: DerivedCandidateRecord, error: DerivedPhysicsError) => void,
  revalidatePendingDerivedCandidates: (
    admitted: DerivedCandidateRecord,
  ) => DerivedPhysicsError | undefined,
  candidates: readonly DerivedPhysicsCandidate[],
  commitGeometry?: () => Result<void, Error>,
  unionOfGroups = false,
): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidates']>> {
  const pending = pendingDerivedMutation('admitDerivedShapeCandidates');
  if (pending) return err(pending);
  if (!unionOfGroups) assertActive('admitDerivedShapeCandidates');
  const records: DerivedCandidateRecord[] = [];
  const sources = new Map<number, DerivedBodySource>();
  const constraints = new Set<string>();
  const invalid = (reason: string) =>
    new DerivedPhysicsError(
      'derived-candidate-invalid',
      'one bounded admission contains distinct prepared bodies and constraint updates',
      'prepare one candidate per body and submit the complete replacement together',
      { reason },
    );
  if (candidates.length === 0 || candidates.length > DERIVED_PHYSICS_LIMITS.maxBatchCandidates)
    return err(invalid('invalid batch size'));
  // Resolve credentials before mutating the queue. Never use caller input as
  // the source projection or invalidate another owner's matching token ID.
  const credentialFailure = resolveAdmissionCredentials(
    derivedCandidates,
    physicsOwner,
    readBackendGeneration,
    candidates,
    records,
    sources,
    constraints,
    invalid,
  );
  if (credentialFailure !== undefined) return credentialFailure;
  const first = records[0];
  if (first === undefined) return err(invalid('empty preparation group'));
  const refusal = derivedRosterRefusal(records, unionOfGroups);
  if (refusal !== undefined) return err(invalid(refusal));
  // All caller credentials have been resolved. Frozen owned tokens keep
  // the following synchronous validation and enqueue free of caller getters.
  const queuedSources = pendingDerivedSources();
  for (const [entity, source] of queuedSources)
    if (!sources.has(entity)) sources.set(entity, source);
  const projection = { sources, queuedSources };
  const validateAdmissionRecords = () => {
    for (const record of records) {
      const checked = admitDerivedShapeCandidateInternal(record.token, projection, true);
      if (!checked.ok) {
        for (const record of records) {
          if (derivedCandidates.has(record.token.candidateId))
            rejectPreparedCandidate(record, checked.error);
        }
        return checked;
      }
    }
    return undefined;
  };
  const recordFailure = validateAdmissionRecords();
  if (recordFailure !== undefined) return recordFailure;
  const batch: DerivedAdmissionBatch = Object.freeze({
    records: Object.freeze(records),
    ...(commitGeometry === undefined ? {} : { commitGeometry }),
  });
  for (const record of records) record.batch = batch;
  const queued: DerivedPhysicsCandidate[] = [];
  for (const record of records) {
    const admitted = admitDerivedShapeCandidateInternal(record.token, projection);
    if (!admitted.ok) {
      rejectPreparedCandidate(first, admitted.error);
      return admitted;
    }
    queued.push(admitted.value);
  }
  const queueError = revalidatePendingDerivedCandidates(first);
  if (queueError !== undefined) return err(queueError);
  return ok(Object.freeze(queued));
}

export function runAdmitDerivedShapeCandidateInternal(
  assertActive: (operation: string) => void,
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  physicsOwner: {},
  readBackendGeneration: () => number,
  derivedPoisonedEntities: Set<number>,
  pendingDerivedSources: () => Map<number, DerivedBodySource>,
  validateDerivedAdmission: (
    input: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ) => DerivedPhysicsError | undefined,
  rejectPreparedCandidate: (record: DerivedCandidateRecord, error: DerivedPhysicsError) => void,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  pendingDerivedCandidates: Set<string>,
  revalidatePendingDerivedCandidates: (
    admitted: DerivedCandidateRecord,
  ) => DerivedPhysicsError | undefined,
  candidate: DerivedPhysicsCandidate,
  projection?: DerivedAdmissionProjection,
  validateOnly = false,
): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
  assertActive('admitDerivedShapeCandidate');
  const record = derivedCandidates.get(candidate.candidateId);
  if (
    record === undefined ||
    candidate.owner !== physicsOwner ||
    record.token.owner !== candidate.owner ||
    candidate.generation !== readBackendGeneration()
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-not-found',
        'candidate belongs to the current PhysicsWorld generation',
        'discard stale candidate credentials and prepare from committed input again',
        { candidateId: candidate.candidateId },
      ),
    );
  }
  if (derivedPoisonedEntities.has(record?.input.entity ?? -1)) {
    return err(
      new DerivedPhysicsError(
        'derived-recovery-invalid',
        'the candidate entity is stopped after an unrecoverable native admission failure',
        'rebuild the PhysicsWorld from its portable snapshot before retrying',
        { entity: record?.input.entity, candidateId: candidate.candidateId },
      ),
    );
  }
  if (record.state === 'cancelled' || record.state === 'invalidated') {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-cancelled',
        'candidate has not been cancelled or invalidated',
        'prepare a new candidate from the latest committed revision',
        { candidateId: candidate.candidateId },
      ),
    );
  }
  if (record.state !== 'ready') {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-pending',
        'a prepared candidate is admitted at most once',
        'retain the returned queued receipt and wait for fixed-step publication',
        { candidateId: candidate.candidateId },
      ),
    );
  }
  return enqueueCurrentDerivedCandidate(
    pendingDerivedSources,
    rejectPreparedCandidate,
    derivedBodies,
    pendingDerivedCandidates,
    revalidatePendingDerivedCandidates,
    candidate,
    validateOnly,
    record,
    validateDerivedAdmission,
    projection,
  );
}

export function runCancelDerivedShapeCandidate(
  pendingDerivedMutation: (operation: string) => DerivedPhysicsError | undefined,
  assertActive: (operation: string) => void,
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  physicsOwner: {},
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  pendingDerivedCandidates: Set<string>,
  removeNativeCollider: (handle: number) => void,
  releaseDerivedCandidate: (candidateId: string) => void,
  candidate: DerivedPhysicsCandidate,
): ReturnType<NonNullable<PhysicsWorld['cancelDerivedShapeCandidate']>> {
  const pending = pendingDerivedMutation('cancelDerivedShapeCandidate');
  if (pending) return err(pending);
  assertActive('cancelDerivedShapeCandidate');
  const record = derivedCandidates.get(candidate.candidateId);
  if (
    record === undefined ||
    candidate.owner !== physicsOwner ||
    derivedBodies.get(record.input.entity)?.candidateId === candidate.candidateId
  ) {
    if (
      candidate.owner === physicsOwner &&
      [...derivedBodies.values()].some((body) => body.candidateId === candidate.candidateId)
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-cancelled',
          'a published candidate remains the committed result until replaced',
          'submit a newer candidate instead of cancelling committed state',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    return err(
      new DerivedPhysicsError(
        'derived-candidate-not-found',
        'candidate belongs to the current PhysicsWorld',
        'ignore already-retired credentials and prepare again when needed',
        { candidateId: candidate.candidateId },
      ),
    );
  }
  for (const member of record.batch?.records ?? [record]) {
    pendingDerivedCandidates.delete(member.token.candidateId);
    for (const collider of member.nativeColliders) removeNativeCollider(collider.handle);
    member.state = 'cancelled';
    releaseDerivedCandidate(member.token.candidateId);
  }
  return ok(undefined);
}

export function runGetDerivedCollisionReceipt(
  assertCommittedReadable: (operation: string) => void,
  recoveryBlocked: () => boolean,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  derivedPublications: Map<number, import('@forgeax/engine-physics').DerivedPhysicsPublication>,
  derivedCollisionReceipts: WeakMap<
    import('./derived-candidate-records.js').DerivedBodyRecord,
    import('@forgeax/engine-physics').DerivedPhysicsCollisionReceipt
  >,
  entity: number,
): DerivedPhysicsCollisionReceipt | undefined {
  assertCommittedReadable('getDerivedCollisionReceipt');
  if (recoveryBlocked()) return undefined;
  const body = derivedBodies.get(entity);
  const publication = derivedPublications.get(entity);
  if (
    !body ||
    !publication ||
    body.revision !== publication.revision ||
    body.candidateId !== publication.candidateId
  )
    return undefined;
  const cached = derivedCollisionReceipts.get(body);
  if (cached?.publication === publication) return cached;
  const shapes: DerivedPhysicsCollisionReceipt['shapes'] = Object.freeze(
    body.shapes.flatMap(({ input }): DerivedPhysicsCollisionReceipt['shapes'][number][] => {
      if (input.kind === 'convex-compound')
        return [
          Object.freeze({
            kind: 'convex-compound',
            id: input.id,
            revision: input.revision,
            origin: Object.freeze([...input.origin]) as typeof input.origin,
            rotation: Object.freeze([...input.rotation]) as typeof input.rotation,
            pieces: Object.freeze(input.pieces.map((piece) => Object.freeze(Array.from(piece)))),
          }),
        ];
      if (input.kind === 'trimesh')
        return [
          Object.freeze({
            kind: 'trimesh',
            id: input.id,
            revision: input.revision,
            origin: Object.freeze([...input.origin]) as typeof input.origin,
            rotation: Object.freeze([...input.rotation]) as typeof input.rotation,
            vertices: Object.freeze(Array.from(input.vertices)),
            indices: Object.freeze(Array.from(input.indices)),
          }),
        ];
      return [];
    }),
  );
  const receipt = Object.freeze({
    publication,
    sourceKey: body.sourceKey,
    ...(body.sourceTransform === undefined ? {} : { sourceTransform: body.sourceTransform }),
    shapes,
  });
  derivedCollisionReceipts.set(body, receipt);
  return receipt;
}

export function runRestoreDerivedPhysicsState(
  pendingDerivedMutation: (operation: string) => DerivedPhysicsError | undefined,
  assertActive: (operation: string) => void,
  prepareDerivedShapeCandidate: (
    input: DerivedPhysicsCandidateInput,
  ) => ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>>,
  cancelDerivedShapeCandidate: (
    candidate: DerivedPhysicsCandidate,
  ) => ReturnType<NonNullable<PhysicsWorld['cancelDerivedShapeCandidate']>>,
  admitDerivedShapeCandidates: (
    candidates: readonly DerivedPhysicsCandidate[],
    commitGeometry?: () => Result<void, Error>,
    unionOfGroups?: boolean,
  ) => ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidates']>>,
  snapshot: DerivedPhysicsSnapshot,
): ReturnType<NonNullable<PhysicsWorld['restoreDerivedPhysicsState']>> {
  const pending = pendingDerivedMutation('restoreDerivedPhysicsState');
  if (pending) return err(pending);
  assertActive('restoreDerivedPhysicsState');
  const snapshotSources = new Map<number, DerivedBodySource>();
  for (const body of snapshot.bodies) {
    if (snapshotSources.has(body.entity)) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'a portable snapshot contains one committed body row per entity',
          'capture the snapshot from one PhysicsWorld without duplicate entities',
          { entity: body.entity },
        ),
      );
    }
    snapshotSources.set(body.entity, {
      sourceKey: body.sourceKey,
      revision: body.revision,
    });
  }
  const preparedCandidates: DerivedPhysicsCandidate[] = [];
  const restoredConstraintIds = new Set<string>();
  for (const body of snapshot.bodies) {
    const prepared = prepareDerivedShapeCandidate({
      entity: body.entity,
      revision: body.revision,
      sourceKey: body.sourceKey,
      shapes: body.shapes,
      ...(body.bodyType === undefined ? {} : { bodyType: body.bodyType }),
      ...(body.velocityPolicy === undefined ? {} : { velocityPolicy: body.velocityPolicy }),
      ...(body.motion === undefined ? {} : { motion: body.motion }),
      ...(body.sourceTransform === undefined ? {} : { sourceTransform: body.sourceTransform }),
      ...(body.massProperties === undefined ? {} : { massProperties: body.massProperties }),
      constraints: body.constraints.filter((constraint) => {
        if (restoredConstraintIds.has(constraint.id)) return false;
        restoredConstraintIds.add(constraint.id);
        return true;
      }),
    });
    if (!prepared.ok) {
      for (const candidate of preparedCandidates) cancelDerivedShapeCandidate(candidate);
      return prepared;
    }
    preparedCandidates.push(prepared.value);
  }
  if (preparedCandidates.length === 0) return ok([]);
  return admitDerivedShapeCandidates(preparedCandidates);
}

export function runCreateManagedJoints(
  pendingManagedMutation: (
    operation: string,
  ) => ManagedPhysicsError<'managed-physics-unavailable'> | undefined,
  assertActive: (operation: string) => void,
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  removeNativeConstraint: (handle: number) => void,
  readRaw: () => RapierWorld,
  rapierModule: Rapier3DModule,
  readDisposed: () => boolean,
  readSolverPending: () => boolean,
  solverRetiredJoints: Set<number>,
  inputs: readonly ManagedJointInput[],
): Result<ManagedJointBinding, ManagedPhysicsFailure> {
  const pending = pendingManagedMutation('createManagedJoints');
  if (pending) return err(pending);
  assertActive('createManagedJoints');
  const valid = validateManagedJoints(inputs);
  if (!valid.ok) return valid;
  for (const input of inputs)
    for (const entity of [input.bodyA, input.bodyB]) {
      if (bodyForEntity(entity) === undefined)
        return err(new ManagedPhysicsError('managed-body-missing', { entity }));
    }
  const handles: number[] = [];
  const release = (): boolean => {
    for (const handle of handles) removeNativeConstraint(handle);
    return handles.every((handle) => readRaw().getImpulseJoint(handle) == null);
  };
  try {
    for (const input of inputs) {
      const data = createManagedJointData(rapierModule, input);
      const joint = readRaw().createImpulseJoint(
        data,
        bodyForEntity(input.bodyA),
        bodyForEntity(input.bodyB),
        true,
      );
      handles.push(joint.handle);
      joint.setContactsEnabled(input.contactsEnabled ?? false);
      if (input.kind === 'hinge') joint.setLimits(input.limits[0], input.limits[1]);
    }
    let active = true;
    return ok({
      dispose: () => {
        if (!active) return;
        if (readDisposed()) {
          active = false;
          return;
        }
        if (readSolverPending()) {
          active = false;
          for (const handle of handles) solverRetiredJoints.add(handle);
          return;
        }
        assertActive('disposeManagedJoints');
        active = false;
        if (!release())
          throw new ManagedPhysicsError('managed-physics-failed', {
            reason: 'native managed joint cleanup failed',
            recovery: 'rebuild-required',
          });
      },
    });
  } catch (cause) {
    const released = release();
    return err(
      new ManagedPhysicsError('managed-physics-failed', {
        reason: cause instanceof Error ? cause.message : String(cause),
        recovery: released ? 'old-state-retained' : 'rebuild-required',
      }),
    );
  }
}

export function runCreateDerivedCollider(
  rapierModule: Rapier3DModule,
  readRaw: () => RapierWorld,
  syncIsolationCollider: (collider: RapierCollider, entity: number) => void,
  derivedColliderToShape: Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >,
  colliderFailure: (reason: string) => never,
  removeNativeCollider: (handle: number) => void,
  body: RapierRigidBody,
  shape: DerivedShapeInput,
  previous?: DerivedShapeRecord,
  allowGroups = false,
  sourceTransform?: DerivedPhysicsSourceTransform,
): { readonly handle: number; readonly colliderHandles?: readonly number[] } {
  const { colliders } = createDerivedColliderGroup(
    rapierModule,
    readRaw(),
    body,
    sourceTransform === undefined ? shape : projectSourceOwnedShape(shape, sourceTransform),
    previous,
    allowGroups,
  );
  try {
    for (const [groupIndex, collider] of colliders.entries()) {
      syncIsolationCollider(collider, body.userData);
      derivedColliderToShape.set(collider.handle, {
        entity: body.userData,
        id: shape.id,
        ...(colliders.length > 1 ? { grouped: true, groupIndex } : {}),
      });
    }
    const first = colliders[0];
    if (first === undefined) return colliderFailure('derived shape produced no collider');
    return {
      handle: first.handle,
      ...(colliders.length > 1
        ? {
            colliderHandles: Object.freeze(colliders.map((collider) => collider.handle)),
          }
        : {}),
    };
  } catch (error) {
    for (const collider of colliders) removeNativeCollider(collider.handle);
    throw error;
  }
}

export function runCreateNativeConstraint(
  bodyForEntity: (entity: number) => RapierRigidBody | undefined,
  rapierModule: Rapier3DModule,
  readRaw: () => RapierWorld,
  removeNativeConstraint: (handle: number) => void,
  input: PhysicsConstraintInput,
): Result<{ readonly handle: number }, DerivedPhysicsError> {
  let native: RapierWorld | undefined;
  try {
    const bodyA = bodyForEntity(input.bodyA);
    const bodyB = bodyForEntity(input.bodyB);
    if (bodyA === undefined || bodyB === undefined) {
      return err(
        new DerivedPhysicsError(
          'derived-body-not-found',
          'both constraint endpoints have committed bodies in this PhysicsWorld',
          'reconcile both entities before creating the constraint',
          { constraintId: input.id },
        ),
      );
    }
    const jointData = createDerivedJointData(rapierModule, input);
    native = readRaw().createImpulseJoint(jointData, bodyA, bodyB, true);
    if (input.kind === 'hinge' && input.limits !== undefined)
      native.setLimits(input.limits[0], input.limits[1]);
    return ok({ handle: native.handle });
  } catch (cause) {
    if (native !== undefined) removeNativeConstraint(native.handle);
    return err(
      new DerivedPhysicsError(
        'derived-backend-failed',
        'the selected Rapier joint can be created for both endpoint bodies',
        'repair endpoint state or use a supported spring/hinge input',
        {
          constraintId: input.id,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
}

export function runProcessDerivedCandidates(
  pendingDerivedCandidates: Set<string>,
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  rejectPreparedCandidate: (record: DerivedCandidateRecord, error: DerivedPhysicsError) => void,
  derivedPoisonedEntities: Set<number>,
  derivedGroupRejection: (
    group: readonly DerivedCandidateRecord[],
  ) => DerivedPhysicsError | undefined,
  preflightDerivedBatch: (
    group: readonly DerivedCandidateRecord[],
  ) => DerivedPhysicsError | undefined,
  admitDerivedGroup: (group: readonly DerivedCandidateRecord[]) => boolean,
): boolean {
  if (pendingDerivedCandidates.size === 0) return false;
  const pendingRecords = [...pendingDerivedCandidates]
    .map((id) => derivedCandidates.get(id))
    .filter((record): record is DerivedCandidateRecord => record?.state === 'queued');
  const { ordered, cyclic } = orderDerivedCandidateGroups(pendingRecords);
  for (const { record, key } of cyclic)
    rejectPreparedCandidate(
      record,
      new DerivedPhysicsError(
        'derived-constraint-invalid',
        'cyclic endpoint updates share one batch',
        'submit mutually dependent body replacements together',
        { candidateId: key },
      ),
    );
  let geometryCommitted = false;
  for (const group of ordered) {
    if (derivedPoisonedEntities.size > 0) break;
    const first = group[0];
    if (first === undefined) continue;
    if (
      group.some(
        (record) =>
          record.state !== 'queued' || !pendingDerivedCandidates.has(record.token.candidateId),
      )
    )
      continue;
    // Validate the whole final projection before any native body changes.
    const rejected = derivedGroupRejection(group) ?? preflightDerivedBatch(group);
    if (rejected !== undefined) {
      rejectPreparedCandidate(first, rejected);
      continue;
    }
    if (admitDerivedGroup(group)) geometryCommitted = true;
  }
  return geometryCommitted;
}

export function runStageDerivedRecord(
  motionReadback: import('./body-motion-readback.js').BodyMotionReadback,
  readRaw: () => RapierWorld,
  derivedColliderToShape: Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >,
  groupedContactEvents: import('./grouped-contact-events.js').GroupedContactEvents,
  stageDerivedConstraints: (
    record: DerivedCandidateRecord,
    staged: Map<string, DerivedConstraintRecord>,
  ) => void,
  rapierModule: Rapier3DModule,
  enableCandidateColliders: (record: DerivedCandidateRecord) => void,
  retireReplacedDerivedShapes: (record: DerivedCandidateRecord, old: DerivedBodyRecord) => void,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  applyDerivedMass: (
    body: RapierRigidBody,
    properties: PhysicsMassProperties | undefined,
    previousWorldCom: { x: number; y: number; z: number },
    velocityPolicy: 'preserve' | 'reset',
    authoredAdditionalMass: number,
    entity: number,
    candidateShapes: readonly DerivedShapeInput[],
    candidateColliders: readonly { readonly handle: number }[],
  ) => void,
  derivedConstraints: Map<string, import('./derived-candidate-records.js').DerivedConstraintRecord>,
  retireSupersededConstraints: (record: DerivedCandidateRecord) => void,
  adoptStagedConstraints: (
    record: DerivedCandidateRecord,
    staged: ReadonlyMap<string, DerivedConstraintRecord>,
  ) => void,
  readBackendGeneration: () => number,
  undo: DerivedAdmissionUndo,
): DerivedBodyRecord {
  const { record, body, old } = undo;
  // Invalidation carries no native values and remains valid if admission rolls back.
  motionReadback.enroll(record.input.entity, true);
  motionReadback.notify(record.input.entity);
  primeGroupedContacts(
    readRaw(),
    old,
    candidateShapeRecords(record),
    derivedColliderToShape,
    groupedContactEvents,
  );
  stageDerivedConstraints(record, undo.stagedConstraints);
  if (record.input.bodyType !== undefined)
    body.setBodyType(rapierBodyTypeFromString(rapierModule, record.input.bodyType), true);
  enableCandidateColliders(record);
  // Disable superseded shapes before the mass refresh. They carry no mass
  // after admission, but Rapier still integrates every enabled collider's
  // mass properties, which dominates retiring many voxel bodies at once.
  if (old !== undefined && record.retainedGeometry === undefined)
    retireReplacedDerivedShapes(record, old);
  if (record.input.sourceTransform !== undefined) {
    const transform = sourceNativePose(record.input.sourceTransform);
    body.setTranslation(
      { x: transform.position[0], y: transform.position[1], z: transform.position[2] },
      true,
    );
    body.setRotation(
      {
        x: transform.rotation[0],
        y: transform.rotation[1],
        z: transform.rotation[2],
        w: transform.rotation[3],
      },
      true,
    );
    const entityRecord = entityMap.get(record.input.entity);
    if (entityRecord !== undefined)
      entityRecord.scale = Object.freeze(
        transform.scale.map(Math.abs),
      ) as typeof entityRecord.scale;
  }
  if (record.input.motion?.rotation !== undefined) {
    const [x, y, z, w] = record.input.motion.rotation;
    body.setRotation({ x, y, z, w }, true);
  }
  applyDerivedMass(
    body,
    record.input.massProperties,
    undo.bodyState.worldCom,
    record.input.velocityPolicy ?? 'preserve',
    entityMap.get(record.input.entity)?.additionalMass ?? 0,
    record.input.entity,
    record.input.shapes,
    candidateNativeColliders(record),
  );
  if (record.input.motion !== undefined)
    applyDerivedMotion(
      body,
      record.input.motion,
      entityMap.get(record.input.entity)?.lockRotation === true,
    );
  // Retire joints against this committed revision only. Other queued
  // endpoints may still fail and retain their previous joints.
  if (derivedConstraints.size > 0) retireSupersededConstraints(record);
  adoptStagedConstraints(record, undo.stagedConstraints);
  return {
    entity: record.input.entity,
    sourceKey: record.input.sourceKey,
    generation: readBackendGeneration(),
    revision: record.input.revision,
    bodyType: record.input.bodyType,
    velocityPolicy: record.input.velocityPolicy,
    candidateId: record.token.candidateId,
    inputDigest:
      record.input.inputDigest ??
      sha256(
        canonicalJson({
          sourceKey: record.input.sourceKey,
          revision: record.input.revision,
          shapes: record.input.shapes.map(({ id, revision, kind }) => ({ id, revision, kind })),
        }),
      ),
    shapes: candidateShapeRecords(record),
    massProperties: record.input.massProperties,
    sourceTransform: record.input.sourceTransform,
    constraints: record.retainedGeometry?.constraints ?? [...(record.input.constraints ?? [])],
  };
}

export function runFailDerivedGroup(
  tryRollbackDerivedAdmission: (undo: DerivedAdmissionUndo) => boolean,
  derivedPoisonedEntities: Set<number>,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  derivedPublications: Map<number, import('@forgeax/engine-physics').DerivedPhysicsPublication>,
  rememberDerivedFailure: (
    record: DerivedCandidateRecord,
    error: DerivedPhysicsError,
    recovery: DerivedPhysicsFailure['recovery'],
  ) => void,
  group: readonly DerivedCandidateRecord[],
  failed: DerivedAdmissionUndo,
  committed: DerivedAdmissionUndo[],
  cause: unknown,
): void {
  let restored = tryRollbackDerivedAdmission(failed);
  for (const undo of committed.reverse()) {
    if (!tryRollbackDerivedAdmission(undo)) restored = false;
  }
  const error =
    cause instanceof DerivedPhysicsError
      ? cause
      : new DerivedPhysicsError(
          'derived-backend-failed',
          'derived admission either commits completely or preserves the prior body state',
          'inspect the failure receipt and rebuild the PhysicsWorld if recovery is required',
          {
            entity: failed.record.input.entity,
            candidateId: failed.record.token.candidateId,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        );
  // A thrown consumer callback can have changed ECS state. Native
  // rollback alone cannot certify any member of that combined group.
  if (failed.geometryCommitUncertain) restored = false;
  for (const member of group) {
    if (!restored) {
      derivedPoisonedEntities.add(member.input.entity);
      derivedBodies.delete(member.input.entity);
      derivedPublications.delete(member.input.entity);
    }
    rememberDerivedFailure(member, error, restored ? 'old-state-retained' : 'rebuild-required');
  }
}

export function runApplyDerivedMass(
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  rememberAuthoredDensity: (entity: number, body: RapierRigidBody) => void,
  bodyColliders: (body: RapierRigidBody) => RapierWorld[],
  derivedColliderToShape: Map<
    number,
    { entity: number; id: string; grouped?: boolean; groupIndex?: number }
  >,
  restoreAutomaticMass: (body: RapierRigidBody, additionalMass: number) => void,
  body: RapierRigidBody,
  properties: PhysicsMassProperties | undefined,
  previousWorldCom: { x: number; y: number; z: number },
  velocityPolicy: 'preserve' | 'reset',
  authoredAdditionalMass: number,
  entity: number,
  candidateShapes: readonly DerivedShapeInput[],
  candidateColliders: readonly { readonly handle: number }[],
): void {
  const oldVelocity = body.linvel();
  const oldAngularVelocity = entityMap.get(entity)?.lockRotation
    ? { x: 0, y: 0, z: 0 }
    : body.angvel();
  if (properties?.mode === 'explicit') {
    // Explicit mass is the sole source for this body. Zero every ordinary
    // and derived collider density first so Rapier does not add a hidden
    // density contribution to the authored value.
    rememberAuthoredDensity(entity, body);
    for (const collider of bodyColliders(body)) {
      if (typeof collider.setDensity === 'function') collider.setDensity(0);
    }
    const frame = properties.principalInertiaLocalFrame ?? [0, 0, 0, 1];
    body.setAdditionalMassProperties(
      properties.mass,
      {
        x: properties.centerOfMass[0],
        y: properties.centerOfMass[1],
        z: properties.centerOfMass[2],
      },
      {
        x: properties.principalInertia[0],
        y: properties.principalInertia[1],
        z: properties.principalInertia[2],
      },
      { x: frame[0], y: frame[1], z: frame[2], w: frame[3] },
      true,
    );
    // Rapier defers additional mass updates. Admission reads worldCom below
    // before stepping, so refresh now or COM restoration shifts the body twice.
    body.recomputeMassPropertiesFromColliders();
  } else {
    restoreDerivedDensities(
      bodyColliders(body),
      properties?.mode === 'automatic' ? properties.density : undefined,
      entityMap.get(entity)?.authoredDensity ?? 1,
      candidateShapes,
      candidateColliders,
      derivedColliderToShape,
    );
    restoreAutomaticMass(body, authoredAdditionalMass);
  }
  if (velocityPolicy === 'reset') {
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return;
  }
  const nextWorldCom = body.worldCom();
  const next = preserveCenterOfMassVelocity(
    [oldVelocity.x, oldVelocity.y, oldVelocity.z],
    [oldAngularVelocity.x, oldAngularVelocity.y, oldAngularVelocity.z],
    [previousWorldCom.x, previousWorldCom.y, previousWorldCom.z],
    [nextWorldCom.x, nextWorldCom.y, nextWorldCom.z],
  );
  body.setLinvel({ x: next[0], y: next[1], z: next[2] }, true);
  body.setAngvel(oldAngularVelocity, true);
}

export function runRestoreCommittedMass(
  restoreAutomaticMass: (body: RapierRigidBody, additionalMass: number) => void,
  body: RapierRigidBody,
  previous: DerivedBodyRecord | undefined,
  automaticAdditionalMass: number,
): void {
  if (previous?.massProperties?.mode === 'explicit') {
    const frame = previous.massProperties.principalInertiaLocalFrame ?? [0, 0, 0, 1];
    body.setAdditionalMassProperties(
      previous.massProperties.mass,
      {
        x: previous.massProperties.centerOfMass[0],
        y: previous.massProperties.centerOfMass[1],
        z: previous.massProperties.centerOfMass[2],
      },
      {
        x: previous.massProperties.principalInertia[0],
        y: previous.massProperties.principalInertia[1],
        z: previous.massProperties.principalInertia[2],
      },
      { x: frame[0], y: frame[1], z: frame[2], w: frame[3] },
      true,
    );
    body.recomputeMassPropertiesFromColliders();
    return;
  }
  restoreAutomaticMass(body, automaticAdditionalMass);
}

export function runValidateConstraintDependencies(
  derivedPoisonedEntities: Set<number>,
  entityMap: Map<number, import('./physics-entity-records.js').PhysicsEntityRecord>,
  sourceForEntity: (entity: number) => DerivedBodySource,
  input: PhysicsConstraintInput,
  candidate?: DerivedPhysicsCandidateInput,
  sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
): DerivedPhysicsError | undefined {
  const endpoints = [
    [input.bodyA, input.bodyASource],
    [input.bodyB, input.bodyBSource],
  ] as const;
  for (const [entity, dependency] of endpoints) {
    if (derivedPoisonedEntities.has(entity)) {
      return new DerivedPhysicsError(
        'derived-recovery-invalid',
        'constraint endpoints belong to a healthy PhysicsWorld state',
        'rebuild the PhysicsWorld before recreating constraints',
        { constraintId: input.id, entity },
      );
    }
    if (!entityMap.has(entity)) {
      return new DerivedPhysicsError(
        'derived-body-not-found',
        'both constraint endpoint entities have committed bodies',
        'reconcile both endpoint entities before creating or migrating a constraint',
        { constraintId: input.id, entity },
      );
    }
    const expected =
      candidate !== undefined && entity === candidate.entity
        ? { sourceKey: candidate.sourceKey, revision: candidate.revision }
        : (sourceOverrides?.get(entity) ?? sourceForEntity(entity));
    if (dependency.sourceKey !== expected.sourceKey || dependency.revision !== expected.revision) {
      return new DerivedPhysicsError(
        'derived-constraint-stale',
        'constraint endpoint sourceKey and revision match the committed endpoint',
        'refresh both endpoint dependencies and retry the complete candidate',
        {
          constraintId: input.id,
          entity,
          expected: `${expected.sourceKey}@${expected.revision}`,
          actual: `${dependency.sourceKey}@${dependency.revision}`,
        },
      );
    }
  }
  return undefined;
}

export function runValidateDerivedAdmission(
  validateConstraintDependencies: (
    input: PhysicsConstraintInput,
    candidate?: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ) => DerivedPhysicsError | undefined,
  derivedConstraints: Map<string, import('./derived-candidate-records.js').DerivedConstraintRecord>,
  input: DerivedPhysicsCandidateInput,
  sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
): DerivedPhysicsError | undefined {
  if (
    input.bodyType !== undefined &&
    input.bodyType !== 'static' &&
    input.bodyType !== 'dynamic' &&
    input.bodyType !== 'kinematic'
  ) {
    return new DerivedPhysicsError(
      'derived-candidate-invalid',
      'candidate bodyType is one of static, dynamic, or kinematic',
      'repair the motion type before admission',
      { entity: input.entity, actual: input.bodyType },
    );
  }
  const seen = new Set<string>();
  for (const constraint of input.constraints ?? []) {
    const validation = validateConstraintInput(constraint);
    if (!validation.ok) return validation.error;
    if (seen.has(constraint.id)) {
      return new DerivedPhysicsError(
        'derived-constraint-invalid',
        'candidate contains one constraint update per identity',
        'merge duplicate updates before admission',
        { entity: input.entity, constraintId: constraint.id },
      );
    }
    seen.add(constraint.id);
    const dependencyError = validateConstraintDependencies(constraint, input, sourceOverrides);
    if (dependencyError !== undefined) return dependencyError;
    const existing = derivedConstraints.get(constraint.id);
    if (existing !== undefined && constraint.revision <= existing.input.revision) {
      return new DerivedPhysicsError(
        'derived-constraint-stale',
        'migrated constraint revision advances the committed revision',
        'submit both endpoint dependencies and a newer constraint revision',
        {
          entity: input.entity,
          constraintId: constraint.id,
          expected: `>${existing.input.revision}`,
          actual: constraint.revision,
        },
      );
    }
  }
  return undefined;
}

export function runInstallDerivedConstraint(
  pendingDerivedMutation: (operation: string) => DerivedPhysicsError | undefined,
  assertActive: (operation: string) => void,
  validateConstraintDependencies: (
    input: PhysicsConstraintInput,
    candidate?: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ) => DerivedPhysicsError | undefined,
  pendingDerivedSources: () => Map<number, DerivedBodySource>,
  derivedConstraints: Map<string, import('./derived-candidate-records.js').DerivedConstraintRecord>,
  createNativeConstraint: (
    input: PhysicsConstraintInput,
  ) => Result<{ readonly handle: number }, DerivedPhysicsError>,
  removeNativeConstraint: (handle: number) => void,
  input: PhysicsConstraintInput,
  updating: boolean,
): ReturnType<NonNullable<PhysicsWorld['createDerivedConstraint']>> {
  const pending = pendingDerivedMutation(
    updating ? 'updateDerivedConstraint' : 'createDerivedConstraint',
  );
  if (pending) return err(pending);
  assertActive(updating ? 'updateDerivedConstraint' : 'createDerivedConstraint');
  const validation = validateConstraintInput(input);
  if (!validation.ok) return validation;
  const dependencyError = validateConstraintDependencies(input, undefined, pendingDerivedSources());
  if (dependencyError !== undefined) return err(dependencyError);
  const existing = derivedConstraints.get(input.id);
  if (existing !== undefined && !updating) {
    return err(
      new DerivedPhysicsError(
        'derived-constraint-stale',
        'constraint identity is not already committed when creating it',
        'call updateDerivedConstraint with a newer revision',
        { constraintId: input.id },
      ),
    );
  }
  if (existing !== undefined && input.revision <= existing.input.revision) {
    return err(
      new DerivedPhysicsError(
        'derived-constraint-stale',
        'constraint revision advances monotonically',
        'submit a newer constraint revision',
        {
          constraintId: input.id,
          actual: input.revision,
          expected: `>${existing.input.revision}`,
        },
      ),
    );
  }
  const native = createNativeConstraint(input);
  if (!native.ok) return native;
  if (existing !== undefined) removeNativeConstraint(existing.handle);
  derivedConstraints.set(input.id, { input: { ...input }, handle: native.value.handle });
  return ok({ id: input.id, revision: input.revision });
}

function resolveAdmissionCredentials(
  derivedCandidates: Map<string, import('./derived-candidate-records.js').DerivedCandidateRecord>,
  physicsOwner: {},
  readBackendGeneration: () => number,
  candidates: readonly DerivedPhysicsCandidate[],
  records: DerivedCandidateRecord[],
  sources: Map<number, DerivedBodySource>,
  constraints: Set<string>,
  invalid: (reason: string) => DerivedPhysicsError,
): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidates']>> | undefined {
  for (const candidate of candidates) {
    const record = derivedCandidates.get(candidate.candidateId);
    if (
      record === undefined ||
      candidate.owner !== physicsOwner ||
      candidate.generation !== readBackendGeneration() ||
      record.state !== 'ready'
    )
      return err(invalid('batch member is not a current prepared candidate'));
    if (sources.has(record.input.entity)) return err(invalid('duplicate body'));
    for (const constraint of record.input.constraints ?? []) {
      if (constraints.has(constraint.id)) return err(invalid('duplicate constraint update'));
      constraints.add(constraint.id);
    }
    records.push(record);
    sources.set(record.input.entity, {
      sourceKey: record.input.sourceKey,
      revision: record.input.revision,
    });
  }

  return undefined;
}

function enqueueCurrentDerivedCandidate(
  pendingDerivedSources: () => Map<number, DerivedBodySource>,
  rejectPreparedCandidate: (record: DerivedCandidateRecord, error: DerivedPhysicsError) => void,
  derivedBodies: Map<number, import('./derived-candidate-records.js').DerivedBodyRecord>,
  pendingDerivedCandidates: Set<string>,
  revalidatePendingDerivedCandidates: (
    admitted: DerivedCandidateRecord,
  ) => DerivedPhysicsError | undefined,
  candidate: DerivedPhysicsCandidate,
  validateOnly: boolean,
  record: DerivedCandidateRecord,
  validateDerivedAdmission: (
    input: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ) => DerivedPhysicsError | undefined,
  projection?: DerivedAdmissionProjection,
): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
  const queuedSources = projection?.queuedSources ?? pendingDerivedSources();
  const newestPendingRevision = queuedSources.get(record.input.entity)?.revision;
  const pendingSources =
    projection?.sources ??
    new Map(queuedSources).set(record.input.entity, {
      sourceKey: record.input.sourceKey,
      revision: record.input.revision,
    });
  const admissionError = validateDerivedAdmission(record.input, pendingSources);
  if (admissionError !== undefined) {
    rejectPreparedCandidate(record, admissionError);
    return err(admissionError);
  }
  const active = derivedBodies.get(record.input.entity);
  if (
    (record.sharedGeometry !== undefined && active !== record.sharedGeometry.owner) ||
    (record.retainedGeometry !== undefined
      ? active !== record.retainedGeometry
      : active !== undefined && record.input.revision <= active.revision)
  ) {
    const stale = new DerivedPhysicsError(
      'derived-candidate-stale',
      'candidate revision is newer than the committed shape revision',
      'advance the consumer revision before admission',
      { entity: record.input.entity, candidateId: candidate.candidateId },
    );
    rejectPreparedCandidate(record, stale);
    return err(stale);
  }
  if (newestPendingRevision !== undefined && record.input.revision <= newestPendingRevision) {
    const stale = new DerivedPhysicsError(
      'derived-candidate-stale',
      'candidate revision advances every already queued revision for the body',
      'admit only the newest body revision at a fixed-step boundary',
      {
        entity: record.input.entity,
        candidateId: candidate.candidateId,
        expected: `>${newestPendingRevision}`,
        actual: record.input.revision,
      },
    );
    rejectPreparedCandidate(record, stale);
    return err(stale);
  }
  if (validateOnly) return ok(record.token);
  record.state = 'queued';
  pendingDerivedCandidates.add(candidate.candidateId);
  // A batch already projects its complete source roster. Revalidate after
  // the whole synchronous enqueue, rather than after each partial prefix.
  if (projection === undefined) {
    const queueError = revalidatePendingDerivedCandidates(record);
    if (queueError !== undefined) return err(queueError);
  }
  return ok(record.token);
}
