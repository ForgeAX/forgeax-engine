import {
  type BodyMotion,
  type DerivedPhysicsAdmissionGuard,
  type DerivedPhysicsAdmissionState,
  type DerivedPhysicsCandidate,
  DerivedPhysicsError,
  type DerivedPhysicsMotion,
  type DerivedShapeState,
  type PhysicsConstraintInput,
  type PhysicsQuaternion,
  type PhysicsVector,
} from '@forgeax/engine-physics';
import { err, type Result } from '@forgeax/engine-types';
import type { RigidBody } from '../pkg/rapier.mjs';
import type {
  DerivedBodyRecord,
  DerivedBodySource,
  DerivedCandidateRecord,
  DerivedConstraintRecord,
} from './derived-candidate-records.js';

export function readNativeBodyMotion(body: RigidBody): BodyMotion {
  const p = body.translation(),
    q = body.rotation(),
    v = body.linvel(),
    a = body.angvel();
  return {
    position: [p.x, p.y, p.z],
    rotation: [q.x, q.y, q.z, q.w],
    linearVelocity: [v.x, v.y, v.z],
    angularVelocity: [a.x, a.y, a.z],
    sleeping: body.isSleeping(),
  };
}

export function readNativeDerivedMotion(body: RigidBody): DerivedPhysicsMotion {
  const com = body.worldCom(),
    linear = body.linvel(),
    angular = body.angvel(),
    rotation = body.rotation();
  return Object.freeze({
    centerOfMass: [com.x, com.y, com.z] as PhysicsVector,
    linearVelocity: [linear.x, linear.y, linear.z] as PhysicsVector,
    angularVelocity: [angular.x, angular.y, angular.z] as PhysicsVector,
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as PhysicsQuaternion,
  });
}

export function currentDerivedAdmission(
  active: DerivedCandidateRecord | undefined,
  entity: number | undefined,
  fixedStep: () => number,
) {
  const record =
    entity === undefined
      ? active
      : (active?.batch?.records.find((item) => item.input.entity === entity) ??
        (active?.input.entity === entity ? active : undefined));
  return record === undefined
    ? undefined
    : { entity: record.input.entity, revision: record.input.revision, fixedStep: fixedStep() };
}

interface PreflightHost {
  readonly generation: number;
  readonly bodies: ReadonlyMap<number, DerivedBodyRecord>;
  readonly records: ReadonlyMap<string, DerivedCandidateRecord>;
  readonly pending: ReadonlySet<string>;
  body(entity: number): RigidBody | undefined;
  execute(states: readonly DerivedPhysicsAdmissionState[]): unknown;
  validate(record: DerivedCandidateRecord): DerivedPhysicsError | undefined;
}

export function preflightDerivedBatch(
  group: readonly DerivedCandidateRecord[],
  host: PreflightHost,
): DerivedPhysicsError | undefined {
  let reason = 'admission guard rejected';
  try {
    const states: readonly DerivedPhysicsAdmissionState[] = Object.freeze(
      group.map((record) => {
        const body = host.body(record.input.entity);
        if (body === undefined) throw new Error('admission guard body disappeared');
        const old = host.bodies.get(record.input.entity),
          motion = readNativeBodyMotion(body);
        return Object.freeze({
          entity: record.input.entity,
          candidateId: record.token.candidateId,
          generation: host.generation,
          source:
            old === undefined
              ? undefined
              : Object.freeze({ sourceKey: old.sourceKey, revision: old.revision }),
          bodyType: body.isDynamic()
            ? ('dynamic' as const)
            : body.isFixed()
              ? ('static' as const)
              : ('kinematic' as const),
          position: Object.freeze(motion.position),
          rotation: Object.freeze(motion.rotation),
          linearVelocity: Object.freeze(motion.linearVelocity),
          angularVelocity: Object.freeze(motion.angularVelocity),
          sleeping: motion.sleeping,
        });
      }),
    );
    const accepted = host.execute(states);
    if (accepted instanceof Promise)
      void Promise.prototype.then.call(accepted, undefined, () => undefined);
    if (accepted === true) {
      for (const record of group) {
        if (
          host.records.get(record.token.candidateId) !== record ||
          record.state !== 'queued' ||
          !host.pending.has(record.token.candidateId)
        ) {
          reason = 'admission guard roster changed';
          break;
        }
        const invalid = host.validate(record);
        if (invalid !== undefined) return invalid;
      }
      if (reason === 'admission guard rejected') return;
    }
  } catch (cause) {
    reason = cause instanceof Error ? cause.message : String(cause);
  }
  return new DerivedPhysicsError(
    'derived-candidate-stale',
    'the complete current Native roster passes its synchronous admission guard',
    'retain old state and prepare again after the current Game conditions permit admission',
    { reason },
  );
}

