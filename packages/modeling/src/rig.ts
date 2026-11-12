import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import { createMeshBuilder } from '@forgeax/engine-geometry';
import { AssetGuid, type PackageId } from '@forgeax/engine-pack/guid';
import {
  type AnimationClip,
  type AnimationTransformChannel,
  err,
  type MeshAsset,
  ok,
  type Result,
  type SceneAsset,
  type SceneEntity,
  type SkeletonAsset,
  type SkinAsset,
} from '@forgeax/engine-types';
import {
  type Affine,
  type Angles,
  applyPoint,
  axisAngle,
  fromAngles,
  IDENTITY,
  invertRigid,
  multiply,
  toColumnMajor,
  toQuaternion,
  translation,
} from './affine';
import { maxOf, minOf, pushAll } from './arrays';
import { extractFaces } from './boolean';
import { registerCapturedRig } from './capture';
import {
  type Choreography,
  type ChoreographyOptions,
  choreograph,
  rigMotionReport,
} from './choreograph';
import {
  type ComputeJobReport,
  type ComputeLocation,
  computeCacheKey,
  resolveBackend,
  runComputeJob,
  type SkinBone,
} from './compute/job';
import { SKIN_INFLUENCES, tsSkinBackend } from './compute/skin-ts';
import { atan2, hypot3 } from './dmath';
import { type DraftFace, draftFace, draftInputs } from './draft';
import { type ModelingError, modelingError } from './errors';
import { type ClipReport, type ExportReport, exportMesh, type NormalMode } from './finish';
import { encodeSnapshot } from './fxem';
import { type Axis, axisVector, faceCentroid, faceNormal, type Tuple3 } from './geom';
import {
  type ConnectivityOptions,
  type ConnectivityReport,
  contactTolerance,
  type DesignedContact,
  FIT_TOLERANCE,
  type FloatingPart,
  type InterferenceOptions,
  type InterferenceReport,
  type JointTurn,
  type MotionBound,
  type PartGeometry,
  type Placement,
  partDistance,
  partGeometry,
  partGroups,
  type ScanOptions,
  type ScanPose,
  type ScanReport,
  scanPath,
  testPose,
} from './interference';
import { rigActuation, solidProperties } from './mass';
import type { EditMesh } from './mesh';
import type { Model, OpStatus } from './model';
import { model } from './model';
import { rigPhaseClaims, rigSweep, type SweepOverlap, type SweptVolume } from './motion-space';
import {
  convexHull,
  insideMargin,
  lineOfAction,
  NEGATIVE_SPACE,
  negativeSpace,
  type PoseCode,
  type PoseReport,
  type PoseReportOptions,
  silhouetteFill,
} from './pose-report';
import type { Point2 } from './primitives';
import { type Coverage, coverageOf, type Issue } from './report';
import {
  buildPiece,
  type MountedJoint,
  type MountHardwareOptions,
  type MountHardwareReport,
  planHardware,
} from './rig-hardware';
import {
  acrossOf,
  analyze,
  CLOSURE_ROWS,
  type ClosureRecord,
  closureRows,
  gram,
  jacobian,
  type LoopSpec,
  leastSquares,
  orientation,
  solveLinear,
} from './rig-loops';
import { type FaceSelector, sel } from './selectors';
import { SurfaceQuery } from './shrinkwrap';
import { rigStopReport } from './stops';

export type { Affine, Angles } from './affine';

/** `fixed` has no value; `revolute` turns about `axis` (degrees); `prismatic` slides along `axis` (meters); `spherical` turns by `Angles`. */
export type JointKind = 'fixed' | 'revolute' | 'prismatic' | 'spherical';

export type Range = readonly [number, number];

export interface JointSpec {
  readonly name: string;
  /** Parent joint name; `null` for the single root. Parents precede their children. */
  readonly parent: string | null;
  /** Rest position in model space. */
  readonly position: Tuple3;
  /** Rest orientation in model space (degrees, `Rz * Ry * Rx`). */
  readonly rotation?: Angles;
  /** Default `fixed`. */
  readonly kind?: JointKind;
  /** Revolute and prismatic: the motion axis in the joint's rest frame. */
  readonly axis?: Axis | Tuple3;
  /**
   * Revolute: `[min, max]` degrees; prismatic: `[min, max]` meters; spherical: a range
   * per axis in degrees (an axis without a range is locked at 0).
   */
  readonly limits?: Range | Readonly<Partial<Record<Axis, Range>>>;
  /**
   * Revolute and prismatic joints with limits: the hard stop each end lands on,
   * checked by `rig.stopReport`.
   */
  readonly stops?: { readonly min?: JointStop; readonly max?: JointStop };
  /**
   * Revolute and prismatic: this joint's value is `ratio * value(joint) + offset` (a gear,
   * rack or mirrored jaw). The leader is declared earlier, so cycles cannot be written. A
   * follower is not a coordinate: pose, path and driver lists name the leader, and the
   * follower's limits narrow the leader's range.
   */
  readonly mimic?: { readonly joint: string; readonly ratio: number; readonly offset?: number };
}

/** A hard stop: the part a joint's end lands on, and the moving part that lands on it. */
export interface JointStop {
  /** The stop part (it does not move with the joint). */
  readonly stop: string;
  /** The landing part (default: every part the joint carries). */
  readonly against?: string;
}

export interface StopReportOptions extends PoseOptions {
  /** The other joints' values (default rest). */
  readonly pose?: Pose;
  /** Largest gap that counts as landed (meters, default 0.0005). */
  readonly contact?: number;
}

/**
 * One stop at one end: `landed` (gap at the limit within `contact`, no deeper overlap, clear
 * at mid-travel), `open` (the end does not reach its stop), `through` (the end runs into its
 * stop deeper than `contact`), `early` (the stop touches at mid-travel) or `missing` (no part
 * of that name is bound) or `unreachable` (a mimic follower's limits keep the leader from
 * this end: the effective leader range stops short of it).
 */
export type StopFinding = 'landed' | 'open' | 'through' | 'early' | 'missing' | 'unreachable';

export interface StopCheck {
  readonly joint: string;
  readonly end: 'min' | 'max';
  readonly stop: string;
  readonly against: readonly string[];
  readonly value: number;
  /**
   * Gap at the limit, overlap depth there and gap at mid-travel (meters), null when the stop is
   * missing.
   */
  readonly gap: number | null;
  readonly depth: number | null;
  readonly travelGap: number | null;
  readonly finding: StopFinding;
}

export interface StopReport {
  readonly checks: readonly StopCheck[];
  /** `<joint>/<end>` of limited revolute and prismatic joints without a stop. */
  readonly unstopped: readonly string[];
  /** Every limited end has a stop and every stop `landed`. */
  readonly pass: boolean;
}

export interface RigSpec {
  readonly joints: readonly JointSpec[];
  /**
   * Pairs of parts designed to touch (pins in holes, hinge knuckles), with their own
   * tolerance; every interference test and scan applies them, after which per-call
   * `contacts` add or override.
   */
  readonly contacts?: readonly DesignedContact[];
  /**
   * Closed loops cut out of the tree (four-bars, cylinder rockers): each names the two
   * joints whose bodies meet. `pose` and everything built on it (`scan`, `toMesh`,
   * `finish`) solve the loop joints a pose does not name, so a path keys only the drivers.
   */
  readonly loops?: readonly LoopSpec[];
}

/** @internal Largest closure error (meters, or sines for directions) a solved loop may keep. */
export const LOOP_TOLERANCE = 1e-9;

/** Largest driver step of one solve when walking from a known pose (radians; meters / 10). */
const CONTINUATION_STEP = 0.1;

/** A pose with its loops closed: the full pose, the driven and solved joints and the fit. */
export interface LoopSolution {
  /** Every joint the pose named plus every solved loop joint. */
  readonly pose: Pose;
  readonly drivers: readonly string[];
  readonly solved: readonly string[];
  /** Largest closure error left (meters, or sines for directions). */
  readonly residual: number;
  readonly iterations: number;
  /**
   * Smallest over largest singular value of the closure Jacobian in the solved joints: near
   * 0 the solved joints are not determined by the drivers (a change point where two branches
   * meet, such as a parallelogram folding flat).
   */
  readonly conditioning: number;
  /**
   * Distance (largest solved-joint change: radians, or meters) to the nearest other closed
   * solution at the same drivers, the other assembly mode; Infinity when none is found.
   */
  readonly branchGap: number;
  /**
   * The next pose may continue on either branch: `conditioning` below `BRANCH_CONDITIONING`
   * (a change point), `branchGap` below `BRANCH_GAP` (a fold, where the two modes come close),
   * or continuation to this pose met a fold it could not step around.
   */
  readonly branchRisk: boolean;
}

/** @internal Conditioning below which a solved pose is reported as a branch risk. */
export const BRANCH_CONDITIONING = 1e-3;

/** @internal Distance to the other assembly mode below which a solved pose is a branch risk (0.35 rad, 20 degrees). */
export const BRANCH_GAP = 0.35;

/** Pushes along the least determined direction that look for the other assembly mode. */
const BRANCH_PUSHES = [0.05, 0.15, 0.35, 0.7] as const;

export interface MotionReportOptions {
  /** Named joint groups (joint name prefixes); the main groups are counted for concurrency. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
  /** Groups that count as main actions (default all). */
  readonly main?: readonly string[];
  /** Clip length in seconds (u = t / duration) and frame rate (default 24). */
  readonly duration: number;
  readonly fps?: number;
  /** Joint speed below which a group is still (rad/s or m/s, default 0.02). */
  readonly still?: number;
  /** Read points (e.g. from `choreograph`): each needs a hold of `hold` frames after it (default 8). */
  readonly readPoints?: readonly { readonly phase: string; readonly at: number }[];
  readonly hold?: number;
}

/**
 * Readability of a motion: `concurrent` when fewer than 90 % of the frames move at
 * most one main group, `short-hold` when a read point is not followed by a still hold.
 */
export type MotionCode = 'concurrent' | 'short-hold';

export interface MotionReport {
  readonly fps: number;
  readonly frames: number;
  /** Seconds intervals in which each group moves. */
  readonly groups: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  /** Share of frames with at most one main group moving. */
  readonly concurrency: number;
  /** Seconds intervals in which no group moves. */
  readonly holds: readonly (readonly [number, number])[];
  /** Per read point: the still frames that follow it. */
  readonly readPoints: readonly {
    readonly phase: string;
    readonly at: number;
    readonly held: number;
  }[];
  /** What fails (severity `warn`), with the measured values in `detail`. */
  readonly issues: readonly Issue<MotionCode>[];
}

export interface RigSweepOptions extends PoseOptions {
  /** Lattice spacing in meters (the CAD space-claim default is 0.01). */
  readonly voxel: number;
  /** Parts to sweep (default every part). */
  readonly parts?: readonly string[];
  /** The stretch of the path (default [0, 1]). */
  readonly u?: readonly [number, number];
}

export interface PhaseClaimsOptions extends PoseOptions {
  readonly voxel: number;
  /**
   * Phase windows in u (phases whose windows overlap run at the same time) and the joints each
   * drives (default: every part that moves in its window is its mover).
   */
  readonly phases: readonly {
    readonly id: string;
    readonly u: readonly [number, number];
    readonly joints?: readonly string[];
  }[];
  /** Designed pairs (hinge pins in their lugs, seats) whose shared cells are not conflicts. */
  readonly contacts?: readonly DesignedContact[];
}

export interface PhaseClaim {
  readonly phase: string;
  readonly u: readonly [number, number];
  /** The parts the phase's joints move (every moving part without `joints`). */
  readonly parts: readonly string[];
  /**
   * Parts that move in the window although no overlapping phase declares their joints (drive
   * members keyed through `extra`, loop links): they claim cells too and are checked.
   */
  readonly unclaimed: readonly string[];
  readonly count: number;
  readonly volume: number;
  readonly bounds: readonly [Tuple3, Tuple3] | null;
}

/**
 * Cells two parts both claim: `static` a part moving in a phase sweeps through a part standing
 * still during it, `concurrent` two parts moving relative to each other in the same phase
 * (one id in `phases`) or in overlapping phases sweep shared space (a timing hazard even when
 * sampled scans find them apart).
 */
export interface ClaimConflict extends SweepOverlap {
  readonly kind: 'static' | 'concurrent';
  readonly phases: readonly string[];
  readonly parts: readonly [string, string];
}

export type PhaseClaimsCode = 'static-conflict' | 'concurrent-conflict' | 'nothing-checked';

/**
 * `issues` holds one entry per conflict, plus `nothing-checked` when no part was evaluated.
 * `coverage` subjects are `phase/part`: a part moving in a phase is checked as a mover (both
 * codes), a standing one as a target (`static-conflict`); a moving part nobody evaluated is
 * unchecked.
 */
export interface PhaseClaimsReport {
  readonly voxel: number;
  readonly claims: readonly PhaseClaim[];
  readonly conflicts: readonly ClaimConflict[];
  readonly pass: boolean;
  readonly issues: readonly Issue<PhaseClaimsCode>[];
  readonly coverage: Coverage<PhaseClaimsCode>;
}

export interface ReleaseOptions extends PoseOptions {
  /** Where along the path the part starts to move (default 0). */
  readonly u?: number;
  /** Faces within this distance of another part are checked (meters, default 0.005). */
  readonly near?: number;
  /** Degrees where the critical band starts (default 85). */
  readonly warn?: number;
}

/** A face of the released part beside a neighbour, its draft against the part's motion. */
export interface ReleaseFace extends DraftFace {
  readonly neighbour: string;
  readonly gap: number;
}

export interface ReleaseReport {
  readonly part: string;
  readonly u: number;
  readonly faces: readonly ReleaseFace[];
  readonly critical: readonly number[];
  /** Faces that move into their neighbour as the part starts: the part cannot leave. */
  readonly undercut: readonly number[];
}

/** Steel, the default density of `actuation` (kg/m^3). */
export const STEEL_DENSITY = 7850;

export interface ActuationOptions extends PoseOptions {
  /** Density of every part, or per part name (kg/m^3, default `STEEL_DENSITY`). */
  readonly density?: number | Readonly<Record<string, number>>;
  /** Gravity in model space (m/s^2, default [0, -9.81, 0]). */
  readonly gravity?: Tuple3;
  /** Rated effort per joint (N m for turns, N for slides); a holding effort above it is reported. */
  readonly ratings?: Readonly<Record<string, number>>;
  /** A pose past a joint limit fails (`reject`, the default) or is clamped and reported. */
  readonly limits?: LimitMode;
}

/** The effort one joint coordinate holds against gravity at a pose. */
export interface JointEffort {
  readonly joint: string;
  /** Spherical joints: the angle axis. */
  readonly axis?: Axis;
  readonly kind: 'revolute' | 'prismatic' | 'spherical';
  /**
   * dV/dq: the torque (N m) or force (N) the joint's actuator must apply against gravity to
   * hold the pose; for loop drivers it acts through the closed mechanism, so it grows without
   * bound near a dead centre.
   */
  readonly effort: number;
  readonly rating?: number;
  /**
   * The joint rests on a declared stop at this limit and the effort pushes into it: the stop
   * carries it (never `exceeded`).
   */
  readonly atStop?: 'min' | 'max';
  readonly exceeded: boolean;
}

export interface ActuationReport {
  /** Total mass of the closed rigid parts (kg). */
  readonly mass: number;
  /** Centre of mass at the pose (model space). */
  readonly centroid: Tuple3;
  /** Every driven coordinate: tree joints, and the loop joints the pose names (drivers). */
  readonly joints: readonly JointEffort[];
  /** Joints whose effort is above their rating. */
  readonly exceeded: readonly string[];
  /** Open parts (no volume) left out of the mass. */
  readonly massless: readonly string[];
  /** Joints held at a limit (only with `limits: 'clamp'`; reports reject by default). */
  readonly clamped: readonly Clamp[];
}

/** Degrees of freedom by formula and by the rank of the closure Jacobian. */
export interface MobilityReport {
  /** Joint coordinates: 1 per revolute and prismatic joint, 3 per spherical joint. */
  readonly coordinates: number;
  /** Closure rows: 5 per pin or slide, 3 per ball. */
  readonly constraints: number;
  readonly rank: number;
  /** Coordinates minus the rank, idle spins left out: the motions the closed rig really has at this pose. */
  readonly mobility: number;
  /**
   * Grubler-Kutzbach count: coordinates minus every closure's rows, with 2 per pin or slide
   * when the loops are planar (all revolute axes parallel, every slide across them).
   */
  readonly grubler: number;
  readonly planar: boolean;
  /**
   * Idle spins left out of `mobility`: S-S links (a spherical joint meeting the loop at one
   * ball) turning about their own axis, which moves nothing else. The count includes them,
   * so `mobility + idle` is what the closure Jacobian leaves.
   */
  readonly idle: number;
  readonly idleJoints: readonly string[];
  /** `mobility` above `grubler`: closures only hold through special geometry (coaxial hinges). */
  readonly overconstrained: boolean;
  readonly redundant: number;
  /** With `drivers`: the driven coordinates and the motions they leave free. */
  readonly actuation?: {
    readonly drivers: readonly string[];
    /** Motions left when every driver is held: above 0 the rig is underactuated. */
    readonly free: number;
    readonly underactuated: boolean;
    /** Joints that move in those free motions. */
    readonly uncontrolled: readonly string[];
    /** Drivers that the others and the loops already determine. */
    readonly redundantDrivers: number;
  };
}

/** A number for revolute and prismatic joints, `Angles` for spherical joints. */
export type JointValue = number | Angles;

/** Joint values by name; joints left out stay at rest (0). */
export type Pose = Readonly<Record<string, JointValue>>;

export interface PoseKey {
  /** Path parameter in [0, 1]; keys are strictly increasing. */
  readonly u: number;
  /**
   * Sparse: each joint is keyed only by the keys that name it and interpolates between
   * its own keys; it starts from rest at u = 0 unless a key names it there, and holds its
   * last value. Joints no key names stay at rest, so u = 0 is the rest pose unless keyed.
   */
  readonly pose: Pose;
}

/** `smooth` eases in and out of every key (zero joint velocity at keys). */
/**
 * `smooth` eases in and out of every key (zero joint velocity at keys); `hermite` passes
 * through keys with velocity (Steffen's monotone cubic: no overshoot between keys, zero
 * velocity only at each joint's first and last key).
 */
export type PathInterpolation = 'linear' | 'smooth' | 'step' | 'hermite';

/** A transformation path: keyed poses over u in [0, 1]. */
export interface PosePath {
  readonly keys: readonly PoseKey[];
  readonly interpolation?: PathInterpolation;
}

/** `clamp` (default) applies the nearest limit and reports it; `reject` fails instead. */
export type LimitMode = 'clamp' | 'reject';

export interface PoseOptions {
  readonly limits?: LimitMode;
}

