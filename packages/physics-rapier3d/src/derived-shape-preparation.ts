import type { World } from '@forgeax/engine-ecs';
import {
  cloneDerivedPhysicsInput,
  DERIVED_PHYSICS_LIMITS,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  DerivedPhysicsError,
  type DerivedPhysicsSourceTransform,
  type DerivedShapeInput,
  estimateDerivedPhysicsInputBytes,
  type PhysicsWorld,
  validateMassProperties,
} from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';
import type {
  DerivedAdmissionBatch,
  DerivedBodyRecord,
  DerivedCandidateRecord,
  DerivedShapeRecord,
} from './derived-candidate-records.js';
import { stageDerivedColliders } from './derived-collider.js';
import type {
  PhysicsEntityRecord,
  RapierRigidBody,
  RapierWorld,
} from './physics-entity-records.js';
import { samePhysicsValue } from './physics-sync-descriptor.js';

export interface DerivedShapePreparationOwner {
  readonly worldIdentity: World | undefined;
  readonly entityMap: ReadonlyMap<number, PhysicsEntityRecord>;
  readonly derivedPoisonedEntities: ReadonlySet<number>;
  readonly derivedBodies: ReadonlyMap<number, DerivedBodyRecord>;
  readonly pendingDerivedCandidates: ReadonlySet<string>;
  readonly derivedCandidates: Map<string, DerivedCandidateRecord>;
  readonly derivedColliderToShape: ReadonlyMap<number, { readonly grouped?: boolean }>;
  readonly raw: RapierWorld;
  readonly backendGeneration: number;
  readonly physicsOwner: object;
  nativeExecuting: boolean;
  candidateSequence: number;
  derivedCandidateBytes: number;
  copyInput(input: DerivedPhysicsCandidateInput): ReturnType<typeof cloneDerivedPhysicsInput>;
  bodyForEntity(entity: number): RapierRigidBody | undefined;
  pendingDerivedMutation(operation: string): DerivedPhysicsError | undefined;
  assertActive(operation: string): void;
  prepareDerivedShapeCandidateInternal(
    input: DerivedPhysicsCandidateInput,
    batch?: DerivedAdmissionBatch,
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>>;
  releaseDerivedCandidate(id: string): void;
  removeNativeCollider(handle: number): void;
  createDerivedCollider(
    body: RapierRigidBody,
    shape: DerivedShapeInput,
    previous?: DerivedShapeRecord,
    allowGroups?: boolean,
    sourceTransform?: DerivedPhysicsSourceTransform,
  ): { readonly handle: number; readonly colliderHandles?: readonly number[] };
}

export function prepareDerivedShapeCandidates(
  owner: DerivedShapePreparationOwner,
  inputs: readonly DerivedPhysicsCandidateInput[],
): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidates']>> {
  const pending = owner.pendingDerivedMutation('prepareDerivedShapeCandidates');
  if (pending) return err(pending);
  owner.assertActive('prepareDerivedShapeCandidates');
  const records: DerivedCandidateRecord[] = [];
  const batch: DerivedAdmissionBatch = Object.freeze({ records });
  let complete = false;
  // Reuse the native execution fence while caller inputs are copied and
  // disabled colliders are allocated; no partial roster can be observed.
  owner.nativeExecuting = true;
  try {
    const count = Array.isArray(inputs) ? inputs.length : 0;
    if (
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > DERIVED_PHYSICS_LIMITS.maxBatchCandidates
    )
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          `one preparation declares 1 to ${DERIVED_PHYSICS_LIMITS.maxBatchCandidates} bodies`,
          'submit one bounded complete replacement roster',
        ),
      );
    const entities = new Set<number>();
    const constraints = new Set<string>();
    for (let index = 0; index < count; index++) {
      const input = inputs[index];
      if (input === undefined)
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            'every declared batch member is present',
            'submit a complete dense input roster',
          ),
        );
      if (entities.has(input.entity))
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            'one preparation names each body once',
            'combine each body replacement before preparation',
            { entity: input.entity },
          ),
        );
      const prepared = owner.prepareDerivedShapeCandidateInternal(input, batch);
      if (!prepared.ok) return prepared;
      const record = owner.derivedCandidates.get(prepared.value.candidateId);
      if (record === undefined)
        return err(
          new DerivedPhysicsError(
            'derived-candidate-not-found',
            'the prepared member remains owned by this PhysicsWorld',
            'prepare the complete group after native ownership is restored',
          ),
        );
      records.push(record);
      entities.add(record.input.entity);
      for (const constraint of record.input.constraints ?? []) {
        if (constraints.has(constraint.id))
          return err(
            new DerivedPhysicsError(
              'derived-candidate-invalid',
              'one preparation names each constraint update once',
              'combine constraint updates in the complete roster',
              { constraintId: constraint.id },
            ),
          );
        constraints.add(constraint.id);
      }
    }
    Object.freeze(records);
    complete = true;
    return ok(Object.freeze(records.map((record) => record.token)));
  } finally {
    try {
      if (!complete)
        for (const record of records) {
          for (const collider of record.nativeColliders)
            owner.removeNativeCollider(collider.handle);
          record.state = 'cancelled';
          owner.releaseDerivedCandidate(record.token.candidateId);
        }
    } finally {
      owner.nativeExecuting = false;
    }
  }
}

