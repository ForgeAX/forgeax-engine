import { type Angles, type JointSpec, type Model, recipes, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { carFormFrames, rotation } from './pose.ts';
import { MECH } from './proportions.ts';

/**
 * Case C-100 stage S7 (code name mech-gt): drives, in car-form model space (the rig rest
 * pose). A hydraulic cylinder is two rig joints, a barrel on a spherical joint at its base
 * pin (riding the carrier) and a rod on a prismatic joint along it; a gear pair is a wheel
 * on the driven link around the joint axis and a pinion on a revolute joint of the carrier.
 * Their values follow from the posed carrier and driven links (`cylinderValues`,
 * `gearTurn`), so a drive works for any motion between them: hinges, slides, multi-axis
 * joints and telescopes alike.
 */
type Rows3 = readonly (readonly number[])[];
/** Inputs accept read-only points (the design tables); results are kernel `Tuple3`. */
export type V3 = readonly [number, number, number];
/** A rig joint transform: row-major 3x4 (rotation rows with the translation in column 3). */
export type Affine = readonly number[];
/** A joint's transform at rest and now. */
export interface Moved {
  readonly rest: Affine;
  readonly now: Affine;
}

export const add = (a: V3, b: V3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): Tuple3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3) => scale(a, 1 / norm(a));
/** The component of `v` across the unit `axis`, normalized. */
export const across = (v: V3, axis: V3) => unit(sub(v, scale(axis, dot(v, axis))));
const apply = (r: Rows3, v: V3): Tuple3 => [0, 1, 2].map((i) => (r[i]?.[0] as number) * v[0] + (r[i]?.[1] as number) * v[1] + (r[i]?.[2] as number) * v[2]) as unknown as Tuple3;
const deg = (r: number) => (r * 180) / Math.PI;

/** Rotate `p` about the line through `pivot` along the unit `axis` by `degrees` (right hand). */
export function turnAbout(p: V3, pivot: V3, axis: V3, degrees: number): Tuple3 {
  const v = sub(p, pivot);
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(pivot, add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c))));
}

/** Signed angle in degrees from `a` to `b` about `axis`, both taken across it. */
export function angleAbout(a: V3, b: V3, axis: V3): number {
  const x = across(a, axis);
  const y = across(b, axis);
  return deg(Math.atan2(dot(cross(x, y), axis), dot(x, y)));
}

/** Euler angles (`Rz * Ry * Rx`, degrees) of a rotation matrix given by rows. */
export function eulerOf(m: Rows3): { x: number; y: number; z: number } {
  const r = (i: number, j: number) => m[i]?.[j] as number;
  const sy = Math.max(-1, Math.min(1, -r(2, 0)));
  if (Math.abs(sy) > 1 - 1e-12) return { x: deg(Math.atan2(-r(1, 2), r(1, 1))), y: deg(Math.asin(sy)), z: 0 };
  return { x: deg(Math.atan2(r(2, 1), r(2, 2))), y: deg(Math.asin(sy)), z: deg(Math.atan2(r(1, 0), r(0, 0))) };
}

/** The smallest rotation taking unit `a` onto unit `b`, as rows. */
function minimalRotation(a: V3, b: V3): Rows3 {
  const v = cross(a, b);
  const c = dot(a, b);
  const k = 1 / (1 + c);
  return [
    [c + v[0] * v[0] * k, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1]],
    [v[1] * v[0] * k + v[2], c + v[1] * v[1] * k, v[1] * v[2] * k - v[0]],
    [v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], c + v[2] * v[2] * k],
  ];
}

/** Orient faces built along local axes: +Y onto `y`, +Z onto `z` (+X completes), origin onto `origin`. */
export function orient(m: Model, faces: ReturnType<typeof sel.all>, y: V3, z: V3, origin: V3): void {
  const x = cross(y, z);
  const e = eulerOf([[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]]);
  for (const axis of ['x', 'y', 'z'] as const) if (e[axis] !== 0) m.rotate(faces, axis, e[axis]);
  m.translate(faces, [...origin]);
}

const TABLE = new Map(MECH.joints.map((j) => [j.name, j]));
const FRAMES = carFormFrames();
export const tableAt = (name: string): Tuple3 => [...(TABLE.get(name)?.position as V3)];
export const parentOf = (name: string) => TABLE.get(name)?.parent as string;

/** Map a joint-table point that rides `joint` (table angles 0) into the car form. */
export function place(joint: string, p: V3): Tuple3 {
  const f = FRAMES.get(joint);
  if (f === undefined) throw new Error(joint);
  return add(f.position, apply(rotation(f.rotation), sub(p, tableAt(joint))));
}