export interface Clamp {
  readonly joint: string;
  readonly axis?: Axis;
  readonly requested: number;
  readonly applied: number;
  /**
   * A loop joint the solve put beyond its limit: `requested` is the solved value (kept, the
   * loop cannot close otherwise) and `applied` the limit it passes.
   */
  readonly solved?: true;
}

export interface JointPose {
  readonly name: string;
  /** The applied (clamped) value; `null` for fixed joints. */
  readonly value: JointValue | null;
  /** Model-space transform of the joint frame. */
  readonly world: Affine;
}

export interface PoseResult {
  readonly joints: readonly JointPose[];
  readonly clamped: readonly Clamp[];
}

export interface RigPart {
  readonly name: string;
  readonly joint: string;
  readonly faces: number;
  /** Every edge of the part has two part faces. */
  readonly closed: boolean;
}

export interface BindReport {
  readonly status: OpStatus;
  readonly part: string;
  readonly joint: string;
  readonly error?: ModelingError;
}

/** Settings of `bindAuto` (defaults in brackets). */
export interface AutoWeightOptions {
  /** Part name [the joint names joined by '-']. */
  readonly part?: string;
  /** Occupancy cells along the region's longest axis [64]. */
  readonly resolution?: number;
  /** 0 gives a 1 / d^2 falloff, 1 gives 1 / d^4 [0.2]. */
  readonly stiffness?: number;
  /** Cotangent smoothing iterations [8]. */
  readonly smoothing?: number;
  /** Blend toward the neighbor average per iteration [0.5]. */
  readonly smoothingStrength?: number;
  /** Influences per vertex, at most 4 [4]. */
  readonly maxInfluences?: number;
  /** Influences below this weight are dropped [0.01]. */
  readonly prune?: number;
}

/** The automatic weights of one `bindAuto` region, from the `skin.bind` compute job. */
export interface SkinWeights {
  readonly part: string;
  /** Source vertex ids of the region, ascending. */
  readonly vertices: Int32Array;
  /** Per region vertex, 4 joint indices into `rig.joints`, by descending weight. */
  readonly joints: Uint16Array;
  /** Per region vertex, 4 weights summing to 1 (unused slots 0). */
  readonly weights: Float32Array;
  /** `partial`: some vertices no bone reaches inside the shape use straight distances. */
  readonly status: 'ok' | 'partial';
  readonly report: ComputeJobReport;
  readonly locations: readonly ComputeLocation[];
}

/**
 * `rigid` (default): one mesh per part in its joint's rest frame, parented under
 * joint entities (no `bindAuto` regions). `skinned`: one mesh with `skinIndex`/
 * `skinWeight` (rigid parts single-influence, `bindAuto` regions up to four) plus
 * Skeleton and Skin assets, for the Engine's skinning path.
 */
export type RigExportForm = 'rigid' | 'skinned';

export interface RigClipSpec {
  /** Source key segment: `animation-clip/<key>/<name>`. */
  readonly name: string;
  readonly path: PosePath;
  /** Clip length in seconds. */
  readonly duration: number;
  /** Clip samples per second (default 30). */
  readonly frameRate?: number;
  readonly loop?: boolean;
}

export interface RigFinishOptions {
  /** Source key segment of every output (`mesh/<key>.<part>`, `scene/<key>`, ...). */
  readonly key: string;
  /** The Pack build context's `packageId`: scene references use derived GUIDs. */
  readonly packageId: PackageId;
  readonly form?: RigExportForm;
  readonly normals?: NormalMode;
  /** Export this path as `animation-clip/<key>` and play it on the rig entity. */
  readonly path?: PosePath;
  /**
   * Several named clips, each `animation-clip/<key>/<name>`; mutually exclusive with `path`.
   * The Engine clip format has no loop flag, so `loop` (default false) is reported by
   * `Rig.exportedClips` and sets `AnimationPlayer.looping` for the first clip, the one the
   * rig entity's player starts on.
   */
  readonly clips?: readonly RigClipSpec[];
  /**
   * Pack material source key per mesh slot name (`{ paint: 'material/arm-paint' }`). Every
   * exported mesh slot needs an entry; the renderers bind them in slot order. Omitted: the
   * renderers carry no materials.
   */
  readonly materials?: Readonly<Record<string, string>>;
  /** Clip length in seconds (default 4). */
  readonly duration?: number;
  /** Clip samples per second (default 30). */
  readonly frameRate?: number;
}

/** @internal */
export interface MimicLink {
  readonly leader: number;
  readonly ratio: number;
  readonly offset: number;
  readonly root: number;
  readonly rootRatio: number;
  readonly rootOffset: number;
}

/** @internal The range a pose may take for this joint (a leader with followers: its reach). */
export function rangeOf(joint: JointRecord): JointRecord['limits'] {
  return joint.reach ?? joint.limits;
}

/** @internal Whether a declared stop holds the end of the joint's pose range. */
export function stopHeld(joint: JointRecord, end: 'min' | 'max'): boolean {
  return joint.holds === undefined ? joint.stops?.[end] !== undefined : joint.holds[end];
}

/** @internal */
export interface JointRecord {
  readonly name: string;
  readonly parent: number;
  readonly kind: JointKind;
  readonly axis: Tuple3;
  readonly limits: Range | Readonly<Partial<Record<Axis, Range>>> | undefined;
  readonly stops: JointSpec['stops'];
  /** A follower: its leader as declared and the same relation composed back to the root leader. */
  readonly mimic?: MimicLink;
  /** A root leader with followers: the leader range every follower limit allows. */
  readonly reach?: Range | undefined;
  /** A root leader with followers: whether a declared stop holds each end of `reach`. */
  readonly holds?: { readonly min: boolean; readonly max: boolean };
  readonly restWorld: Affine;
  /** Rest transform relative to the parent's rest frame. */
  readonly restLocal: Affine;
}

interface TrackKey {
  readonly u: number;
  readonly value: JointValue;
}

interface Binding {
  readonly part: string;
  /** The rigid joint; for an automatic region its first joint. */
  readonly joint: number;
  readonly faces: FaceSelector;
  readonly auto?: { readonly joints: readonly number[]; readonly options: AutoWeightOptions };
}

interface ResolvedSkin {
  readonly name: string;
  readonly joints: readonly number[];
  readonly faces: readonly number[];
  readonly options: AutoWeightOptions;
}

interface Resolved {
  readonly parts: ResolvedPart[];
  readonly skins: ResolvedSkin[];
  /** Source vertex -> index into `parts`. */
  readonly rigidVertex: ReadonlyMap<number, number>;
}

/** Source keys of a finished rig, in sorted order. */
function outputKeysOf(
  key: string,
  parts: readonly string[],
  skinned: boolean,
  clips: boolean | readonly string[],
): string[] {
  const keys = skinned
    ? [`mesh/${key}`, `skeleton/${key}`, `skin/${key}`]
    : parts.map((part) => `mesh/${key}.${part}`);
  if (clips === true) keys.push(`animation-clip/${key}`);
  else if (clips !== false) for (const name of clips) keys.push(`animation-clip/${key}/${name}`);
  keys.push(`scene/${key}`);
  return keys.sort();
}

/** @internal A bound part resolved against the current source mesh. */
export interface ResolvedPart {
  readonly name: string;
  readonly joint: number;
  readonly faces: readonly number[];
  readonly closed: boolean;
}

const KEY = /^[a-z0-9][a-z0-9_.-]*$/;
const AXES: readonly Axis[] = ['x', 'y', 'z'];

