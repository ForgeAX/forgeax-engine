import { type DesignedContact, type JointSpec, type Model, model, recipes, sel } from '@forgeax/engine-modeling';
import parts from './parts.json' with { type: 'json' };
import { type Mechanism, TRANSFORM } from './pose.ts';
import { CAR } from './proportions.ts';
import { buildS3Car, type PanelForm } from './s3-rough.ts';
import { s6bMechSource } from './s6b-robot.ts';
import type { RigExtension } from './s4-transform.ts';
import { buildS5Internals } from './s5-chassis.ts';
import { buildS5JointsStowed } from './s5-joints.ts';
import { across, add, angleAbout, cross, direction, leverOf, orient, parentOf, place, placeBelow, scale, sizeCylinder, sub, swingLengths, tableAt, turnAbout, unit, type V3 } from './s7-drives.ts';

/**
 * Case C-100 stage S7 (code name mech-gt): the single assembly that transforms. One session
 * holds the S3 panels and stowed mech volumes, the S5 internals and stowed joint mechanisms
 * (tagged with their part ids), and a real mechanism on the body for every `transform.json`
 * mechanism: recipe hinges and slide rails with the bearings and springs they list. Drives
 * (cylinders for every listed piston, gear pairs) are specified here and sized by
 * `s7-motion.ts` over the actual path.
 */

/** A rig joint: a joint-table or rig joint name, or one end of a `transform.json` mechanism (known once the S4 table exists). */
export type JointRef = string | { readonly mechanism: string; readonly end: 'carrier' | 'link' } | { readonly parentOf: string };

export interface PartSpec {
  readonly tag: string;
  readonly joint: JointRef;
  readonly part: string;
}

export interface CylinderSpec {
  readonly name: string;
  readonly carrier: JointRef;
  readonly driven: JointRef;
  /** Pins in the rest pose: base on the carrier, eye on the driven link. */
  readonly base: V3;
  readonly eye: V3;
  /** Direction the pin bores run along (the main turning axis). */
  readonly pinAxis: V3;
  /** Extra range a joint that holds still on this path is sized for: the eye turns about `axis` through `pivot`. */
  readonly sweep?: { readonly pivot: V3; readonly axis: V3; readonly range: readonly [number, number] };
}

export interface GearSpec {
  readonly name: string;
  readonly carrier: JointRef;
  readonly driven: JointRef;
  readonly axis: V3;
  readonly center: V3;
  readonly toward: V3;
  /** Bound of the driven turn in degrees. */
  readonly travel: number;
}

export interface RackSpec {
  readonly name: string;
  readonly carrier: JointRef;
  readonly driven: JointRef;
  /** Pitch-line point under the pinion at rest, the slide direction and the side the teeth face. */
  readonly start: V3;
  readonly axis: V3;
  readonly up: V3;
  readonly travel: number;
}

export interface Assembly {
  readonly model: Model;
  /** Parts the S4 rig binds by `parts.json` / S4 piece id. */
  readonly units: readonly string[];
  /** Joint mechanisms and mechanism hardware with the joints they ride. */
  readonly parts: readonly PartSpec[];
  readonly cylinders: readonly CylinderSpec[];
  readonly gears: readonly GearSpec[];
  readonly racks: readonly RackSpec[];
  readonly contacts: readonly DesignedContact[];
  /** Hardware and the parts it may be fastened to; a fastening only counts on one rigid joint. */
  readonly mounts: readonly (readonly [string, string])[];
  /** The mech source's own rig extension. */
  readonly mech?: (joints: readonly JointSpec[]) => RigExtension;
}

/** Joint pistons, left side in the joint table (mirrored for the right): pins of each cylinder. */
interface JointCylinders {
  readonly joint: string;
  /** Turning axis in the joint table (pin bores run along it; sweeps turn about it). */
  readonly axis: V3;
  /** Base pin on the parent segment and eye pin on the child segment: offsets from the joint in the table frame at angle 0 (left side). */
  readonly pins: readonly (readonly [V3, V3])[];
  /** Range a joint that holds still on this path is sized for (degrees about `axis`). */
  readonly sweep?: readonly [number, number];
  readonly sides: boolean;
}