/** A joint-table direction seen in `joint`'s car-form frame. */
export function direction(joint: string, v: V3): Tuple3 {
  const f = FRAMES.get(joint);
  if (f === undefined) throw new Error(joint);
  return apply(rotation(f.rotation), v);
}

const rows = (w: Affine): Rows3 => [
  [w[0] as number, w[1] as number, w[2] as number],
  [w[4] as number, w[5] as number, w[6] as number],
  [w[8] as number, w[9] as number, w[10] as number],
];
const transpose = (r: Rows3): Rows3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => r[j]?.[i] as number));

/** Where a rest-pose point riding a joint is when the joint has moved. */
export function carry(j: Moved, p: V3): Tuple3 {
  const local = apply(transpose(rows(j.rest)), [p[0] - (j.rest[3] as number), p[1] - (j.rest[7] as number), p[2] - (j.rest[11] as number)]);
  return add(apply(rows(j.now), local), [j.now[3] as number, j.now[7] as number, j.now[11] as number]);
}

/** A rest-pose direction riding a joint, turned with it. */
function carryDirection(j: Moved, v: V3): Tuple3 {
  return apply(rows(j.now), apply(transpose(rows(j.rest)), v));
}

/** A direction seen from the moved frame of a joint, in rest-pose terms (the inverse of `carryDirection`). */
function backDirection(j: Moved, v: V3): Tuple3 {
  return apply(rows(j.rest), apply(transpose(rows(j.now)), v));
}

export interface CylinderLink {
  readonly name: string;
  /** The joint the base pin and the barrel's joint ride. */
  readonly carrier: string;
  /** The joint the eye pin rides. */
  readonly driven: string;
  readonly barrel: string;
  readonly rod: string;
  /** Pins in the rest pose. */
  readonly base: V3;
  readonly eye: V3;
  readonly bore: number;
  readonly stroke: number;
}

/** Pin distance of a cylinder between a moved carrier and driven link. */
export function pinDistance(base: V3, eye: V3, carrier: Moved, driven: Moved): number {
  return norm(sub(carry(driven, eye), carry(carrier, base)));
}

/** Barrel angles and rod travel that close a cylinder between a moved carrier and driven link. */
export function cylinderValues(c: Pick<CylinderLink, 'base' | 'eye'>, carrier: Moved, driven: Moved): { barrel: Angles; rod: number } {
  const line0 = sub(c.eye, c.base);
  const line = sub(carry(driven, c.eye), carry(carrier, c.base));
  return { barrel: eulerOf(minimalRotation(unit(line0), unit(backDirection(carrier, line)))), rod: norm(line) - norm(line0) };
}

/** Clearance of a cylinder's pins to its closed and extended lengths (m). */
const MARGIN = 0.008;
const BORES = [0.05, 0.045, 0.04, 0.035, 0.03, 0.025, 0.02, 0.016] as const;

/** Pin-to-pin length of a cylinder less its stroke: closed it is this plus the stroke, extended plus two strokes. */
const FIXED = new Map<number, number>();
function fixedLength(bore: number): number {
  let k = FIXED.get(bore);
  if (k === undefined) {
    const r = recipes.hydraulicCylinder({ bore, rod: bore * 0.55, stroke: bore * 2, extension: 0, name: 'probe' });
    if (!r.ok) throw r.error;
    k = (r.value.dimensions.pinToPin as number) - bore * 2;
    FIXED.set(bore, k);
  }
  return k;
}

/** The largest bore whose closed and extended lengths bracket pin distances in [dMin, dMax]. */
export function sizeCylinder(dMin: number, dMax: number): { bore: number; stroke: number } | undefined {
  for (const bore of BORES) {
    const stroke = dMin - MARGIN - fixedLength(bore);
    if (fixedLength(bore) + 2 * stroke >= dMax + MARGIN && stroke >= bore && stroke <= 20 * bore) return { bore, stroke };
  }
  return undefined;
}

/** Pin distances while the eye turns about a fixed line (hinge pin search, static sweeps). */
export function swingLengths(base: V3, eye: V3, pivot: V3, axis: V3, range: readonly [number, number]): number[] {
  return Array.from({ length: 65 }, (_, k) => norm(sub(turnAbout(eye, pivot, axis, range[0] + ((range[1] - range[0]) * k) / 64), base)));
}

/** Smallest distance of the turning line from the cylinder over a swing: its lever arm. */
export function leverOf(base: V3, eye: V3, pivot: V3, axis: V3, range: readonly [number, number]): number {
  let best = Infinity;
  for (let k = 0; k <= 32; k++) {
    const e = turnAbout(eye, pivot, axis, range[0] + ((range[1] - range[0]) * k) / 32);
    const line = unit(sub(e, base));
    const off = sub(pivot, base);
    best = Math.min(best, norm(sub(off, scale(line, dot(off, line)))));
  }
  return best;
}