/** @internal */
export function finite(...values: readonly unknown[]): boolean {
  return values.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function isRange(value: unknown): value is Range {
  return Array.isArray(value) && value.length === 2 && finite(...value) && value[0] <= value[1];
}

function unit(axis: Axis | Tuple3): Tuple3 | undefined {
  if (typeof axis === 'string') return AXES.includes(axis) ? axisVector(axis) : undefined;
  if (!Array.isArray(axis) || axis.length !== 3 || !finite(...axis)) return undefined;
  const l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  return l > 1e-12 ? [axis[0] / l, axis[1] / l, axis[2] / l] : undefined;
}

function rejectSpec(expected: string, detail: Record<string, unknown>, hint?: string) {
  return err(modelingError('model-invalid-argument', expected, detail, hint));
}

function compileJoints(spec: RigSpec): Result<JointRecord[], ModelingError> {
  if (!Array.isArray(spec?.joints) || spec.joints.length === 0) {
    return rejectSpec('a rig has at least one joint', {});
  }
  const index = new Map<string, number>();
  const out: JointRecord[] = [];
  for (const [i, j] of spec.joints.entries()) {
    if (typeof j.name !== 'string' || !KEY.test(j.name)) {
      return rejectSpec('joint names are lowercase key segments', { joint: i, name: j.name });
    }
    if (index.has(j.name)) return rejectSpec('joint names are unique', { joint: j.name });
    let parent = -1;
    if (j.parent === null) {
      if (out.some((o) => o.parent < 0)) {
        return rejectSpec(
          'a rig has a single root joint',
          { joint: j.name },
          'parent every other joint to the root',
        );
      }
    } else {
      const p = index.get(j.parent);
      if (p === undefined) {
        return rejectSpec('a parent joint precedes its children', {
          joint: j.name,
          parent: j.parent,
        });
      }
      parent = p;
    }
    if (!Array.isArray(j.position) || j.position.length !== 3 || !finite(...j.position)) {
      return rejectSpec('a finite rest position [x, y, z]', { joint: j.name });
    }
    if (
      j.rotation !== undefined &&
      !AXES.every((a) => j.rotation?.[a] === undefined || finite(j.rotation[a]))
    ) {
      return rejectSpec('finite rest rotation angles', { joint: j.name });
    }
    const kind = j.kind ?? 'fixed';
    let axis: Tuple3 = [0, 0, 0];
    if (kind === 'revolute' || kind === 'prismatic') {
      const u = j.axis === undefined ? undefined : unit(j.axis);
      if (u === undefined) {
        return rejectSpec(`a ${kind} joint has a non-zero axis`, { joint: j.name });
      }
      axis = u;
      if (j.limits !== undefined && !isRange(j.limits)) {
        return rejectSpec(`${kind} limits are [min, max] with min <= max`, { joint: j.name });
      }
      const ends = j.stops === undefined ? [] : [j.stops.min, j.stops.max];
      if (
        ends.length > 0 &&
        (j.limits === undefined ||
          ends.every((e) => e === undefined) ||
          !ends.every(
            (e) =>
              e === undefined ||
              (typeof e.stop === 'string' &&
                KEY.test(e.stop) &&
                (e.against === undefined ||
                  (typeof e.against === 'string' && KEY.test(e.against)))),
          ))
      ) {
        return rejectSpec(
          'stops on a limited joint: { min?, max? } with stop (and against) part names',
          { joint: j.name },
        );
      }
    } else if (kind === 'spherical') {
      const limits = j.limits;
      if (
        limits !== undefined &&
        (Array.isArray(limits) ||
          !AXES.every(
            (a) =>
              (limits as Record<string, unknown>)[a] === undefined ||
              isRange((limits as Record<string, unknown>)[a]),
          ))
      ) {
        return rejectSpec('spherical limits are { x?, y?, z? } ranges in degrees', {
          joint: j.name,
        });
      }
    } else if (kind === 'fixed') {
      if (j.limits !== undefined || j.axis !== undefined || j.stops !== undefined) {
        return rejectSpec('a fixed joint has no axis or limits', { joint: j.name });
      }
    } else {
      return rejectSpec("a joint kind 'fixed' | 'revolute' | 'prismatic' | 'spherical'", {
        joint: j.name,
        kind,
      });
    }
    let mimic: MimicLink | undefined;
    if (j.mimic !== undefined) {
      const linked = linkMimic(j, kind, index, out);
      if (!linked.ok) return linked;
      mimic = linked.value;
    }
    const restWorld = multiply(translation(j.position), fromAngles(j.rotation));
    const restLocal =
      parent < 0
        ? restWorld
        : multiply(invertRigid((out[parent] as JointRecord).restWorld), restWorld);
    index.set(j.name, out.length);
    if (kind === 'spherical' && j.stops !== undefined) {
      return rejectSpec('stops on revolute and prismatic joints', { joint: j.name });
    }
    out.push({
      name: j.name,
      parent,
      kind,
      axis,
      limits: j.limits,
      stops: j.stops,
      ...(mimic === undefined ? {} : { mimic }),
      restWorld,
      restLocal,
    });
  }
  return reachOf(out);
}

function linkMimic(
  j: JointSpec,
  kind: JointKind,
  index: ReadonlyMap<string, number>,
  out: readonly JointRecord[],
): Result<MimicLink, ModelingError> {
  const m = j.mimic as NonNullable<JointSpec['mimic']>;
  const leader = typeof m?.joint === 'string' ? index.get(m.joint) : undefined;
  if (kind !== 'revolute' && kind !== 'prismatic') {
    return rejectSpec('a mimic follower is a revolute or prismatic joint', { joint: j.name, kind });
  }
  if (leader === undefined) {
    return rejectSpec(
      'a mimic joint precedes its follower',
      { joint: j.name, mimic: m?.joint },
      'declare the leader before the follower; a cycle needs a forward reference, so it cannot be written',
    );
  }
  const head = out[leader] as JointRecord;
  if (head.kind !== 'revolute' && head.kind !== 'prismatic') {
    return rejectSpec('a mimic leader is a revolute or prismatic joint', {
      joint: j.name,
      mimic: m.joint,
      kind: head.kind,
    });
  }
  const offset = m.offset ?? 0;
  if (!finite(m.ratio, offset) || m.ratio === 0) {
    return rejectSpec(
      'a finite non-zero mimic ratio and a finite offset',
      { joint: j.name, ratio: m.ratio, offset: m.offset },
      m.ratio === 0 ? "a zero ratio is a fixed joint: use kind: 'fixed'" : undefined,
    );
  }
  const above = head.mimic;
  return ok({
    leader,
    ratio: m.ratio,
    offset,
    root: above === undefined ? leader : above.root,
    rootRatio: above === undefined ? m.ratio : m.ratio * above.rootRatio,
    rootOffset: above === undefined ? offset : m.ratio * above.rootOffset + offset,
  });
}

const near = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

/** Combine every follower's limits onto its root leader, in declaration order. */
function reachOf(out: JointRecord[]): Result<JointRecord[], ModelingError> {
  const reach = new Map<number, Range>();
  const mapped = (f: JointRecord): Range | undefined => {
    const link = f.mimic as MimicLink;
    if (!Array.isArray(f.limits)) return undefined;
    const [lo, hi] = f.limits as Range;
    const a = (lo - link.rootOffset) / link.rootRatio;
    const b = (hi - link.rootOffset) / link.rootRatio;
    return a <= b ? [a, b] : [b, a];
  };
  for (const f of out) {
    const link = f.mimic;
    if (link === undefined) continue;
    const root = out[link.root] as JointRecord;
    const own =
      reach.get(link.root) ?? (Array.isArray(root.limits) ? (root.limits as Range) : undefined);
    const to = mapped(f);
    const next: Range | undefined =
      to === undefined
        ? own
        : own === undefined
          ? to
          : [Math.max(own[0], to[0]), Math.min(own[1], to[1])];
    if (next === undefined) continue;
    const detail = {
      joint: f.name,
      leader: root.name,
      ratio: link.rootRatio,
      leaderRange: own,
      followerRange: to,
    };
    if (next[0] > next[1]) {
      return rejectSpec(
        'follower limits that overlap the leader range',
        detail,
        `no value of '${root.name}' keeps '${f.name}' (= ${link.rootRatio} * '${root.name}' + ${link.rootOffset}) in its limits`,
      );
    }
    if (next[0] > 0 || next[1] < 0) {
      return rejectSpec(
        'an effective leader range that includes the rest value 0',
        { ...detail, effective: next },
        `widen the limits of '${f.name}' or '${root.name}' (or set the mimic offset) so the rest pose is reachable`,
      );
    }
    reach.set(link.root, next);
  }
  const held = (j: JointRecord, end: 'min' | 'max', lo: number, hi: number, r: Range) => {
    const link = j.mimic;
    const sign = link === undefined ? 1 : Math.sign(link.rootRatio);
    const own = (end === 'min') === sign > 0 ? 'min' : 'max';
    return (
      j.stops?.[own] !== undefined && near(end === 'min' ? lo : hi, end === 'min' ? r[0] : r[1])
    );
  };
  for (const [root, r] of reach) {
    const holds = { min: false, max: false };
    for (const j of out) {
      if (j.mimic === undefined ? out.indexOf(j) !== root : j.mimic.root !== root) continue;
      const to = j.mimic === undefined ? (j.limits as Range | undefined) : mapped(j);
      if (to === undefined) continue;
      holds.min ||= held(j, 'min', to[0], to[1], r);
      holds.max ||= held(j, 'max', to[0], to[1], r);
    }
    out[root] = { ...(out[root] as JointRecord), reach: r, holds };
  }
  return ok(out);
}

function clampValue(value: number, range: Range | undefined): number {
  if (range === undefined) return value;
  return Math.min(range[1], Math.max(range[0], value));
}

/** Local motion of a joint at its value, in the joint's rest frame. */
function motion(joint: JointRecord, value: JointValue | null): Affine {
  switch (joint.kind) {
    case 'fixed':
      return IDENTITY;
    case 'revolute':
      return axisAngle(joint.axis, value as number);
    case 'prismatic':
      return translation(joint.axis.map((c) => c * (value as number)));
    case 'spherical':
      return fromAngles(value as Angles);
  }
}

/** A distance inside a fit band, with 1 nm slack for flush faces. */
function within(d: number, gap: readonly [number, number]): boolean {
  return d >= gap[0] - FIT_TOLERANCE && d <= gap[1] + FIT_TOLERANCE;
}

/**
 * Steffen's monotone cubic between keys s and s + 1 (of 0..last) at fraction t: tangents limited so the
 * curve never overshoots between keys; zero at the first and last key (the value holds there).
 */
function steffen(
  u: (k: number) => number,
  v: (k: number) => number,
  last: number,
  s: number,
  t: number,
): number {
  const h = (k: number) => u(k + 1) - u(k);
  const d = (k: number) => (v(k + 1) - v(k)) / h(k);
  const tangent = (k: number) => {
    if (k <= 0 || k >= last) return 0;
    const d0 = d(k - 1);
    const d1 = d(k);
    if (d0 * d1 <= 0) return 0;
    const p = (d0 * h(k) + d1 * h(k - 1)) / (h(k - 1) + h(k));
    return (
      (Math.sign(d0) + Math.sign(d1)) * Math.min(Math.abs(d0), Math.abs(d1), 0.5 * Math.abs(p))
    );
  };
  const a = v(s);
  const b = v(s + 1);
  const span = h(s);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * a +
    (t3 - 2 * t2 + t) * span * tangent(s) +
    (-2 * t3 + 3 * t2) * b +
    (t3 - t2) * span * tangent(s + 1)
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A rig over one modeling session: the joint table plus rigid part bindings.
 * Bindings are selector expressions, re-evaluated against the session whenever the
 * rig is used. The first failure poisons the rig, like a session.
 */
export class Rig {
  readonly source: Model;
  /** @internal */
  readonly _table: readonly JointRecord[];
  private readonly index: ReadonlyMap<string, number>;
  private readonly bindings: Binding[] = [];
  private readonly designed: DesignedContact[];
  private failure: ModelingError | undefined;
  private readonly compiled = new WeakMap<
    PosePath,
    Result<Map<number, TrackKey[]>, ModelingError>
  >();
  private exported:
    | { readonly key: string; readonly path?: PosePath; readonly clips: readonly ClipReport[] }
    | undefined;
  private readonly weightCache = new Map<string, SkinWeights>();
  private readonly closures: readonly ClosureRecord[];
  /** Solved loop poses by solved-joint set: driver coordinates and solution, for warm starts. */
  private readonly loopCache = new Map<string, { drivers: number[]; x: number[] }[]>();

  constructor(source: Model, spec: RigSpec) {
    this.source = source;
    this.designed = [...(spec?.contacts ?? [])];
    const compiled = compileJoints(spec);
    if (compiled.ok) {
      this._table = compiled.value;
    } else {
      this._table = [];
      this.failure = compiled.error;
    }
    this.index = new Map(this._table.map((j, i) => [j.name, i]));
    const closures = this.failure === undefined ? this.compileLoops(spec?.loops ?? []) : ok([]);
    this.closures = closures.ok ? closures.value : [];
    if (!closures.ok) this.failure = closures.error;
    this.failure ??= this.followerLoop();
    registerCapturedRig(this);
  }

  get poisoned(): ModelingError | undefined {
    return this.failure;
  }

  /** Output source key of the last finish() (`scene/<key>`); absent before it. */
  get output(): string | undefined {
    return this.exported === undefined ? undefined : `scene/${this.exported.key}`;
  }

  /** The clips the last finish() exported with `clips`: name, source key, loop, duration, frames. */
  get exportedClips(): readonly ClipReport[] {
    return this.exported?.clips ?? [];
  }

  /** The transformation path the last finish() exported; tools scan and pose along it. */
  get path(): PosePath | undefined {
    return this.exported?.path;
  }

  /**
   * The faces of one bound part as a selector: its binding minus the faces later
   * bindings take over.
   */
  partFaces(part: string): Result<FaceSelector, ModelingError> {
    const i = this.bindings.findIndex((b) => b.part === part);
    if (i < 0) {
      return err(
        modelingError('model-invalid-argument', 'the part is bound in the rig', {
          part,
          parts: this.bindings.map((b) => b.part),
        }),
      );
    }
    return ok(
      this.bindings
        .slice(i + 1)
        .reduce<FaceSelector>(
          (faces, later) => faces.minus(later.faces),
          (this.bindings[i] as Binding).faces,
        ),
    );
  }

  /** The compiled joint table (rest transforms in model space). */
  get joints(): readonly {
    readonly name: string;
    readonly parent: string | null;
    readonly kind: JointKind;
    readonly axis: Tuple3;
    readonly limits?: JointSpec['limits'];
    readonly rest: Affine;
  }[] {
    return this._table.map((j) => ({
      name: j.name,
      parent: j.parent < 0 ? null : (this._table[j.parent] as JointRecord).name,
      kind: j.kind,
      axis: j.axis,
      ...(j.limits === undefined ? {} : { limits: j.limits }),
      rest: j.restWorld,
    }));
  }

  /**
   * Bind the selected faces rigidly to `joint`. The part is named `options.part`
   * (default: the joint name). A later binding takes over faces an earlier one selected,
   * so `bindRigid(sel.all(), 'root')` first and specific parts after is the usual form.
   */
  bindRigid(
    faces: FaceSelector,
    joint: string,
    options: { readonly part?: string } = {},
  ): BindReport {
    const part = options.part ?? joint;
    const base = { part, joint };
    if (this.failure !== undefined) return { ...base, status: 'skipped' };
    const j = this.index.get(joint);
    let failure: ModelingError | undefined;
    if (j === undefined) {
      failure = modelingError('model-invalid-argument', 'the joint exists in the rig', {
        joint,
        joints: this._table.map((t) => t.name),
      });
    } else if (!KEY.test(part)) {
      failure = modelingError('model-invalid-argument', 'part names are lowercase key segments', {
        part,
      });
    } else if (this.bindings.some((b) => b.part === part)) {
      failure = modelingError(
        'model-invalid-argument',
        'part names are unique',
        { part },
        'pass options.part to bind several parts to one joint',
      );
    }
    if (failure !== undefined) {
      this.failure = failure;
      return { ...base, status: 'failed', error: failure };
    }
    this.bindings.push({ part, joint: j as number, faces });
    return { ...base, status: 'ok' };
  }

  /**
   * Bind the selected faces with automatic weights over `joints` (the `skin.bind`
   * compute job: geodesic voxel distances to each joint's bone, cotangent smoothing,
   * normalize, at most four influences, prune). Bones run from a joint to each of its
   * children. Vertices the region shares with rigid parts stay on those parts' joints,
   * which must be among `joints`. Takes over faces like `bindRigid`; the region moves
   * by linear blend skinning in poses and exports with `form: 'skinned'`; interference
   * tests leave it out.
   */
  bindAuto(
    faces: FaceSelector,
    joints: readonly string[],
    options: AutoWeightOptions = {},
  ): BindReport {
    const part = options.part ?? (Array.isArray(joints) ? joints.join('-') : '');
    const base = { part, joint: Array.isArray(joints) ? (joints[0] ?? '') : '' };
    if (this.failure !== undefined) return { ...base, status: 'skipped' };
    const ids = Array.isArray(joints) ? joints.map((name) => this.index.get(name)) : [];
    let failure: ModelingError | undefined;
    if (!Array.isArray(joints) || joints.length === 0 || new Set(joints).size !== joints.length) {
      failure = modelingError('model-invalid-argument', 'a non-empty list of distinct joints', {
        joints,
      });
    } else if (ids.some((j) => j === undefined)) {
      failure = modelingError('model-invalid-argument', 'the joints exist in the rig', {
        joints: joints.filter((_, i) => ids[i] === undefined),
        known: this._table.map((t) => t.name),
      });
    } else if (!KEY.test(part)) {
      failure = modelingError('model-invalid-argument', 'part names are lowercase key segments', {
        part,
      });
    } else if (this.bindings.some((b) => b.part === part)) {
      failure = modelingError(
        'model-invalid-argument',
        'part names are unique',
        { part },
        'pass options.part to name the region',
      );
    }
    if (failure !== undefined) {
      this.failure = failure;
      return { ...base, status: 'failed', error: failure };
    }
    const resolvedJoints = ids as number[];
    this.bindings.push({
      part,
      joint: resolvedJoints[0] as number,
      faces,
      auto: { joints: resolvedJoints, options },
    });
    return { ...base, status: 'ok' };
  }

  /** The automatic weights of a `bindAuto` region, computed for the current session. */
  weights(part: string): Result<SkinWeights, ModelingError> {
    const resolved = this.resolveAll();
    if (!resolved.ok) return resolved;
    const skin = resolved.value.skins.find((s) => s.name === part);
    if (skin === undefined) {
      return err(
        modelingError('model-invalid-argument', 'the part is a bindAuto region of the rig', {
          part,
          regions: resolved.value.skins.map((s) => s.name),
        }),
      );
    }
    return this.skinWeights(skin, resolved.value);
  }

  /** The rigidly bound parts, resolved against the current session. */
  parts(): Result<readonly RigPart[], ModelingError> {
    const resolved = this._resolve();
    if (!resolved.ok) return resolved;
    return ok(
      resolved.value.map((p) => ({
        name: p.name,
        joint: (this._table[p.joint] as JointRecord).name,
        faces: p.faces.length,
        closed: p.closed,
      })),
    );
  }

  /** Forward kinematics with limit clamping. */
  pose(pose: Pose = {}, options: PoseOptions = {}): Result<PoseResult, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const values: (JointValue | null)[] = this._table.map(() => null);
    const clamped: Clamp[] = [];
    for (const [name, value] of Object.entries(pose)) {
      const i = this.index.get(name);
      if (i === undefined) {
        return err(
          modelingError('model-invalid-argument', 'pose joints exist in the rig', {
            joint: name,
            joints: this._table.map((t) => t.name),
          }),
        );
      }
      const joint = this._table[i] as JointRecord;
      const follower = this.followerError(i);
      if (follower !== undefined) return err(follower);
      const applied = this.applyLimits(joint, value, clamped);
      if (!applied.ok) return applied;
      values[i] = applied.value;
    }
    if (this.closures.length > 0) {
      const named = values.map((v) => v !== null);
      const closed = this.closeLoops(values, undefined);
      if (!closed.ok) return closed;
      // Solved loop joints are not clamped (the loop would open), but passing a limit is reported.
      for (const [i, joint] of this._table.entries()) {
        if (named[i] === true || values[i] === null) continue;
        const beyond: Clamp[] = [];
        this.applyLimits({ ...joint, reach: undefined }, values[i] as JointValue, beyond);
        for (const c of beyond) clamped.push({ ...c, solved: true });
      }
      for (const joint of this._table) {
        const link = joint.mimic;
        if (link === undefined || named[link.root] === true || values[link.root] === null) continue;
        const beyond: Clamp[] = [];
        const solved = link.rootRatio * (values[link.root] as number) + link.rootOffset;
        this.applyLimits(joint, solved, beyond);
        for (const c of beyond) clamped.push({ ...c, solved: true });
      }
    }
    this.follow(values);
    if (options.limits === 'reject' && clamped.length > 0) {
      return err(
        modelingError(
          'model-invalid-argument',
          'pose values within the joint limits',
          { clamped },
          "move the values inside detail.clamped[].applied, or use limits: 'clamp'",
        ),
      );
    }
    const world = this.worlds(values);
    const joints = this._table.map((joint, i) => ({
      name: joint.name,
      value: this.valueAt(values, i),
      world: world[i] as Affine,
    }));
    return ok({ joints, clamped });
  }

  /**
   * Close the rig's loops at `pose`: the loop joints the pose does not name are solved
   * (Levenberg-Marquardt from `guess`, else from the nearest pose solved before). Reports
   * the closure error and how well the drivers determine the solved joints.
   */
  solve(
    pose: Pose = {},
    options: PoseOptions & { readonly guess?: Pose } = {},
  ): Result<LoopSolution, ModelingError> {
    const posed = this.pose(pose, options);
    if (!posed.ok) return posed;
    const values: (JointValue | null)[] = this._table.map(() => null);
    for (const name of Object.keys(pose)) {
      const i = this.index.get(name) as number;
      values[i] = (posed.value.joints[i] as JointPose).value;
    }
    let guess: (JointValue | null)[] | undefined;
    if (options.guess !== undefined) {
      guess = this._table.map(() => null);
      for (const [name, value] of Object.entries(options.guess)) {
        const i = this.index.get(name);
        if (i === undefined) {
          return err(
            modelingError('model-invalid-argument', 'guess joints exist in the rig', {
              joint: name,
            }),
          );
        }
        const follower = this.followerError(i);
        if (follower !== undefined) return err(follower);
        guess[i] = value;
      }
    }
    const closed = this.closeLoops(values, guess);
    if (!closed.ok) return closed;
    const { coords, residual, iterations, folded } = closed.value;
    const x = coords.map((c) => this.coordinate(values, c));
    const rows = this.closureAt(values, coords);
    const j = jacobian(rows, x);
    // Idle spins (S-S links) leave the Jacobian singular at every pose: hold them first.
    const { singular, vectors } = analyze([...j, ...this.idleSpins(values, coords).rows], x.length);
    const top = singular[0] ?? 0;
    const conditioning = x.length === 0 || top === 0 ? 1 : (singular[x.length - 1] as number) / top;
    // The other assembly mode: solve again from starts pushed along the least determined
    // direction of the solved joints and keep the nearest distinct closed solution.
    let branchGap = Infinity;
    const weakest = vectors.map((row) => row[x.length - 1] as number);
    // Another root that differs only by idle spins is the same assembly.
    const spins = this.idleSpins(values, coords).rows.map((v) => {
      const l = Math.sqrt(v.reduce((sum, c) => sum + c * c, 0));
      return v.map((c) => c / l);
    });
    const unspun = (g: number[]) => {
      for (const v of spins) {
        const along = g.reduce((sum, c, k) => sum + c * (v[k] as number), 0);
        for (let k = 0; k < g.length; k++) g[k] = (g[k] as number) - along * (v[k] as number);
      }
      return g;
    };
    // Re-solves pin the spins where they are, so they cannot drift onto a spun copy.
    const pinned = (y: readonly number[]) => [
      ...rows(y),
      ...spins.map((v) =>
        v.reduce((sum, c, k) => sum + c * ((y[k] as number) - (x[k] as number)), 0),
      ),
    ];
    for (const push of BRANCH_PUSHES) {
      for (const sign of [1, -1]) {
        const start = x.map((v, k) => v + sign * push * (weakest[k] as number));
        const other = leastSquares(pinned, start, LOOP_TOLERANCE * 1e-3);
        if (other.residual > LOOP_TOLERANCE) continue;
        const gap = unspun(other.x.map((v, k) => v - (x[k] as number))).reduce(
          (m, v) => Math.max(m, Math.abs(v)),
          0,
        );
        if (gap > 1e-3) branchGap = Math.min(branchGap, gap);
      }
    }
    const named = new Set(Object.keys(pose));
    const solved = [...new Set(coords.map((c) => (this._table[c.joint] as JointRecord).name))];
    const full: Record<string, JointValue> = {};
    for (const [i, joint] of this._table.entries()) {
      if (named.has(joint.name) || solved.includes(joint.name)) {
        full[joint.name] = this.valueAt(values, i) as JointValue;
      }
    }
    return ok({
      pose: full,
      drivers: [...named],
      solved,
      residual,
      iterations,
      conditioning,
      branchGap,
      branchRisk: conditioning < BRANCH_CONDITIONING || branchGap < BRANCH_GAP || folded,
    });
  }

  /**
   * Degrees of freedom of the closed rig at `pose` (solved first): the Grubler-Kutzbach count
   * and the rank of the closure Jacobian over every joint coordinate. With `drivers`, also
   * what holding those joints leaves free (underactuation) and which drivers are redundant.
   */
  mobility(
    pose: Pose = {},
    options: { readonly drivers?: readonly string[] } = {},
  ): Result<MobilityReport, ModelingError> {
    const posed = this.pose(pose);
    if (!posed.ok) return posed;
    const values = posed.value.joints.map((j) => j.value);
    const coords = this.coordinatesOf(this._table.map((_, i) => i));
    const x = coords.map((c) => this.coordinate(values, c));
    const rows = this.closureAt(values, coords);
    const j = jacobian(rows, x);
    const { rank } = analyze(j, x.length);
    const spins = this.idleSpins(values, coords);
    const withSpins = analyze([...j, ...spins.rows], x.length).rank;
    const constraints = this.closures.reduce((n, c) => n + CLOSURE_ROWS[c.kind], 0);
    const planar = this.planarLoops(posed.value);
    const removed = this.closures.reduce(
      (n, c) => n + (planar ? (c.kind === 'ball' ? 3 : 2) : CLOSURE_ROWS[c.kind]),
      0,
    );
    const mobility = x.length - withSpins;
    const idle = withSpins - rank;
    const grubler = x.length - removed;
    let actuation: MobilityReport['actuation'];
    if (options.drivers !== undefined) {
      const driven = new Set<number>();
      for (const name of options.drivers) {
        const i = this.index.get(name);
        if (i === undefined || (this._table[i] as JointRecord).kind === 'fixed') {
          return err(
            modelingError('model-invalid-argument', 'drivers name moving joints of the rig', {
              driver: name,
            }),
          );
        }
        const follower = this.followerError(i);
        if (follower !== undefined) return err(follower);
        driven.add(i);
      }
      const held = coords.flatMap((c, k) =>
        driven.has(c.joint) ? [x.map((_, m) => (m === k ? 1 : 0))] : [],
      );
      const augmented = analyze([...j, ...spins.rows, ...held], x.length);
      const uncontrolled = new Set<string>();
      for (const v of augmented.nullSpace) {
        v.forEach((component, k) => {
          if (Math.abs(component) > 1e-6) {
            uncontrolled.add(
              (this._table[(coords[k] as { joint: number }).joint] as JointRecord).name,
            );
          }
        });
      }
      const free = x.length - augmented.rank;
      actuation = {
        drivers: [...options.drivers],
        free,
        underactuated: free > 0,
        uncontrolled: [...uncontrolled],
        redundantDrivers: held.length - (augmented.rank - withSpins),
      };
    }
    return ok({
      coordinates: x.length,
      constraints,
      rank,
      mobility,
      grubler,
      planar,
      idle,
      idleJoints: spins.joints,
      overconstrained: mobility + idle > grubler,
      redundant: Math.max(0, mobility + idle - grubler),
      ...(actuation === undefined ? {} : { actuation }),
    });
  }

  /**
   * Idle spins: a spherical joint whose body meets the rest of a loop only at a ball closure
   * (an S-S link: tie rod, rod end, cylinder between two balls) turns freely about the line
   * through its centre and the ball, moving nothing else. One row per such spin, in the
   * given coordinates, when the spin keeps every closure.
   */
  private idleSpins(
    values: readonly (JointValue | null)[],
    coords: readonly { joint: number; axis?: Axis }[],
  ): { rows: number[][]; joints: string[] } {
    const rows: number[][] = [];
    const joints: string[] = [];
    const x = coords.map((c) => this.coordinate(values, c));
    const world = this.worlds(values);
    const closure = this.closureAt(values, coords);
    for (const [j, joint] of this._table.entries()) {
      if (joint.kind !== 'spherical') continue;
      const own = coords.flatMap((c, k) => (c.joint === j ? [k] : []));
      if (own.length !== 3) continue;
      for (const c of this.closures) {
        if (c.kind !== 'ball' || (c.a !== j && c.b !== j)) continue;
        const delta = multiply(world[j] as Affine, invertRigid(joint.restWorld));
        const ball = applyPoint(delta, c.at);
        const w = world[j] as Affine;
        const axis: [number, number, number] = [
          ball[0] - (w[3] as number),
          ball[1] - (w[7] as number),
          ball[2] - (w[11] as number),
        ];
        const l = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
        if (l < 1e-9) continue;
        // Angular velocity of the body per unit change of each of its three angles.
        const h = 1e-6;
        const rates = own.map((k) => {
          const trial = [...values];
          this._setCoordinate(
            trial,
            coords[k] as { joint: number; axis?: Axis },
            (x[k] as number) + h,
          );
          const r1 = this.worlds(trial)[j] as Affine;
          // omega^ = (R1 - R0) R0^T / h, read from its skew part.
          const d = (r: number, cc: number) =>
            ((r1[r * 4] as number) - (w[r * 4] as number)) * (w[cc * 4] as number) +
            ((r1[r * 4 + 1] as number) - (w[r * 4 + 1] as number)) * (w[cc * 4 + 1] as number) +
            ((r1[r * 4 + 2] as number) - (w[r * 4 + 2] as number)) * (w[cc * 4 + 2] as number);
          return [
            (d(2, 1) - d(1, 2)) / (2 * h),
            (d(0, 2) - d(2, 0)) / (2 * h),
            (d(1, 0) - d(0, 1)) / (2 * h),
          ];
        });
        const m = [0, 1, 2].map((r) => rates.map((col) => col[r] as number));
        const spin = solveLinear(
          m,
          axis.map((v) => v / l),
        );
        if (spin === undefined) continue;
        const v = coords.map(() => 0);
        own.forEach((k, i) => {
          v[k] = spin[i] as number;
        });
        // A spin that opens a closure is a real motion, not an idle one.
        const base = closure(x);
        const moved = closure(x.map((xi, k) => xi + h * (v[k] as number)));
        if (moved.some((e, i) => Math.abs(e - (base[i] as number)) > 1e-9)) continue;
        rows.push(v);
        joints.push(joint.name);
      }
    }
    return { rows, joints };
  }

  /**
   * Static holding efforts at `pose` (solved first): every closed rigid part is weighed at its
   * density, gravity's potential V is differentiated along each driven coordinate (tree joints,
   * and loop drivers through the solved loops) and dV/dq is the torque or force the actuator
   * holds. Efforts above their `ratings` are reported (a cylinder near a dead centre).
   */
  actuation(
    pose: Pose = {},
    options: ActuationOptions = {},
  ): Result<ActuationReport, ModelingError> {
    return rigActuation(this, pose, options);
  }

  /** Mass and rest centre of mass of every closed rigid part; open parts are massless. */
  weigh(
    parts: readonly ResolvedPart[],
    density: number | Readonly<Record<string, number>> | undefined,
  ): Result<
    { weights: { joint: number; rest: Tuple3; mass: number }[]; massless: string[] },
    ModelingError
  > {
    const weights: { joint: number; rest: Tuple3; mass: number }[] = [];
    const massless: string[] = [];
    for (const part of parts) {
      if (!part.closed) {
        massless.push(part.name);
        continue;
      }
      const d = typeof density === 'number' ? density : (density?.[part.name] ?? STEEL_DENSITY);
      const props = solidProperties(this.source.editMesh, part.faces, d);
      if (!props.ok) return props;
      weights.push({ joint: part.joint, rest: props.value.centroid, mass: props.value.mass });
    }
    return ok({ weights, massless });
  }

  /** Total mass and centre of mass of weighed parts at the given joint transforms. */
  centreOfMass(
    weights: readonly { joint: number; rest: Tuple3; mass: number }[],
    worlds: readonly Affine[],
  ): { mass: number; centroid: Tuple3 } {
    const mass = weights.reduce((m, w) => m + w.mass, 0);
    const sum: Tuple3 = [0, 0, 0];
    for (const w of weights) {
      const joint = this._table[w.joint] as JointRecord;
      const p = applyPoint(
        multiply(worlds[w.joint] as Affine, invertRigid(joint.restWorld)),
        w.rest,
      );
      for (let k = 0; k < 3; k++) sum[k] = (sum[k] as number) + w.mass * (p[k] as number);
    }
    return { mass, centroid: sum.map((v) => v / (mass || 1)) as unknown as Tuple3 };
  }

  /**
   * How a pose reads: the counter-tilt of the hip and shoulder lines in
   * the front view, the centre of mass against the support polygon of the grounded feet, each
   * foot's gap to the ground, and the front silhouette's fill. `issues` lists what fails.
   */
  poseReport(pose: Pose = {}, options: PoseReportOptions = {}): Result<PoseReport, ModelingError> {
    const resolved = this._resolve();
    if (!resolved.ok) return resolved;
    const posed = this.pose(pose, { limits: options.limits ?? 'reject' });
    if (!posed.ok) return posed;
    const norm = (v: Tuple3): Tuple3 => {
      const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const up = norm(options.up ?? [0, 1, 0]);
    const toward = norm(options.front ?? [0, 0, 1]);
    // Front-view axes: right (as the viewer sees it) and up, orthogonal to the view direction.
    const right = norm([
      up[1] * toward[2] - up[2] * toward[1],
      up[2] * toward[0] - up[0] * toward[2],
      up[0] * toward[1] - up[1] * toward[0],
    ]);
    const ground = options.ground ?? 0;
    const contact = options.contact ?? 0.005;
    const worlds = posed.value.joints.map((j) => j.world);
    const at = (name: string): Tuple3 | undefined => {
      const i = this.index.get(name);
      if (i === undefined) return undefined;
      const w = worlds[i] as Affine;
      return [w[3] as number, w[7] as number, w[11] as number];
    };
    const tilt = (
      pair: readonly [string, string] | undefined,
    ): Result<number | undefined, ModelingError> => {
      if (pair === undefined) return ok(undefined);
      const l = at(pair[0]);
      const r = at(pair[1]);
      if (l === undefined || r === undefined) {
        return err(
          modelingError('model-invalid-argument', 'hip and shoulder joints exist in the rig', {
            pair,
          }),
        );
      }
      // From the subject's right to its left as the viewer sees them: + when the left side is higher.
      const d: Tuple3 = [l[0] - r[0], l[1] - r[1], l[2] - r[2]];
      return ok((atan2(dot(d, up), Math.abs(dot(d, right))) * 180) / Math.PI);
    };
    const hips = tilt(options.hips);
    if (!hips.ok) return hips;
    const shoulders = tilt(options.shoulders);
    if (!shoulders.ok) return shoulders;
    const weighed = this.weigh(resolved.value, options.density);
    if (!weighed.ok) return weighed;
    const { centroid, mass } = this.centreOfMass(weighed.value.weights, worlds);
    const { massless } = weighed.value;
    // Ground-plane axes for the support polygon.
    const across = right;
    const depth = norm([
      up[1] * across[2] - up[2] * across[1],
      up[2] * across[0] - up[0] * across[2],
      up[0] * across[1] - up[1] * across[0],
    ]);
    const mesh = this.source.editMesh;
    const deltas = this.deltas(resolved.value, posed.value);
    const feet: { part: string; gap: number; grounded: boolean }[] = [];
    const support: Point2[] = [];
    const triangles: [Point2, Point2, Point2][] = [];
    for (const [i, part] of resolved.value.entries()) {
      const g = partGeometry(mesh, part.name, part.faces, part.closed);
      const delta = deltas[i] as Affine;
      const points: Tuple3[] = [];
      for (let k = 0; k < g.points.length; k += 3) {
        points.push(
          applyPoint(delta, [
            g.points[k] as number,
            g.points[k + 1] as number,
            g.points[k + 2] as number,
          ]),
        );
      }
      for (let t = 0; t < g.tris.length; t += 9) {
        const tri = [0, 3, 6].map((o) => {
          const p = applyPoint(delta, [
            g.tris[t + o] as number,
            g.tris[t + o + 1] as number,
            g.tris[t + o + 2] as number,
          ]);
          return [dot(p, right), dot(p, up)] as Point2;
        });
        triangles.push(tri as [Point2, Point2, Point2]);
      }
      if (!(options.feet ?? []).includes(part.name)) continue;
      const lowest = minOf(points.map((p) => dot(p, up)));
      const gap = lowest - ground;
      const grounded = Math.abs(gap) <= contact;
      feet.push({ part: part.name, gap, grounded });
      if (grounded) {
        for (const p of points) {
          if (dot(p, up) - ground <= contact) support.push([dot(p, across), dot(p, depth)]);
        }
      }
    }
    for (const name of options.feet ?? []) {
      if (!feet.some((f) => f.part === name)) {
        return err(
          modelingError('model-invalid-argument', 'feet name bound parts', { part: name }),
        );
      }
    }
    const hull = convexHull(support);
    // Without mass there is no centre of mass to balance.
    const margin =
      feet.length === 0 || mass === 0
        ? undefined
        : insideMargin(hull, [dot(centroid, across), dot(centroid, depth)]);
    const shape = silhouetteFill(triangles);
    // The hip line splits the silhouette: arms must stand clear of the torso above it.
    const hipLine = options.hips?.map((name) => dot(at(name) as Tuple3, up));
    const silhouette = {
      fill: shape.fill,
      width: shape.width,
      height: shape.height,
      negativeSpace: negativeSpace(
        shape.raster,
        hipLine === undefined ? -Infinity : ((hipLine[0] as number) + (hipLine[1] as number)) / 2,
      ),
    };
    const line = lineOfAction(shape.raster);
    const issues: Issue<PoseCode>[] = [];
    const flag = (code: PoseCode, detail: Readonly<Record<string, unknown>>) =>
      issues.push({ code, severity: 'warn', detail });
    let counterTilt: number | undefined;
    let contrapposto: boolean | undefined;
    if (hips.value !== undefined && shoulders.value !== undefined) {
      counterTilt = shoulders.value - hips.value;
      contrapposto =
        hips.value * shoulders.value < 0 &&
        Math.abs(counterTilt) >= 5 &&
        Math.abs(counterTilt) <= 15;
      if (!contrapposto) {
        flag('no-contrapposto', { hips: hips.value, shoulders: shoulders.value, counterTilt });
      }
    }
    if (margin !== undefined && !(margin > 0)) flag('unbalanced', { margin, centroid });
    const lifted = feet.filter((f) => !f.grounded);
    if (lifted.length > 0) flag('not-grounded', { feet: lifted, contact });
    if (silhouette.fill < 0.41) flag('thin-silhouette', { fill: silhouette.fill, threshold: 0.41 });
    if (silhouette.negativeSpace < NEGATIVE_SPACE) {
      flag('no-negative-space', {
        negativeSpace: silhouette.negativeSpace,
        threshold: NEGATIVE_SPACE,
      });
    }
    if (line.shape === 'straight') flag('straight-line-of-action', { deviation: line.deviation });
    if (massless.length > 0) flag('massless', { parts: massless });
    const lineSubject = ['hips/shoulders'];
    const haveLine = hips.value !== undefined && shoulders.value !== undefined;
    const haveFeet = (options.feet ?? []).length > 0;
    const haveMass = mass !== 0;
    const coverage = coverageOf<PoseCode>(
      {
        'no-contrapposto': lineSubject,
        unbalanced: ['balance'],
        'not-grounded': haveFeet ? (options.feet as readonly string[]) : ['feet'],
        'thin-silhouette': ['silhouette'],
        'no-negative-space': ['silhouette'],
        'straight-line-of-action': ['silhouette'],
        massless: resolved.value.map((part) => part.name),
      },
      {
        ...(haveLine ? { 'no-contrapposto': new Set(lineSubject) } : {}),
        ...(haveFeet && haveMass ? { unbalanced: new Set(['balance']) } : {}),
        ...(haveFeet ? { 'not-grounded': new Set(feet.map((f) => f.part)) } : {}),
        'thin-silhouette': new Set(['silhouette']),
        'no-negative-space': new Set(['silhouette']),
        'straight-line-of-action': new Set(['silhouette']),
        massless: new Set(resolved.value.map((part) => part.name)),
      },
      [
        ...(haveLine
          ? []
          : [
              {
                code: 'no-contrapposto' as const,
                subject: 'hips/shoulders',
                reason:
                  options.hips === undefined && options.shoulders === undefined
                    ? ('not-requested' as const)
                    : ('missing-input' as const),
              },
            ]),
        ...(haveFeet
          ? haveMass
            ? []
            : [
                {
                  code: 'unbalanced' as const,
                  subject: 'balance',
                  reason: 'missing-input' as const,
                },
              ]
          : [
              { code: 'unbalanced' as const, subject: 'balance', reason: 'not-requested' as const },
              { code: 'not-grounded' as const, subject: 'feet', reason: 'not-requested' as const },
            ]),
      ],
    );
    return ok({
      ...(hips.value === undefined ? {} : { hips: hips.value }),
      ...(shoulders.value === undefined ? {} : { shoulders: shoulders.value }),
      ...(counterTilt === undefined ? {} : { counterTilt }),
      ...(contrapposto === undefined ? {} : { contrapposto }),
      centroid,
      support: hull,
      ...(margin === undefined ? {} : { margin }),
      feet,
      silhouette,
      lineOfAction: line,
      massless,
      clamped: posed.value.clamped,
      coverage,
      pass: issues.length === 0 && coverage.checked.length > 0,
      issues,
    });
  }

  /**
   * How a motion reads at a frame rate: per frame which groups move (joint speed
   * above `still`, loop joints included as solved), the share of frames with at most one main
   * group moving, the still holds, and the hold after each read point.
   */
  motionReport(path: PosePath, options: MotionReportOptions): Result<MotionReport, ModelingError> {
    return rigMotionReport(this, path, options);
  }

  /** Joint values with rest defaults (0, or no angles for spherical joints). */
  valueAt(values: readonly (JointValue | null)[], i: number): JointValue | null {
    const joint = this._table[i] as JointRecord;
    return values[i] ?? (joint.kind === 'fixed' ? null : joint.kind === 'spherical' ? {} : 0);
  }

  /** Followers take their value from the root leader, in place. */
  private follow(values: (JointValue | null)[]): void {
    for (const [i, joint] of this._table.entries()) {
      const link = joint.mimic;
      if (link === undefined) continue;
      values[i] = link.rootRatio * (this.valueAt(values, link.root) as number) + link.rootOffset;
    }
  }

  /** The failure of naming a follower where only a leader is a coordinate. */
  private followerError(i: number): ModelingError | undefined {
    const joint = this._table[i] as JointRecord;
    const link = joint.mimic;
    if (link === undefined) return undefined;
    const leader = (this._table[link.leader] as JointRecord).name;
    return modelingError(
      'model-invalid-argument',
      'pose joints are not mimic followers',
      { joint: joint.name, leader, ratio: link.ratio, offset: link.offset },
      `'${joint.name}' follows '${leader}' (= ${link.ratio} * '${leader}' + ${link.offset}): name '${leader}' instead`,
    );
  }

  /** A follower is not a loop joint (v1): the closure would fight the coupling. */
  private followerLoop(): ModelingError | undefined {
    for (const j of this.loopJoints()) {
      const joint = this._table[j] as JointRecord;
      if (joint.mimic !== undefined) {
        return modelingError(
          'model-invalid-argument',
          'a mimic follower is not a loop joint',
          { joint: joint.name, leader: (this._table[joint.mimic.leader] as JointRecord).name },
          'couple the loop joint through its leader, or drop the mimic',
        );
      }
    }
    return undefined;
  }

  /** World transform of every joint for the given values. */
  private worlds(given: readonly (JointValue | null)[]): Affine[] {
    const values = this._table.some((j) => j.mimic !== undefined) ? [...given] : given;
    this.follow(values as (JointValue | null)[]);
    const world: Affine[] = [];
    for (const [i, joint] of this._table.entries()) {
      const local = multiply(joint.restLocal, motion(joint, this.valueAt(values, i)));
      world.push(joint.parent < 0 ? local : multiply(world[joint.parent] as Affine, local));
    }
    return world;
  }

  /** Closure error rows as a function of the given coordinates, the other values held. */
  private closureAt(
    values: readonly (JointValue | null)[],
    coords: readonly { joint: number; axis?: Axis }[],
  ): (x: readonly number[]) => number[] {
    return (x) => {
      const trial = [...values];
      for (const [k, c] of coords.entries()) this._setCoordinate(trial, c, x[k] as number);
      return this.closureError(trial);
    };
  }

  /** Every closure's error rows at the given values. */
  private closureError(values: readonly (JointValue | null)[]): number[] {
    const world = this.worlds(values);
    const delta = (j: number) =>
      multiply(world[j] as Affine, invertRigid((this._table[j] as JointRecord).restWorld));
    return this.closures.flatMap((c) => closureRows(c, delta(c.a), delta(c.b)));
  }

  /** Free coordinates of joints: one per revolute or prismatic joint (none for a mimic follower), the limited (or all) axes of a spherical one. */
  coordinatesOf(joints: readonly number[]): { joint: number; axis?: Axis }[] {
    const out: { joint: number; axis?: Axis }[] = [];
    for (const j of joints) {
      const joint = this._table[j] as JointRecord;
      if (joint.mimic !== undefined) continue;
      if (joint.kind === 'revolute' || joint.kind === 'prismatic') out.push({ joint: j });
      else if (joint.kind === 'spherical') {
        const limits = joint.limits as Readonly<Partial<Record<Axis, Range>>> | undefined;
        for (const axis of AXES) {
          if (limits === undefined || limits[axis] !== undefined) out.push({ joint: j, axis });
        }
      }
    }
    return out;
  }

  /** A coordinate in solver units: radians for angles, meters for slides. */
  coordinate(values: readonly (JointValue | null)[], c: { joint: number; axis?: Axis }): number {
    const value = this.valueAt(values, c.joint);
    if (c.axis === undefined) {
      const v = value as number;
      return (this._table[c.joint] as JointRecord).kind === 'prismatic' ? v : (v * Math.PI) / 180;
    }
    return ((((value as Angles)[c.axis] ?? 0) as number) * Math.PI) / 180;
  }

  /** @internal */
  _setCoordinate(
    values: (JointValue | null)[],
    c: { joint: number; axis?: Axis },
    x: number,
  ): void {
    if (c.axis === undefined) {
      values[c.joint] =
        (this._table[c.joint] as JointRecord).kind === 'prismatic' ? x : (x * 180) / Math.PI;
      return;
    }
    values[c.joint] = {
      ...(this.valueAt(values, c.joint) as Angles),
      [c.axis]: (x * 180) / Math.PI,
    };
  }

  /** Moving joints on the two chains of each loop, below the bodies' common ancestor. */
  loopJoints(): number[] {
    const out = new Set<number>();
    for (const c of this.closures) {
      const up = (j: number) => {
        const chain: number[] = [];
        for (let k = j; k >= 0; k = (this._table[k] as JointRecord).parent) chain.push(k);
        return chain;
      };
      const ca = up(c.a);
      const cb = new Set(up(c.b));
      const common = ca.find((j) => cb.has(j)) ?? -1;
      for (const chain of [ca, [...cb]]) {
        for (const j of chain) {
          if (j === common) break;
          if ((this._table[j] as JointRecord).kind !== 'fixed') out.add(j);
        }
      }
    }
    return [...out].sort((x, y) => x - y);
  }

  /**
   * Solve the loop joints that `values` leaves unset, in place. The start is `guess`, else the
   * solution of the nearest driver values solved before, else rest.
   */
  private closeLoops(
    values: (JointValue | null)[],
    guess: readonly (JointValue | null)[] | undefined,
  ): Result<
    {
      coords: { joint: number; axis?: Axis }[];
      residual: number;
      iterations: number;
      /** Continuation met a fold: a step that could not shrink further left its prediction. */
      folded: boolean;
    },
    ModelingError
  > {
    const loop = this.loopJoints();
    const passive = loop.filter((j) => values[j] === null);
    const coords = this.coordinatesOf(passive);
    const driverCoords = this.coordinatesOf(loop.filter((j) => values[j] !== null));
    const drivers = driverCoords.map((c) => this.coordinate(values, c));
    const key = passive.join(',');
    const cached = this.loopCache.get(key) ?? [];
    // Start from the guess, else from the nearest solved drivers, else from rest (all 0).
    let from = { drivers: driverCoords.map(() => 0), x: coords.map(() => 0) };
    if (guess !== undefined) {
      from = { drivers, x: coords.map((c) => this.coordinate(guess, c)) };
    } else {
      let bestDistance = Infinity;
      for (const entry of [from, ...cached]) {
        let d = 0;
        entry.drivers.forEach((v, k) => {
          const e = v - (drivers[k] as number);
          d += e * e;
        });
        if (d < bestDistance) {
          bestDistance = d;
          from = entry;
        }
      }
    }
    // Closure rows at the given drivers; idle spins (S-S links) are pinned at `anchor`, so the
    // solved joints are determined and the solve stays well posed.
    const rowsAt = (driven: readonly number[], anchor?: readonly number[]) => {
      const trial = [...values];
      for (const [k, c] of driverCoords.entries())
        this._setCoordinate(trial, c, driven[k] as number);
      const closure = this.closureAt(trial, coords);
      if (anchor === undefined) return closure;
      const pinned = [...trial];
      for (const [k, c] of coords.entries()) this._setCoordinate(pinned, c, anchor[k] as number);
      const spins = this.idleSpins(pinned, coords).rows;
      if (spins.length === 0) return closure;
      return (y: readonly number[]) => [
        ...closure(y),
        ...spins.map((v) =>
          v.reduce((sum, c, k) => sum + c * ((y[k] as number) - (anchor[k] as number)), 0),
        ),
      ];
    };
    const target = LOOP_TOLERANCE * 1e-3;
    const scale = driverCoords.map((c) =>
      (this._table[c.joint] as JointRecord).kind === 'prismatic' ? 0.1 : 1,
    );
    const span = driverCoords.reduce(
      (m, _, k) =>
        Math.max(
          m,
          Math.abs((drivers[k] as number) - (from.drivers[k] as number)) / (scale[k] as number),
        ),
      0,
    );
    let fit = leastSquares(rowsAt(drivers, from.x), from.x, target, span === 0 ? 100 : 0);
    let folded = false;
    if (span > 0 && coords.length > 0) {
      // Predictor-corrector continuation from the start: each step predicts the solved joints
      // along the tangent and accepts the corrected solve only near that prediction, so a
      // solve that lands on the other assembly mode (near a fold, where the two come close)
      // is refused and the step halved. A step that cannot shrink further is a fold.
      const along = (t: number) =>
        drivers.map((v, i) => (from.drivers[i] as number) + (v - (from.drivers[i] as number)) * t);
      const largest = Math.min(1, CONTINUATION_STEP / span);
      const smallest = largest / 65536;
      let t = 0;
      let h = largest;
      let x = from.x;
      while (t < 1) {
        const t1 = Math.min(1, t + h);
        const d0 = along(t);
        const d1 = along(t1);
        const tangent = this.loopTangent(values, coords, driverCoords, d0, x);
        const step = d1.map((v, i) => v - (d0[i] as number));
        const predicted = x.map(
          (v, k) =>
            v + (tangent[k] as number[]).reduce((sum, g, i) => sum + g * (step[i] as number), 0),
        );
        const trial = leastSquares(rowsAt(d1, x), predicted, target);
        const moved = predicted.reduce((m, v, k) => Math.max(m, Math.abs(v - (x[k] as number))), 0);
        const off = trial.x.reduce(
          (m, v, k) => Math.max(m, Math.abs(v - (predicted[k] as number))),
          0,
        );
        // The other assembly mode turns the closure Jacobian over: refuse a step that does.
        const before = jacobian(rowsAt(d0, x), x);
        const after = jacobian(rowsAt(d1, x), trial.x);
        const kept =
          orientation(before, after, coords.length) * orientation(before, before, coords.length) >=
          0;
        const close =
          trial.residual <= LOOP_TOLERANCE && kept && off <= Math.max(0.5 * moved, 1e-7);
        if (close || (h <= smallest && trial.residual <= LOOP_TOLERANCE)) {
          if (!close) folded = true;
          x = trial.x;
          fit = trial;
          t = t1;
          h = Math.min(largest, h * 2);
        } else if (h <= smallest) {
          fit = trial;
          break;
        } else {
          h /= 2;
        }
      }
    }
    if (fit.residual > LOOP_TOLERANCE) {
      return err(
        modelingError(
          'model-solver-diverged',
          'the rig loops close at the pose',
          {
            residual: fit.residual,
            solved: passive.map((j) => (this._table[j] as JointRecord).name),
            loops: this.closures.map((c) => c.name),
          },
          'the drivers are out of reach of the loop (a link too short, or past a limit position); move them back, or pass solve({ guess }) for the other branch',
        ),
      );
    }
    for (const [k, c] of coords.entries()) this._setCoordinate(values, c, fit.x[k] as number);
    if (coords.length > 0) {
      cached.push({ drivers, x: fit.x });
      if (cached.length > 4096) cached.shift();
      this.loopCache.set(key, cached);
    }
    return ok({ coords, residual: fit.residual, iterations: fit.iterations, folded });
  }

  /**
   * d(solved joints)/d(drivers) at a closed pose: the least-squares solution of
   * J_x dx = -J_d dd (rows: closure errors), one column per driver coordinate.
   */
  private loopTangent(
    values: readonly (JointValue | null)[],
    coords: readonly { joint: number; axis?: Axis }[],
    driverCoords: readonly { joint: number; axis?: Axis }[],
    driven: readonly number[],
    x: readonly number[],
  ): number[][] {
    const all = [...coords, ...driverCoords];
    const j = jacobian(this.closureAt(values, all), [...x, ...driven]);
    const n = coords.length;
    const jx = j.map((row) => row.slice(0, n));
    const g = gram(jx, n).map((row, i) => row.map((v, k) => (i === k ? v + 1e-12 : v)));
    const columns = driverCoords.map((_, i) => {
      const rhs = Array.from(
        { length: n },
        (_, k) => -j.reduce((sum, row) => sum + (row[k] as number) * (row[n + i] as number), 0),
      );
      return solveLinear(g, rhs) ?? new Array<number>(n).fill(0);
    });
    return Array.from({ length: n }, (_, k) => columns.map((c) => c[k] as number));
  }

  /** Whether every loop is planar at a pose: revolute and pin axes parallel, slides across them, no ball. */
  private planarLoops(pose: PoseResult): boolean {
    if (this.closures.length === 0 || this.closures.some((c) => c.kind === 'ball')) return false;
    const rotate = (m: Affine, v: Tuple3): Tuple3 => [
      (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
      (m[4] as number) * v[0] + (m[5] as number) * v[1] + (m[6] as number) * v[2],
      (m[8] as number) * v[0] + (m[9] as number) * v[1] + (m[10] as number) * v[2],
    ];
    const turns: Tuple3[] = [];
    const slides: Tuple3[] = [];
    for (const j of this.loopJoints()) {
      const joint = this._table[j] as JointRecord;
      if (joint.kind === 'spherical') return false;
      const axis = rotate((pose.joints[j] as JointPose).world, joint.axis);
      (joint.kind === 'revolute' ? turns : slides).push(axis);
    }
    for (const c of this.closures) {
      const delta = multiply(
        (pose.joints[c.a] as JointPose).world,
        invertRigid((this._table[c.a] as JointRecord).restWorld),
      );
      (c.kind === 'pin' ? turns : slides).push(rotate(delta, c.axis));
    }
    const normal = turns[0];
    if (normal === undefined) return false;
    const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return (
      turns.every((t) => Math.abs(Math.abs(dot(t, normal)) - 1) < 1e-9) &&
      slides.every((t) => Math.abs(dot(t, normal)) < 1e-9)
    );
  }

  /** Validate and compile the loop closures. */
  private compileLoops(loops: readonly LoopSpec[]): Result<ClosureRecord[], ModelingError> {
    if (!Array.isArray(loops)) return rejectSpec('loops is an array', {});
    const out: ClosureRecord[] = [];
    for (const [i, loop] of loops.entries()) {
      if (typeof loop?.name !== 'string' || !KEY.test(loop.name)) {
        return rejectSpec('loop names are lowercase key segments', { loop: i });
      }
      if (out.some((o) => o.name === loop.name)) {
        return rejectSpec('loop names are unique', { loop: loop.name });
      }
      const a = this.index.get(loop.a);
      const b = this.index.get(loop.b);
      if (a === undefined || b === undefined || a === b) {
        return rejectSpec('a loop joins two different joints of the rig', {
          loop: loop.name,
          a: loop.a,
          b: loop.b,
        });
      }
      if (!['pin', 'ball', 'slide'].includes(loop.kind)) {
        return rejectSpec("a loop closure 'pin' | 'ball' | 'slide'", { loop: loop.name });
      }
      if (!Array.isArray(loop.at) || loop.at.length !== 3 || !finite(...loop.at)) {
        return rejectSpec('a finite closure point [x, y, z]', { loop: loop.name });
      }
      let axis: Tuple3 = [0, 1, 0];
      if (loop.kind !== 'ball') {
        const u = loop.axis === undefined ? undefined : unit(loop.axis);
        if (u === undefined) {
          return rejectSpec(`a ${loop.kind} closure has a non-zero axis`, { loop: loop.name });
        }
        axis = u;
      }
      out.push({
        name: loop.name,
        a,
        b,
        kind: loop.kind,
        at: [...loop.at] as Tuple3,
        axis,
        across: acrossOf(axis),
      });
    }
    return ok(out);
  }

  /**
   * Choreograph phases into a path for this rig: each phase's joints follow its beat (quintic
   * ease, anticipation dip, overshoot settle, staggered windows), keyed at phase-window times,
   * with the read points (phase ends and their holds) for a shot list. A beat that drives a
   * joint past its limits fails unless `limits: 'clamp'`, which holds and reports it.
   */
  choreograph(options: ChoreographyOptions): Result<Choreography, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const known = new Set(this._table.map((j) => j.name));
    const unknown = (Array.isArray(options.phases) ? options.phases : []).flatMap((p) =>
      [...Object.keys(p.from), ...Object.keys(p.to), ...(p.joints ?? [])]
        .filter((j) => !known.has(j))
        .map((joint) => ({ phase: p.id, joint })),
    );
    if (unknown.length > 0) {
      return err(
        modelingError('model-invalid-argument', 'phase joints that exist in the rig', {
          unknown: unknown.slice(0, 16),
        }),
      );
    }
    for (const p of options.phases) {
      for (const name of [...Object.keys(p.from), ...Object.keys(p.to), ...(p.joints ?? [])]) {
        const follower = this.followerError(this.index.get(name) as number);
        if (follower !== undefined) return err(follower);
      }
    }
    return choreograph(options, (name) => {
      const joint = this._table.find((j) => j.name === name);
      return joint === undefined ? undefined : rangeOf(joint);
    });
  }

  /**
   * The space parts occupy along `path`: cells of the world lattice of spacing
   * `voxel` that the moving parts touch. The path is sampled until no point of a part moves
   * more than a quarter voxel between samples, and a cell counts when its centre comes within
   * `reach` (half the cell diagonal, plus the distance-field and sampling errors, about
   * 1.4 voxels) of a part: the sweep covers every cube the parts pass through, so two sweeps
   * that share no cell keep the parts apart along the whole motion.
   */
  sweep(path: PosePath, options: RigSweepOptions): Result<SweptVolume, ModelingError> {
    return rigSweep(this, path, options);
  }

  /**
   * Space claims per phase: each phase claims the sweep of every part
   * that moves in its window, under its `joints` (`parts`) or under no overlapping phase's
   * (`unclaimed`, such as drive members keyed through `extra`). A conflict is a cell shared
   * with a part standing still during the phase (`static`), or between two parts moving
   * relative to each other in the same or overlapping phases (`concurrent`; rigidly co-moving
   * parts are skipped). Designed `contacts` are exempt. Cells are compared at the sweep's
   * reach, so parts closer than about a voxel conflict too.
   */
  phaseClaims(
    path: PosePath,
    options: PhaseClaimsOptions,
  ): Result<PhaseClaimsReport, ModelingError> {
    return rigPhaseClaims(this, path, options);
  }

  /**
   * How a part leaves its neighbours: every face with another part within `near`
   * in front of it (within 60 degrees of its normal) at `u` is drafted against the direction its points start to move (their velocity at u+).
   * A face moving away from its neighbour is `safe`, one sliding along it within 90 - `warn`
   * degrees `critical` (zero draft), one moving into it an `undercut`.
   */
  release(
    part: string,
    path: PosePath,
    options: ReleaseOptions = {},
  ): Result<ReleaseReport, ModelingError> {
    const all = this._resolve();
    if (!all.ok) return all;
    const index = all.value.findIndex((p) => p.name === part);
    const u = options.u ?? 0;
    const near = options.near ?? 0.005;
    const inputs = draftInputs([0, 0, 1], options.warn ?? 85);
    if (!inputs.ok) return inputs;
    if (index < 0 || !finite(u, near) || u < 0 || u >= 1 || near <= 0) {
      return err(
        modelingError('model-invalid-argument', 'a bound part, u in [0, 1) and a positive near', {
          part,
          u,
          near,
          parts: all.value.map((p) => p.name),
        }),
      );
    }
    const released = all.value[index] as ResolvedPart;
    const at = (v: number) => {
      const sampled = this.sample(path, v);
      return sampled.ok ? this.posedMesh(sampled.value, options) : sampled;
    };
    const now = at(u);
    if (!now.ok) return now;
    const du = Math.min(1e-4, 1 - u);
    const next = at(u + du);
    if (!next.ok) return next;
    const mesh = now.value.mesh;
    const owner = new Map<number, string>();
    const others: number[] = [];
    for (const p of all.value) {
      if (p.name === part) continue;
      for (const f of p.faces) {
        owner.set(f, p.name);
        others.push(f);
      }
    }
    const query = SurfaceQuery.of(mesh, others);
    if (!query.ok) return query;
    const shift = (f: number): Tuple3 => {
      const c0 = faceCentroid(mesh, f);
      const c1 = faceCentroid(next.value.mesh, f);
      return [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
    };
    if (released.faces.every((f) => hypot3(...shift(f)) <= 1e-12)) {
      return err(
        modelingError(
          'model-precondition',
          'a part that moves at u',
          { part, u },
          'release reads the direction from the motion: pick the u where the part starts to move',
        ),
      );
    }
    const faces: ReleaseFace[] = [];
    for (const f of released.faces) {
      const points = [faceCentroid(mesh, f), ...mesh.faceVertices(f).map((v) => mesh.position(v))];
      let gap = Infinity;
      let neighbour = '';
      const n = faceNormal(mesh, f);
      for (const p of points) {
        const hit = query.value.nearest(p);
        if (hit === undefined || hit.distance >= gap) continue;
        // Only a neighbour in front of the face (within 60 degrees of its normal) bounds it.
        const ahead =
          (hit.point[0] - p[0]) * n[0] +
          (hit.point[1] - p[1]) * n[1] +
          (hit.point[2] - p[2]) * n[2];
        if (ahead < 0.5 * hit.distance) continue;
        gap = hit.distance;
        neighbour = owner.get(hit.face) ?? '';
      }
      if (gap > near) continue;
      const v = shift(f);
      const speed = hypot3(...v);
      if (!(speed > 1e-12)) continue;
      const away: Tuple3 = [-v[0] / speed, -v[1] / speed, -v[2] / speed];
      faces.push({ ...draftFace(f, n, away, inputs.value.warn), neighbour, gap });
    }
    return ok({
      part,
      u,
      faces,
      critical: faces.filter((f) => f.class === 'critical').map((f) => f.face),
      undercut: faces.filter((f) => f.class === 'undercut').map((f) => f.face),
    });
  }

  /**
   * Hard stops: each declared stop with its joint at that limit (the other
   * joints at `pose`) must be within `contact` of its landing parts, and clear of them at
   * mid-travel; a stop part that is not bound fails. `unstopped` lists the limited ends
   * without a stop.
   */
  stopReport(options: StopReportOptions = {}): Result<StopReport, ModelingError> {
    return rigStopReport(this, options);
  }

  /** The named parts with their rest-frame distance fields at half the voxel. */
  /** Per part, the cells it occupies over u in `range` (a single pose when u0 = u1). */
  /** The pose of `path` at `u` (clamped to the first and last key). */
  sample(path: PosePath, u: number): Result<Pose, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const tracks = this.tracks(path);
    if (!tracks.ok) return tracks;
    if (!finite(u)) return err(modelingError('model-invalid-argument', 'a finite u', { u }));
    const mode = path.interpolation ?? 'linear';
    const out: Record<string, JointValue> = {};
    for (const [i, track] of tracks.value) {
      const name = (this._table[i] as JointRecord).name;
      const last = track.length - 1;
      if (u <= (track[0] as TrackKey).u) {
        out[name] = (track[0] as TrackKey).value;
        continue;
      }
      if (u >= (track[last] as TrackKey).u) {
        out[name] = (track[last] as TrackKey).value;
        continue;
      }
      // Largest s with track[s].u < u (the ends are handled above).
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((track[mid] as TrackKey).u < u) lo = mid;
        else hi = mid;
      }
      const s = lo;
      const a = track[s] as TrackKey;
      const b = track[s + 1] as TrackKey;
      let t = (u - a.u) / (b.u - a.u);
      if (mode === 'step') {
        out[name] = t >= 1 ? b.value : a.value;
        continue;
      }
      if (mode === 'smooth') t = t * t * (3 - 2 * t);
      const component = (v: JointValue, axis?: Axis) =>
        axis === undefined ? (v as number) : ((v as Angles)[axis] ?? 0);
      const value = (axis?: Axis) =>
        mode === 'hermite'
          ? steffen(
              (k) => (track[k] as TrackKey).u,
              (k) => component((track[k] as TrackKey).value, axis),
              last,
              s,
              t,
            )
          : lerp(component(a.value, axis), component(b.value, axis), t);
      if (typeof a.value === 'number') {
        out[name] = value();
        continue;
      }
      const angles: Partial<Record<Axis, number>> = {};
      for (const axis of AXES) {
        const x = a.value[axis] ?? 0;
        const y = (b.value as Angles)[axis] ?? 0;
        if (x !== 0 || y !== 0) angles[axis] = value(axis);
      }
      out[name] = angles;
    }
    return ok(out);
  }

  /** An FXEM snapshot of the session with every part moved to `pose`. */
  posedSnapshot(pose: Pose = {}, options: PoseOptions = {}): Result<Uint8Array, ModelingError> {
    const posed = this.posedMesh(pose, options);
    if (!posed.ok) return posed;
    return ok(encodeSnapshot(posed.value.mesh));
  }

  /** The session exported at `pose` as one MeshAsset (rigid parts moved, nothing else changed). */
  toMesh(
    pose: Pose = {},
    options: PoseOptions & { readonly normals?: NormalMode } = {},
  ): Result<
    { readonly mesh: MeshAsset; readonly report: ExportReport; readonly pose: PoseResult },
    ModelingError
  > {
    const posed = this.posedMesh(pose, options);
    if (!posed.ok) return posed;
    const exported = exportMesh(posed.value.mesh.compact().mesh, {
      normals: options.normals ?? { mode: 'weighted' },
    });
    if (!exported.ok) return exported;
    return ok({ mesh: exported.value.mesh, report: exported.value.report, pose: posed.value.pose });
  }

  /** Part-vs-part interference at one pose. */
  interference(
    pose: Pose = {},
    options: InterferenceOptions = {},
  ): Result<InterferenceReport, ModelingError> {
    const prepared = this._prepare(options);
    if (!prepared.ok) return prepared;
    const posed = this.pose(pose, options);
    if (!posed.ok) return posed;
    const placement = this.placement(prepared.value.parts, posed.value);
    const report = testPose(
      prepared.value.geometry,
      placement,
      prepared.value.contacts,
      prepared.value.tolerance,
      posed.value.clamped,
    );
    if (prepared.value.bands.length === 0) return ok(report);
    const fits = prepared.value.bands.map((band) => {
      const d = this.fitDistance(prepared.value.geometry, band, placement);
      return { parts: band.parts, gap: band.gap, min: d, max: d, pass: within(d, band.gap) };
    });
    return ok({ ...report, fits });
  }

  /** Closest surface distance of a fit pair at a placement (Infinity beyond 1 cm past its band). */
  private fitDistance(
    geometry: readonly PartGeometry[],
    band: { a: number; b: number; gap: readonly [number, number] },
    placement: Placement,
  ): number {
    return partDistance(geometry, band.a, band.b, placement, band.gap[1] + 0.01);
  }

  /** Interference along a path, sampled every `step` in u, with first contacts refined per pair. */
  scan(path: PosePath, options: ScanOptions = {}): Result<ScanReport, ModelingError> {
    const prepared = this._prepare(options);
    if (!prepared.ok) return prepared;
    const tracks = this.tracks(path);
    if (!tracks.ok) return tracks;
    const step = options.step ?? 0.05;
    if (!finite(step) || step <= 0 || step > 1) {
      return err(modelingError('model-invalid-argument', 'a scan step in (0, 1]', { step }));
    }
    const clearance = options.clearance;
    if (clearance !== undefined && (!finite(clearance) || clearance <= 0)) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a positive clearance in meters',
          { clearance },
          'the CAD default is 0.005 (5 mm)',
        ),
      );
    }
    const refine = options.refine ?? 6;
    if (!Number.isInteger(refine) || refine < 0 || refine > 32) {
      return err(
        modelingError('model-invalid-argument', 'refine is an integer in [0, 32]', { refine }),
      );
    }
    const maxTravel = options.maxTravel ?? 0.005;
    if (!finite(maxTravel) || maxTravel <= 0) {
      return err(
        modelingError('model-invalid-argument', 'a positive maxTravel in meters', { maxTravel }),
      );
    }
    const { parts, geometry, contacts, tolerance, bands } = prepared.value;
    const us = new Set<number>();
    const count = Math.ceil(1 / step - 1e-9);
    for (let i = 0; i <= count; i++) us.add(Math.min(1, i * step));
    for (const key of path.keys) us.add(key.u);
    const motion = this.motionBounds(parts);
    const at = (u: number) => {
      const sampled = this.sample(path, u);
      if (!sampled.ok) return sampled;
      const posed = this.pose(sampled.value, options);
      if (!posed.ok) return posed;
      return ok({
        ...this.placement(parts, posed.value),
        clamped: posed.value.clamped,
        q: this.coordinates(posed.value),
        worlds: posed.value.joints.map((j) => j.world),
      });
    };
    const sorted = [...us].sort((a, b) => a - b);
    const scanned = scanPath(geometry, at, contacts, tolerance, sorted, {
      step,
      maxTravel,
      refine,
      ...(clearance === undefined ? {} : { clearance }),
      motion,
    });
    if (!scanned.ok || bands.length === 0) return scanned;
    // Fit bands at every regular sample: a fit must hold its declared distance all along.
    const measured = bands.map(() => [] as { u: number; d: number }[]);
    for (const u of sorted) {
      const placed = at(u);
      if (!placed.ok) return placed;
      for (const [k, band] of bands.entries()) {
        (measured[k] as { u: number; d: number }[]).push({
          u,
          d: this.fitDistance(geometry, band, placed.value),
        });
      }
    }
    const fits = bands.map((band, k) => {
      const ds = measured[k] as { u: number; d: number }[];
      const outside = (d: number) => Math.max(band.gap[0] - d, d - band.gap[1], 0);
      const worst = ds.reduce((w, e) => (outside(e.d) > outside(w.d) ? e : w));
      return {
        parts: band.parts,
        gap: band.gap,
        min: minOf(ds.map((e) => e.d)),
        max: maxOf(ds.map((e) => e.d)),
        at: worst.u,
        pass: ds.every((e) => within(e.d, band.gap)),
      };
    });
    return ok({ ...scanned.value, fits });
  }

  /**
   * Connecting hardware for every bound part (F1 criterion 13), built into the session at
   * rest and bound as one rigid part per joint, `mount-<joint>` (faces tagged
   * `hardware:<joint>`, box-projected UVs). Each joint whose subtree carries parts and that
   * existing hardware does not already link gets one element by kind: revolute and fixed
   * a hinge (pin in two knuckles), spherical a ball in an equator ring, prismatic a rail
   * over the whole travel with a sleeve carriage; the halves keep `clearance`, so they stay
   * within the connectivity gap in every pose. Elements sit on their locus where they are
   * closest to both sides; arms run to the nearest faces and posts join the separate touch
   * groups of one joint's parts (a minimum spanning tree), their ends sunk `seat` into the
   * faces, which become designed contacts. Every element, arm and post keeps clear of the
   * other parts, of the other joints' hardware and of `within`; what cannot is reported in
   * `unroutable` and not built.
   */
  mountHardware(options: MountHardwareOptions = {}): MountHardwareReport {
    if (this.failure !== undefined) {
      return {
        status: 'skipped',
        joints: [],
        pieces: 0,
        triangles: 0,
        embedded: 0,
        unroutable: [],
      };
    }
    const fail = (error: ModelingError): MountHardwareReport => {
      this.failure = error;
      return {
        status: 'failed',
        joints: [],
        pieces: 0,
        triangles: 0,
        embedded: 0,
        unroutable: [],
        error,
      };
    };
    const resolved = this._resolve();
    if (!resolved.ok) return fail(resolved.error);
    for (const [name, value] of [
      ['clearance', options.clearance],
      ['seat', options.seat],
      ['gap', options.gap],
    ] as const) {
      if (value !== undefined && (!finite(value) || value < 0)) {
        return fail(
          modelingError('model-invalid-argument', `a non-negative ${name} in meters`, {
            [name]: value,
          }),
        );
      }
    }
    const parts = resolved.value;
    const mesh = this.source.editMesh;
    const geometry = parts.map((p) => partGeometry(mesh, p.name, p.faces, p.closed));
    const rest = this.pose({});
    if (!rest.ok) return fail(rest.error);
    const joints = this._table.map((j) => {
      const m = j.restWorld;
      const [x, y, z] = j.axis;
      return {
        name: j.name,
        parent: j.parent,
        kind: j.kind,
        axis: [
          (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z,
          (m[4] as number) * x + (m[5] as number) * y + (m[6] as number) * z,
          (m[8] as number) * x + (m[9] as number) * y + (m[10] as number) * z,
        ] as Tuple3,
        anchor: [m[3], m[7], m[11]] as Tuple3,
        ...(j.kind === 'prismatic' && isRange(j.limits) ? { limits: j.limits } : {}),
      };
    });
    const roots = this.rootJoints(options.roots);
    if (!roots.ok) return fail(roots.error);
    const placement = this.placement(parts, rest.value);
    // Joints existing hardware already links at rest keep it and get no element; neither
    // do the roots and the joints above them, which never move the structure.
    const unlinked = new Set(
      this.groupsAt(parts, geometry, placement, options.gap ?? 5e-4, options.hardware, roots.value)
        .unlinked,
    );
    const linked = new Set(parts.map((p) => p.joint).filter((j) => !unlinked.has(j)));
    for (const r of roots.value) {
      for (let j = r; j >= 0; j = (this._table[j] as JointRecord).parent) linked.add(j);
    }
    // Clearance holds in every given pose: per pose, each joint's rest-to-posed transform.
    const frames: Affine[][] = [];
    for (const pose of options.poses ?? []) {
      const posedPose = this.pose(pose, options);
      if (!posedPose.ok) return fail(posedPose.error);
      frames.push(
        this._table.map((joint, j) =>
          multiply((posedPose.value.joints[j] as JointPose).world, invertRigid(joint.restWorld)),
        ),
      );
    }
    const plan = planHardware(
      joints,
      parts.map((p, i) => ({ joint: p.joint, geometry: geometry[i] as PartGeometry })),
      placement,
      linked,
      frames,
      options,
    );
    const scratch = model();
    for (const piece of plan.pieces) {
      const material = piece.material === 'metal' ? options.metal : options.frame;
      buildPiece(
        scratch,
        piece,
        `hardware:${(this._table[piece.joint] as JointRecord).name}`,
        material,
      );
    }
    // Hardware carries the UV channels the session's parts carry (box projected).
    for (const channel of ['uv0', 'uv1'] as const) {
      if (channel === 'uv0' || this.source.editMesh.channels.has(channel)) {
        scratch.uv.project({ mode: 'box', scale: 0.25, channel });
      }
    }
    if (scratch.poisoned !== undefined) return fail(scratch.poisoned);
    let triangles = 0;
    for (const f of scratch.editMesh.faces())
      triangles += scratch.editMesh.faceVertices(f).length - 2;
    if (plan.pieces.length > 0) {
      const appended = this.source.append(scratch.snapshot(), { label: 'hardware' });
      if (appended.status !== 'ok') {
        return fail(
          appended.error ?? modelingError('model-invalid-argument', 'the hardware appends', {}),
        );
      }
    }
    const mounted: MountedJoint[] = [];
    for (const row of plan.joints) {
      const name = (this._table[row.index] as JointRecord).name;
      if (!plan.pieces.some((p) => p.joint === row.index)) continue;
      const part = `mount-${name}`;
      const bound = this.bindRigid(sel.tag(`hardware:${name}`), name, { part });
      if (bound.status !== 'ok')
        return fail(
          bound.error ?? modelingError('model-invalid-argument', 'the mount binds', { part }),
        );
      for (const [i, tolerance] of plan.seats.get(row.index) ?? []) {
        this.designed.push({ parts: [part, (parts[i] as ResolvedPart).name], tolerance });
      }
      const { index: _index, ...rest } = row;
      mounted.push({
        joint: name,
        part,
        pieces: plan.pieces.filter((p) => p.joint === row.index).length,
        ...rest,
      });
    }
    // Parent-side halves ride joints whose own row may list no element pieces.
    for (const index of new Set(plan.pieces.map((p) => p.joint))) {
      if (plan.joints.some((row) => row.index === index)) continue;
      const name = (this._table[index] as JointRecord).name;
      const bound = this.bindRigid(sel.tag(`hardware:${name}`), name, { part: `mount-${name}` });
      if (bound.status !== 'ok')
        return fail(bound.error ?? modelingError('model-invalid-argument', 'the mount binds', {}));
    }
    const nameOf = (j: number) => (this._table[j] as JointRecord).name;
    return {
      status: 'ok',
      joints: mounted,
      pieces: plan.pieces.length,
      triangles,
      embedded: plan.embedded,
      unroutable: plan.unroutable.map((u) => ({
        joint: nameOf(u.joint),
        what: u.what,
        parts: u.parts.map((i) => (parts[i] as ResolvedPart).name),
      })),
    };
  }

  /**
   * Whether every rigid part hangs off the root through touching hardware at each pose
   * (F1 criterion 13). Parts connect when their surfaces come within `gap` (or one encloses
   * the other): parts of one joint directly, and across a joint (a part's joint and its
   * nearest part-carrying ancestor) only when one of the two is hardware
   * (`options.hardware`, default parts named `mount-*`). The parts of the `roots` joints
   * (default the rig root) and of the joints above them are fixed; every part they never
   * reach floats. Each pose also lists the floating touch groups and the joints no
   * hardware crossing links.
   */
  connectivity(
    poses: readonly Pose[],
    options: ConnectivityOptions = {},
  ): Result<ConnectivityReport, ModelingError> {
    const resolved = this._resolve();
    if (!resolved.ok) return resolved;
    const gap = options.gap ?? 5e-4;
    if (!finite(gap) || gap < 0) {
      return err(modelingError('model-invalid-argument', 'a non-negative gap in meters', { gap }));
    }
    if (!Array.isArray(poses) || poses.length === 0) {
      return err(modelingError('model-invalid-argument', 'at least one pose', {}));
    }
    const roots = this.rootJoints(options.roots);
    if (!roots.ok) return roots;
    const parts = resolved.value;
    const mesh = this.source.editMesh;
    const geometry = parts.map((p) => partGeometry(mesh, p.name, p.faces, p.closed));
    const out: ConnectivityReport['poses'][number][] = [];
    const floating = new Set<string>();
    for (const [index, pose] of poses.entries()) {
      const posed = this.pose(pose, options);
      if (!posed.ok) return posed;
      const at = this.groupsAt(
        parts,
        geometry,
        this.placement(parts, posed.value),
        gap,
        options.hardware,
        roots.value,
      );
      const loose: FloatingPart[] = [];
      const groups = new Map<number, string[]>();
      for (const [i, p] of parts.entries()) {
        if (at.attached[i] === 1) continue;
        floating.add(p.name);
        const g = at.group[i] as number;
        groups.set(g, [...(groups.get(g) ?? []), p.name]);
        const n = at.nearest.get(i);
        loose.push({
          part: p.name,
          joint: (this._table[p.joint] as JointRecord).name,
          ...(n === undefined
            ? {}
            : { nearest: { part: (parts[n.part] as ResolvedPart).name, distance: n.distance } }),
        });
      }
      out.push({
        index,
        floating: loose,
        detached: [...groups.values()],
        unlinked: at.unlinked.map((j) => (this._table[j] as JointRecord).name),
      });
    }
    return ok({
      attached: floating.size === 0,
      gap,
      roots: parts.filter((p) => roots.value.has(p.joint)).map((p) => p.name),
      poses: out,
      floating: [...floating].sort(),
    });
  }

  /** Seed joints by name (default the rig root) with the joints above them, validated. */
  private rootJoints(names: readonly string[] | undefined): Result<Set<number>, ModelingError> {
    if (names === undefined) return ok(new Set([0]));
    const out = new Set<number>();
    for (const name of Array.isArray(names) ? names : [undefined]) {
      const j = typeof name === 'string' ? this.index.get(name) : undefined;
      if (j === undefined) {
        return err(
          modelingError('model-invalid-argument', 'roots name joints of the rig', {
            roots: names,
            joints: this._table.map((t) => t.name),
          }),
        );
      }
      // The joints above a root (a stand) are fixed with it, not structure.
      for (let k = j; k >= 0; k = (this._table[k] as JointRecord).parent) out.add(k);
    }
    return ok(out);
  }

  /**
   * Touch groups of the bound parts at one placement, under the criterion-13 rules: parts
   * of one joint connect by touch; across a joint (to the nearest part-carrying ancestor)
   * only when one of the two is hardware. The root joint's parts are attached.
   */
  private groupsAt(
    parts: readonly ResolvedPart[],
    geometry: readonly PartGeometry[],
    placement: Placement,
    gap: number,
    hardware: ((part: string) => boolean) | undefined,
    roots: ReadonlySet<number>,
  ): {
    readonly attached: Uint8Array;
    readonly group: Int32Array;
    readonly nearest: ReadonlyMap<number, { part: number; distance: number }>;
    /** Part-carrying joints (not the root) with no touching hardware crossing to their ancestor group. */
    readonly unlinked: readonly number[];
  } {
    const isHardware = hardware ?? ((name: string) => name.startsWith('mount-'));
    const carries = new Set(parts.map((p) => p.joint));
    const carrier = this._table.map((joint) => {
      let k = joint.parent;
      while (k >= 0 && !carries.has(k)) k = (this._table[k] as JointRecord).parent;
      return k;
    });
    const hw = parts.map((p) => isHardware(p.name));
    const crossing = (a: number, b: number) => {
      const ja = (parts[a] as ResolvedPart).joint;
      const jb = (parts[b] as ResolvedPart).joint;
      return (carrier[ja] === jb || carrier[jb] === ja) && (hw[a] === true || hw[b] === true);
    };
    const same = (a: number, b: number) =>
      (parts[a] as ResolvedPart).joint === (parts[b] as ResolvedPart).joint;
    const seeds = parts.flatMap((p, i) => (roots.has(p.joint) ? [i] : []));
    const { group, nearest, touching } = partGroups(
      geometry,
      placement,
      same,
      crossing,
      seeds,
      gap,
    );
    const attached = new Uint8Array(parts.length);
    const rootGroups = new Set(seeds.map((i) => group[i] as number));
    for (let i = 0; i < parts.length; i++) if (rootGroups.has(group[i] as number)) attached[i] = 1;
    const linked = new Set<number>();
    for (const [a, b] of touching) {
      const ja = (parts[a] as ResolvedPart).joint;
      const jb = (parts[b] as ResolvedPart).joint;
      linked.add(carrier[ja] === jb ? ja : jb);
    }
    const unlinked = [...carries]
      .filter((j) => !roots.has(j) && !linked.has(j))
      .sort((x, y) => x - y);
    return { attached, group, nearest, unlinked };
  }

  /**
   * The source keys `finish` would write for these options, without exporting anything
   * (a Pack that defers the rig to a cooker lists them up front).
   */
  outputKeys(
    options: Pick<RigFinishOptions, 'key' | 'form' | 'path' | 'clips'>,
  ): Result<readonly string[], ModelingError> {
    const all = this.resolveAll();
    if (!all.ok) return all;
    return ok(
      outputKeysOf(
        options.key,
        all.value.parts.map((p) => p.name),
        options.form === 'skinned',
        options.clips === undefined ? options.path !== undefined : options.clips.map((c) => c.name),
      ),
    );
  }

  /**
   * Pack build output for the Engine: part meshes, a SceneAsset with one entity per
   * joint (Name, Transform, ChildOf, AnimationTargetId) and, with `path`, an
   * AnimationClip that the root entity's AnimationPlayer plays. Consumers bind the
   * joint entities with `bindAnimationTargets(world, root, joints)`. A Pack returning
   * the scene declares the components it uses in `sceneComponents` (Name, Transform,
   * ChildOf, AnimationTargetId, AnimationPlayer, MeshFilter, MeshRenderer, and Skin for
   * the skinned form); the Pack producer rejects the scene otherwise.
   */
  finish(
    options: RigFinishOptions,
  ): Result<
    Readonly<Record<string, MeshAsset | SceneAsset | AnimationClip | SkeletonAsset | SkinAsset>>,
    ModelingError
  > {
    if (typeof options.key !== 'string' || !KEY.test(options.key)) {
      return err(
        modelingError('model-invalid-argument', 'key is a lowercase source key segment', {
          key: options.key,
        }),
      );
    }
    const named = this.checkClips(options);
    if (!named.ok) return named;
    const all = this.resolveAll();
    if (!all.ok) return all;
    const resolved = { ok: true, value: all.value.parts } as const;
    if (options.form !== 'skinned' && all.value.skins.length > 0) {
      return err(
        modelingError(
          'model-invalid-argument',
          "bindAuto regions export with form: 'skinned'",
          { regions: all.value.skins.map((s) => s.name) },
          "pass form: 'skinned', or bind those faces with bindRigid",
        ),
      );
    }
    const key = options.key;
    const guid = (k: string) => AssetGuid.format(AssetGuid.derive(options.packageId, k));
    const normals = options.normals ?? { mode: 'weighted' as const };
    const outputs: Record<
      string,
      MeshAsset | SceneAsset | AnimationClip | SkeletonAsset | SkinAsset
    > = {};
    const target = (j: JointRecord) => deriveAnimationTargetId([key, j.name]);
    const entities: Record<string, SceneEntity> = {};
    const rootKey = 'rig';
    entities[rootKey] = { components: { Name: { value: key }, Transform: {} } };
    for (const j of this._table) {
      const [x, y, z] = [j.restLocal[3], j.restLocal[7], j.restLocal[11]] as [
        number,
        number,
        number,
      ];
      entities[`joint.${j.name}`] = {
        components: {
          Name: { value: j.name },
          Transform: { pos: [x, y, z], quat: toQuaternion(j.restLocal) },
          ChildOf: {
            parent: j.parent < 0 ? rootKey : `joint.${(this._table[j.parent] as JointRecord).name}`,
          },
          AnimationTargetId: { value: target(j) },
        },
      };
    }
    const bind = (asset: MeshAsset, output: string): Result<string[], ModelingError> => {
      if (options.materials === undefined) return ok([]);
      const slots = asset.materialSlots.map((m) => m.slotName);
      const missing = slots.filter((n) => options.materials?.[n] === undefined);
      if (missing.length > 0)
        return err(
          modelingError(
            'model-invalid-argument',
            'materials names every mesh slot',
            { output, slots: missing },
            'add the missing slot names to the finish materials option',
          ),
        );
      return ok(slots.map((n) => guid(options.materials?.[n] as string)));
    };
    const mesh = this.source.editMesh;
    if (options.form === 'skinned') {
      const skinned = this.skinnedMesh(all.value, normals);
      if (!skinned.ok) {
        const cause = skinned.error;
        return err(
          modelingError(
            cause.code,
            cause.expected,
            { output: `mesh/${key}`, ...cause.detail },
            cause.hint,
          ),
        );
      }
      const skinnedMaterials = bind(skinned.value, `mesh/${key}`);
      if (!skinnedMaterials.ok) return skinnedMaterials;
      outputs[`mesh/${key}`] = skinned.value;
      const inverseBindMatrices = new Float32Array(this._table.length * 16);
      for (const [i, j] of this._table.entries())
        inverseBindMatrices.set(toColumnMajor(invertRigid(j.restWorld)), i * 16);
      outputs[`skeleton/${key}`] = {
        kind: 'skeleton',
        jointCount: this._table.length,
        inverseBindMatrices,
      };
      outputs[`skin/${key}`] = {
        kind: 'skin',
        skeletonGuid: guid(`skeleton/${key}`),
        jointPaths: this._table.map((j) => [key, ...this.chain(j)].join('/')),
      };
      entities.mesh = {
        components: {
          Name: { value: `${key}.mesh` },
          Transform: {},
          ChildOf: { parent: rootKey },
          MeshFilter: { assetHandle: guid(`mesh/${key}`) },
          MeshRenderer: { materials: skinnedMaterials.value },
          Skin: { skeleton: guid(`skeleton/${key}`) },
        },
      };
    } else {
      for (const part of resolved.value) {
        const joint = this._table[part.joint] as JointRecord;
        const local = invertRigid(joint.restWorld);
        const meshKey = `mesh/${key}.${part.name}`;
        const exported = exportMesh(this.partMesh(mesh, part, local), { normals });
        if (!exported.ok) {
          const cause = exported.error;
          return err(
            modelingError(
              cause.code,
              cause.expected,
              { output: meshKey, part: part.name, ...cause.detail },
              cause.hint,
            ),
          );
        }
        const materials = bind(exported.value.mesh, meshKey);
        if (!materials.ok) return materials;
        outputs[meshKey] = exported.value.mesh;
        entities[`part.${part.name}`] = {
          components: {
            Name: { value: part.name },
            Transform: {},
            ChildOf: { parent: `joint.${joint.name}` },
            MeshFilter: { assetHandle: guid(meshKey) },
            MeshRenderer: { materials: materials.value },
          },
        };
      }
    }
    const reports: ClipReport[] = [];
    if (options.path !== undefined) {
      const clip = this.clip(options.path, options.duration ?? 4, options.frameRate ?? 30, target);
      if (!clip.ok) return clip;
      outputs[`animation-clip/${key}`] = clip.value.clip;
      entities[rootKey] = {
        components: {
          ...entities[rootKey]?.components,
          AnimationPlayer: {
            clips: [guid(`animation-clip/${key}`)],
            times: [0],
            weights: [1],
            speeds: [1],
            looping: false,
          },
        },
      };
    } else if (options.clips !== undefined && options.clips.length > 0) {
      for (const spec of options.clips) {
        const clipKey = `animation-clip/${key}/${spec.name}`;
        const clip = this.clip(spec.path, spec.duration, spec.frameRate ?? 30, target);
        if (!clip.ok) {
          const cause = clip.error;
          return err(
            modelingError(
              cause.code,
              cause.expected,
              { output: clipKey, clip: spec.name, ...cause.detail },
              cause.hint,
            ),
          );
        }
        outputs[clipKey] = clip.value.clip;
        reports.push({
          name: spec.name,
          key: clipKey,
          loop: spec.loop === true,
          duration: spec.duration,
          frames: clip.value.frames,
        });
      }
      entities[rootKey] = {
        components: {
          ...entities[rootKey]?.components,
          AnimationPlayer: {
            clips: reports.map((c) => guid(c.key)),
            times: reports.map(() => 0),
            weights: reports.map((_, i) => (i === 0 ? 1 : 0)),
            speeds: reports.map(() => 1),
            looping: (reports[0] as ClipReport).loop,
          },
        },
      };
    }
    outputs[`scene/${key}`] = {
      kind: 'scene',
      entities,
      ...(options.form === 'skinned' ? { skinGuids: [guid(`skin/${key}`)] } : {}),
    };
    this.exported = {
      key,
      ...(options.path === undefined ? {} : { path: options.path }),
      clips: reports,
    };
    return ok(outputs);
  }

  // ---- internals ----------------------------------------------------------------------

  private chain(j: JointRecord): string[] {
    const names = [j.name];
    let p = j.parent;
    while (p >= 0) {
      const parent = this._table[p] as JointRecord;
      names.unshift(parent.name);
      p = parent.parent;
    }
    return names;
  }

  private applyLimits(
    joint: JointRecord,
    value: JointValue,
    clamped: Clamp[],
  ): Result<JointValue | null, ModelingError> {
    const bad = (expected: string) =>
      err(modelingError('model-invalid-argument', expected, { joint: joint.name, value }));
    switch (joint.kind) {
      case 'fixed':
        return bad('fixed joints take no pose value');
      case 'revolute':
      case 'prismatic': {
        if (!finite(value)) return bad(`a finite number for the ${joint.kind} joint`);
        const applied = clampValue(value as number, rangeOf(joint) as Range | undefined);
        if (applied !== value)
          clamped.push({ joint: joint.name, requested: value as number, applied });
        return ok(applied);
      }
      case 'spherical': {
        if (
          value === null ||
          typeof value !== 'object' ||
          Object.keys(value).some((k) => !AXES.includes(k as Axis))
        ) {
          return bad('{ x?, y?, z? } degrees for the spherical joint');
        }
        const limits = joint.limits as Readonly<Partial<Record<Axis, Range>>> | undefined;
        const out: Partial<Record<Axis, number>> = {};
        for (const axis of AXES) {
          const requested = (value as Angles)[axis];
          if (requested === undefined) continue;
          if (!finite(requested)) return bad('finite spherical angles');
          const range = limits === undefined ? undefined : (limits[axis] ?? [0, 0]);
          const applied = clampValue(requested, range);
          if (applied !== requested) clamped.push({ joint: joint.name, axis, requested, applied });
          out[axis] = applied;
        }
        return ok(out);
      }
    }
  }

  /** Per joint, the keys that name it, in u order. */
  /**
   * Per joint, the keys that name it, in u order. Compiled once per path object: paths are
   * immutable values, so scans and clip export that sample one path thousands of times
   * validate and sort it once.
   */
  private tracks(path: PosePath): Result<Map<number, TrackKey[]>, ModelingError> {
    if (path !== null && typeof path === 'object') {
      const cached = this.compiled.get(path);
      if (cached !== undefined) return cached;
      const compiled = this.compileTracks(path);
      this.compiled.set(path, compiled);
      return compiled;
    }
    return this.compileTracks(path);
  }

  private compileTracks(path: PosePath): Result<Map<number, TrackKey[]>, ModelingError> {
    if (!Array.isArray(path?.keys) || path.keys.length === 0) {
      return err(modelingError('model-invalid-argument', 'a path has at least one key', {}));
    }
    const mode = path.interpolation ?? 'linear';
    if (mode !== 'linear' && mode !== 'smooth' && mode !== 'step' && mode !== 'hermite') {
      return err(
        modelingError(
          'model-invalid-argument',
          "interpolation 'linear' | 'smooth' | 'step' | 'hermite'",
          {
            interpolation: mode,
          },
        ),
      );
    }
    const tracks = new Map<number, TrackKey[]>();
    let previous = -Infinity;
    for (const [k, key] of path.keys.entries()) {
      if (!finite(key.u) || key.u < 0 || key.u > 1 || key.u <= previous) {
        return err(
          modelingError('model-invalid-argument', 'key u values in [0, 1], strictly increasing', {
            key: k,
            u: key.u,
          }),
        );
      }
      previous = key.u;
      for (const [name, value] of Object.entries(key.pose ?? ({} as Pose))) {
        const i = this.index.get(name);
        const joint = i === undefined ? undefined : this._table[i];
        if (i === undefined || joint === undefined || joint.kind === 'fixed') {
          return err(
            modelingError('model-invalid-argument', 'path keys name movable rig joints', {
              key: k,
              joint: name,
            }),
          );
        }
        const follower = this.followerError(i);
        if (follower !== undefined) return err(follower);
        if ((joint.kind === 'spherical') !== (typeof value === 'object')) {
          return err(
            modelingError(
              'model-invalid-argument',
              'numbers for revolute/prismatic joints, angles for spherical joints',
              { key: k, joint: name },
            ),
          );
        }
        let track = tracks.get(i);
        if (track === undefined) {
          // A joint starts from rest at u = 0 unless a key names it there.
          track = key.u > 0 ? [{ u: 0, value: joint.kind === 'spherical' ? {} : 0 }] : [];
          tracks.set(i, track);
        }
        track.push({ u: key.u, value: value as JointValue });
      }
    }
    return ok(tracks);
  }

  /** @internal */
  _resolve(): Result<ResolvedPart[], ModelingError> {
    const resolved = this.resolveAll();
    return resolved.ok ? ok(resolved.value.parts) : resolved;
  }

  private resolveAll(): Result<Resolved, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const sourceFailure = this.source.poisoned;
    if (sourceFailure !== undefined) {
      return err(
        modelingError(
          'model-precondition',
          'the rig source session is not poisoned',
          { cause: sourceFailure.code },
          'fix the source session first; its first failure is in detail.cause',
        ),
      );
    }
    if (this.bindings.length === 0) {
      return err(
        modelingError(
          'model-precondition',
          'the rig binds at least one part',
          {},
          "bindRigid(sel.all(), '<root joint>') binds the whole session",
        ),
      );
    }
    const mesh = this.source.editMesh;
    const owner = new Map<number, number>();
    for (const [b, binding] of this.bindings.entries()) {
      const ids = binding.faces.resolve(mesh);
      if (!ids.ok) {
        const cause = ids.error;
        return err(
          modelingError(
            cause.code,
            cause.expected,
            { ...cause.detail, part: binding.part },
            cause.hint,
          ),
        );
      }
      for (const f of ids.value) owner.set(f, b);
    }
    const unbound = mesh.faces().filter((f) => !owner.has(f));
    if (unbound.length > 0) {
      return err(
        modelingError(
          'model-precondition',
          'every face belongs to a bound part',
          { unbound: unbound.length, faces: unbound.slice(0, 16) },
          "bindRigid(sel.all(), '<root joint>') first; later bindings take over the faces they select",
        ),
      );
    }
    const faces = this.bindings.map(() => [] as number[]);
    for (const [f, b] of owner) (faces[b] as number[]).push(f);
    const rigidOwner = new Map<number, number>();
    const skinOwner = new Map<number, number>();
    const rigidVertex = new Map<number, number>();
    const parts: ResolvedPart[] = [];
    const skins: ResolvedSkin[] = [];
    for (const [b, binding] of this.bindings.entries()) {
      const list = (faces[b] as number[]).sort((x, y) => x - y);
      if (list.length === 0) {
        return err(
          modelingError(
            'model-precondition',
            'every binding keeps at least one face',
            { part: binding.part },
            'a later binding selected all of its faces; narrow that selector',
          ),
        );
      }
      const vertexOwner = binding.auto === undefined ? rigidOwner : skinOwner;
      let closed = true;
      for (const f of list) {
        for (const v of mesh.faceVertices(f)) {
          const other = vertexOwner.get(v);
          if (other !== undefined && other !== b) {
            return err(
              modelingError(
                'model-precondition',
                binding.auto === undefined
                  ? 'rigid parts share no vertex'
                  : 'bindAuto regions share no vertex',
                { parts: [(this.bindings[other] as Binding).part, binding.part], vertex: v },
                binding.auto === undefined
                  ? 'disconnect(faces) one part, or model the parts as separate shells'
                  : 'bind the connected surface as one bindAuto region over all of its joints',
              ),
            );
          }
          vertexOwner.set(v, b);
          if (binding.auto === undefined) rigidVertex.set(v, parts.length);
        }
        for (const h of mesh.faceHalves(f)) if (mesh.isBoundaryEdge(h >> 1)) closed = false;
      }
      if (binding.auto === undefined) {
        parts.push({ name: binding.part, joint: binding.joint, faces: list, closed });
      } else {
        skins.push({
          name: binding.part,
          joints: binding.auto.joints,
          faces: list,
          options: binding.auto.options,
        });
      }
    }
    return ok({ parts, skins, rigidVertex });
  }

  /** Run (or reuse) the `skin.bind` job of one region and map it back to rig joints. */
  private skinWeights(skin: ResolvedSkin, resolved: Resolved): Result<SkinWeights, ModelingError> {
    const region = this.source.editMesh.clone();
    const keep = new Set(skin.faces);
    for (const f of region.faces()) if (!keep.has(f)) region.removeFace(f);
    const { mesh: compacted, vertexMap } = region.compact();
    const vertices = new Int32Array(compacted.vertexCount);
    for (let v = 0; v < vertexMap.length; v++) {
      const c = vertexMap[v] as number;
      if (c >= 0) vertices[c] = v;
    }
    const bones: SkinBone[] = skin.joints.map((j) => {
      const joint = this._table[j] as JointRecord;
      const at = (r: JointRecord): Tuple3 => [
        r.restWorld[3] as number,
        r.restWorld[7] as number,
        r.restWorld[11] as number,
      ];
      return { root: at(joint), tips: this._table.filter((c) => c.parent === j).map(at) };
    });
    const pins: number[] = [];
    for (let c = 0; c < vertices.length; c++) {
      const part = resolved.rigidVertex.get(vertices[c] as number);
      if (part === undefined) continue;
      const joint = (resolved.parts[part] as ResolvedPart).joint;
      const bone = skin.joints.indexOf(joint);
      if (bone < 0) {
        return err(
          modelingError(
            'model-precondition',
            "a bindAuto region's joints include the joints of the rigid parts it touches",
            {
              part: skin.name,
              rigid: (resolved.parts[part] as ResolvedPart).name,
              joint: (this._table[joint] as JointRecord).name,
            },
            'add that joint to the bindAuto joints',
          ),
        );
      }
      pins.push(c, bone);
    }
    const o = skin.options;
    const request = {
      kind: 'skin.bind' as const,
      inputs: [encodeSnapshot(compacted)],
      params: {
        bones,
        resolution: o.resolution ?? 64,
        stiffness: o.stiffness ?? 0.2,
        smoothing: o.smoothing ?? 8,
        smoothingStrength: o.smoothingStrength ?? 0.5,
        maxInfluences: o.maxInfluences ?? SKIN_INFLUENCES,
        prune: o.prune ?? 0.01,
        pins,
      },
    };
    const context = this.source.computeContext;
    const backend = resolveBackend('skin.bind', context.policy, tsSkinBackend, context.native);
    const key = backend.ok ? computeCacheKey(request, backend.value.identity) : undefined;
    const cached = key === undefined ? undefined : this.weightCache.get(key);
    if (cached !== undefined && cached.part === skin.name) return ok(cached);
    const job = runComputeJob(request, tsSkinBackend, context);
    if (!job.ok) {
      const cause = job.error;
      return err(
        modelingError(cause.code, cause.expected, { ...cause.detail, part: skin.name }, cause.hint),
      );
    }
    const [indexBytes, weightBytes] = job.value.outputs as [Uint8Array, Uint8Array];
    const local = new Uint16Array(
      indexBytes.buffer.slice(indexBytes.byteOffset, indexBytes.byteOffset + indexBytes.byteLength),
    );
    const joints = local.map((b) => skin.joints[b] as number);
    const weights = new Float32Array(
      weightBytes.buffer.slice(
        weightBytes.byteOffset,
        weightBytes.byteOffset + weightBytes.byteLength,
      ),
    );
    const out: SkinWeights = {
      part: skin.name,
      vertices,
      joints,
      weights,
      status: job.value.status,
      report: job.value.report,
      locations: job.value.locations,
    };
    this.weightCache.set(job.value.report.cacheKey, out);
    return ok(out);
  }

  /** @internal */
  _prepare(options: InterferenceOptions): Result<
    {
      parts: ResolvedPart[];
      geometry: PartGeometry[];
      contacts: Map<string, number>;
      /** Fits with a declared band, by part index. */
      bands: { a: number; b: number; parts: [string, string]; gap: readonly [number, number] }[];
      tolerance: number;
    },
    ModelingError
  > {
    const resolved = this._resolve();
    if (!resolved.ok) return resolved;
    const tolerance = options.tolerance ?? 1e-4;
    if (!finite(tolerance) || tolerance < 0) {
      return err(
        modelingError('model-invalid-argument', 'a non-negative tolerance in meters', {
          tolerance,
        }),
      );
    }
    const names = new Set(resolved.value.map((p) => p.name));
    const contacts = new Map<string, number>();
    for (const c of [...this.designed, ...(options.contacts ?? [])]) {
      const [a, b] = c.parts;
      if (!names.has(a) || !names.has(b) || a === b) {
        return err(
          modelingError(
            'model-invalid-argument',
            'designed contacts name two different bound parts',
            { parts: c.parts, known: [...names] },
          ),
        );
      }
      if (c.kind !== undefined && c.kind !== 'seat' && c.kind !== 'fit') {
        return err(
          modelingError('model-invalid-argument', "a designed contact kind 'seat' | 'fit'", {
            parts: c.parts,
            kind: c.kind,
          }),
        );
      }
      if (c.kind === 'fit' && c.tolerance !== undefined) {
        return err(
          modelingError(
            'model-invalid-argument',
            'a fit accepts no penetration',
            { parts: c.parts, tolerance: c.tolerance },
            "drop tolerance, or declare kind: 'seat' for a part sunk into another",
          ),
        );
      }
      const t = contactTolerance(c);
      if (!finite(t) || t < 0)
        return err(
          modelingError('model-invalid-argument', 'a non-negative contact tolerance', {
            parts: c.parts,
          }),
        );
      if (c.gap !== undefined) {
        const [lo, hi] = Array.isArray(c.gap) ? c.gap : [Number.NaN, Number.NaN];
        if (c.kind !== 'fit' || !finite(lo, hi) || lo < 0 || lo > (hi as number)) {
          return err(
            modelingError(
              'model-invalid-argument',
              "a fit's gap band [min, max] with 0 <= min <= max meters",
              { parts: c.parts, kind: c.kind, gap: c.gap },
              "declare the band on a kind: 'fit' contact",
            ),
          );
        }
      }
      contacts.set(a < b ? `${a}\n${b}` : `${b}\n${a}`, t);
    }
    const index = new Map(resolved.value.map((p, i) => [p.name, i]));
    const bands = new Map<
      string,
      { a: number; b: number; parts: [string, string]; gap: readonly [number, number] }
    >();
    for (const c of [...this.designed, ...(options.contacts ?? [])]) {
      const [a, b] = c.parts;
      const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
      if (c.gap === undefined || c.kind !== 'fit') {
        bands.delete(key);
        continue;
      }
      bands.set(key, {
        a: index.get(a) as number,
        b: index.get(b) as number,
        parts: (a < b ? [a, b] : [b, a]) as [string, string],
        gap: c.gap,
      });
    }
    const mesh = this.source.editMesh;
    return ok({
      parts: resolved.value,
      geometry: resolved.value.map((p) => partGeometry(mesh, p.name, p.faces, p.closed)),
      contacts,
      bands: [...bands.values()],
      tolerance,
    });
  }

  /** Joint coordinates of a pose: radians for revolute and spherical axes, meters for prismatic. */
  private coordinates(pose: PoseResult): Float64Array {
    const q: number[] = [];
    for (const [i, joint] of this._table.entries()) {
      const value = (pose.joints[i] as JointPose).value;
      if (joint.kind === 'revolute') q.push(((value as number) * Math.PI) / 180);
      else if (joint.kind === 'prismatic') q.push(value as number);
      else if (joint.kind === 'spherical') {
        for (const axis of AXES) q.push((((value as Angles)[axis] ?? 0) * Math.PI) / 180);
      }
    }
    return Float64Array.from(q);
  }

  /**
   * Motion of two parts relative to each other between two samples. Every joint is
   * monotone between samples (keys are samples); joints shared by both chains move them
   * rigidly and drop out. Each other moving joint is reported in the part's rest frame
   * at the first sample, with its turn and axis, or as prismatic travel.
   */
  private motionBounds(
    parts: readonly ResolvedPart[],
  ): (s0: ScanPose, s1: ScanPose, a: number, b: number) => readonly [MotionBound, MotionBound] {
    const offset: number[] = [];
    let n = 0;
    for (const joint of this._table) {
      offset.push(n);
      n += joint.kind === 'fixed' ? 0 : joint.kind === 'spherical' ? 3 : 1;
    }
    const chains = parts.map((p) => {
      const chain: number[] = [];
      for (let j = p.joint; j >= 0; j = (this._table[j] as JointRecord).parent) chain.unshift(j);
      return chain;
    });
    return (s0, s1, a, b) => {
      const ca = chains[a] as number[];
      const cb = chains[b] as number[];
      let common = 0;
      while (common < ca.length && common < cb.length && ca[common] === cb[common]) common++;
      const bound = (chain: readonly number[], part: number): MotionBound => {
        let linear = 0;
        const turns: JointTurn[] = [];
        const toRest = invertRigid(s0.deltas[part] as Affine);
        for (let k = common; k < chain.length; k++) {
          const j = chain[k] as number;
          const joint = this._table[j] as JointRecord;
          const o = offset[j] as number;
          const dims = joint.kind === 'spherical' ? 3 : joint.kind === 'fixed' ? 0 : 1;
          let change = 0;
          for (let d = 0; d < dims; d++) {
            change += Math.abs((s1.q[o + d] as number) - (s0.q[o + d] as number));
          }
          if (change === 0) continue;
          if (joint.kind === 'prismatic') {
            linear += change;
            continue;
          }
          const frame = multiply(toRest, s0.worlds[j] as Affine);
          const origin: Tuple3 = [frame[3] as number, frame[7] as number, frame[11] as number];
          if (joint.kind === 'spherical') {
            turns.push({ angle: change, origin });
            continue;
          }
          const tip = applyPoint(frame, joint.axis);
          turns.push({
            angle: change,
            origin,
            axis: [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]],
          });
        }
        return { linear, turns };
      };
      return [bound(ca, a), bound(cb, b)];
    };
  }

  /**
   * Deltas plus pair transforms built from the joints below each pair's deepest common
   * ancestor. Ancestors move both parts rigidly, so they are left out of the arithmetic:
   * the result is bitwise independent of their motion, and a pair whose own joints are
   * all at rest gets the exact identity (coincident seams of split skins stay exact).
   */
  placement(parts: readonly ResolvedPart[], pose: PoseResult): Placement {
    const deltas = this.deltas(parts, pose);
    const moving = this._table.map((joint, i) => {
      const value = (pose.joints[i] as JointPose).value;
      if (joint.kind === 'fixed' || value === null) return false;
      if (typeof value === 'number') return value !== 0;
      return AXES.some((axis) => (value[axis] ?? 0) !== 0);
    });
    const local = this._table.map((joint, i) =>
      multiply(joint.restLocal, motion(joint, (pose.joints[i] as JointPose).value)),
    );
    const chains = parts.map((p) => {
      const chain: number[] = [];
      for (let j = p.joint; j >= 0; j = (this._table[j] as JointRecord).parent) chain.unshift(j);
      return chain;
    });
    const below = (chain: readonly number[], from: number): Affine =>
      chain.slice(from).reduce<Affine>((m, j) => multiply(m, local[j] as Affine), IDENTITY);
    const relative = (a: number, b: number): Affine => {
      const ca = chains[a] as number[];
      const cb = chains[b] as number[];
      let common = 0;
      while (common < ca.length && common < cb.length && ca[common] === cb[common]) common++;
      const still = (chain: readonly number[]) => chain.slice(common).every((j) => !moving[j]);
      if (still(ca) && still(cb)) return IDENTITY;
      const ja = (this._table[(parts[a] as ResolvedPart).joint] as JointRecord).restWorld;
      const jb = (this._table[(parts[b] as ResolvedPart).joint] as JointRecord).restWorld;
      return multiply(
        multiply(ja, invertRigid(below(ca, common))),
        multiply(below(cb, common), invertRigid(jb)),
      );
    };
    return { deltas, relative };
  }

  /** Per part: rest model space -> posed model space. */
  deltas(parts: readonly ResolvedPart[], pose: PoseResult): Affine[] {
    return parts.map((p) => {
      const joint = this._table[p.joint] as JointRecord;
      return multiply((pose.joints[p.joint] as JointPose).world, invertRigid(joint.restWorld));
    });
  }

  private posedMesh(
    pose: Pose,
    options: PoseOptions,
  ): Result<{ mesh: EditMesh; pose: PoseResult }, ModelingError> {
    const all = this.resolveAll();
    if (!all.ok) return all;
    const resolved = { ok: true, value: all.value.parts } as const;
    const posed = this.pose(pose, options);
    if (!posed.ok) return posed;
    const deltas = this.deltas(resolved.value, posed.value);
    const mesh = this.source.editMesh.clone();
    const done = new Set<number>();
    const jointDelta = this._table.map((joint, j) =>
      multiply((posed.value.joints[j] as JointPose).world, invertRigid(joint.restWorld)),
    );
    for (const skin of all.value.skins) {
      const weights = this.skinWeights(skin, all.value);
      if (!weights.ok) return weights;
      const { vertices, joints, weights: w } = weights.value;
      for (let r = 0; r < vertices.length; r++) {
        const v = vertices[r] as number;
        if (all.value.rigidVertex.has(v)) continue;
        const p = this.source.editMesh.position(v);
        const out: Tuple3 = [0, 0, 0];
        for (let k = 0; k < SKIN_INFLUENCES; k++) {
          const weight = w[r * SKIN_INFLUENCES + k] as number;
          if (weight === 0) continue;
          const q = applyPoint(jointDelta[joints[r * SKIN_INFLUENCES + k] as number] as Affine, p);
          out[0] += weight * q[0];
          out[1] += weight * q[1];
          out[2] += weight * q[2];
        }
        mesh.setPosition(v, ...out);
      }
    }
    for (const [i, part] of resolved.value.entries()) {
      const m = deltas[i] as Affine;
      for (const f of part.faces) {
        for (const v of mesh.faceVertices(f)) {
          if (done.has(v)) continue;
          done.add(v);
          mesh.setPosition(v, ...applyPoint(m, mesh.position(v)));
        }
      }
    }
    return ok({ mesh, pose: posed.value });
  }

  /** The part's faces alone, with positions mapped by `m`. */
  /** The part's faces alone (attributes, corners, edge intent), with positions mapped by `m`. */
  partMesh(source: EditMesh, part: ResolvedPart, m: Affine): EditMesh {
    // compact() puts the extracted faces in canonical order, as for the whole session.
    const mesh = extractFaces(source, part.faces).compact().mesh;
    for (const v of mesh.vertices()) mesh.setPosition(v, ...applyPoint(m, mesh.position(v)));
    return mesh;
  }

  private skinnedMesh(resolved: Resolved, normals: NormalMode): Result<MeshAsset, ModelingError> {
    const parts = resolved.parts;
    const { mesh: compacted, faceMap, vertexMap } = this.source.editMesh.compact();
    const exported = exportMesh(compacted, { normals });
    if (!exported.ok) return exported;
    const jointOfFace = new Int32Array(compacted.faceCount).fill(-1);
    for (const part of parts) {
      for (const f of part.faces) {
        const c = faceMap[f] as number;
        if (c >= 0) jointOfFace[c] = part.joint;
      }
    }
    const asset = exported.value.mesh;
    const vertexCount = (asset.attributes.position as Float32Array).length / 3;
    const skinIndex = new Uint16Array(vertexCount * 4);
    const skinWeight = new Float32Array(vertexCount * 4);
    const indices = asset.indices as Uint16Array | Uint32Array;
    // Compacted vertex -> (weights, row) of the bindAuto region that owns it.
    const blended = new Map<number, { readonly weights: SkinWeights; readonly row: number }>();
    for (const skin of resolved.skins) {
      const weights = this.skinWeights(skin, resolved);
      if (!weights.ok) return weights;
      for (let r = 0; r < weights.value.vertices.length; r++) {
        const c = vertexMap[weights.value.vertices[r] as number] as number;
        if (c >= 0) blended.set(c, { weights: weights.value, row: r });
      }
    }
    for (let t = 0; t < exported.value.triangleFace.length; t++) {
      const joint = jointOfFace[exported.value.triangleFace[t] as number] as number;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k] as number;
        if (joint >= 0) {
          skinIndex[v * 4] = joint;
          skinWeight[v * 4] = 1;
          continue;
        }
        const corner = exported.value.vertexCorner[v] as number;
        const owner = blended.get(compacted.hVert[corner] as number);
        if (owner === undefined) continue;
        const base = owner.row * SKIN_INFLUENCES;
        skinIndex.set(owner.weights.joints.subarray(base, base + SKIN_INFLUENCES), v * 4);
        skinWeight.set(owner.weights.weights.subarray(base, base + SKIN_INFLUENCES), v * 4);
      }
    }
    return withSkin(asset, skinIndex, skinWeight);
  }

  private checkClips(options: RigFinishOptions): Result<null, ModelingError> {
    const clips = options.clips;
    if (clips === undefined) return ok(null);
    if (options.path !== undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          'either path or clips, not both',
          { clips: clips.map((c) => c.name) },
          'move the path into a clips entry',
        ),
      );
    }
    const seen = new Set<string>();
    for (const spec of clips) {
      if (typeof spec.name !== 'string' || !KEY.test(spec.name)) {
        return err(
          modelingError('model-invalid-argument', 'a lowercase source key segment as clip name', {
            name: spec.name,
          }),
        );
      }
      if (seen.has(spec.name)) {
        return err(
          modelingError(
            'model-invalid-argument',
            'unique clip names',
            { name: spec.name },
            'rename one of the clips',
          ),
        );
      }
      seen.add(spec.name);
    }
    return ok(null);
  }

  private clip(
    path: PosePath,
    duration: number,
    rate: number,
    target: (j: JointRecord) => string,
  ): Result<{ clip: AnimationClip; frames: number }, ModelingError> {
    if (!finite(duration, rate) || duration <= 0 || rate <= 0) {
      return err(
        modelingError('model-invalid-argument', 'a positive clip duration and frame rate', {
          duration,
          frameRate: rate,
        }),
      );
    }
    const frames = Math.max(2, Math.ceil(duration * rate) + 1);
    const input = new Float32Array(frames);
    const tracks = this._table.map(() => ({ t: [] as number[], r: [] as number[] }));
    for (let f = 0; f < frames; f++) {
      const u = f / (frames - 1);
      input[f] = u * duration;
      const sampled = this.sample(path, u);
      if (!sampled.ok) return sampled;
      const posed = this.pose(sampled.value);
      if (!posed.ok) return posed;
      for (const [i, joint] of this._table.entries()) {
        const value = (posed.value.joints[i] as JointPose).value;
        const local = multiply(joint.restLocal, motion(joint, value));
        const track = tracks[i] as { t: number[]; r: number[] };
        track.t.push(local[3] as number, local[7] as number, local[11] as number);
        const q = toQuaternion(local);
        const prev = track.r.length - 4;
        // Keep consecutive quaternions in one hemisphere so linear sampling takes the short arc.
        const flip =
          prev >= 0 &&
          q[0] * (track.r[prev] as number) +
            q[1] * (track.r[prev + 1] as number) +
            q[2] * (track.r[prev + 2] as number) +
            q[3] * (track.r[prev + 3] as number) <
            0;
        pushAll(track.r, flip ? q.map((c) => -c) : q);
      }
    }
    const channels: AnimationTransformChannel[] = [];
    const varies = (values: readonly number[], width: number) =>
      values.some((v, k) => Math.abs(v - (values[k % width] as number)) > 1e-9);
    for (const [i, joint] of this._table.entries()) {
      if (joint.kind === 'fixed') continue;
      const track = tracks[i] as { t: number[]; r: number[] };
      const targetId = target(joint) as AnimationTransformChannel['targetId'];
      if (varies(track.t, 3)) {
        channels.push({
          targetId,
          property: 'translation',
          sampler: { interpolation: 'LINEAR', input, output: new Float32Array(track.t) },
        });
      }
      if (varies(track.r, 4)) {
        channels.push({
          targetId,
          property: 'rotation',
          sampler: { interpolation: 'LINEAR', input, output: new Float32Array(track.r) },
        });
      }
    }
    return ok({ clip: { kind: 'animation-clip', duration, channels }, frames });
  }
}

/** `mesh` rebuilt with skin attributes (the builder owns the interleaved layout). */
function withSkin(
  mesh: MeshAsset,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
): Result<MeshAsset, ModelingError> {
  const built = createMeshBuilder({
    attributes: { ...mesh.attributes, skinIndex, skinWeight },
    indices: mesh.indices as Uint16Array | Uint32Array,
    submeshes: mesh.submeshes.map((s) => ({
      indexOffset: s.indexOffset,
      indexCount: s.indexCount,
      materialSlot: s.materialSlot,
    })),
    materialSlots: mesh.materialSlots,
  }).build();
  if (!built.ok) {
    return err(
      modelingError('model-degenerate', 'the skinned buffers form a valid MeshAsset', {
        cause: built.error.code,
      }),
    );
  }
  return ok(built.value);
}

/** A rig over `source` (see `Rig`). Spec errors poison the rig and surface at its first use. */
export function rig(source: Model, spec: RigSpec): Rig {
  return new Rig(source, spec);
}