export function prepareDerivedShapeCandidate(
  owner: DerivedShapePreparationOwner,
  input: DerivedPhysicsCandidateInput,
  batch?: DerivedAdmissionBatch,
): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>> {
  if (input.worldIdentity !== undefined && input.worldIdentity !== owner.worldIdentity) {
    return err(
      new DerivedPhysicsError(
        'derived-world-mismatch',
        'candidate belongs to the ECS World bound to this PhysicsWorld',
        'submit the candidate to the PhysicsWorld that owns its entity',
        { entity: input.entity },
      ),
    );
  }
  const hasEntityBody = owner.entityMap.has(input.entity);
  const refuseExistingBodyCandidate = () => {
    if (hasEntityBody) {
      if (owner.derivedPoisonedEntities.has(input.entity)) {
        return err(
          new DerivedPhysicsError(
            'derived-recovery-invalid',
            'the entity has a recoverable committed native PhysicsWorld state',
            'rebuild the PhysicsWorld from the last portable snapshot before retrying',
            { entity: input.entity },
          ),
        );
      }
      const active = owner.derivedBodies.get(input.entity);
      if (active !== undefined && input.revision <= active.revision) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-stale',
            'candidate revision is newer than the committed derived shape revision',
            'read the latest publication and advance the consumer revision',
            { entity: input.entity, actual: input.revision, expected: `>${active.revision}` },
          ),
        );
      }
      const refusePendingBodyCandidate = () => {
        for (const pendingId of owner.pendingDerivedCandidates) {
          const pending = owner.derivedCandidates.get(pendingId);
          if (pending?.input.entity === input.entity) {
            return err(
              new DerivedPhysicsError(
                'derived-candidate-pending',
                'one body has at most one queued derived-shape candidate',
                'cancel or let the current candidate publish before preparing another',
                { entity: input.entity, candidateId: pendingId },
              ),
            );
          }
        }
        return undefined;
      };
      const pendingCandidateFailure = refusePendingBodyCandidate();
      if (pendingCandidateFailure !== undefined) return pendingCandidateFailure;
    }
    return undefined;
  };
  const existingBodyFailure = refuseExistingBodyCandidate();
  if (existingBodyFailure !== undefined) return existingBodyFailure;
  const copied = owner.copyInput(input);
  if (!copied.ok) return copied;
  const validateSourceOwnership = () => {
    const activeSource = owner.derivedBodies.get(copied.value.entity);
    if (
      activeSource?.sourceTransform !== undefined &&
      copied.value.sourceTransform === undefined &&
      (copied.value.shapes.length > 0 ||
        (copied.value.bodyType !== undefined && copied.value.bodyType !== 'static'))
    )
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'a source-owned body remains source-owned or is explicitly retired before pose transfer',
          'publish a complete replacement with a valid source transform, or retire the accepted source',
          {
            entity: copied.value.entity,
            actual: { sourceKey: activeSource.sourceKey, revision: copied.value.revision },
          },
        ),
      );
    return undefined;
  };
  const ownershipFailure = validateSourceOwnership();
  if (ownershipFailure !== undefined) return ownershipFailure;
  const mass = validateMassProperties(copied.value.massProperties);
  if (!mass.ok) return mass;
  if (!hasEntityBody) {
    return err(
      new DerivedPhysicsError(
        'derived-body-not-found',
        'candidate entity has a committed body in this PhysicsWorld',
        'wait for physics reconciliation before preparing derived shapes',
        { entity: input.entity },
      ),
    );
  }
  const candidateBytes = estimateDerivedPhysicsInputBytes(copied.value);
  if (owner.derivedCandidateBytes + candidateBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        `candidate source and native geometry POD fit ${DERIVED_PHYSICS_LIMITS.maxCandidateBytes} bytes`,
        'publish or cancel another candidate, or reduce the candidate geometry',
        {
          entity: input.entity,
          actual: owner.derivedCandidateBytes + candidateBytes,
          reason:
            candidateBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes ? 'oversized' : 'in-flight',
        },
      ),
    );
  }
  const body = owner.bodyForEntity(input.entity);
  if (body === undefined) {
    return err(
      new DerivedPhysicsError(
        'derived-body-not-found',
        'candidate entity resolves to a live native body',
        'wait for the next ECS physics sync',
        { entity: input.entity },
      ),
    );
  }
  // Recheck the group's preparation credit after potentially reentrant getters.
  const first = batch?.records[0];
  const refusePreparationCapacity = () => {
    if (
      first === undefined ||
      owner.derivedCandidates.get(first.token.candidateId) !== first ||
      first.batch !== batch
    ) {
      const preparations = new Set(
        [...owner.derivedCandidates.values()].map((record) => record.batch ?? record),
      );
      if (
        (batch === undefined || !preparations.has(batch)) &&
        preparations.size >= DERIVED_PHYSICS_LIMITS.maxCandidates
      ) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-budget-exceeded',
            `this PhysicsWorld keeps at most ${DERIVED_PHYSICS_LIMITS.maxCandidates} in-flight preparations`,
            'cancel or publish an existing candidate before preparing another',
            { entity: input.entity, actual: preparations.size, reason: 'in-flight' },
          ),
        );
      }
    }
    return undefined;
  };
  const capacityFailure = refusePreparationCapacity();
  if (capacityFailure !== undefined) return capacityFailure;
  const candidateInput = Object.freeze({
    ...copied.value,
    ...(mass.value === undefined ? {} : { massProperties: mass.value }),
  });
  const privateInput = candidateInput; // Admission retains the detached first copy.
  // Publication checks read entity/revision, not geometry. Keep their public
  // metadata detached, but copy the already isolated Shape buffers only if
  // a caller actually inspects them. Admission always owns privateInput.
  const publicInput = cloneDerivedPhysicsInput({ ...privateInput, shapes: [] });
  if (!publicInput.ok) return publicInput;
  let inspectedShapes: DerivedPhysicsCandidateInput['shapes'] | undefined;
  const tokenInput = Object.freeze({
    ...publicInput.value,
    get shapes() {
      inspectedShapes ??= cloneDerivedPhysicsInput({
        entity: privateInput.entity,
        revision: privateInput.revision,
        sourceKey: privateInput.sourceKey,
        shapes: privateInput.shapes,
      }).unwrap().shapes;
      return inspectedShapes;
    },
  });
  let staged: ReturnType<typeof stageDerivedColliders>;
  try {
    const oldBody = owner.derivedBodies.get(input.entity);
    const geometryOwner =
      oldBody !== undefined &&
      samePhysicsValue(oldBody.sourceTransform, privateInput.sourceTransform)
        ? oldBody
        : undefined;
    staged = stageDerivedColliders(
      privateInput.shapes,
      geometryOwner,
      (shape, previous) =>
        owner.createDerivedCollider(
          body,
          shape,
          previous,
          privateInput.bodyType === 'dynamic' && privateInput.massProperties?.mode === 'explicit',
          privateInput.sourceTransform,
        ),
      (handle) =>
        (!owner.derivedColliderToShape.get(handle)?.grouped ||
          (privateInput.bodyType === 'dynamic' &&
            privateInput.massProperties?.mode === 'explicit')) &&
        owner.raw.colliders.contains(handle) &&
        owner.raw.getCollider(handle)?.handle === handle &&
        owner.raw.getCollider(handle)?.parent()?.handle === body.handle,
      (handle) => owner.removeNativeCollider(handle),
    );
  } catch (cause) {
    return err(
      new DerivedPhysicsError(
        'derived-backend-failed',
        'Rapier can create every candidate collider while it remains disabled',
        'reduce the candidate or rebuild the PhysicsWorld after a native failure',
        { entity: input.entity, reason: cause instanceof Error ? cause.message : String(cause) },
      ),
    );
  }
  const candidateId = `derived:${owner.backendGeneration}:${input.entity}:${++owner.candidateSequence}:${input.revision}`;
  let record: DerivedCandidateRecord;
  const token: DerivedPhysicsCandidate = Object.freeze({
    candidateId,
    generation: owner.backendGeneration,
    owner: owner.physicsOwner,
    input: tokenInput,
    get state() {
      return record.state;
    },
  });
  record = {
    token,
    ...staged,
    input: privateInput,
    bytes: candidateBytes,
    state: 'ready',
    ...(batch === undefined ? {} : { batch }),
  };
  owner.derivedCandidates.set(candidateId, record);
  owner.derivedCandidateBytes += candidateBytes;
  return ok(token);
}
