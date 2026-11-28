// The joint manifest of a rig: joint kinds, axes, limits, stops, mimic followers and rigid part
// bindings as one schema-validated, JSON-serialisable artifact. A game reads it with
// readRigManifest and evaluates it with poseRigManifest, which imports nothing from the Rig class,
// so the consumer copy cannot drift from the modeled mechanism. Matrices are column-major 4x4 (the
// Engine's Mat4 layout, the one scene nodes use). A joint's matrix maps its rest-frame coordinates
// into model space; a rigid part's mesh is stored in its joint's rest frame, so the part's matrix
// is its joint's matrix.
import { err, ok, type Result } from '@forgeax/engine-types';
import { type Affine, toQuaternion } from './affine';
import { cos, hypot3, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Axis, Tuple3 } from './geom';
import type { JointKind, JointRecord, JointStop, Range, RigExportForm } from './rig';
import { KEY } from './rig-kernel';

export const RIG_MANIFEST_SCHEMA = 'forgeax.rig-manifest/1' as const;

/** Unit quaternion `[x, y, z, w]`, w >= 0 (the Engine's quaternion order). */
export type RigQuat = readonly [number, number, number, number];

export interface RigTransform {
  readonly position: Tuple3;
  readonly rotation: RigQuat;
}

/** `[min, max]`: degrees for revolute joints, meters for prismatic joints. */
export type RigRange = readonly [number, number];

/** Spherical limits in degrees per axis; every axis has a range (an unlisted axis is locked at 0). */
export interface RigSphericalLimits {
  readonly x: RigRange;
  readonly y: RigRange;
  readonly z: RigRange;
}

export interface RigLeader {
  /** The leader joint's name. */
  readonly joint: string;
  readonly ratio: number;
  /** Degrees for a revolute follower, meters for a prismatic one. */
  readonly offset: number;
}

export interface RigStopEnd {
  readonly stop: string;
  readonly against?: string;
}

export interface RigManifestJoint {
  readonly name: string;
  /** `null` for the single root; a parent always precedes its children in `joints`. */
  readonly parent: string | null;
  readonly kind: JointKind;
  /** Unit axis in the joint's rest frame; revolute and prismatic joints only. */
  readonly axis?: Tuple3;
  /** Own declared limits (revolute and prismatic: range; spherical: per axis). Absent: unlimited. */
  readonly limits?: RigRange | RigSphericalLimits;
  /** A root leader with followers: the range its value may take (its limits narrowed by every follower). */
  readonly reach?: RigRange;
  readonly stops?: { readonly min?: RigStopEnd; readonly max?: RigStopEnd };
  /** A follower: its declared leader. */
  readonly mimic?: RigLeader;
  /** A follower: the same relation composed onto its root leader (the joint a pose names). */
  readonly leader?: RigLeader;
  /** True when a pose names this joint: not a follower and not fixed. */
  readonly driven: boolean;
  /** Rest transform in model space. */
  readonly rest: RigTransform;
  /** Rest transform relative to the parent's rest frame (the root: equal to `rest`). */
  readonly restLocal: RigTransform;
}

/** A rigid part (its mesh lies in its joint's rest frame) or a `bindAuto` region (skinned, no matrix). */
export type RigManifestPart =
  | {
      readonly name: string;
      readonly joint: string;
      readonly skinned: false;
      /** `mesh/<key>.<name>` once the rig is finished. */
      readonly sourceKey?: string;
    }
  | {
      readonly name: string;
      /** The joints the vertices are weighted to. */
      readonly joints: readonly string[];
      readonly skinned: true;
      /** `mesh/<key>`: the skinned mesh, shared by every skinned part. */
      readonly sourceKey?: string;
    };

export interface RigManifest {
  readonly schema: typeof RIG_MANIFEST_SCHEMA;
  /** The rig's output key once finished. */
  readonly key?: string;
  readonly units: { readonly length: 'm'; readonly angle: 'deg' };
  readonly joints: readonly RigManifestJoint[];
  readonly parts: readonly RigManifestPart[];
}

