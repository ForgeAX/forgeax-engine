import {
  cloneDerivedPhysicsInput,
  DERIVED_PHYSICS_LIMITS,
  type DerivedBodyTypeCandidateInput,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  DerivedPhysicsError,
  type DerivedPhysicsPublication,
  estimateDerivedPhysicsInputBytes,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { World as NativeWorld } from '../pkg/rapier.mjs';
import type {
  DerivedAdmissionBatch,
  DerivedBodyRecord,
  DerivedCandidateRecord,
  DerivedShapeRecord,
} from './derived-candidate-records';

interface PreparationOwner {
  readonly identity: object;
  readonly generation: number;
  readonly healthy: boolean;
  readonly bodies: ReadonlyMap<number, DerivedBodyRecord>;
  readonly publications: ReadonlyMap<number, DerivedPhysicsPublication>;
  readonly candidates: ReadonlyMap<string, DerivedCandidateRecord>;
  readonly pending: ReadonlySet<string>;
  readonly hasBody: (entity: number) => boolean;
  readonly nextId: (entity: number, revision: number) => string;
  readonly retain: (record: DerivedCandidateRecord) => Result<void, DerivedPhysicsError>;
  readonly release: (candidateId: string) => void;
}

/** Borrow the existing Native owner; no separate candidate ledger or collider ownership. */
export function prepareDerivedBodyTypes(
  owner: PreparationOwner,
  inputs: readonly DerivedBodyTypeCandidateInput[],
): Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError> {
  const records: DerivedCandidateRecord[] = [];
  const batch: DerivedAdmissionBatch = Object.freeze({ records });
  const invalid = (reason: string) =>
    new DerivedPhysicsError(
      'derived-candidate-invalid',
      'one type-only group names distinct current owned body publications',
      'read each current getDerivedPublication receipt and prepare the complete group',
      { reason },
    );
  let complete = false;
  try {
    const count = Array.isArray(inputs) ? inputs.length : 0;
    if (
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > DERIVED_PHYSICS_LIMITS.maxBatchCandidates
    )
      return err(invalid('invalid batch size'));
    const preparations = new Set(
      [...owner.candidates.values()].map((record) => record.batch ?? record),
    );
    if (preparations.size >= DERIVED_PHYSICS_LIMITS.maxCandidates)
      return err(
        new DerivedPhysicsError(
          'derived-candidate-budget-exceeded',
          'type-only preparations share the existing in-flight credit budget',
          'cancel or publish another preparation before retrying',
          { reason: 'in-flight' },
        ),
      );
    const entities = new Set<number>();
    for (let index = 0; index < count; index++) {
      const input = inputs[index];
      if (input == null) return err(invalid('missing member'));
      const publication = input.publication;
      const bodyType = input.bodyType;
      if (
        publication == null ||
        owner.publications.get(publication.entity) !== publication ||
        publication.generation !== owner.generation
      )
        return err(
          new DerivedPhysicsError(
            'derived-candidate-stale',
            'the exact current publication belongs to this PhysicsWorld generation',
            'read the current publication from the owning PhysicsWorld',
          ),
        );
      if (records.some((record) => owner.candidates.get(record.token.candidateId) !== record))
        return err(invalid('the preparation was invalidated while reading caller inputs'));
      const active = owner.bodies.get(publication.entity);
      if (
        active === undefined ||
        active.candidateId !== publication.candidateId ||
        active.revision !== publication.revision ||
        entities.has(publication.entity)
      )
        return err(invalid('missing, replaced or duplicate committed body'));
      if (bodyType !== 'static' && bodyType !== 'dynamic' && bodyType !== 'kinematic')
        return err(invalid('invalid body type'));
      if (!owner.healthy)
        return err(
          new DerivedPhysicsError(
            'derived-recovery-invalid',
            'type-only updates require a healthy committed PhysicsWorld',
            'rebuild the PhysicsWorld before retrying',
          ),
        );
      if (!owner.hasBody(active.entity))
        return err(
          new DerivedPhysicsError(
            'derived-body-not-found',
            'the accepted body still has a live native owner',
            'reconcile physics before retrying',
          ),
        );
      for (const id of owner.pending)
        if (owner.candidates.get(id)?.input.entity === active.entity)
          return err(
            new DerivedPhysicsError(
              'derived-candidate-pending',
              'the body has no queued replacement',
              'wait for its current preparation to publish',
            ),
          );
      const privateInput: DerivedPhysicsCandidateInput = Object.freeze({
        entity: active.entity,
        revision: active.revision,
        sourceKey: active.sourceKey,
        shapes: Object.freeze(active.shapes.map((shape) => shape.input)),
        bodyType,
        ...(active.massProperties === undefined ? {} : { massProperties: active.massProperties }),
        velocityPolicy: 'preserve',
      });
      const publicInput = cloneDerivedPhysicsInput(privateInput);
      if (!publicInput.ok) return publicInput;
      const bytes = estimateDerivedPhysicsInputBytes(privateInput);
      const candidateId = owner.nextId(active.entity, active.revision);
      const token: DerivedPhysicsCandidate = Object.freeze({
        candidateId,
        generation: owner.generation,
        owner: owner.identity,
        input: publicInput.value,
        state: 'ready',
      });
      const record: DerivedCandidateRecord = {
        token,
        nativeColliders: [],
        input: privateInput,
        retainedGeometry: active,
        bytes,
        state: 'ready',
        batch,
      };
      const retained = owner.retain(record);
      if (!retained.ok) return retained;
      records.push(record);
      entities.add(active.entity);
    }
    Object.freeze(records);
    complete = true;
    return ok(Object.freeze(records.map((record) => record.token)));
  } finally {
    if (!complete) for (const record of records) owner.release(record.token.candidateId);
  }
}

/** Retained handles must still belong to the same native body at the commit fence. */
export function retainedDerivedGeometryCurrent(
  record: DerivedCandidateRecord,
  active: DerivedBodyRecord | undefined,
  world: NativeWorld,
  bodyHandle: number | undefined,
): boolean {
  const retained = record.retainedGeometry;
  return (
    retained === undefined ||
    (retained === active &&
      bodyHandle !== undefined &&
      retained.shapes.every(
        (shape) => world.getCollider(shape.colliderHandle)?.parent()?.handle === bodyHandle,
      ))
  );
}

export function candidateNativeColliders(
  record: DerivedCandidateRecord,
): readonly { readonly handle: number }[] {
  return (
    record.retainedGeometry?.shapes.map((shape) => ({ handle: shape.colliderHandle })) ??
    record.nativeColliders
  );
}

export function candidateShapeRecords(
  record: DerivedCandidateRecord,
): readonly DerivedShapeRecord[] {
  return (
    record.retainedGeometry?.shapes ??
    record.input.shapes.map((input, index) => ({
      input: input as DerivedShapeRecord['input'],
      colliderHandle: record.nativeColliders[index]?.handle as number,
    }))
  );
}
