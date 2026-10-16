import { err, ok, type Result } from '@forgeax/engine-types';

/** A portable quaternion used by derived-physics inputs. */
export type PhysicsQuaternion = readonly [number, number, number, number];

/** A portable three-component vector used by derived-physics inputs. */
export type PhysicsVector = readonly [number, number, number];

interface DerivedShapeBase {
  readonly id: string;
  readonly revision: number;
  readonly origin?: PhysicsVector;
  readonly rotation?: PhysicsQuaternion;
  readonly friction?: number;
  readonly restitution?: number;
  readonly density?: number;
  readonly isSensor?: boolean;
  readonly collisionGroups?: number;
  readonly solverGroups?: number;
}

/**
 * One logical shape composed of convex point sets in its local frame.
 * Each piece contains x/y/z triples whose convex hull has positive volume.
 * Preparation copies the buffers; the producer owns decomposition and units.
 */
export interface ConvexCompoundShapeInput extends DerivedShapeBase {
  readonly kind: 'convex-compound';
  readonly pieces: readonly Float32Array[];
}

/** Finite column-major matrix in the same bounded candidate transaction. */
export interface HeightfieldShapeInput extends DerivedShapeBase {
  readonly kind: 'heightfield';
  readonly rows: number;
  readonly columns: number;
  readonly heights: Float32Array;
  readonly scale: PhysicsVector;
}
export type DerivedShapeInput = ConvexCompoundShapeInput | HeightfieldShapeInput;
export type NormalizedDerivedShapeInput = DerivedShapeInput & {
  readonly origin: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
};

/** Stable producer identity and revision for one constraint endpoint. */
export interface PhysicsConstraintBodyDependency {
  readonly sourceKey: string;
  readonly revision: number;
}

/** Explicit or density-derived rigid-body mass properties. */
export type PhysicsMassProperties =
  | {
      readonly mode: 'automatic';
      readonly density?: number;
    }
  | {
      readonly mode: 'explicit';
      readonly mass: number;
      readonly centerOfMass: PhysicsVector;
      readonly principalInertia: PhysicsVector;
      readonly principalInertiaLocalFrame?: PhysicsQuaternion;
    };

/** How a topology replacement carries the committed body's motion. */
export type PhysicsVelocityPolicy = 'preserve' | 'reset';

/**
 * Consumer-visible movement state for one committed derived body.
 *
 * `centerOfMass` is world-space (the same frame as the body's transform),
 * while both velocity vectors are world-space.  Keeping this as one POD
 * value makes snapshot/recovery carry the complete motion boundary instead
 * of exposing Rapier objects or asking consumers to infer velocity from
 * successive transforms.
 */
export interface DerivedPhysicsMotion {
  readonly centerOfMass: PhysicsVector;
  readonly linearVelocity: PhysicsVector;
  readonly angularVelocity: PhysicsVector;
  /** World-space xyzw orientation; omitted input preserves the native orientation. */
  readonly rotation?: PhysicsQuaternion;
}

/** Stable, consumer-owned constraint input. */
export type PhysicsConstraintInput =
  | {
      readonly id: string;
      readonly revision: number;
      readonly kind: 'spring';
      readonly bodyA: number;
      readonly bodyB: number;
      readonly bodyASource: PhysicsConstraintBodyDependency;
      readonly bodyBSource: PhysicsConstraintBodyDependency;
      readonly anchorA: PhysicsVector;
      readonly anchorB: PhysicsVector;
      readonly restLength: number;
      readonly stiffness: number;
      readonly damping: number;
    }
  | {
      readonly id: string;
      readonly revision: number;
      readonly kind: 'hinge';
      readonly bodyA: number;
      readonly bodyB: number;
      readonly bodyASource: PhysicsConstraintBodyDependency;
      readonly bodyBSource: PhysicsConstraintBodyDependency;
      readonly anchorA: PhysicsVector;
      readonly anchorB: PhysicsVector;
      readonly axis: PhysicsVector;
      readonly limits?: readonly [number, number];
    };

/** All data needed to prepare one body's derived shape replacement. */
export interface DerivedPhysicsCandidateInput {
  readonly entity: number;
  readonly revision: number;
  readonly sourceKey: string;
  /** Empty clears derived shapes; ordinary colliders and ECS body lifetime remain independent. */
  readonly shapes: readonly DerivedShapeInput[];
  readonly bodyType?: 'static' | 'dynamic' | 'kinematic';
  readonly massProperties?: PhysicsMassProperties;
  readonly velocityPolicy?: PhysicsVelocityPolicy;
  /** Optional committed motion to restore after native mass admission. */
  readonly motion?: DerivedPhysicsMotion;
  readonly constraints?: readonly PhysicsConstraintInput[];
  /** Optional World identity; it is checked when the backend is ECS-bound. */
  readonly worldIdentity?: object;
}