export interface CylinderSpan {
  readonly dMin: number;
  readonly dMax: number;
  readonly angles: Readonly<Record<'x' | 'y' | 'z', readonly [number, number]>>;
}

/** The cylinder geometry and its two joints, sized for `span`; the pins lie across `pinAxis`. */
export function cylinder(m: Model, name: string, carrier: string, driven: string, base: V3, eye: V3, pinAxis: V3, span: CylinderSpan): { link: CylinderLink; joints: JointSpec[] } {
  const size = sizeCylinder(span.dMin, span.dMax);
  if (size === undefined) throw new Error(`${name}: no cylinder fits pins ${span.dMin.toFixed(3)}..${span.dMax.toFixed(3)} m apart`);
  const d0 = norm(sub(eye, base));
  const closed = fixedLength(size.bore) + size.stroke;
  const c = recipes.hydraulicCylinder({ bore: size.bore, rod: size.bore * 0.55, stroke: size.stroke, extension: (d0 - closed) / size.stroke, segments: 16, name });
  if (!c.ok) throw c.error;
  m.append(c.value.model, { tag: name });
  m.translate(sel.tag(name), scale(c.value.anchors.baseEye as V3, -1) as [number, number, number]);
  const y = unit(sub(eye, base));
  orient(m, sel.tag(name), y, across(pinAxis, y), base);
  m.tag(sel.tag(name).and(sel.createdBy(`${name}-barrel`).or(sel.createdBy(`${name}-eye`))), `s7:${name}-barrel`);
  m.tag(sel.tag(name).and(sel.createdBy(`${name}-rod`).or(sel.createdBy(`${name}-rod-eye`))), `s7:${name}-rod`);
  const rod = `${name}-rod`;
  const pad = ([lo, hi]: readonly [number, number]): [number, number] => [lo - 1, hi + 1];
  return {
    link: { name, carrier, driven, barrel: name, rod, base, eye, bore: size.bore, stroke: size.stroke },
    joints: [
      { name, parent: carrier, position: [...base], kind: 'spherical', limits: { x: pad(span.angles.x), y: pad(span.angles.y), z: pad(span.angles.z) } },
      { name: rod, parent: name, position: [...base], kind: 'prismatic', axis: y, limits: [span.dMin - d0 - 1e-3, span.dMax - d0 + 1e-3] },
    ],
  };
}

export interface GearLink {
  readonly name: string;
  readonly carrier: string;
  readonly driven: string;
  readonly pinion: string;
  /** The wheel axis in the rest pose. */
  readonly axis: V3;
  /** Pinion degrees per degree the driven link turns about the axis relative to the carrier. */
  readonly ratio: number;
}

/** Degrees the driven link has turned about the gear axis relative to the carrier. */
export function gearTurn(g: Pick<GearLink, 'axis'>, carrier: Moved, driven: Moved): number {
  const probe = across(Math.abs(g.axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], g.axis);
  return angleAbout(probe, backDirection(carrier, carryDirection(driven, probe)), g.axis);
}

const GEAR = { module: 0.0025, wheel: 30, pinion: 12, width: 0.02, backlash: 0.0015 };

/**
 * A gear pair: the wheel rides `driven` around `axis` at `center`, the pinion rides
 * `carrier` beside it toward `toward` (across the axis). Built with a wheel tooth facing a
 * pinion gap; `travel` bounds the driven turn in degrees.
 */
export function gearPair(m: Model, name: string, carrier: string, driven: string, axis: V3, center: V3, toward: V3, travel: number): { link: GearLink; joints: JointSpec[] } {
  const a = unit(axis);
  const dir = across(toward, a);
  const part = (teeth: number, label: string) => {
    const g = recipes.gear({ module: GEAR.module, teeth, width: GEAR.width, bore: 0.012, chamfer: 0, flankSegments: 2, name: label });
    if (!g.ok) throw g.error;
    return g.value;
  };
  const wheel = part(GEAR.wheel, `gear-${name}`);
  const pinion = part(GEAR.pinion, `pinion-${name}`);
  const distance = (wheel.dimensions.pitchRadius as number) + (pinion.dimensions.pitchRadius as number) + GEAR.backlash;
  m.append(wheel.model, { tag: `s7:gear-${name}` });
  orient(m, sel.tag(`s7:gear-${name}`), cross(a, dir), a, center);
  m.append(pinion.model, { tag: `s7:pinion-${name}` });
  m.rotate(sel.tag(`s7:pinion-${name}`), 'z', 180 - 180 / GEAR.pinion);
  const at = add(center, scale(dir, distance));
  orient(m, sel.tag(`s7:pinion-${name}`), cross(a, dir), a, at);
  const ratio = -GEAR.wheel / GEAR.pinion;
  const turns = Math.abs(travel * ratio) + 1;
  return {
    link: { name, carrier, driven, pinion: `pinion-${name}`, axis: a, ratio },
    joints: [{ name: `pinion-${name}`, parent: carrier, position: at, kind: 'revolute', axis: a, limits: [-turns, turns] }],
  };
}

