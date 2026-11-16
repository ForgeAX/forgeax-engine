import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { err, ok, type Result, type RigidBodyType } from '@forgeax/engine-types';

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
  /** Experimental, default absent. Same geometry, at most eight internal colliders.
   * Geometry preparation groups only dynamic explicit-mass bodies; unsupported sizes retain one collider.
   * A later type-only policy change preserves the existing owned layout.
   * Logical contact transitions are coalesced. A started observation samples a real
   * contact from the lowest active spatial-group ordinal; its representative point
   * can differ from the single collider, including the gameplay impact location. */
  readonly nativeLayout?: 'spatial-groups-16';
}

/** Finite column-major matrix in the same bounded candidate transaction. */
export interface HeightfieldShapeInput extends DerivedShapeBase {
  readonly kind: 'heightfield';
  readonly rows: number;
  readonly columns: number;
  readonly heights: Float32Array;
  readonly scale: PhysicsVector;
}
/** Union of half-open integer boxes in a uniform local voxel grid. */
export interface VoxelShapeInput extends DerivedShapeBase {
  readonly kind: 'voxels';
  readonly regions: Int32Array;
  readonly voxelSize: PhysicsVector;
}
/** Static indexed triangle mesh retained as one Rapier trimesh collider. */
export interface TriangleMeshShapeInput extends DerivedShapeBase {
  readonly kind: 'trimesh';
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}
export type DerivedShapeInput =
  | ConvexCompoundShapeInput
  | HeightfieldShapeInput
  | VoxelShapeInput
  | TriangleMeshShapeInput;
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

/** Complete source-owned affine transform for a static derived body. Native
 * pose and collider-local affine geometry are derived from this matrix in one
 * candidate transaction. */
export interface DerivedPhysicsSourceTransform {
  readonly sceneMatrix: readonly number[];
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
  /** Optional producer-owned digest of the complete source and candidate geometry. */
  readonly inputDigest?: string;
  /** Empty clears derived shapes; ordinary colliders and ECS body lifetime remain independent. */
  readonly shapes: readonly DerivedShapeInput[];
  readonly bodyType?: RigidBodyType;
  readonly massProperties?: PhysicsMassProperties;
  readonly velocityPolicy?: PhysicsVelocityPolicy;
  /** Optional committed motion to restore after native mass admission.
   * Source-owned static bodies use `sourceTransform` as their complete pose
   * and cannot also carry motion. */
  readonly motion?: DerivedPhysicsMotion;
  /** When present on a static source, this matrix is the sole pose authority.
   * Source-owned candidates omit `motion`; snapshots restore pose from here. */
  readonly sourceTransform?: DerivedPhysicsSourceTransform;
  readonly constraints?: readonly PhysicsConstraintInput[];
  /** Optional World identity; it is checked when the backend is ECS-bound. */
  readonly worldIdentity?: object;
}

/** Reuse the current owned shape publication while changing only native motion type. */
export interface DerivedBodyTypeCandidateInput {
  /** The exact current frozen receipt returned by getDerivedPublication, not a reconstructed copy. */
  readonly publication: DerivedPhysicsPublication;
  readonly bodyType: RigidBodyType;
}

/** Detached current Native state, sampled before any member of this batch mutates.
 * This is not a publication receipt or permission to read a half-committed World. */
export interface DerivedPhysicsAdmissionState {
  readonly entity: number;
  readonly candidateId: string;
  readonly generation: number;
  readonly source: Readonly<{ sourceKey: string; revision: number }> | undefined;
  readonly bodyType: RigidBodyType;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly linearVelocity: readonly [number, number, number];
  readonly angularVelocity: readonly [number, number, number];
  readonly sleeping: boolean;
}

/** Must be synchronous and read-only. Only literal true permits admission.
 * Managed physics access is fenced while it runs; use the detached states. */
export type DerivedPhysicsAdmissionGuard = (
  states: readonly DerivedPhysicsAdmissionState[],
) => boolean;

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
  /** Stable digest of the exact accepted candidate input. */
  readonly inputDigest: string;
}