/**
 * One cylinder per piston of the S4 hardware table. The pins come from `s7-place.ts`: the
 * largest length change that fits a cylinder and clears every other part along the path.
 */
export const JOINT_CYLINDERS: readonly JointCylinders[] = [
  { joint: 'spine', axis: [1, 0, 0], sides: false, sweep: [-20, 30], pins: [[[0, -0.3, 0.16], [0, 0.35, 0.14]], [[0.15, -0.3, 0.16], [0.15, 0.35, 0.14]], [[-0.15, -0.3, 0.16], [-0.15, 0.35, 0.14]]] },
  { joint: 'chest', axis: [1, 0, 0], sides: false, sweep: [-15, 25], pins: [[[0.08, -0.2, -0.16], [0.08, 0.35, -0.14]], [[-0.08, -0.2, -0.16], [-0.08, 0.35, -0.14]]] },
  { joint: 'shoulder', axis: [0, 0, 1], sides: true, pins: [[[-0.388, -0.337, -0.15], [0.113, -0.337, -0.15]], [[-0.318, -0.255, 0.08], [-0.085, -0.367, 0.08]]] },
  { joint: 'elbow', axis: [1, 0, 0], sides: true, pins: [[[-0.08, 0.506, 0.141], [-0.08, -0.343, 0.155]]] },
  { joint: 'hip', axis: [1, 0, 0], sides: true, sweep: [-30, 20], pins: [[[0.22, 0.2, -0.16], [0.22, -0.145, 0.107]], [[0.08, 0.5, -0.16], [0.08, -0.157, -0.132]]] },
  { joint: 'knee', axis: [1, 0, 0], sides: true, sweep: [0, 30], pins: [[[0.08, 0.491, -0.185], [0.08, -0.343, -0.157]], [[0.22, 0.491, -0.185], [0.22, -0.343, -0.157]]] },
  { joint: 'ankle', axis: [1, 0, 0], sides: true, pins: [[[-0.08, 0.496, 0.104], [-0.08, -0.015, 0.364]]] },
];

/** Gear drives: a wheel on the joint's child segment around its axis, `offset` m along it, its pinion `toward` (table frame). */
export const JOINT_GEARS: readonly { readonly joint: string; readonly axis: V3; readonly offset: number; readonly toward: V3; readonly travel: number }[] = [
  { joint: 'wrist-l', axis: [0, 0, 1], offset: -0.35, toward: [0, 1, 0], travel: 30 },
  { joint: 'wrist-r', axis: [0, 0, 1], offset: -0.16, toward: [0, 1, 0], travel: 30 },
  { joint: 'neck', axis: [1, 0, 0], offset: 0.23, toward: [0, 1, 0], travel: 40 },
  { joint: 'head', axis: [0, 1, 0], offset: 0.12, toward: [0, 0, -1], travel: 45 },
];

/**
 * Telescope cylinders stand on the outer side of the bone, stage 1 `offset` off it and stage 2
 * at the same distance behind it (left side, table frame); the stage-1 base pin stands `base` m
 * from the parent, the eye pins 0.15 m from the shut joint end. Inboard, the V12 and its rails
 * sit beside the shut thighs.
 */
const TELESCOPE_CYLINDERS: Readonly<Record<string, { readonly offset: V3; readonly base: number }>> = {
  knee: { offset: [0.17, 0, 0.05], base: 0.2 },
  ankle: { offset: [0.1, 0, 0.08], base: 0.15 },
};
const TELESCOPE_EYE = 0.15;
/** Base of the stage-2 cylinder on stage 1, back from the shut joint end. */
const TELESCOPE_STAGE = 0.5;