export type RigManifestIssueCode =
  | 'manifest-schema'
  | 'manifest-units'
  | 'manifest-wrong-type'
  | 'manifest-unknown-field'
  | 'manifest-joint-name'
  | 'manifest-root'
  | 'manifest-parent-order'
  | 'manifest-kind'
  | 'manifest-axis'
  | 'manifest-limits'
  | 'manifest-reach'
  | 'manifest-stops'
  | 'manifest-mimic'
  | 'manifest-leader'
  | 'manifest-driven'
  | 'manifest-transform'
  | 'manifest-part-name'
  | 'manifest-part-joint'
  | 'manifest-part-source';

/** One problem of a manifest: the closed code and the path of the offending field. */
export interface RigManifestIssue {
  readonly code: RigManifestIssueCode;
  readonly path: string;
  readonly expected: string;
}

export type RigPoseErrorCode =
  | 'pose-unknown-joint'
  | 'pose-fixed-joint'
  | 'pose-follower-driven'
  | 'pose-value-shape'
  | 'pose-out-of-range';

export const RIG_POSE_ERROR_HINTS: Readonly<Record<RigPoseErrorCode, string>> = {
  'pose-unknown-joint': 'name joints that the manifest lists in joints[].name',
  'pose-fixed-joint': 'fixed joints have no value: leave them out of the pose',
  'pose-follower-driven': 'a follower is not a coordinate: name its leader (detail.leader) instead',
  'pose-value-shape':
    'pass a finite number for a revolute or prismatic joint (meters or degrees), and [x, y, z] degrees for a spherical joint',
  'pose-out-of-range':
    'move the value inside detail.range, or pass { clamp: true } to apply the nearest limit and report it',
};

/** Expected failure of a pose: the first offending value; never a throw. */
export interface RigPoseError {
  readonly code: RigPoseErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A joint value: a number (revolute degrees, prismatic meters) or `[x, y, z]` degrees for spherical joints. */
export type RigPoseValue = number | Tuple3;

export interface RigPoseOptions {
  /** Apply the nearest limit and report it in `clamped` (default: reject out-of-range values). */
  readonly clamp?: boolean;
}

export interface RigPoseClamp {
  readonly joint: string;
  readonly axis?: Axis;
  readonly requested: number;
  readonly applied: number;
}

export interface RigPose {
  /** Column-major 4x4 model-space transform of every joint, in manifest order. */
  readonly joints: Readonly<Record<string, number[]>>;
  /** Column-major 4x4 transform of every rigid part (its joint's transform); skinned parts are absent. */
  readonly parts: Readonly<Record<string, number[]>>;
  readonly clamped: readonly RigPoseClamp[];
}

/** @internal What rig.ts hands the builder: the compiled joint table, bindings and the last finish(). */
export interface RigManifestInputs {
  readonly joints: readonly JointRecord[];
  /** Bound parts: `joints` are their joint indices (one, or every region joint). */
  readonly parts: readonly {
    readonly part: string;
    readonly joints: readonly number[];
    readonly skinned: boolean;
  }[];
  readonly loops: boolean;
  readonly finished?: { readonly key: string; readonly form: RigExportForm };
}

const TOLERANCE = 1e-6;
const RADIANS = Math.PI / 180;
const ROUND = 1e9;

/** @internal Builds the manifest of a rig. Rigs with closed loops are refused: the loop solve is not in the artifact. */
export function buildRigManifest(input: RigManifestInputs): Result<RigManifest, ModelingError> {
  if (input.loops) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a rig without closed loops has a joint manifest',
        {},
        'the manifest carries no loop solver: drop the loops, or model the loop joints as separate driven joints',
      ),
    );
  }
  const names = input.joints.map((j) => j.name);
  const nameOf = (i: number) => names[i] as string;
  const joints = input.joints.map((j): RigManifestJoint => {
    const limits = normalLimits(j);
    const stops = stopsOf(j);
    const mimic =
      j.mimic === undefined
        ? undefined
        : { joint: nameOf(j.mimic.leader), ratio: j.mimic.ratio, offset: j.mimic.offset };
    const leader =
      j.mimic === undefined
        ? undefined
        : { joint: nameOf(j.mimic.root), ratio: j.mimic.rootRatio, offset: j.mimic.rootOffset };
    return {
      name: j.name,
      parent: j.parent < 0 ? null : nameOf(j.parent),
      kind: j.kind,
      ...(j.kind === 'revolute' || j.kind === 'prismatic' ? { axis: [...j.axis] as Tuple3 } : {}),
      ...(limits === undefined ? {} : { limits }),
      ...(j.reach === undefined ? {} : { reach: [j.reach[0], j.reach[1]] as RigRange }),
      ...(stops === undefined ? {} : { stops }),
      ...(mimic === undefined ? {} : { mimic }),
      ...(leader === undefined ? {} : { leader }),
      driven: j.kind !== 'fixed' && j.mimic === undefined,
      rest: transformOf(j.restWorld),
      restLocal: transformOf(j.restLocal),
    };
  });
  const finished = input.finished;
  const parts = input.parts.map((p): RigManifestPart => {
    const skinned = p.skinned || finished?.form === 'skinned';
    if (skinned) {
      return {
        name: p.part,
        joints: p.joints.map(nameOf),
        skinned: true,
        ...(finished === undefined ? {} : { sourceKey: `mesh/${finished.key}` }),
      };
    }
    return {
      name: p.part,
      joint: nameOf(p.joints[0] as number),
      skinned: false,
      ...(finished === undefined ? {} : { sourceKey: `mesh/${finished.key}.${p.part}` }),
    };
  });
  return ok({
    schema: RIG_MANIFEST_SCHEMA,
    ...(finished === undefined ? {} : { key: finished.key }),
    units: { length: 'm', angle: 'deg' },
    joints,
    parts,
  });
}