/** Reuse the current owned shape publication while changing only native motion type. */
export interface DerivedBodyTypeCandidateInput {
  /** The exact current frozen receipt returned by getDerivedPublication, not a reconstructed copy. */
  readonly publication: DerivedPhysicsPublication;
  readonly bodyType: 'static' | 'dynamic' | 'kinematic';
}

/** Candidate lifecycle visible to a consumer. */
export type DerivedPhysicsCandidateState =
  | 'ready'
  | 'queued'
  | 'published'
  | 'cancelled'
  | 'invalidated'
  | 'failed';

/** Opaque-enough prepared candidate. Native handles never cross this type. */
export interface DerivedPhysicsCandidate {
  readonly candidateId: string;
  readonly generation: number;
  /** Per-PhysicsWorld owner identity; candidate IDs are not global. */
  readonly owner: object;
  readonly input: Readonly<DerivedPhysicsCandidateInput>;
  readonly state: DerivedPhysicsCandidateState;
}

/** Stable receipt emitted when a candidate becomes the committed shape set. */
export interface DerivedPhysicsPublication {
  readonly candidateId: string;
  readonly entity: number;
  readonly revision: number;
  readonly fixedStep: number;
  readonly shapeIds: readonly string[];
  readonly generation: number;
}

/** Structured admission failure that leaves the prior publication queryable. */
export interface DerivedPhysicsFailure {
  readonly candidateId: string;
  readonly entity: number;
  readonly revision: number;
  readonly fixedStep: number;
  readonly error: DerivedPhysicsError;
  readonly recovery: 'old-state-retained' | 'rebuild-required';
}

/** Public identity and pose of an active local shape. Geometry stays in snapshots. */
export interface DerivedShapeState {
  readonly id: string;
  readonly revision: number;
  readonly entity: number;
  readonly kind: DerivedShapeInput['kind'];
  readonly origin: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly generation: number;
}

/** Real backend contact observation, including stable shape identity when known. */
export interface PhysicsContactObservation {
  readonly phase: 'started' | 'stopped';
  readonly fixedStep: number;
  readonly entityA: number;
  readonly entityB: number;
  readonly shapeA?: string;
  readonly shapeB?: string;
  /** World-space contact sample from either surface, when available. */
  readonly point?: PhysicsVector;
  /** World-space normal oriented from entityA toward entityB, when available. */
  readonly normal?: PhysicsVector;
}

/** Portable recovery input produced from a committed derived state. */
export interface DerivedPhysicsSnapshot {
  readonly generation: number;
  readonly fixedStep: number;
  readonly bodies: readonly {
    readonly entity: number;
    readonly revision: number;
    readonly sourceKey: string;
    readonly shapes: readonly DerivedShapeInput[];
    readonly bodyType?: 'static' | 'dynamic' | 'kinematic';
    readonly massProperties?: PhysicsMassProperties;
    readonly velocityPolicy?: PhysicsVelocityPolicy;
    /** Committed world-space COM and velocities at capture time. */
    readonly motion?: DerivedPhysicsMotion;
    readonly constraints: readonly PhysicsConstraintInput[];
  }[];
}

export type DerivedPhysicsErrorCode =
  | 'derived-physics-disposed'
  | 'derived-body-not-found'
  | 'derived-world-mismatch'
  | 'derived-candidate-not-found'
  | 'derived-candidate-stale'
  | 'derived-candidate-pending'
  | 'derived-candidate-cancelled'
  | 'derived-candidate-invalid'
  | 'derived-candidate-budget-exceeded'
  | 'derived-shape-invalid'
  | 'derived-shape-duplicate'
  | 'derived-shape-unsupported'
  | 'derived-mass-invalid'
  | 'derived-constraint-invalid'
  | 'derived-constraint-not-found'
  | 'derived-constraint-stale'
  | 'derived-backend-failed'
  | 'derived-recovery-invalid';

/** Bounded derived-physics preparation envelope. */
export const DERIVED_PHYSICS_LIMITS = Object.freeze({
  maxCandidates: 32,
  maxBatchCandidates: 4096,
  maxShapesPerCandidate: 64,
  maxConstraintsPerCandidate: 64,
  maxConvexPiecesPerCandidate: 65_536,
  maxHeightfieldSamples: 262_144,
  maxCandidateBytes: 8 * 1024 * 1024,
});

