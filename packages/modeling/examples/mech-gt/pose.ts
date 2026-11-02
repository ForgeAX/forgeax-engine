import { fit, fitRigid, type JointTable, MECH } from './proportions.ts';
import transform from './transform.json' with { type: 'json' };

/**
 * Case C-100 stage S4 (paper design): typed access to `transform.json` and forward
 * kinematics of the `joints.json` skeleton, so the car-form pose can be checked
 * against the joint limits and the car envelope before any geometry exists. S7 reuses
 * the same kinematics for the transformation animation.
 */
type Tuple3 = readonly [number, number, number];
type Rows3 = readonly [Tuple3, Tuple3, Tuple3];
export type Angles = Readonly<Partial<Record<'x' | 'y' | 'z', number>>>;

export interface Piece {
  readonly id: string;
  readonly part: string;
  readonly car: { readonly role: string };
  readonly mech: { readonly joint: string; readonly role: string };
}
export interface Mechanism {
  readonly id: string;
  readonly kind: 'hinge' | 'slide';
  /** Pieces or unsplit parts the mechanism carries. */
  readonly moves: readonly string[];
  /** Piece or unsplit part the mechanism is mounted on. */
  readonly base: string;
  readonly anchor: Tuple3;
  readonly axis: Tuple3;
  /** Degrees for a hinge, meters for a slide. */
  readonly range: readonly [number, number];
  readonly phase: string;
  readonly hardware: readonly string[];
}
export interface JointHardware {
  readonly joint: string;
  readonly kind: 'revolute' | 'universal' | 'spherical';
  readonly hardware: readonly { readonly recipe: string; readonly count: number }[];
}
export interface Phase {
  readonly name: string;
  readonly u: readonly [number, number];
  /** Joints that move from the car pose to the mech pose in this phase. */
  readonly joints: readonly string[];
  /** The phase that turns the root from the car-form root to upright. */
  readonly root: boolean;
  readonly note: string;
}
/** A bone that slides shut in car form: `joint` sits `length` meters closer to its parent along the bone. */
export interface Telescope {
  readonly joint: string;
  readonly length: number;
  readonly phase: string;
}
export interface TransformTable {
  readonly schema: string;
  readonly carRoot: { readonly position: Tuple3; readonly rotation: Angles };
  readonly carPose: Readonly<Record<string, Angles>>;
  /** Joint angles the mech form ends in (absent: the `joints.json` rest angle, 0). */
  readonly mechPose: Readonly<Record<string, Angles>>;
  readonly telescopes: readonly Telescope[];
  readonly pieces: readonly Piece[];
  readonly mechanisms: readonly Mechanism[];
  readonly jointHardware: readonly JointHardware[];
  readonly phases: readonly Phase[];
}

const AUTHORED = transform as unknown as TransformTable;

/**
 * Nominal car-form ankle station. The stowed mech is rigid, and its tightest fit is the feet
 * between the rear wheels and the tail; it moves with that station of the rear overhang, so a
 * longer wheelbase neither pushes the feet out of the tail nor into the wheels.
 */
const STOWED_FEET_Z = -2.19;

/**
 * `transform.json` on the current car: its car-form positions (root, mechanism anchors) are
 * authored against the nominal S1 car and placed through `fit`. Read anchors here, never
 * from the JSON.
 */
export const TRANSFORM: TransformTable = {
  ...AUTHORED,
  carRoot: { ...AUTHORED.carRoot, position: fitRigid(AUTHORED.carRoot.position, STOWED_FEET_Z) },
  mechanisms: AUTHORED.mechanisms.map((m) => ({ ...m, anchor: fit(m.anchor) })),
};

/** The mechanical recipes the B4 library provides (design: gear, piston, bearing, bolt, spring, hinge, slide rail). */
export const RECIPES = ['gear', 'piston', 'bearing', 'bolt', 'spring', 'hinge', 'slide-rail'] as const;

function multiply(a: Rows3, b: Rows3): Rows3 {
  const row = (r: Tuple3): Tuple3 => [0, 1, 2].map((j) => r[0] * (b[0][j] as number) + r[1] * (b[1][j] as number) + r[2] * (b[2][j] as number)) as unknown as Tuple3;
  return [row(a[0]), row(a[1]), row(a[2])];
}

function apply(m: Rows3, v: Tuple3): Tuple3 {
  return [0, 1, 2].map((i) => {
    const r = m[i] as Tuple3;
    return r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  }) as unknown as Tuple3;
}

