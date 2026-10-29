import type {
  DerivedPhysicsAdmissionGuard,
  DerivedPhysicsCandidate,
  DerivedPhysicsCandidateInput,
  DerivedPhysicsCandidateState,
  NormalizedDerivedShapeInput,
  PhysicsConstraintInput,
  PhysicsMassProperties,
} from '@forgeax/engine-physics';
import { DERIVED_PHYSICS_LIMITS } from '@forgeax/engine-physics';
import type { Result, RigidBodyType } from '@forgeax/engine-types';

export interface DerivedShapeRecord {
  readonly input: NormalizedDerivedShapeInput;
  readonly colliderHandle: number;
  /** Complete native roster for one logical shape, including the primary handle. */
  readonly colliderHandles?: readonly number[];
}

export interface DerivedBodyRecord {
  readonly entity: number;
  readonly sourceKey: string;
  readonly generation: number;
  readonly revision: number;
  readonly bodyType: RigidBodyType | undefined;
  readonly velocityPolicy: 'preserve' | 'reset' | undefined;
  readonly candidateId: string;
  readonly shapes: readonly DerivedShapeRecord[];
  readonly massProperties: PhysicsMassProperties | undefined;
  readonly constraints: readonly PhysicsConstraintInput[];
}

export interface DerivedCandidateRecord {
  token: DerivedPhysicsCandidate;
  readonly nativeColliders: readonly { readonly handle: number }[];
  readonly stagedShapes?: readonly DerivedShapeRecord[];
  readonly input: DerivedPhysicsCandidateInput;
  readonly retainedGeometry?: DerivedBodyRecord;
  readonly sharedGeometry?: {
    readonly owner: DerivedBodyRecord;
    readonly shapes: readonly DerivedShapeRecord[];
  };
  readonly bytes: number;
  state: DerivedPhysicsCandidateState;
  commitGeometry?: () => Result<void, Error>;
  batch?: DerivedAdmissionBatch;
}

export interface DerivedAdmissionBatch {
  readonly preflight?: DerivedPhysicsAdmissionGuard;
  readonly records: readonly DerivedCandidateRecord[];
  readonly commitGeometry?: () => Result<void, Error>;
}

export interface DerivedConstraintRecord {
  readonly input: PhysicsConstraintInput;
  readonly handle: number;
}

export interface DerivedBodySource {
  readonly sourceKey: string;
  readonly revision: number;
}

export interface DerivedAdmissionProjection {
  readonly sources: ReadonlyMap<number, DerivedBodySource>;
  readonly queuedSources: ReadonlyMap<number, DerivedBodySource>;
}

export function derivedShapeHandles(shape: DerivedShapeRecord): readonly number[] {
  return shape.colliderHandles ?? [shape.colliderHandle];
}

/** Every prepared group in the roster is complete; none is a subset. */
function completeGroups(records: readonly DerivedCandidateRecord[]): boolean {
  const admitted = new Set(records);
  const groups = new Set<DerivedAdmissionBatch | undefined>(records.map((record) => record.batch));
  for (const group of groups)
    if (group === undefined || group.records.some((record) => !admitted.has(record))) return false;
  return true;
}

/**
 * Why a resolved roster is not one admissible replacement. One admission is
 * one complete declared group or a bounded set of individual candidates; the
 * group-union mode accepts only complete declared groups.
 */
export function derivedRosterRefusal(
  records: readonly DerivedCandidateRecord[],
  unionOfGroups: boolean,
): string | undefined {
  if (unionOfGroups)
    return completeGroups(records)
      ? undefined
      : 'submit only complete declared preparation groups without subsets or individual members';
  const prepared = records[0]?.batch;
  const single = records.every((record) => record.batch === prepared);
  const valid =
    single &&
    (prepared === undefined
      ? records.length <= DERIVED_PHYSICS_LIMITS.maxCandidates
      : prepared.records.length === records.length && completeGroups(records));
  return valid
    ? undefined
    : 'submit exactly one complete preparation group without subsets or mixed members';
}