function normalLimits(j: JointRecord): RigRange | RigSphericalLimits | undefined {
  if (j.limits === undefined) return undefined;
  if (j.kind === 'spherical') {
    const l = j.limits as Readonly<Partial<Record<Axis, Range>>>;
    return { x: l.x ?? [0, 0], y: l.y ?? [0, 0], z: l.z ?? [0, 0] };
  }
  const r = j.limits as Range;
  return [r[0], r[1]];
}

function endOf(end: JointStop | undefined): RigStopEnd | undefined {
  if (end === undefined) return undefined;
  return end.against === undefined ? { stop: end.stop } : { stop: end.stop, against: end.against };
}

function stopsOf(j: JointRecord): RigManifestJoint['stops'] {
  const min = endOf(j.stops?.min);
  const max = endOf(j.stops?.max);
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

function transformOf(m: Affine): RigTransform {
  return { position: [m[3] as number, m[7] as number, m[11] as number], rotation: toQuaternion(m) };
}

export const RIG_MANIFEST_HINT =
  'regenerate the document with rig.manifest(), or correct the fields listed in detail.issues';

export interface RigManifestError {
  readonly code: 'rig-manifest-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly issues: readonly RigManifestIssue[] };
}

type Obj = Record<string, unknown>;
/** Column-major 4x4, the Engine's Mat4 layout. */
type Mat = number[];

const TOP_FIELDS = ['schema', 'key', 'units', 'joints', 'parts'] as const;
const JOINT_FIELDS = [
  'name',
  'parent',
  'kind',
  'axis',
  'limits',
  'reach',
  'stops',
  'mimic',
  'leader',
  'driven',
  'rest',
  'restLocal',
] as const;
const PART_FIELDS = ['name', 'joint', 'joints', 'skinned', 'sourceKey'] as const;
const LINK_FIELDS = ['joint', 'ratio', 'offset'] as const;
const KINDS: readonly JointKind[] = ['fixed', 'revolute', 'prismatic', 'spherical'];
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTriple = (v: unknown): v is Tuple3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => finite(c));
const isRange = (v: unknown): v is RigRange =>
  Array.isArray(v) &&
  v.length === 2 &&
  finite(v[0]) &&
  finite(v[1]) &&
  (v[0] as number) <= (v[1] as number);