export interface DerivedPhysicsErrorDetail {
  readonly code: DerivedPhysicsErrorCode;
  readonly entity?: number;
  readonly candidateId?: string;
  readonly shapeId?: string;
  readonly constraintId?: string;
  readonly expected?: string;
  readonly actual?: unknown;
  readonly reason?: string;
}

/** Closed, structured failure for the public derived-physics surface. */
export class DerivedPhysicsError extends Error {
  readonly code: DerivedPhysicsErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DerivedPhysicsErrorDetail;

  constructor(
    code: DerivedPhysicsErrorCode,
    expected: string,
    hint: string,
    detail: Omit<DerivedPhysicsErrorDetail, 'code'> = {},
    options?: ErrorOptions,
  ) {
    super(`${code}: ${expected}`, options);
    this.name = 'DerivedPhysicsError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = Object.freeze({ code, ...detail });
  }
}

const ID_RE = /\S/;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function vectorFinite(vector: readonly number[], length: number): boolean {
  return vector.length === length && vector.every(finite);
}

function normalizedQuaternion(rotation: PhysicsQuaternion): PhysicsQuaternion | undefined {
  if (!vectorFinite(rotation, 4)) return undefined;
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (!finite(length) || length < 1e-6) return undefined;
  return [rotation[0] / length, rotation[1] / length, rotation[2] / length, rotation[3] / length];
}

const SHAPE_BASE_KEYS = [
  'kind',
  'id',
  'revision',
  'origin',
  'rotation',
  'friction',
  'restitution',
  'density',
  'isSensor',
  'collisionGroups',
  'solverGroups',
];
const COMPOUND_KEYS = new Set([...SHAPE_BASE_KEYS, 'pieces']);
const HEIGHTFIELD_KEYS = new Set([...SHAPE_BASE_KEYS, 'rows', 'columns', 'heights', 'scale']);
const CANDIDATE_KEYS = new Set([
  'entity',
  'revision',
  'sourceKey',
  'shapes',
  'bodyType',
  'massProperties',
  'velocityPolicy',
  'motion',
  'constraints',
  'worldIdentity',
]);

function declaredKeys(value: object, keys: ReadonlySet<string>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.has(key))
  );
}

/** Bound all buffers before copying or visiting their elements. */
function candidateEnvelopeError(
  input: DerivedPhysicsCandidateInput,
): Result<void, DerivedPhysicsError> {
  const invalid = (expected: string) =>
    err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        expected,
        'provide a complete bounded candidate',
        { entity: input.entity },
      ),
    );
  const budget = () =>
    err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        'candidate geometry fits the preparation limits',
        'reduce geometry or publish another candidate before retrying',
        { entity: input.entity },
      ),
    );
  if (
    !declaredKeys(input, CANDIDATE_KEYS) ||
    !Array.isArray(input.shapes) ||
    !Array.isArray(input.constraints ?? [])
  )
    return invalid('candidate fields match the public contract');
  if (
    input.shapes.length > DERIVED_PHYSICS_LIMITS.maxShapesPerCandidate ||
    (input.constraints?.length ?? 0) > DERIVED_PHYSICS_LIMITS.maxConstraintsPerCandidate
  )
    return budget();
  let pieces = 0;
  let samples = 0;
  let bytes = 256 + (input.constraints?.length ?? 0) * 192;
  for (const shape of input.shapes) {
    if (shape === null || typeof shape !== 'object') return invalid('candidate shapes are objects');
    bytes += 128;
    if (shape.kind === 'heightfield') {
      if (!declaredKeys(shape, HEIGHTFIELD_KEYS) || !(shape.heights instanceof Float32Array))
        return invalid('heightfield fields and sample buffer match the public contract');
      samples += shape.heights.length;
      bytes += shape.heights.byteLength * 4;
    } else if (shape.kind === 'convex-compound') {
      if (!declaredKeys(shape, COMPOUND_KEYS) || !Array.isArray(shape.pieces))
        return invalid('compound fields and piece array match the public contract');
      pieces += shape.pieces.length;
      if (pieces > DERIVED_PHYSICS_LIMITS.maxConvexPiecesPerCandidate) return budget();
      for (const piece of shape.pieces) {
        if (!(piece instanceof Float32Array))
          return invalid('convex pieces are Float32Array point sets');
        bytes += piece.byteLength * 4 + 128;
        if (bytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes) return budget();
      }
    } else return invalid('shape kind is convex-compound or heightfield');
    if (
      samples > DERIVED_PHYSICS_LIMITS.maxHeightfieldSamples ||
      bytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes
    )
      return budget();
  }
  return ok(undefined);
}