const mirror = (p: V3, side: string): V3 => (side === 'r' ? [-p[0], p[1], p[2]] : p);

/**
 * Where a mechanism's hardware sits, from `s7-place.ts`: a hinge may slide `along` its pin
 * line and a rail may move to any parallel line (`offset`), neither changing the motion;
 * `pins` are the cylinder's base and eye in the car form.
 */
export interface Placement {
  readonly along?: number;
  readonly offset?: V3;
  readonly pins?: readonly [V3, V3];
}
export const MECHANISM_PLACEMENT: Readonly<Record<string, Placement>> = {
  'door-l-pop': { offset: [-0.16, 0.18, 0], pins: [[0.525, 0.73, 0.1], [0.74, 0.73, 0.1]] },
  'door-r-pop': { offset: [0.16, 0.18, 0], pins: [[-0.525, 0.73, 0.1], [-0.74, 0.73, 0.1]] },
  'front-halfshaft-l-release': { offset: [0, 0.04, 0.18] },
  'front-halfshaft-r-release': { offset: [0, 0.04, -0.18] },
  'front-wheel-l-swing': { along: -0.3 },
  'front-wheel-r-swing': { along: -0.3 },
  'front-motor-l-shift': { offset: [-0.07, -0.04, -0.04] },
  'front-motor-r-shift': { offset: [0.07, -0.04, -0.04] },
  'head-lift': { offset: [0, -0.18, -0.15], pins: [[0, 0.47, 1.535], [0, 0.47, 1.85]] },
  'toe-l-pop': { offset: [0, 0, 0.4] },
  'toe-r-pop': { offset: [0, 0, 0.4] },
  'toe-l-set': { offset: [0.026, 0.352, 0.013] },
  'toe-r-set': { offset: [-0.026, 0.352, 0.013] },
  'door-l-hinge': { along: -0.2, pins: [[0.55, 0.741, 1.121], [0.55, 0.79, 0.812]] },
  'door-r-hinge': { along: -0.2, pins: [[-0.55, 0.741, 1.121], [-0.55, 0.79, 0.812]] },
  // The engine-cover hinges stand at the tail end of their pins, outside the pelvis flip's sweep;
  // a lever cylinder there would meet the lifted diffuser.
  'engine-cover-l-hinge': { along: -0.8 },
  'engine-cover-r-hinge': { along: -0.8 },
  'front-fender-l-pop': { offset: [-0.1, 0.18, 0], pins: [[0.455, 0.68, 1.721], [0.75, 0.68, 1.721]] },
  'front-fender-r-pop': { offset: [0.1, 0.18, 0], pins: [[-0.455, 0.68, 1.721], [-0.75, 0.68, 1.721]] },
  'leg-l-split': { offset: [0.15, 0, 0] },
  'leg-r-split': { offset: [-0.15, 0, 0] },
  'pelvis-lift': { offset: [0, 0, -0.25] },
  'engine-cover-l-stow-1': { offset: [0.039, 0.176, 0.4] },
  'engine-cover-l-stow': { offset: [0.009, 0.039, -0.18] },
  'engine-cover-r-stow-1': { offset: [-0.039, 0.176, 0.4] },
  'engine-cover-r-stow': { offset: [-0.009, 0.039, -0.18] },
  'pelvis-flip': { along: 0.6 },
  'v12-flip': { along: 0.2 },
  'pelvis-raise': { offset: [-0.18, 0.4, 0.05] },
  'front-fender-l-unfold': { pins: [[0.967, 0.8, 2.143], [1.001, 0.8, 1.806]] },
  'front-fender-r-unfold': { pins: [[-0.967, 0.8, 2.143], [-1.001, 0.8, 1.806]] },
  'chest-l-open': { offset: [0, -0.05, 0.25] },
  'chest-r-open': { offset: [0, -0.05, 0.25] },
};