const isUnitAxis = (v: unknown): v is Tuple3 =>
  isTriple(v) && Math.abs(hypot3(v[0], v[1], v[2]) - 1) <= TOLERANCE;
const isQuat = (v: unknown): v is RigQuat => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((c) => finite(c))) return false;
  const [x = 0, y = 0, z = 0, w = 0] = v;
  return w >= 0 && Math.abs(Math.sqrt(x * x + y * y + z * z + w * w) - 1) <= TOLERANCE;
};
const isTransform = (v: unknown): v is RigTransform =>
  isObj(v) &&
  unknownKeys(v, ['position', 'rotation']).length === 0 &&
  isTriple(v.position) &&
  isQuat(v.rotation);
const isLink = (v: unknown): v is RigLeader =>
  isObj(v) &&
  unknownKeys(v, LINK_FIELDS).length === 0 &&
  typeof v.joint === 'string' &&
  finite(v.ratio) &&
  finite(v.offset);

function unknownKeys(o: Obj, allowed: readonly string[]): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

function join(at: string, key: string): string {
  return at === '' ? key : `${at}.${key}`;
}

function note(
  issues: RigManifestIssue[],
  code: RigManifestIssueCode,
  path: string,
  expected: string,
): void {
  issues.push({ code, path, expected });
}

function noteUnknown(issues: RigManifestIssue[], o: Obj, allowed: readonly string[], at: string) {
  for (const k of unknownKeys(o, allowed)) {
    note(issues, 'manifest-unknown-field', join(at, k), `no field '${k}'`);
  }
}

function rotationMatrix(q: RigQuat): Mat {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    0,
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    0,
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
    0,
    0,
    0,
    0,
    1,
  ];
}

function transformMatrix(t: RigTransform): Mat {
  const m = rotationMatrix(t.rotation);
  m[12] = t.position[0];
  m[13] = t.position[1];
  m[14] = t.position[2];
  return m;
}

/** Column-major product a * b (math order: b applied first to column vectors). */
function mul(a: readonly number[], b: readonly number[]): Mat {
  const out: Mat = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function near(a: Mat, b: Mat): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] as number)) <= TOLERANCE);
}