/** Barrel angles of a cylinder whose carrier stays at rest while the eye pin moves to `eyeNow`. */
export function restBarrel(base: V3, eye: V3, eyeNow: V3): { barrel: { x: number; y: number; z: number }; length: number } {
  return { barrel: eulerOf(minimalRotation(unit(sub(eye, base)), unit(sub(eyeNow, base)))), length: norm(sub(eyeNow, base)) };
}

/**
 * Map a joint-table point on the parent segment near `joint` into the car form: it rides the
 * joint's rig parent there (a telescope keeps the parent's turn but sits at the joint).
 */
export function placeBelow(joint: string, p: V3): Tuple3 {
  const f = FRAMES.get(joint);
  const up = FRAMES.get(parentOf(joint));
  if (f === undefined || up === undefined) throw new Error(joint);
  return add(f.position, apply(rotation(up.rotation), sub(p, tableAt(joint))));
}

export interface RackLink {
  readonly name: string;
  /** The joint the rack rides. */
  readonly carrier: string;
  /** The sliding joint the pinion's joint rides. */
  readonly driven: string;
  readonly pinion: string;
  /** Pinion center and slide direction in the rest pose. */
  readonly center: V3;
  readonly axis: V3;
  readonly pitchRadius: number;
}

/** Pinion degrees that roll it along the rack by the driven link's slide relative to the carrier. */
export function rackTurn(k: Pick<RackLink, 'center' | 'axis' | 'pitchRadius'>, carrier: Moved, driven: Moved): number {
  const slide = dot(backDirection(carrier, sub(carry(driven, k.center), carry(carrier, k.center))), k.axis);
  return deg(-slide / k.pitchRadius);
}

const RACK = { module: 0.004, pinion: 18, width: 0.02 };

/**
 * A rack and pinion for a slide: the rack rides `carrier` along `axis` with its teeth toward
 * `up`, the pinion rides `driven` on a revolute joint and rolls along it over `travel`
 * meters. At rest the pinion sits over a tooth gap at `start`.
 */
export function rackPinion(m: Model, name: string, carrier: string, driven: string, start: V3, axis: V3, up: V3, travel: number): { link: RackLink; joints: JointSpec[] } {
  const x = unit(axis);
  const y = across(up, x);
  const z = cross(x, y);
  const pinion = recipes.gear({ module: RACK.module, teeth: RACK.pinion, width: RACK.width, bore: 0.008, chamfer: 0, flankSegments: 2, name: `pinion-${name}` });
  if (!pinion.ok) throw pinion.error;
  const r = pinion.value.dimensions.pitchRadius as number;
  const pitch = Math.PI * RACK.module;
  const teeth = Math.ceil((Math.abs(travel) + 4 * pitch) / pitch) + 2;
  const rack = recipes.rack({ module: RACK.module, teeth, width: RACK.width, chamfer: 0, name: `rack-${name}` });
  if (!rack.ok) throw rack.error;
  // Rack frame: +X along the slide, +Y toward the pinion; the pinion starts over the gap after tooth 1.
  const gap = 1.5 * pitch;
  const center = add(start, scale(y, r));
  m.append(rack.value.model, { tag: `s7:rack-${name}` });
  m.translate(sel.tag(`s7:rack-${name}`), [-gap, 0, 0]);
  orient(m, sel.tag(`s7:rack-${name}`), y, z, start);
  m.append(pinion.value.model, { tag: `s7:pinion-${name}` });
  m.rotate(sel.tag(`s7:pinion-${name}`), 'z', -90);
  orient(m, sel.tag(`s7:pinion-${name}`), y, z, center);
  const turn = (Math.abs(travel) / r) * (180 / Math.PI) + 1;
  return {
    link: { name, carrier, driven, pinion: `pinion-${name}`, center, axis: x, pitchRadius: r },
    joints: [{ name: `pinion-${name}`, parent: driven, position: center, kind: 'revolute', axis: z, limits: [-turn, turn] }],
  };
}