/**
 * Penetration accepted where mechanism hardware is fastened to a panel that rides the same
 * rigid joint (a leaf or rail seated on the sheet-form skin). Hardware that moves against a
 * panel gets no allowance.
 */
export const MOUNT_TOLERANCE = 0.01;
/** Penetration accepted between the two halves of one hinge (pin in its bores). */
const PIN_TOLERANCE = 0.003;

/** Hardware sizes of the body mechanisms. */
const HINGE = { length: 0.12, leafWidth: 0.03, thickness: 0.004, pin: 0.01, knuckles: 3, holes: 0, segments: 16 };
const RAIL = { width: 0.02, carriage: 0.04 };
/** Mechanism hardware stands this far along the hinge axis beside the hinge (piston, gear, bearing, spring). */
const BESIDE = 0.13;

/** Center of a part's faces in the car form. */
function centerOf(m: Model, part: string): V3 {
  const b = m.bounds(sel.tag(`part:${part}`));
  if (!b.ok) throw b.error;
  return scale(add(b.value.min, b.value.max), 0.5);
}

/** Shortest pin distance at which a cylinder covers `travel` meters of slide. */
function slideLength(travel: number): number {
  for (let d = 0.05; d < 2; d += 0.005) if (sizeCylinder(d, d + travel) !== undefined) return d;
  throw new Error(`no cylinder covers a ${travel} m slide`);
}

/**
 * The hardware of one `transform.json` mechanism at its anchor on the body. Hinges are butt
 * hinges along the axis (leaf A on the carrier, leaf B moving); slides are profiled rails
 * along the axis (rail on the carrier, carriage moving). `piston` adds a cylinder (a lever
 * cylinder beside a hinge, a cylinder along a rail), `gear` a wheel and pinion on the hinge
 * axis (a rack and pinion beside a rail), `bearing` a ball bearing on the pin, `spring` a torsion or return spring.
 */