/** Check every coordinate while finding the same noncoplanarity witnesses. */
function finiteVolume(points: Float32Array): boolean {
  const x = points[0] as number,
    y = points[1] as number,
    z = points[2] as number;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  let ax = 0,
    ay = 0,
    az = 0,
    farthest = 0;
  for (let i = 3; i < points.length; i += 3) {
    const px = points[i] as number,
      py = points[i + 1] as number,
      pz = points[i + 2] as number;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return false;
    const dx = px - x,
      dy = py - y,
      dz = pz - z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance > farthest) {
      farthest = distance;
      ax = dx;
      ay = dy;
      az = dz;
    }
  }
  let nx = 0,
    ny = 0,
    nz = 0,
    largest = 0;
  for (let i = 3; i < points.length; i += 3) {
    const dx = (points[i] as number) - x,
      dy = (points[i + 1] as number) - y,
      dz = (points[i + 2] as number) - z;
    const cx = ay * dz - az * dy,
      cy = az * dx - ax * dz,
      cz = ax * dy - ay * dx;
    const area = cx * cx + cy * cy + cz * cz;
    if (area > largest) {
      largest = area;
      nx = cx;
      ny = cy;
      nz = cz;
    }
  }
  for (let i = 3; i < points.length; i += 3)
    if (
      nx * ((points[i] as number) - x) +
        ny * ((points[i + 1] as number) - y) +
        nz * ((points[i + 2] as number) - z) !==
      0
    )
      return true;
  return false;
}

/** Snapshot ordinary convex geometry before native resources are created. */
export function normalizeConvexCompoundShapeInput(
  input: ConvexCompoundShapeInput,
): Result<NormalizedDerivedShapeInput, DerivedPhysicsError> {
  const invalid = (actual: unknown) =>
    err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'finite convex point sets, stable identity and a valid local pose',
        'repair the geometry before candidate preparation',
        { shapeId: input.id, actual },
      ),
    );
  const bounded = candidateEnvelopeError({
    entity: 0,
    revision: 0,
    sourceKey: 'shape',
    shapes: [input],
  });
  if (!bounded.ok) return bounded;
  if (
    input.kind !== 'convex-compound' ||
    typeof input.id !== 'string' ||
    !ID_RE.test(input.id) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    input.pieces.length === 0
  )
    return invalid(input.id);
  const origin = input.origin ?? [0, 0, 0];
  const rotation = normalizedQuaternion(input.rotation ?? [0, 0, 0, 1]);
  if (!vectorFinite(origin, 3) || rotation === undefined) return invalid(origin);
  for (const value of [input.friction, input.restitution, input.density])
    if (value !== undefined && (!finite(value) || value < 0)) return invalid(value);
  for (const value of [input.collisionGroups, input.solverGroups])
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
      return invalid(value);
  if (input.isSensor !== undefined && typeof input.isSensor !== 'boolean')
    return invalid(input.isSensor);
  for (const piece of input.pieces)
    if (piece.length < 12 || piece.length % 3 !== 0 || !finiteVolume(piece))
      return invalid(piece.length);
  return ok(
    Object.freeze({
      ...input,
      pieces: Object.freeze(input.pieces.map((piece) => new Float32Array(piece))),
      origin: Object.freeze([...origin]) as PhysicsVector,
      rotation: Object.freeze(rotation),
    }),
  );
}