/** Detached accepted collider geometry tied to the exact current publication. */
export interface DerivedPhysicsCollisionReceipt {
  readonly publication: DerivedPhysicsPublication;
  readonly sourceKey: string;
  /** Accepted Scene matrix. With this present, receipt shape geometry remains canonical source-space data; Native projection is separate. */
  readonly sourceTransform?: DerivedPhysicsSourceTransform;
  readonly shapes: readonly (
    | Readonly<{
        readonly kind: 'convex-compound';
        readonly id: string;
        readonly revision: number;
        readonly origin: PhysicsVector;
        readonly rotation: PhysicsQuaternion;
        readonly pieces: readonly (readonly number[])[];
      }>
    | Readonly<{
        readonly kind: 'trimesh';
        readonly id: string;
        readonly revision: number;
        readonly origin: PhysicsVector;
        readonly rotation: PhysicsQuaternion;
        readonly vertices: readonly number[];
        readonly indices: readonly number[];
      }>
  )[];
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

/** Public identity and source-local pose of an active shape. Geometry stays in the collision receipt. */
export interface DerivedShapeState {
  readonly id: string;
  readonly revision: number;
  readonly entity: number;
  readonly kind: DerivedShapeInput['kind'];
  readonly origin: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly generation: number;
  /** Accepted Scene matrix used for Native projection, when the source owns its pose. */
  readonly sourceTransform?: DerivedPhysicsSourceTransform;
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
    readonly bodyType?: RigidBodyType;
    readonly massProperties?: PhysicsMassProperties;
    readonly velocityPolicy?: PhysicsVelocityPolicy;
    /** Committed world-space COM and velocities at capture time. */
    readonly motion?: DerivedPhysicsMotion;
    readonly sourceTransform?: DerivedPhysicsSourceTransform;
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

function validSourceSceneMatrix(matrix: readonly number[]): boolean {
  if (matrix.length !== 16 || !matrix.every(finite)) return false;
  const position = vec3.create();
  const rotation = quat.create();
  const scale = vec3.create();
  const shear = vec3.create();
  return mat4.decomposeAffine(position, rotation, scale, shear, matrix);
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
const COMPOUND_KEYS = new Set([...SHAPE_BASE_KEYS, 'pieces', 'nativeLayout']);
const VOXEL_KEYS = new Set([...SHAPE_BASE_KEYS, 'regions', 'voxelSize']);
const HEIGHTFIELD_KEYS = new Set([...SHAPE_BASE_KEYS, 'rows', 'columns', 'heights', 'scale']);
const TRIMESH_KEYS = new Set([...SHAPE_BASE_KEYS, 'vertices', 'indices']);
const SOURCE_TRANSFORM_KEYS = new Set(['sceneMatrix']);
const CANDIDATE_KEYS = new Set([
  'entity',
  'revision',
  'sourceKey',
  'inputDigest',
  'shapes',
  'bodyType',
  'massProperties',
  'velocityPolicy',
  'motion',
  'sourceTransform',
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
  if (input.sourceTransform !== undefined) {
    if (
      !declaredKeys(input.sourceTransform, SOURCE_TRANSFORM_KEYS) ||
      !Array.isArray(input.sourceTransform.sceneMatrix) ||
      !validSourceSceneMatrix(input.sourceTransform.sceneMatrix)
    )
      return invalid('source transform fields match the complete finite Scene projection contract');
    bytes += 16 * 4;
  }
  const visitCandidateShapes = () => {
    for (const shape of input.shapes) {
      if (shape === null || typeof shape !== 'object')
        return invalid('candidate shapes are objects');
      bytes += 128;
      if (shape.kind === 'heightfield') {
        if (!declaredKeys(shape, HEIGHTFIELD_KEYS) || !(shape.heights instanceof Float32Array))
          return invalid('heightfield fields and sample buffer match the public contract');
        samples += shape.heights.length;
        bytes += shape.heights.byteLength * 4;
      } else if (shape.kind === 'voxels') {
        if (!declaredKeys(shape, VOXEL_KEYS) || !(shape.regions instanceof Int32Array))
          return invalid('voxel regions are an Int32Array of half-open boxes');
        const voxelBytes = estimateVoxelShapeBytes(shape);
        if (!Number.isFinite(voxelBytes))
          return invalid('voxel regions contain valid bounded half-open integer boxes');
        bytes += voxelBytes;
      } else if (shape.kind === 'convex-compound') {
        const visitCompoundPieces = (shape: ConvexCompoundShapeInput) => {
          if (!declaredKeys(shape, COMPOUND_KEYS) || !Array.isArray(shape.pieces))
            return invalid('compound fields and piece array match the public contract');
          if (shape.nativeLayout !== undefined && shape.nativeLayout !== 'spatial-groups-16')
            return invalid('unsupported compound native layout');
          if (shape.nativeLayout !== undefined) bytes += 8 * 256;
          pieces += shape.pieces.length;
          if (pieces > DERIVED_PHYSICS_LIMITS.maxConvexPiecesPerCandidate) return budget();
          for (const piece of shape.pieces) {
            if (!(piece instanceof Float32Array))
              return invalid('convex pieces are Float32Array point sets');
            bytes += piece.byteLength * 4 + 128;
            if (bytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes) return budget();
          }
          return undefined;
        };
        const compoundFailure = visitCompoundPieces(shape);
        if (compoundFailure !== undefined) return compoundFailure;
      } else if (shape.kind === 'trimesh') {
        const validateTriangleEnvelope = (shape: TriangleMeshShapeInput) => {
          if (
            !declaredKeys(shape, TRIMESH_KEYS) ||
            !(shape.vertices instanceof Float32Array) ||
            !(shape.indices instanceof Uint32Array) ||
            shape.vertices.length < 9 ||
            shape.vertices.length % 3 !== 0 ||
            shape.indices.length < 3 ||
            shape.indices.length % 3 !== 0
          )
            return invalid('trimesh fields contain indexed triangle buffers');
          if (
            shape.vertices.byteLength + shape.indices.byteLength >
            DERIVED_PHYSICS_LIMITS.maxCandidateBytes - bytes
          )
            return budget();
          bytes += shape.vertices.byteLength * 4 + shape.indices.byteLength * 4;
          for (const coordinate of shape.vertices)
            if (!Number.isFinite(coordinate)) return invalid('trimesh vertices are finite');
          for (const index of shape.indices)
            if (index >= shape.vertices.length / 3)
              return invalid('trimesh indices reference existing vertices');
          return undefined;
        };
        const triangleFailure = validateTriangleEnvelope(shape);
        if (triangleFailure !== undefined) return triangleFailure;
      } else return invalid('shape kind is convex-compound, heightfield, voxels or trimesh');
      if (
        samples > DERIVED_PHYSICS_LIMITS.maxHeightfieldSamples ||
        bytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes
      )
        return budget();
    }
    return undefined;
  };
  const shapeFailure = visitCandidateShapes();
  if (shapeFailure !== undefined) return shapeFailure;
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
  const validateConvexProperties = (input: ConvexCompoundShapeInput) => {
    for (const value of [input.friction, input.restitution, input.density])
      if (value !== undefined && (!finite(value) || value < 0)) return invalid(value);
    for (const value of [input.collisionGroups, input.solverGroups])
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
        return invalid(value);
    if (input.isSensor !== undefined && typeof input.isSensor !== 'boolean')
      return invalid(input.isSensor);
    return undefined;
  };
  const propertiesFailure = validateConvexProperties(input);
  if (propertiesFailure !== undefined) return propertiesFailure;
  const pieces: Float32Array[] = [];
  let pointCount = 0;
  for (const piece of input.pieces) {
    if (piece.length < 12 || piece.length % 3 !== 0 || !finiteVolume(piece))
      return invalid(piece.length);
    pieces.push(piece);
    pointCount += piece.length;
  }
  // A logical shape owns and retires all pieces together. Copy its validated
  // roster into disjoint views without retaining one backing store per hull.
  const pointStorage = new ArrayBuffer(pointCount * Float32Array.BYTES_PER_ELEMENT);
  let pointOffset = 0;
  for (let index = 0; index < pieces.length; index++) {
    const source = pieces[index] as Float32Array;
    const copy = new Float32Array(pointStorage, pointOffset, source.length);
    copy.set(source);
    pieces[index] = copy;
    pointOffset += copy.byteLength;
  }

  return ok(
    Object.freeze({
      ...input,
      pieces: Object.freeze(pieces),
      origin: Object.freeze([...origin]) as PhysicsVector,
      rotation: Object.freeze(rotation),
    }),
  );
}

export function normalizeTriangleMeshShapeInput(
  input: TriangleMeshShapeInput,
): Result<NormalizedDerivedShapeInput, DerivedPhysicsError> {
  const invalid = () =>
    err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'bounded indexed static trimesh with a valid pose',
        'repair the mesh before candidate preparation',
        { shapeId: input.id },
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
    typeof input.id !== 'string' ||
    !ID_RE.test(input.id) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    return invalid();
  const origin = input.origin ?? [0, 0, 0],
    rotation = normalizedQuaternion(input.rotation ?? [0, 0, 0, 1]);
  if (!vectorFinite(origin, 3) || !rotation) return invalid();
  const validateTriangleMeshProperties = (input: TriangleMeshShapeInput) => {
    for (const value of [input.friction, input.restitution, input.density])
      if (value !== undefined && (!finite(value) || value < 0)) return invalid();
    for (const value of [input.collisionGroups, input.solverGroups])
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
        return invalid();
    if (input.isSensor !== undefined && typeof input.isSensor !== 'boolean') return invalid();

    return undefined;
  };
  const properties = validateTriangleMeshProperties(input);
  if (properties !== undefined) return properties;
  return ok(
    Object.freeze({
      ...input,
      vertices: new Float32Array(input.vertices),
      indices: new Uint32Array(input.indices),
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
  const validateHeightfieldProperties = (input: HeightfieldShapeInput) => {
    for (const value of [input.friction, input.restitution, input.density])
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) return invalid(value);
    return undefined;
  };
  const propertiesFailure = validateHeightfieldProperties(input);
  if (propertiesFailure !== undefined) return propertiesFailure;
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

/** Conservative native chunk/copy envelope, including partially occupied chunks. */
function estimateVoxelShapeBytes(input: VoxelShapeInput): number {
  if (!input.regions.length || input.regions.length % 6) return Infinity;
  const inputBytes = input.regions.byteLength * 4;
  if (inputBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes) return inputBytes;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < input.regions.length; i += 6) {
    for (let axis = 0; axis < 3; axis++) {
      const min = input.regions[i + axis] as number,
        max = input.regions[i + axis + 3] as number;
      if (min >= max || min < -2147483640 || max > 2147483639) return Infinity;
    }
    minX = Math.min(minX, Math.floor((input.regions[i] as number) / 8));
    minY = Math.min(minY, Math.floor((input.regions[i + 1] as number) / 8));
    minZ = Math.min(minZ, Math.floor((input.regions[i + 2] as number) / 8));
    maxX = Math.max(maxX, Math.floor(((input.regions[i + 3] as number) - 1) / 8));
    maxY = Math.max(maxY, Math.floor(((input.regions[i + 4] as number) - 1) / 8));
    maxZ = Math.max(maxZ, Math.floor(((input.regions[i + 5] as number) - 1) / 8));
  }
  const nx = maxX - minX + 1,
    ny = maxY - minY + 1;
  const numeric = Number.isSafeInteger(nx * ny * (maxZ - minZ + 1));
  const chunks = new Set<number | string>();
  let visits = 0;
  for (let i = 0; i < input.regions.length; i += 6) {
    const x0 = Math.floor((input.regions[i] as number) / 8),
      x1 = Math.floor(((input.regions[i + 3] as number) - 1) / 8);
    const y0 = Math.floor((input.regions[i + 1] as number) / 8),
      y1 = Math.floor(((input.regions[i + 4] as number) - 1) / 8);
    const z0 = Math.floor((input.regions[i + 2] as number) / 8),
      z1 = Math.floor(((input.regions[i + 5] as number) - 1) / 8);
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          if (++visits > 1_000_000) return DERIVED_PHYSICS_LIMITS.maxCandidateBytes + 1;
          // Exact local ordinals avoid allocating a string for every region/chunk
          // overlap. Very distant sparse input retains collision-free tuple keys.
          chunks.add(numeric ? x - minX + nx * (y - minY + ny * (z - minZ)) : `${x}/${y}/${z}`);
          if (inputBytes + chunks.size * 2048 > DERIVED_PHYSICS_LIMITS.maxCandidateBytes)
            return inputBytes + chunks.size * 2048;
        }
  }
  // Region copies are separate from native occupancy. A unique 8^3 chunk gets
  // an allocation-growth allowance for its cells, spatial headers and BVH.
  return inputBytes + chunks.size * 2048;
}

export function normalizeVoxelShapeInput(
  input: VoxelShapeInput,
): Result<NormalizedDerivedShapeInput, DerivedPhysicsError> {
  const invalid = () =>
    err(
      new DerivedPhysicsError(
        'derived-shape-invalid',
        'bounded integer voxel regions with positive finite cell dimensions and a valid pose',
        'repair voxel regions, dimensions and shape metadata',
        { shapeId: input.id },
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
    typeof input.id !== 'string' ||
    !ID_RE.test(input.id) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Array.isArray(input.voxelSize) ||
    input.voxelSize.length !== 3 ||
    input.voxelSize.some((v) => !Number.isFinite(Math.fround(v)) || Math.fround(v) <= 0)
  )
    return invalid();
  const origin = input.origin ?? [0, 0, 0];
  const rotation = normalizedQuaternion(input.rotation ?? [0, 0, 0, 1]);
  if (!vectorFinite(origin, 3) || rotation === undefined) return invalid();
  const validateVoxelProperties = (input: VoxelShapeInput) => {
    for (const value of [input.friction, input.restitution, input.density])
      if (value !== undefined && (!finite(value) || value < 0)) return invalid();
    for (const value of [input.collisionGroups, input.solverGroups])
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
        return invalid();
    if (input.isSensor !== undefined && typeof input.isSensor !== 'boolean') return invalid();
    for (let i = 0; i < input.regions.length; i++)
      if (
        !Number.isFinite(
          Math.fround((input.regions[i] as number) * (input.voxelSize[i % 3] as number)),
        )
      )
        return invalid();
    return undefined;
  };
  const propertiesFailure = validateVoxelProperties(input);
  if (propertiesFailure !== undefined) return propertiesFailure;
  return ok(
    Object.freeze({
      ...input,
      regions: new Int32Array(input.regions),
      voxelSize: Object.freeze([...input.voxelSize]) as PhysicsVector,
      origin: Object.freeze([...origin]) as PhysicsVector,
      rotation: Object.freeze(rotation),
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
  const sourceTransform =
    input.sourceTransform === undefined
      ? undefined
      : Object.freeze({
          sceneMatrix: Object.freeze(input.sourceTransform.sceneMatrix.map(Math.fround)),
        });
  if (sourceTransform && !validSourceSceneMatrix(sourceTransform.sceneMatrix))
    return err(
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'source-owned transform remains a finite, invertible affine matrix after f32 quantization',
        'publish the full Scene world matrix at a scale representable by Native f32 geometry',
        { entity: input.entity },
      ),
    );
  const validateCandidateIdentity = (input: DerivedPhysicsCandidateInput) => {
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
    if (
      input.inputDigest !== undefined &&
      (typeof input.inputDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(input.inputDigest))
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'optional candidate inputDigest is a SHA-256 hex digest',
          'supply the complete producer digest or omit it',
          { entity: input.entity },
        ),
      );
    }
    return undefined;
  };
  const identityFailure = validateCandidateIdentity(input);
  if (identityFailure !== undefined) return identityFailure;
  const seen = new Set<string>();
  const shapes: DerivedShapeInput[] = [];
  const cloneCandidateShapes = (
    input: DerivedPhysicsCandidateInput,
    seen: Set<string>,
    shapes: DerivedShapeInput[],
  ) => {
    for (const shape of input.shapes) {
      if (shape.kind === 'trimesh' && input.bodyType !== 'static')
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            'trimesh shapes belong to static derived bodies',
            'publish a static candidate for indexed mesh collision',
            { entity: input.entity, shapeId: shape.id },
          ),
        );
      const normalized =
        shape.kind === 'heightfield'
          ? normalizeHeightfieldShapeInput(shape)
          : shape.kind === 'voxels'
            ? normalizeVoxelShapeInput(shape)
            : shape.kind === 'trimesh'
              ? normalizeTriangleMeshShapeInput(shape)
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
    return undefined;
  };
  const shapeFailure = cloneCandidateShapes(input, seen, shapes);
  if (shapeFailure !== undefined) return shapeFailure;
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
  const validateSourceTransformUse = () => {
    if (sourceTransform !== undefined && input.bodyType !== 'static')
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'source-owned transform is a finite, invertible affine matrix on a static body',
          'publish the full Scene world matrix with static geometry',
          { entity: input.entity },
        ),
      );
    if (
      input.sourceTransform !== undefined &&
      shapes.some((shape) => shape.kind !== 'convex-compound' && shape.kind !== 'trimesh')
    )
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'source-owned affine transforms are supported for convex-compound or trimesh geometry',
          'publish static geometry that Physics can project through the complete Scene matrix',
          { entity: input.entity },
        ),
      );
    if (sourceTransform !== undefined && input.motion !== undefined)
      return err(
        new DerivedPhysicsError(
          'derived-candidate-invalid',
          'a source-owned static body has one pose authority and no independent motion snapshot',
          'restore the accepted sourceTransform and omit motion for this static body',
          { entity: input.entity },
        ),
      );
    return undefined;
  };
  const transformFailure = validateSourceTransformUse();
  if (transformFailure !== undefined) return transformFailure;
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
  const cloneCandidateConstraints = () => {
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
    return ok(constraints);
  };
  const constraintResult = cloneCandidateConstraints();
  if (!constraintResult.ok) return constraintResult;
  const constraints = constraintResult.value;
  const publishCandidateSnapshot = () => {
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
        ...(sourceTransform === undefined ? {} : { sourceTransform }),
        constraints: Object.freeze([...constraints]),
        velocityPolicy: input.velocityPolicy ?? 'preserve',
      }),
    );
  };
  return publishCandidateSnapshot();
}

/** Estimate retained private/public copies plus native geometry POD and metadata. */
export function estimateDerivedPhysicsInputBytes(input: DerivedPhysicsCandidateInput): number {
  const shapeBytes = input.shapes.reduce(
    (sum, shape) =>
      sum +
      128 +
      (shape.kind === 'heightfield'
        ? shape.heights.byteLength * 4
        : shape.kind === 'voxels'
          ? estimateVoxelShapeBytes(shape)
          : shape.kind === 'trimesh'
            ? shape.vertices.byteLength * 4 + shape.indices.byteLength * 4
            : shape.pieces.reduce(
                (bytes, piece) => bytes + piece.byteLength * 4 + 128,
                shape.nativeLayout === undefined ? 0 : 8 * 256,
              )),
    0,
  );
  return (
    shapeBytes +
    (input.constraints?.length ?? 0) * 192 +
    (input.sourceTransform === undefined ? 0 : 16 * 4) +
    256
  );
}