export function bodyMechanism(g: Model, source: Model, mech: Mechanism, out: { parts: PartSpec[]; cylinders: CylinderSpec[]; gears: GearSpec[]; racks: RackSpec[]; contacts: DesignedContact[] }, placement: Placement = MECHANISM_PLACEMENT[mech.id] ?? {}): void {
  const id = mech.id;
  const axis = unit(mech.axis);
  // The hardware's own origin: on the pin line for hinges, on a parallel line for rails.
  // Positions along a hinge pin mirror with the anchors: a right-side hinge axis is the
  // mirrored rotation axis, so offsets along its pin use the reversed axis.
  const pin = id.includes('-r-') && mech.kind === 'hinge' ? scale(axis, -1) : axis;
  const anchor = add(add(mech.anchor, scale(pin, placement.along ?? 0)), placement.offset ?? [0, 0, 0]);
  const tags = source.inspect().tags;
  const moved = mech.moves.find((p) => tags.includes(`part:${p}`)) as string;
  // Taken from the declared anchor, as the placement search does: a placement moves the hardware, not its orientation.
  const moving = across(sub(centerOf(source, moved), mech.anchor), axis);
  const side = cross(axis, moving);
  const has = (h: string) => mech.hardware.includes(h);
  const carrier: JointRef = { mechanism: id, end: 'carrier' };
  const link: JointRef = { mechanism: id, end: 'link' };
  const travel: [number, number] = [Math.min(0, mech.range[0]), Math.max(0, mech.range[1])];
  if (mech.kind === 'hinge') {
    const name = `hinge-${id}`;
    // Leaf B lies toward the moving part; leaf A points away from leaf B's mid-travel
    // direction, so the leaves stay apart over the whole swing.
    const leafA = scale(across(turnAbout(moving, [0, 0, 0], axis, (travel[0] + travel[1]) / 2), pin), -1);
    const open = (angleAbout(leafA, moving, pin) + 360) % 360;
    const h = recipes.hinge({ ...HINGE, openAngle: open, name });
    if (!h.ok) throw h.error;
    g.append(h.value.model, { tag: name });
    g.translate(sel.tag(name), scale(add(h.value.anchors.axisTop as V3, h.value.anchors.axisBottom as V3), -0.5) as [number, number, number]);
    // Leaf A along +X on the carrier side, leaf B turned by the open angle about the pin.
    orient(g, sel.tag(name), pin, cross(leafA, pin), anchor);
    g.tag(sel.tag(name).minus(sel.tag(`${name}-b`)), `s7:${name}-a`);
    g.tag(sel.tag(`${name}-b`), `s7:${name}-b`);
    out.parts.push({ tag: `s7:${name}-a`, joint: carrier, part: `${name}-a` }, { tag: `s7:${name}-b`, joint: link, part: `${name}-b` });
    // The two halves of a hinge turn on one pin: knuckles and pin keep only running clearance.
    out.contacts.push({ parts: [`${name}-a`, `${name}-b`], tolerance: PIN_TOLERANCE });
    if (has('piston') && placement.pins !== undefined) out.cylinders.push({ name: `cyl-${id}`, carrier, driven: link, base: placement.pins[0], eye: placement.pins[1], pinAxis: axis });
    else if (has('piston')) {
      // Lever pins beside the hinge: the base behind the pin on the carrier side, the eye out on the moving side.
      let best: { base: V3; eye: V3; lever: number } | undefined;
      for (const a of [0.08, 0.12, 0.16, 0.2]) {
        for (const sb of [0.06, -0.06, 0.1, -0.1]) {
          for (const b of [0.12, 0.16, 0.2, 0.25]) {
            for (const sr of [0.05, -0.05, 0.08, -0.08]) {
              const base = add(add(add(anchor, scale(moving, -a)), scale(side, sb)), scale(pin, BESIDE));
              const eye = add(add(add(anchor, scale(moving, b)), scale(side, sr)), scale(pin, BESIDE));
              const lengths = swingLengths(base, eye, anchor, axis, travel);
              const monotonic = lengths.every((d, i) => i === 0 || d >= (lengths[i - 1] as number)) || lengths.every((d, i) => i === 0 || d <= (lengths[i - 1] as number));
              if (!monotonic || sizeCylinder(Math.min(...lengths), Math.max(...lengths)) === undefined) continue;
              const lever = leverOf(base, eye, anchor, axis, travel);
              if (best === undefined || lever > best.lever + 1e-9) best = { base, eye, lever };
            }
          }
        }
      }
      if (best === undefined) throw new Error(`${id}: no lever cylinder fits`);
      out.cylinders.push({ name: `cyl-${id}`, carrier, driven: link, base: best.base, eye: best.eye, pinAxis: axis });
    }
    if (has('gear')) out.gears.push({ name: id, carrier, driven: link, axis, center: add(anchor, scale(pin, -BESIDE)), toward: scale(moving, -1), travel: travel[1] - travel[0] });
    if (has('bearing')) {
      const b = recipes.ballBearing({ bore: 0.03, outer: 0.07, width: 0.02, segments: 24, balls: 6, name: `bearing-${id}` });
      if (!b.ok) throw b.error;
      g.append(b.value.model, { tag: `s7:bearing-${id}` });
      orient(g, sel.tag(`s7:bearing-${id}`), axis, cross(moving, axis), add(anchor, scale(pin, -BESIDE - 0.06)));
      out.parts.push({ tag: `s7:bearing-${id}`, joint: carrier, part: `bearing-${id}` });
    }
    if (has('spring')) {
      const s = recipes.coilSpring({ radius: 0.025, wire: 0.004, pitch: 0.012, turns: 5, segments: 8, wireSegments: 6, name: `spring-${id}` });
      if (!s.ok) throw s.error;
      g.append(s.value.model, { tag: `s7:spring-${id}` });
      // A torsion spring around the pin, beside the hinge on the far side from the pin head.
      orient(g, sel.tag(`s7:spring-${id}`), axis, cross(moving, axis), add(anchor, scale(pin, -(HINGE.length / 2 + 0.1))));
      out.parts.push({ tag: `s7:spring-${id}`, joint: carrier, part: `spring-${id}` });
    }
    return;
  }
  const name = `rail-${id}`;
  const span = RAIL.carriage + 2 * (0.06 * RAIL.width + 0.004 * RAIL.width);
  const r = recipes.slideRail({ length: travel[1] - travel[0] + span + 0.02, width: RAIL.width, carriage: RAIL.carriage, position: 0, holePitch: RAIL.width * 10, name });
  if (!r.ok) throw r.error;
  g.append(r.value.model, { tag: name });
  const up = Math.abs(axis[1]) > 0.9 ? across([1, 0, 0], axis) : across([0, 1, 0], axis);
  // Local Z runs along the rail; the carriage starts at the anchor.
  g.translate(sel.tag(name), [0, -RAIL.width * 0.45, -(r.value.dimensions.carriageCenter as number)]);
  orient(g, sel.tag(name), up, axis, anchor);
  const carriage = sel.createdBy(`${name}-carriage`).or(sel.createdBy(`${name}-seal-a`)).or(sel.createdBy(`${name}-seal-b`));
  g.tag(sel.tag(name).minus(carriage), `s7:${name}`);
  g.tag(sel.tag(name).and(carriage), `s7:carriage-${id}`);
  out.parts.push({ tag: `s7:${name}`, joint: carrier, part: name }, { tag: `s7:carriage-${id}`, joint: link, part: `carriage-${id}` });
  if (has('piston') && placement.pins !== undefined) out.cylinders.push({ name: `cyl-${id}`, carrier, driven: link, base: placement.pins[0], eye: placement.pins[1], pinAxis: across(side, axis) });
  else if (has('piston')) {
    // Along the rail, above it: the base pin behind the carriage, the eye on the moving link.
    const base = add(add(anchor, scale(up, 0.05)), scale(axis, -slideLength(travel[1] - travel[0])));
    out.cylinders.push({ name: `cyl-${id}`, carrier, driven: link, base, eye: add(anchor, scale(up, 0.05)), pinAxis: across(side, axis) });
  }
  // A geared slide: a rack beside the rail, its pinion on the carriage side.
  if (has('gear')) out.racks.push({ name: id, carrier, driven: link, start: add(anchor, scale(side, 0.06)), axis, up: scale(up, -1), travel: travel[1] - travel[0] });
  if (has('spring')) {
    const s = recipes.coilSpring({ radius: 0.018, wire: 0.003, pitch: 0.01, turns: 4, segments: 8, wireSegments: 6, name: `spring-${id}` });
    if (!s.ok) throw s.error;
    g.append(s.value.model, { tag: `s7:spring-${id}` });
    // A return spring behind the carriage, along the rail.
    orient(g, sel.tag(`s7:spring-${id}`), axis, up, add(add(anchor, scale(up, -0.04)), scale(axis, -0.05)));
    out.parts.push({ tag: `s7:spring-${id}`, joint: carrier, part: `spring-${id}` });
  }
}