/** Reject holes and malformed matrices before allocating any native collider. */
export function normalizeHeightfieldShapeInput(
  input: HeightfieldShapeInput,
): Result<NormalizedDerivedShapeInput, DerivedPhysicsError> {
  const invalid = (actual: unknown) =>
    err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'finite hole-free column-major heightfield with positive dimensions and scale',
        'repair dimensions, samples and pose before candidate preparation',
        { shapeId: input.id, actual },
      ),
    );
  if (
    typeof input.id !== 'string' ||
    !ID_RE.test(input.id) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isSafeInteger(input.rows) ||
    !Number.isSafeInteger(input.columns) ||
    input.rows < 1 ||
    input.columns < 1 ||
    (input.rows + 1) * (input.columns + 1) > DERIVED_PHYSICS_LIMITS.maxHeightfieldSamples ||
    !(input.heights instanceof Float32Array) ||
    input.heights.length !== (input.rows + 1) * (input.columns + 1) ||
    input.heights.some((h) => !Number.isFinite(h)) ||
    !vectorFinite(input.scale, 3) ||
    input.scale.some((v) => v <= 0)
  )
    return invalid(input.id);
  const origin = input.origin ?? [0, 0, 0];
  const rotation = normalizedQuaternion(input.rotation ?? [0, 0, 0, 1]);
  if (!vectorFinite(origin, 3) || !rotation) return invalid(origin);
  for (const value of [input.friction, input.restitution, input.density])
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return invalid(value);
  return ok(
    Object.freeze({
      ...input,
      heights: new Float32Array(input.heights),
      scale: [...input.scale] as PhysicsVector,
      origin: [...origin] as PhysicsVector,
      rotation,
    }),
  );
}

/** Validate explicit mass/inertia values before touching the backend. */
export function validateMassProperties(
  properties: PhysicsMassProperties | undefined,
): Result<PhysicsMassProperties | undefined, DerivedPhysicsError> {
  if (properties === undefined || properties.mode === 'automatic') {
    if (
      properties?.density !== undefined &&
      (!finite(properties.density) || properties.density <= 0)
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-mass-invalid',
          'automatic density is finite and positive',
          'omit density to use backend density or provide a positive density',
          { actual: properties.density },
        ),
      );
    }
    return ok(properties);
  }
  if (
    !finite(properties.mass) ||
    properties.mass <= 0 ||
    !vectorFinite(properties.centerOfMass, 3) ||
    !vectorFinite(properties.principalInertia, 3) ||
    properties.principalInertia.some((value) => !finite(value) || value <= 0)
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-mass-invalid',
        'explicit mass, center of mass, and principal inertia are finite and non-degenerate',
        'provide positive mass/inertia and a finite center of mass',
        { actual: properties },
      ),
    );
  }
  const frame = normalizedQuaternion(properties.principalInertiaLocalFrame ?? [0, 0, 0, 1]);
  if (frame === undefined) {
    return err(
      new DerivedPhysicsError(
        'derived-mass-invalid',
        'principal inertia local frame is a finite non-degenerate quaternion',
        'normalize the inertia frame before submitting it',
        { actual: properties.principalInertiaLocalFrame },
      ),
    );
  }
  return ok(
    Object.freeze({
      ...properties,
      centerOfMass: [...properties.centerOfMass] as PhysicsVector,
      principalInertia: [...properties.principalInertia] as PhysicsVector,
      principalInertiaLocalFrame: frame,
    }),
  );
}

/** The required linear velocity correction for a committed COM change. */
export function preserveCenterOfMassVelocity(
  linearVelocity: PhysicsVector,
  angularVelocity: PhysicsVector,
  previousWorldCom: PhysicsVector,
  nextWorldCom: PhysicsVector,
): PhysicsVector {
  const dx = nextWorldCom[0] - previousWorldCom[0];
  const dy = nextWorldCom[1] - previousWorldCom[1];
  const dz = nextWorldCom[2] - previousWorldCom[2];
  return [
    linearVelocity[0] + angularVelocity[1] * dz - angularVelocity[2] * dy,
    linearVelocity[1] + angularVelocity[2] * dx - angularVelocity[0] * dz,
    linearVelocity[2] + angularVelocity[0] * dy - angularVelocity[1] * dx,
  ];
}