function axisRotation(axis: 'x' | 'y' | 'z', degrees: number): Rows3 {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === 'x') return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 'y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

/** Local joint rotation: about x first, then y, then z (Rz * Ry * Rx), in parent space. */
export function rotation(angles: Angles = {}): Rows3 {
  return multiply(multiply(axisRotation('z', angles.z ?? 0), axisRotation('y', angles.y ?? 0)), axisRotation('x', angles.x ?? 0));
}

/** A joint frame: model-space position and rotation. */
export interface Frame {
  readonly position: Tuple3;
  /** Rotation as Euler angles in degrees, `Rz * Ry * Rx` (the `rotation()` and rig convention). */
  readonly rotation: Angles;
}

/** Euler angles of a rotation matrix in the `Rz * Ry * Rx` convention. */
function eulerOf(m: Rows3): Angles {
  const deg = (r: number) => (r * 180) / Math.PI;
  const y = Math.asin(Math.max(-1, Math.min(1, -m[2][0])));
  return { x: deg(Math.atan2(m[2][1], m[2][2])), y: deg(y), z: deg(Math.atan2(m[1][0], m[0][0])) };
}

/**
 * World joint frames of a pose. The root sits at `root.position` turned by
 * `root.rotation`; every other joint keeps its rest offset from its parent, turned by
 * the accumulated rotations of its ancestors (a joint's own rotation moves its children).
 */
export function forwardFrames(
  pose: Readonly<Record<string, Angles>>,
  root: { readonly position: Tuple3; readonly rotation: Angles },
  table: JointTable = MECH,
): Map<string, Frame> {
  const world = new Map<string, { readonly p: Tuple3; readonly r: Rows3 }>();
  const rest = new Map(table.joints.map((j) => [j.name, j.position]));
  for (const j of table.joints) {
    const local = rotation(pose[j.name]);
    if (j.parent === null) {
      world.set(j.name, { p: root.position, r: multiply(rotation(root.rotation), local) });
      continue;
    }
    const parent = world.get(j.parent);
    const from = rest.get(j.parent);
    if (parent === undefined || from === undefined) throw new Error(`joint ${j.name}: parent ${j.parent} must precede it`);
    const offset = apply(parent.r, [0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number)) as unknown as Tuple3);
    world.set(j.name, { p: [0, 1, 2].map((k) => (parent.p[k] as number) + (offset[k] as number)) as unknown as Tuple3, r: multiply(parent.r, local) });
  }
  return new Map([...world].map(([name, { p, r }]) => [name, { position: p, rotation: eulerOf(r) }]));
}

/** World joint positions of a pose (see `forwardFrames`). */
export function forwardKinematics(
  pose: Readonly<Record<string, Angles>>,
  root: { readonly position: Tuple3; readonly rotation: Angles },
  table: JointTable = MECH,
): Map<string, Tuple3> {
  return new Map([...forwardFrames(pose, root, table)].map(([name, f]) => [name, f.position]));
}

/** Joint frames of the car form, in s1-car coordinates: the rest pose of the S4 rig. */
/** The skeleton with every telescope shut: each telescoped joint and its subtree moved toward its parent along the bone. */
export function carTable(table: JointTable = MECH): JointTable {
  const shift = new Map<string, Tuple3>();
  const at = new Map(table.joints.map((j) => [j.name, j.position]));
  for (const j of table.joints) {
    const base = j.parent === null ? ([0, 0, 0] as Tuple3) : (shift.get(j.parent) ?? [0, 0, 0]);
    const t = TRANSFORM.telescopes.find((x) => x.joint === j.name);
    if (t === undefined || j.parent === null) {
      shift.set(j.name, base);
      continue;
    }
    const from = at.get(j.parent) as Tuple3;
    const d = [0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number));
    const l = Math.hypot(...d);
    shift.set(j.name, [0, 1, 2].map((k) => (base[k] as number) - ((d[k] as number) / l) * t.length) as unknown as Tuple3);
  }
  return { ...table, joints: table.joints.map((j) => ({ ...j, position: [0, 1, 2].map((k) => (j.position[k] as number) + ((shift.get(j.name) as Tuple3)[k] as number)) as unknown as Tuple3 })) };
}

export function carFormFrames(): Map<string, Frame> {
  return forwardFrames(TRANSFORM.carPose, TRANSFORM.carRoot, carTable());
}

/** Joint positions of the car form, in s1-car coordinates. */
export function carFormJoints(): Map<string, Tuple3> {
  return forwardKinematics(TRANSFORM.carPose, TRANSFORM.carRoot, carTable());
}