/**
 * The mech form an assembly stows: its volumes tagged with their part ids (`buildS3Mech`
 * contract) and the rig extension for its sub-parts (finger joints, armor layers). The
 * default is the S6b robot form (`s6b-robot.ts`); `{ build: () => buildS3Mech() }` gives the S3 blocks.
 */
export interface MechSource {
  readonly build: () => Model;
  readonly extension?: (joints: readonly JointSpec[]) => RigExtension;
}

/**
 * The car-form box hardware must stay inside: the bounds of the body panels
 * (parts.json `body` parts and their S4 pieces), raised to the ground clearance so nothing
 * shows under the floor.
 */
export function skinBox(m: Model): { readonly min: V3; readonly max: V3 } {
  const body = new Set(parts.parts.filter((p) => p.system === 'body').map((p) => p.id));
  const ids = [...body, ...TRANSFORM.pieces.filter((p) => body.has(p.part)).map((p) => p.id)];
  const tags = new Set(m.inspect().tags);
  const faces = ids.filter((id) => tags.has(`part:${id}`)).map((id) => sel.tag(`part:${id}`)).reduce((x, y) => x.or(y));
  const b = m.bounds(faces);
  if (!b.ok) throw b.error;
  return { min: [b.value.min[0], Math.max(b.value.min[1], CAR.groundClearance.value), b.value.min[2]], max: b.value.max };
}