/** Snapshot an input without retaining caller-owned typed-array references. */
export function cloneDerivedPhysicsInput(
  input: DerivedPhysicsCandidateInput,
): Result<DerivedPhysicsCandidateInput, DerivedPhysicsError> {
  const envelope = candidateEnvelopeError(input);
  if (!envelope.ok) return envelope;
  if (!Number.isSafeInteger(input.entity) || input.entity < 0) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate entity is a non-negative safe integer',
        'submit a live entity from the same World',
        { entity: input.entity },
      ),
    );
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate revision is a non-negative safe integer',
        'advance the consumer topology revision monotonically',
        { entity: input.entity, actual: input.revision },
      ),
    );
  }
  if (typeof input.sourceKey !== 'string' || !ID_RE.test(input.sourceKey)) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate sourceKey is a non-empty stable producer identity',
        'carry the producer sourceKey with every derived body revision',
        { entity: input.entity, actual: input.sourceKey },
      ),
    );
  }
  const seen = new Set<string>();
  const shapes: DerivedShapeInput[] = [];
  for (const shape of input.shapes) {
    const normalized =
      shape.kind === 'heightfield'
        ? normalizeHeightfieldShapeInput(shape)
        : normalizeConvexCompoundShapeInput(shape);
    if (!normalized.ok) return normalized;
    if (seen.has(normalized.value.id)) {
      return err(
        new DerivedPhysicsError(
          'derived-shape-duplicate',
          'one candidate has one identity per derived shape',
          'merge or rename duplicate shape inputs before preparation',
          { entity: input.entity, shapeId: normalized.value.id },
        ),
      );
    }
    seen.add(normalized.value.id);
    shapes.push(normalized.value);
  }
  const motionRotation =
    input.motion?.rotation === undefined ? undefined : normalizedQuaternion(input.motion.rotation);
  if (input.motion?.rotation !== undefined && motionRotation === undefined)
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'optional motion rotation is a finite non-degenerate world-space quaternion',
        'supply a valid xyzw body orientation or omit it to preserve the native orientation',
        { entity: input.entity, actual: input.motion.rotation },
      ),
    );
  const mass = validateMassProperties(input.massProperties);
  if (!mass.ok) return mass;
  if (
    input.motion !== undefined &&
    (!vectorFinite(input.motion.centerOfMass, 3) ||
      !vectorFinite(input.motion.linearVelocity, 3) ||
      !vectorFinite(input.motion.angularVelocity, 3))
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'optional movement state contains finite world-space COM and velocity vectors',
        'capture or provide three finite components for centerOfMass, linearVelocity, and angularVelocity',
        { entity: input.entity, actual: input.motion },
      ),
    );
  }
  const constraints = input.constraints ?? [];
  if (constraints.length > DERIVED_PHYSICS_LIMITS.maxConstraintsPerCandidate) {
    return err(
      new DerivedPhysicsError(
        'derived-candidate-budget-exceeded',
        `one candidate contains at most ${DERIVED_PHYSICS_LIMITS.maxConstraintsPerCandidate} constraint updates`,
        'submit a bounded constraint set for this body',
        { entity: input.entity, actual: constraints.length },
      ),
    );
  }
  const seenConstraints = new Set<string>();
  for (const constraint of constraints) {
    if (seenConstraints.has(constraint.id)) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-invalid',
          'one candidate contains one update per constraint identity',
          'merge duplicate constraint updates before preparation',
          { entity: input.entity, constraintId: constraint.id },
        ),
      );
    }
    seenConstraints.add(constraint.id);
    for (const dependency of [constraint.bodyASource, constraint.bodyBSource]) {
      if (
        typeof dependency.sourceKey !== 'string' ||
        !ID_RE.test(dependency.sourceKey) ||
        !Number.isInteger(dependency.revision) ||
        dependency.revision < 0
      ) {
        return err(
          new DerivedPhysicsError(
            'derived-constraint-invalid',
            'constraint endpoint sourceKey and revision are stable and non-negative',
            'refresh both endpoint dependencies before preparing the constraint',
            { entity: input.entity, constraintId: constraint.id },
          ),
        );
      }
    }
  }
  return ok(
    Object.freeze({
      ...input,
      shapes: Object.freeze(shapes),

      ...(mass.value === undefined ? {} : { massProperties: mass.value }),
      ...(input.motion === undefined
        ? {}
        : {
            motion: Object.freeze({
              centerOfMass: [...input.motion.centerOfMass] as PhysicsVector,
              linearVelocity: [...input.motion.linearVelocity] as PhysicsVector,
              angularVelocity: [...input.motion.angularVelocity] as PhysicsVector,
              ...(motionRotation === undefined ? {} : { rotation: motionRotation }),
            }),
          }),
      constraints: Object.freeze([...constraints]),
      velocityPolicy: input.velocityPolicy ?? 'preserve',
    }),
  );
}

/** Estimate retained private/public copies plus native geometry POD and metadata. */
export function estimateDerivedPhysicsInputBytes(input: DerivedPhysicsCandidateInput): number {
  const shapeBytes = input.shapes.reduce(
    (sum, shape) =>
      sum +
      128 +
      (shape.kind === 'heightfield'
        ? shape.heights.byteLength * 4
        : shape.pieces.reduce((bytes, piece) => bytes + piece.byteLength * 4 + 128, 0)),
    0,
  );
  return shapeBytes + (input.constraints?.length ?? 0) * 192 + 256;
}