/** Rodrigues rotation about a unit axis, `degrees` positive counter-clockwise (Affine axisAngle). */
function rotation(axis: Tuple3, degrees: number): Mat {
  const angle = degrees * RADIANS;
  const c = cos(angle);
  const s = sin(angle);
  const t = 1 - c;
  const [x, y, z] = axis;
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** Spherical motion: Rz * Ry * Rx with per-axis degrees (matches fromAngles). */
function sphericalMatrix(angles: Tuple3): Mat {
  return mul(
    mul(rotation([0, 0, 1], angles[2]), rotation([0, 1, 0], angles[1])),
    rotation([1, 0, 0], angles[0]),
  );
}

function motionMatrix(joint: RigManifestJoint, value: number | Tuple3 | undefined): Mat {
  switch (joint.kind) {
    case 'fixed':
      return IDENTITY;
    case 'revolute':
      return rotation(joint.axis as Tuple3, (value as number | undefined) ?? 0);
    case 'prismatic': {
      const d = (value as number | undefined) ?? 0;
      const [ax, ay, az] = joint.axis as Tuple3;
      const m = [...IDENTITY];
      m[12] = ax * d;
      m[13] = ay * d;
      m[14] = az * d;
      return m;
    }
    case 'spherical':
      return sphericalMatrix((value as Tuple3 | undefined) ?? [0, 0, 0]);
  }
}

/**
 * Validates an untrusted manifest value (for example `JSON.parse` output). Every problem is
 * reported in `detail.issues`; a value is accepted only when every field and cross-reference checks.
 */
export function readRigManifest(value: unknown): Result<RigManifest, RigManifestError> {
  const issues: RigManifestIssue[] = [];
  const reject = (): Result<RigManifest, RigManifestError> =>
    err({
      code: 'rig-manifest-invalid',
      expected: `a ${RIG_MANIFEST_SCHEMA} document`,
      hint: RIG_MANIFEST_HINT,
      detail: { issues },
    });
  if (!isObj(value)) {
    note(issues, 'manifest-wrong-type', '', 'an object');
    return reject();
  }
  noteUnknown(issues, value, TOP_FIELDS, '');
  if (value.schema !== RIG_MANIFEST_SCHEMA) {
    note(issues, 'manifest-schema', 'schema', `'${RIG_MANIFEST_SCHEMA}'`);
  }
  const units = value.units;
  if (
    !isObj(units) ||
    units.length !== 'm' ||
    units.angle !== 'deg' ||
    unknownKeys(units, ['length', 'angle']).length > 0
  ) {
    note(issues, 'manifest-units', 'units', "{ length: 'm', angle: 'deg' }");
  }
  if (value.key !== undefined && (typeof value.key !== 'string' || !KEY.test(value.key))) {
    note(issues, 'manifest-wrong-type', 'key', 'a lowercase source key');
  }
  if (!Array.isArray(value.joints)) {
    note(issues, 'manifest-wrong-type', 'joints', 'an array');
    return reject();
  }
  const names = readJointNames(value.joints, issues);
  readJoints(value.joints, names, issues);
  if (!Array.isArray(value.parts)) {
    note(issues, 'manifest-wrong-type', 'parts', 'an array');
  } else {
    readParts(value.parts, names, value.key, issues);
  }
  if (issues.length > 0) return reject();
  return ok(value as unknown as RigManifest);
}

/** First pass: the name table in declaration order (a parent must already be listed). */
function readJointNames(raw: readonly unknown[], issues: RigManifestIssue[]): Map<string, number> {
  const names = new Map<string, number>();
  raw.forEach((j, i) => {
    if (!isObj(j)) return;
    const name = j.name;
    if (typeof name !== 'string' || !KEY.test(name) || names.has(name)) {
      note(issues, 'manifest-joint-name', `joints[${i}].name`, 'a unique lowercase joint name');
    } else {
      names.set(name, i);
    }
  });
  return names;
}

function readJoints(
  raw: readonly unknown[],
  names: Map<string, number>,
  issues: RigManifestIssue[],
) {
  if (raw.length === 0) note(issues, 'manifest-root', 'joints', 'a root joint');
  const rests: (Mat | undefined)[] = [];
  const locals: (Mat | undefined)[] = [];
  raw.forEach((j, i) => {
    const at = `joints[${i}]`;
    if (!isObj(j)) {
      note(issues, 'manifest-wrong-type', at, 'an object');
      rests.push(undefined);
      locals.push(undefined);
      return;
    }
    readJointFields(j, i, at, names, issues);
    rests.push(isTransform(j.rest) ? transformMatrix(j.rest) : undefined);
    locals.push(isTransform(j.restLocal) ? transformMatrix(j.restLocal) : undefined);
  });
  raw.forEach((j, i) => {
    if (isObj(j)) readJointLinks(j, i, `joints[${i}]`, raw, names, issues);
    const rest = rests[i];
    const local = locals[i];
    if (!isObj(j) || rest === undefined || local === undefined) return;
    const parent = typeof j.parent === 'string' ? names.get(j.parent) : undefined;
    const parentRest = parent === undefined ? undefined : rests[parent];
    const expected =
      j.parent === null ? local : parentRest === undefined ? undefined : mul(parentRest, local);
    if (expected !== undefined && !near(rest, expected)) {
      note(issues, 'manifest-transform', `joints[${i}].rest`, 'parent.rest * restLocal');
    }
  });
}

function readJointFields(
  j: Obj,
  i: number,
  at: string,
  names: Map<string, number>,
  issues: RigManifestIssue[],
): void {
  noteUnknown(issues, j, JOINT_FIELDS, at);
  if (i === 0) {
    if (j.parent !== null) note(issues, 'manifest-root', join(at, 'parent'), 'null for the root');
  } else if (j.parent === null) {
    note(issues, 'manifest-root', join(at, 'parent'), 'the name of an earlier joint');
  } else if (typeof j.parent !== 'string' || (names.get(j.parent) ?? i) >= i) {
    note(issues, 'manifest-parent-order', join(at, 'parent'), 'the name of an earlier joint');
  }
  const kind = j.kind;
  if (!KINDS.includes(kind as JointKind)) {
    note(issues, 'manifest-kind', join(at, 'kind'), KINDS.join(' | '));
  }
  const movable = kind === 'revolute' || kind === 'prismatic';
  if (movable ? !isUnitAxis(j.axis) : j.axis !== undefined) {
    note(
      issues,
      'manifest-axis',
      join(at, 'axis'),
      movable ? 'a unit axis [x, y, z]' : 'no axis for this joint kind',
    );
  }
  readJointLimits(j, at, kind, movable, issues);
  if (j.stops !== undefined) readStops(j.stops, movable, join(at, 'stops'), issues);
  if ((j.mimic === undefined) !== (j.leader === undefined)) {
    note(issues, 'manifest-mimic', at, 'mimic and leader present together');
  }
  if (j.mimic !== undefined && (!movable || !isLink(j.mimic))) {
    note(
      issues,
      'manifest-mimic',
      join(at, 'mimic'),
      '{ joint, ratio, offset } on a movable joint',
    );
  }
  if (j.leader !== undefined && !isLink(j.leader)) {
    note(issues, 'manifest-leader', join(at, 'leader'), '{ joint, ratio, offset }');
  }
  if (j.driven !== (kind !== 'fixed' && j.mimic === undefined)) {
    note(issues, 'manifest-driven', join(at, 'driven'), 'true unless fixed or a mimic follower');
  }
  if (!isTransform(j.rest)) note(issues, 'manifest-transform', join(at, 'rest'), 'a transform');
  if (!isTransform(j.restLocal)) {
    note(issues, 'manifest-transform', join(at, 'restLocal'), 'a transform');
  }
}

function readJointLimits(
  j: Obj,
  at: string,
  kind: unknown,
  movable: boolean,
  issues: RigManifestIssue[],
): void {
  const limits = j.limits;
  if (kind === 'spherical') {
    const ok3 =
      limits === undefined ||
      (isObj(limits) &&
        unknownKeys(limits, ['x', 'y', 'z']).length === 0 &&
        isRange(limits.x) &&
        isRange(limits.y) &&
        isRange(limits.z));
    if (!ok3) note(issues, 'manifest-limits', join(at, 'limits'), '{ x, y, z } ranges in degrees');
  } else if (movable) {
    if (limits !== undefined && !isRange(limits)) {
      note(issues, 'manifest-limits', join(at, 'limits'), '[min, max] with min <= max');
    }
  } else if (limits !== undefined) {
    note(issues, 'manifest-limits', join(at, 'limits'), 'no limits for a fixed joint');
  }
  const reach = j.reach;
  if (reach === undefined) return;
  const within =
    !isRange(limits) || (isRange(reach) && reach[0] >= limits[0] && reach[1] <= limits[1]);
  if (!movable || !isRange(reach) || !within) {
    note(issues, 'manifest-reach', join(at, 'reach'), 'a range inside limits, on a movable joint');
  }
}

function readStops(stops: unknown, movable: boolean, at: string, issues: RigManifestIssue[]): void {
  const end = (e: unknown) =>
    isObj(e) &&
    unknownKeys(e, ['stop', 'against']).length === 0 &&
    typeof e.stop === 'string' &&
    e.stop.length > 0 &&
    (e.against === undefined || typeof e.against === 'string');
  const ok2 =
    movable &&
    isObj(stops) &&
    unknownKeys(stops, ['min', 'max']).length === 0 &&
    (stops.min !== undefined || stops.max !== undefined) &&
    (stops.min === undefined || end(stops.min)) &&
    (stops.max === undefined || end(stops.max));
  if (!ok2) note(issues, 'manifest-stops', at, '{ min?, max? } on a movable joint');
}

function readJointLinks(
  j: Obj,
  i: number,
  at: string,
  raw: readonly unknown[],
  names: Map<string, number>,
  issues: RigManifestIssue[],
): void {
  if (isLink(j.mimic)) {
    const target = names.get(j.mimic.joint);
    if (target === undefined || target === i) {
      note(issues, 'manifest-mimic', join(at, 'mimic.joint'), 'another existing joint');
    }
  }
  if (!isLink(j.leader)) return;
  const target = names.get(j.leader.joint);
  const leaderJoint = target === undefined ? undefined : raw[target];
  const driven =
    isObj(leaderJoint) && leaderJoint.kind !== 'fixed' && leaderJoint.mimic === undefined;
  if (!driven) {
    note(issues, 'manifest-leader', join(at, 'leader.joint'), 'a driven joint, not a follower');
  }
}

function readParts(
  raw: readonly unknown[],
  names: Map<string, number>,
  key: unknown,
  issues: RigManifestIssue[],
): void {
  const seen = new Set<string>();
  raw.forEach((p, i) => {
    const at = `parts[${i}]`;
    if (!isObj(p)) {
      note(issues, 'manifest-wrong-type', at, 'an object');
      return;
    }
    noteUnknown(issues, p, PART_FIELDS, at);
    if (typeof p.name !== 'string' || p.name.length === 0 || seen.has(p.name)) {
      note(issues, 'manifest-part-name', join(at, 'name'), 'a unique non-empty part name');
    } else {
      seen.add(p.name);
    }
    if (typeof p.skinned !== 'boolean') {
      note(issues, 'manifest-wrong-type', join(at, 'skinned'), 'true or false');
      return;
    }
    const jointOk = (n: unknown) => typeof n === 'string' && names.has(n);
    if (p.skinned) {
      const list = p.joints;
      const good = Array.isArray(list) && list.length > 0 && list.every(jointOk);
      if (p.joint !== undefined || !good) {
        note(
          issues,
          'manifest-part-joint',
          join(at, 'joints'),
          'existing joint names, no joint field',
        );
      }
    } else if (p.joints !== undefined || !jointOk(p.joint)) {
      note(issues, 'manifest-part-joint', join(at, 'joint'), 'an existing joint, no joints field');
    }
    const want =
      typeof key !== 'string'
        ? undefined
        : p.skinned
          ? `mesh/${key}`
          : `mesh/${key}.${String(p.name)}`;
    if (want === undefined ? p.sourceKey !== undefined : p.sourceKey !== want) {
      note(
        issues,
        'manifest-part-source',
        join(at, 'sourceKey'),
        want === undefined ? 'no sourceKey before finish' : `'${want}'`,
      );
    }
  });
}

/** Canonical JSON: sorted keys, numbers rounded to 1e-9, a trailing newline. Same rig, same bytes. */
export function rigManifestJson(manifest: RigManifest): string {
  const canonical = (v: unknown): unknown => {
    if (typeof v === 'number') {
      const r = Math.round(v * ROUND) / ROUND;
      return r === 0 ? 0 : r;
    }
    if (Array.isArray(v)) return v.map(canonical);
    if (isObj(v)) {
      const out: Obj = {};
      for (const k of Object.keys(v).sort()) {
        if (v[k] !== undefined) out[k] = canonical(v[k]);
      }
      return out;
    }
    return v;
  };
  return `${JSON.stringify(canonical(manifest), null, 2)}\n`;
}

function poseFail(
  code: RigPoseErrorCode,
  expected: string,
  detail: Readonly<Record<string, unknown>>,
): Result<never, RigPoseError> {
  return err({ code, expected, hint: RIG_POSE_ERROR_HINTS[code], detail });
}

type Settled = { readonly applied: number } | { readonly range: RigRange };

/** Inside the range, or the nearest bound when clamping; otherwise the range that was passed. */
function settle(requested: number, range: RigRange | undefined, clamp: boolean): Settled {
  if (range === undefined || (requested >= range[0] && requested <= range[1])) {
    return { applied: requested };
  }
  if (!clamp) return { range };
  return { applied: Math.min(range[1], Math.max(range[0], requested)) };
}

/**
 * Poses a manifest in model space, without the Rig class. Joints not named rest at zero; a follower
 * takes its root leader's value through the composed relation. Parts are reported with their joint's
 * matrix (their meshes are stored in the joint's rest frame). Values are checked against the same
 * limits as Rig.pose: out-of-range values are rejected unless `clamp` is set.
 */
export function poseRigManifest(
  manifest: RigManifest,
  values: Readonly<Record<string, RigPoseValue>>,
  options: RigPoseOptions = {},
): Result<RigPose, RigPoseError> {
  const index = new Map(manifest.joints.map((j, i) => [j.name, i] as const));
  const given: (RigPoseValue | undefined)[] = manifest.joints.map(() => undefined);
  const clamped: RigPoseClamp[] = [];
  for (const [name, value] of Object.entries(values)) {
    const i = index.get(name);
    if (i === undefined) {
      return poseFail('pose-unknown-joint', 'a joint named in joints[].name', { joint: name });
    }
    const joint = manifest.joints[i] as RigManifestJoint;
    if (joint.kind === 'fixed') {
      return poseFail('pose-fixed-joint', 'no value for a fixed joint', { joint: name });
    }
    if (joint.mimic !== undefined) {
      return poseFail('pose-follower-driven', 'a driven joint, not a mimic follower', {
        joint: name,
        leader: joint.mimic.joint,
      });
    }
    const settled = settleJoint(name, joint, value, options.clamp === true, clamped);
    if (!settled.ok) return settled;
    given[i] = settled.value;
  }
  for (const [i, joint] of manifest.joints.entries()) {
    const link = joint.leader;
    if (joint.mimic === undefined || link === undefined) continue;
    const root = index.get(link.joint) as number;
    const rootValue = (given[root] as number | undefined) ?? 0;
    given[i] = link.ratio * rootValue + link.offset;
  }
  const world: Mat[] = [];
  for (const [i, joint] of manifest.joints.entries()) {
    const local = mul(transformMatrix(joint.restLocal), motionMatrix(joint, given[i]));
    world.push(
      joint.parent === null ? local : mul(world[index.get(joint.parent) as number] as Mat, local),
    );
  }
  const joints: Record<string, number[]> = {};
  manifest.joints.forEach((j, i) => {
    joints[j.name] = [...(world[i] as Mat)];
  });
  const parts: Record<string, number[]> = {};
  for (const p of manifest.parts) {
    if (!p.skinned) parts[p.name] = [...(joints[p.joint] as number[])];
  }
  return ok({ joints, parts, clamped });
}

/** Checks one named value against its joint's shape and range; the clamped value or the error. */
function settleJoint(
  name: string,
  joint: RigManifestJoint,
  value: RigPoseValue,
  clamp: boolean,
  clamped: RigPoseClamp[],
): Result<RigPoseValue, RigPoseError> {
  if (joint.kind === 'spherical') {
    if (!isTriple(value)) {
      return poseFail('pose-value-shape', '[x, y, z] degrees', { joint: name });
    }
    const limits = joint.limits as RigSphericalLimits | undefined;
    const out: [number, number, number] = [value[0], value[1], value[2]];
    for (const [k, axis] of (['x', 'y', 'z'] as const).entries()) {
      const requested = out[k] as number;
      const settled = settle(requested, limits?.[axis], clamp);
      if ('range' in settled) {
        return poseFail('pose-out-of-range', 'an angle inside the axis range', {
          joint: name,
          axis,
          requested,
          range: settled.range,
        });
      }
      if (settled.applied !== requested) {
        clamped.push({ joint: name, axis, requested, applied: settled.applied });
      }
      out[k] = settled.applied;
    }
    return ok(out);
  }
  if (!finite(value)) {
    return poseFail('pose-value-shape', 'a finite number', { joint: name });
  }
  const settled = settle(value, (joint.reach ?? joint.limits) as RigRange | undefined, clamp);
  if ('range' in settled) {
    return poseFail('pose-out-of-range', 'a value inside the joint range', {
      joint: name,
      requested: value,
      range: settled.range,
    });
  }
  if (settled.applied !== value) {
    clamped.push({ joint: name, requested: value, applied: settled.applied });
  }
  return ok(settled.applied);
}