export function buildAssembly(form: PanelForm = 'closed', mech: MechSource = s6bMechSource()): Assembly {
  const m = model();
  m.append(buildS3Car(() => model(), form).snapshot());
  m.append(mech.build().snapshot());
  m.checkpoint('s3');
  // The S3 session carries uv1 (lightmap channel) on every face, so appended parts need it too.
  const internals = buildS5Internals();
  internals.uv.project({ mode: 'box', scale: 0.5, channel: 'uv1' });
  m.append(internals.snapshot());
  m.checkpoint('internals');
  // S5's static actuators beside the bones are replaced by the linked cylinders of S7.
  const stowed = buildS5JointsStowed();
  const actuators = stowed.inspect().tags.filter((t) => /^part:hw-.*-actuator$/.test(t));
  if (actuators.length > 0) stowed.delete(actuators.map((t) => sel.tag(t)).reduce((a, b) => a.or(b)));
  stowed.uv.project({ mode: 'box', scale: 0.25, channel: 'uv1' });
  m.append(stowed.snapshot());
  m.checkpoint('joint-mechanisms');

  const parts: PartSpec[] = [];
  const cylinders: CylinderSpec[] = [];
  const gears: GearSpec[] = [];
  const racks: RackSpec[] = [];
  for (const t of m.inspect().tags.filter((x) => /^part:hw-.*-mechanism$/.test(x))) {
    const joint = t.slice('part:hw-'.length, -'-mechanism'.length);
    parts.push({ tag: t, joint, part: t.slice('part:'.length) });
  }
  for (const spec of JOINT_CYLINDERS) {
    for (const side of spec.sides ? ['l', 'r'] : ['']) {
      const joint = side === '' ? spec.joint : `${spec.joint}-${side}`;
      const axis = unit(direction(joint, mirror(spec.axis, side === 'r' && spec.axis[0] === 0 ? 'r' : 'l')));
      spec.pins.forEach(([base, eye], k) => {
        cylinders.push({
          name: `cyl-${joint}${spec.pins.length > 1 ? `-${k + 1}` : ''}`,
          // The rig parent: a telescope when the bone telescopes, so the pins span the joint only.
          carrier: { parentOf: joint },
          driven: joint,
          base: placeBelow(joint, add(tableAt(joint), mirror(base, side))),
          eye: place(joint, add(tableAt(joint), mirror(eye, side))),
          pinAxis: axis,
          ...(spec.sweep === undefined ? {} : { sweep: { pivot: place(joint, tableAt(joint)), axis, range: spec.sweep } }),
        });
      });
    }
  }
  // Each telescope stage slides on its own cylinder along the bone: stage 1 from the parent
  // bone, stage 2 from stage 1. Points are placed on the shut bone.
  for (const t of TRANSFORM.telescopes) {
    const side = t.joint.endsWith('-r') ? 'r' : 'l';
    const spec = TELESCOPE_CYLINDERS[t.joint.slice(0, -2)] as { offset: V3; base: number };
    const parent = parentOf(t.joint);
    const from = tableAt(parent);
    const to = tableAt(t.joint);
    const along = unit(sub(to, from));
    const front = mirror(spec.offset, side);
    const back = mirror([spec.offset[0], spec.offset[1], -spec.offset[2]], side);
    // A point `k` m from the shut joint end back along the bone, `off` from it.
    const shut = (k: number, off: V3) => place(parent, add(add(to, scale(along, -(t.length + k))), off));
    const pinAxis = unit(direction(parent, [1, 0, 0]));
    cylinders.push(
      { name: `cyl-${t.joint}-telescope-1`, carrier: parent, driven: `${t.joint}-telescope-1`, base: place(parent, add(add(from, scale(along, spec.base)), front)), eye: shut(TELESCOPE_EYE, front), pinAxis },
      { name: `cyl-${t.joint}-telescope`, carrier: `${t.joint}-telescope-1`, driven: `${t.joint}-telescope`, base: shut(TELESCOPE_STAGE, back), eye: shut(TELESCOPE_EYE / 3, back), pinAxis },
    );
  }
  for (const gspec of JOINT_GEARS) {
    const axis = unit(direction(gspec.joint, gspec.axis));
    gears.push({ name: gspec.joint, carrier: parentOf(gspec.joint), driven: gspec.joint, axis, center: place(gspec.joint, add(tableAt(gspec.joint), scale(gspec.axis, gspec.offset))), toward: direction(parentOf(gspec.joint), gspec.toward), travel: gspec.travel });
  }

  // Mechanism hardware is built in its own session: every operation on the large assembly
  // costs a pass over all of it. A mechanism whose moved parts are not modeled (S3 has no
  // rear wing) has no joint to hang on.
  const g = model();
  const tags = new Set(m.inspect().tags);
  const contacts: DesignedContact[] = [];
  const mounts: [string, string][] = [];
  for (const mech of TRANSFORM.mechanisms) {
    if (!mech.moves.some((p) => tags.has(`part:${p}`))) continue;
    const from = { parts: parts.length, cylinders: cylinders.length, gears: gears.length, racks: racks.length };
    bodyMechanism(g, m, mech, { parts, cylinders, gears, racks, contacts });
    // Mechanism hardware may be fastened to the parts it moves and to its base part.
    const hardware = [
      ...parts.slice(from.parts).map((p) => p.part),
      ...cylinders.slice(from.cylinders).flatMap((c) => [`${c.name}-barrel`, `${c.name}-rod`]),
      ...gears.slice(from.gears).flatMap((x) => [`gear-${x.name}`, `pinion-${x.name}`]),
      ...racks.slice(from.racks).flatMap((x) => [`rack-${x.name}`, `pinion-${x.name}`]),
    ];
    for (const h of hardware) for (const p of [...mech.moves, mech.base]) if (tags.has(`part:${p}`)) mounts.push([h, p]);
  }
  g.uv.project({ mode: 'box', scale: 0.25 });
  g.uv.project({ mode: 'box', scale: 0.25, channel: 'uv1' });
  m.append(g.snapshot());
  m.checkpoint('mechanisms');

  const units = m.inspect().tags.filter((t) => t.startsWith('part:') && !t.startsWith('part:hw-')).map((t) => t.slice(5));
  return { model: m, units, parts, cylinders, gears, racks, contacts, mounts, ...(mech.extension === undefined ? {} : { mech: mech.extension }) };
}

/** The rig joint a reference names, given the S4 joint table. */
export function resolveJoint(table: readonly JointSpec[], ref: JointRef): string {
  if (typeof ref === 'string') return ref;
  if ('parentOf' in ref) {
    const parent = table.find((j) => j.name === ref.parentOf)?.parent;
    if (parent === undefined || parent === null) throw new Error(`${ref.parentOf}: no parent joint`);
    return parent;
  }
  const link = table.find((j) => j.name.startsWith(`${ref.mechanism}-on-`));
  if (link === undefined || link.parent === null) throw new Error(`${ref.mechanism}: no mechanism joint`);
  return ref.end === 'link' ? link.name : link.parent;
}