export function copyDerivedShapeInputs(body: DerivedBodyRecord) {
  return Object.freeze(
    body.shapes.map((shape) => ({
      ...shape.input,
      ...(shape.input.kind === 'heightfield'
        ? {
            heights: new Float32Array(shape.input.heights),
            scale: [...shape.input.scale] as PhysicsVector,
          }
        : shape.input.kind === 'voxels'
          ? {
              regions: new Int32Array(shape.input.regions),
              voxelSize: [...shape.input.voxelSize] as PhysicsVector,
            }
          : { pieces: shape.input.pieces.map((piece) => new Float32Array(piece)) }),
      origin: [...shape.input.origin] as PhysicsVector,
      rotation: [...shape.input.rotation] as PhysicsQuaternion,
    })),
  );
}

export function queueGuardedDerivedAdmission(
  guard: DerivedPhysicsAdmissionGuard,
  queue: () => Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError>,
  records: ReadonlyMap<string, DerivedCandidateRecord>,
): Result<readonly DerivedPhysicsCandidate[], DerivedPhysicsError> {
  if (typeof guard !== 'function')
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'a synchronous admission guard is a function',
        'provide a synchronous read-only predicate',
      ),
    );
  const result = queue();
  if (!result.ok || result.value.length === 0) return result;
  const first =
    result.value[0] === undefined ? undefined : records.get(result.value[0].candidateId);
  if (first?.batch === undefined) throw new Error('queued derived admission group disappeared');
  const batch = Object.freeze({ ...first.batch, preflight: guard });
  for (const record of batch.records) record.batch = batch;
  return result;
}

export function describeDerivedShapes(
  body: DerivedBodyRecord,
  entity: number,
): readonly DerivedShapeState[] {
  return body.shapes.map((shape) => ({
    id: shape.input.id,
    revision: shape.input.revision,
    entity,
    kind: shape.input.kind,
    origin: [...shape.input.origin] as PhysicsVector,
    rotation: [...shape.input.rotation] as PhysicsQuaternion,
    generation: body.generation,
  }));
}

export function describeDerivedConstraints(
  constraints: ReadonlyMap<string, DerivedConstraintRecord>,
): readonly Pick<PhysicsConstraintInput, 'id' | 'revision' | 'bodyA' | 'bodyB'>[] {
  return [...constraints.values()].map(({ input }) => ({
    id: input.id,
    revision: input.revision,
    bodyA: input.bodyA,
    bodyB: input.bodyB,
  }));
}

/** Project every queued body before checking constraint endpoint dependencies. */
export function projectPendingDerivedSources(
  pending: Iterable<string>,
  candidates: ReadonlyMap<string, DerivedCandidateRecord>,
): Map<number, DerivedBodySource> {
  const sources = new Map<number, DerivedBodySource>();
  for (const candidateId of pending) {
    const record = candidates.get(candidateId);
    if (record === undefined || record.state !== 'queued') continue;
    const current = sources.get(record.input.entity);
    if (current === undefined || record.input.revision > current.revision) {
      sources.set(record.input.entity, {
        sourceKey: record.input.sourceKey,
        revision: record.input.revision,
      });
    }
  }
  return sources;
}

/** Recheck the final queue until rejected groups no longer change its dependencies. */
export function revalidatePendingDerivedCandidates(
  pending: ReadonlySet<string>,
  candidates: ReadonlyMap<string, DerivedCandidateRecord>,
  admitted: DerivedCandidateRecord,
  validate: (
    record: DerivedCandidateRecord,
    sources: ReadonlyMap<number, DerivedBodySource>,
  ) => DerivedPhysicsError | undefined,
  reject: (record: DerivedCandidateRecord, error: DerivedPhysicsError) => void,
): DerivedPhysicsError | undefined {
  let changed = true;
  while (changed) {
    changed = false;
    const sources = projectPendingDerivedSources(pending, candidates);
    for (const queuedId of [...pending]) {
      const record = candidates.get(queuedId);
      if (record?.state !== 'queued') continue;
      const projected = sources.get(record.input.entity);
      const error =
        projected !== undefined && record.input.revision < projected.revision
          ? new DerivedPhysicsError(
              'derived-candidate-stale',
              'queued candidates publish only the final revision submitted for an entity',
              'discard the older queued candidate and submit one complete revision',
              {
                entity: record.input.entity,
                candidateId: record.token.candidateId,
                expected: `>=${projected.revision}`,
                actual: record.input.revision,
              },
            )
          : validate(record, sources);
      if (error === undefined) continue;
      reject(record, error);
      changed = true;
      if (record === admitted || (admitted.batch !== undefined && record.batch === admitted.batch))
        return error;
    }
  }
  return undefined;
}
