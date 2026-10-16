import type {
  DerivedPhysicsCandidate,
  DerivedPhysicsCandidateInput,
  DerivedPhysicsCandidateState,
  NormalizedDerivedShapeInput,
  PhysicsConstraintInput,
  PhysicsMassProperties,
} from '@forgeax/engine-physics';
import type { Result } from '@forgeax/engine-types';

export interface DerivedShapeRecord {
  readonly input: NormalizedDerivedShapeInput;
  readonly colliderHandle: number;
}

export interface DerivedBodyRecord {
  readonly entity: number;
  readonly sourceKey: string;
  readonly generation: number;
  readonly revision: number;
  readonly bodyType: 'static' | 'dynamic' | 'kinematic' | undefined;
  readonly velocityPolicy: 'preserve' | 'reset' | undefined;
  readonly candidateId: string;
  readonly shapes: readonly DerivedShapeRecord[];
  readonly massProperties: PhysicsMassProperties | undefined;
  readonly constraints: readonly PhysicsConstraintInput[];
}

export interface DerivedCandidateRecord {
  token: DerivedPhysicsCandidate;
  readonly nativeColliders: readonly { readonly handle: number }[];
  readonly input: DerivedPhysicsCandidateInput;
  readonly retainedGeometry?: DerivedBodyRecord;
  readonly bytes: number;
  state: DerivedPhysicsCandidateState;
  commitGeometry?: () => Result<void, Error>;
  batch?: DerivedAdmissionBatch;
}

export interface DerivedAdmissionBatch {
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
