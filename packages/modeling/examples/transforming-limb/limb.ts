import {
  type DesignedContact,
  type FaceSelector,
  type JointSpec,
  type Model,
  model,
  type Point2,
  type PosePath,
  type RecipePart,
  type Rig,
  recipes,
  rig,
  sel,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-107 (a C-100 part): the front-left corner of the car that becomes the robot's
 * left arm. Car form (u = 0, the rest pose): the fender covers the wheel, the arm lies
 * folded under the body (upper arm forward, forearm doubled back under it) and the
 * wheel hangs from a swing arm on the forearm. The transformation lifts the fender on a
 * hinge, swings the wheel up against the forearm, turns the shoulder down, unfolds the
 * elbow, telescopes the hand out on a slide rail driven by a hydraulic cylinder, opens
 * the claw and lowers the fender onto the shoulder as a pauldron.
 * Axes: Y up, the car nose +Z, outboard +X; the shoulder axis is X through the origin.
 */
export interface LimbParameters {
  /** Hand telescope travel in meters (the cylinder stroke). */
  readonly stroke: number;
  /** Wheel swing in degrees at the end of the path (negative swings the wheel up). */
  readonly wheelSwing: number;
  /**
   * Where the upper-arm beam ends along Z (meters). The first design ran it to 0.45,
   * over the elbow; the path scan confirmed the forearm web hitting it from u = 0.78.
   */
  readonly beamEnd: number;
}

export const LIMB_DEFAULTS: LimbParameters = { stroke: 0.1, wheelSwing: -35, beamEnd: 0.37 };

const WHEEL: readonly [number, number, number] = [0.2, -0.32, 0.22];
const ELBOW: readonly [number, number, number] = [0, -0.1, 0.42];
const SWING: readonly [number, number, number] = [0.2, -0.2, 0.05];
const HINGE: readonly [number, number, number] = [0.075, 0.1, 0.2];

function unwrap(part: ReturnType<typeof recipes.hinge>): RecipePart {
  if (!part.ok) throw part.error;
  return part.value;
}

function circle(center: Point2, radius: number, n = 24): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as Point2;
  });
}

/** Points on an arc around `center` (angles in degrees from +x toward +y), ends included. */
function arc(center: Point2, radius: number, from: number, to: number, n: number): Point2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as Point2;
  });
}

/** A stadium outline joining two discs of `radius` (2D convex hull, counter-clockwise). */
function stadium(a: Point2, b: Point2, radius: number, n = 12): Point2[] {
  const heading = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return [...arc(b, radius, heading - 90, heading + 90, n), ...arc(a, radius, heading + 90, heading + 270, n)];
}

/**
 * Plates are drawn in the side view (x = car z, y = car y) and extruded along +Z; turning
 * a plate -90 degrees about Y lands the drawing in the YZ plane with the depth along -X.
 * Straight-line code: tools map every journal entry to its line.
 */
export function buildLimb(p: LimbParameters = LIMB_DEFAULTS, session: SessionFactory = () => model()): Model {
  const bearing = unwrap(recipes.ballBearing({ bore: 0.05, outer: 0.09, width: 0.02, segments: 24, name: 'bearing' }));
  const hinge = unwrap(recipes.hinge({ length: 0.24, leafWidth: 0.06, thickness: 0.006, pin: 0.012, knuckles: 5, holes: 2, name: 'fhinge' }));
  const rail = unwrap(recipes.slideRail({ length: 0.3, width: 0.02, position: 1, name: 'rail' }));
  const cylinder = unwrap(recipes.hydraulicCylinder({ bore: 0.03, rod: 0.015, stroke: p.stroke, extension: 0, segments: 24, name: 'ram' }));

  const m = session('limb');
  // Chassis: a side plate with the shoulder bearing seat, a top flange and the bearing.
  m.extrudePolygon({ points: [[-0.16, -0.14], [0.16, -0.14], [0.16, 0.1], [-0.16, 0.1]], holes: [circle([0, 0], 0.045)], depth: 0.02, label: 'plate', tag: 'chassis' });
  m.rotate(sel.createdBy('plate'), 'y', -90);
  m.translate(sel.createdBy('plate'), [-0.1, 0, 0]);
  m.box({ size: [0.18, 0.027, 0.3], center: [-0.03, 0.0835, 0.2], label: 'flange', tag: 'chassis' });
  m.append(bearing.model, { tag: 'bearing' });
  m.rotate(sel.tag('bearing'), 'z', -90);
  m.translate(sel.tag('bearing'), [-0.11, 0, 0]);
  m.checkpoint('chassis');

  // Fender hinge: pin along Z on the flange; leaf B (chassis side) inboard, leaf A outboard.
  m.append(hinge.model, { tag: 'fhinge' });
  m.rotate(sel.tag('fhinge'), 'x', 90);
  m.translate(sel.tag('fhinge'), [...HINGE]);
  // Fender: an arch over the wheel drawn around the wheel center, and a riser up to leaf A.
  const center: Point2 = [WHEEL[2], WHEEL[1]];
  m.extrudePolygon({ points: [...arc(center, 0.33, 20, 160, 28), ...arc(center, 0.3, 160, 20, 28)], depth: 0.24, label: 'fender', tag: 'fender' });
  m.rotate(sel.createdBy('fender'), 'y', -90);
  m.translate(sel.createdBy('fender'), [0.32, 0, 0]);
  m.box({ size: [0.06, 0.127, 0.22], center: [0.12, 0.0335, 0.2], label: 'riser', tag: 'fender' });
  m.bevel(sel.createdBy('riser').toEdges('contained'), { width: 0.004, segments: 2, label: 'riser-round' });
  m.checkpoint('fender');

  // Upper arm: a beam forward from the shoulder, the axle through the bearing, elbow lugs and pin.
  // The beam stops short of the elbow so the forearm's lug web can turn between the lugs.
  m.box({ size: [0.1, 0.12, p.beamEnd + 0.02], center: [0, 0, (p.beamEnd - 0.02) / 2], label: 'upper-arm', tag: 'upper-arm' });
  m.bevel(sel.createdBy('upper-arm').toEdges('contained'), { width: 0.008, segments: 2, label: 'upper-arm-round' });
  m.cylinder({ radiusTop: 0.025, radiusBottom: 0.025, height: 0.18, radialSegments: 24, label: 'axle', tag: 'upper-arm' });
  m.rotate(sel.createdBy('axle'), 'z', 90);
  m.translate(sel.createdBy('axle'), [-0.04, 0, 0]);
  m.extrudePolygon({ points: stadium([0.35, -0.02], [ELBOW[2], ELBOW[1]], 0.045), depth: 0.02, label: 'elbow-lug-0', tag: 'upper-arm' });
  m.rotate(sel.createdBy('elbow-lug-0'), 'y', -90);
  m.translate(sel.createdBy('elbow-lug-0'), [-0.03, 0, 0]);
  m.extrudePolygon({ points: stadium([0.35, -0.02], [ELBOW[2], ELBOW[1]], 0.045), depth: 0.02, label: 'elbow-lug-1', tag: 'upper-arm' });
  m.rotate(sel.createdBy('elbow-lug-1'), 'y', -90);
  m.translate(sel.createdBy('elbow-lug-1'), [0.05, 0, 0]);
  m.cylinder({ radiusTop: 0.012, radiusBottom: 0.012, height: 0.12, radialSegments: 24, label: 'elbow-pin', tag: 'upper-arm' });
  m.rotate(sel.createdBy('elbow-pin'), 'z', 90);
  m.translate(sel.createdBy('elbow-pin'), [0, ELBOW[1], ELBOW[2]]);
  m.checkpoint('upper-arm');

  // Forearm, folded back under the upper arm: beam, elbow lug on a web, swing lug and pin.
  m.box({ size: [0.09, 0.1, 0.4], center: [0, -0.2, 0.2], label: 'forearm', tag: 'forearm' });
  m.bevel(sel.createdBy('forearm').toEdges('contained'), { width: 0.008, segments: 2, label: 'forearm-round' });
  m.extrudePolygon({ points: circle([ELBOW[2], ELBOW[1]], 0.03), holes: [circle([ELBOW[2], ELBOW[1]], 0.0125)], depth: 0.05, label: 'forearm-lug', tag: 'forearm' });
  m.rotate(sel.createdBy('forearm-lug'), 'y', -90);
  m.translate(sel.createdBy('forearm-lug'), [0.025, 0, 0]);
  m.box({ size: [0.04, 0.045, 0.06], center: [0, -0.1375, 0.42], label: 'forearm-web', tag: 'forearm' });
  m.box({ size: [0.055, 0.05, 0.05], center: [0.0725, SWING[1], SWING[2]], label: 'swing-lug', tag: 'forearm' });
  m.cylinder({ radiusTop: 0.01, radiusBottom: 0.01, height: 0.09, radialSegments: 24, label: 'swing-pin', tag: 'forearm' });
  m.rotate(sel.createdBy('swing-pin'), 'z', 90);
  m.translate(sel.createdBy('swing-pin'), [0.09, SWING[1], SWING[2]]);
  // Telescope: the slide rail hangs under the forearm, its carriage starts at the elbow end.
  m.append(rail.model, { tag: 'rail' });
  m.rotate(sel.tag('rail'), 'z', 180);
  m.translate(sel.tag('rail'), [0, -0.25, 0.17]);
  // Hydraulic ram along -Z on the inboard side: barrel on the forearm, rod toward the hand.
  m.append(cylinder.model, { tag: 'ram' });
  m.rotate(sel.tag('ram'), 'x', -90);
  const base = cylinder.anchors.baseEye as [number, number, number];
  const rodEye = 0.36 - (cylinder.dimensions.pinToPin as number);
  m.translate(sel.tag('ram'), [-0.075, -0.29, 0.36 + base[1]]);
  m.box({ size: [0.03, 0.05, 0.03], center: [-0.06, -0.275, 0.36], label: 'ram-mount', tag: 'forearm' });
  m.checkpoint('forearm');

  // Slider: a bar under the carriage out to the hand plate, and a bracket at the rod eye.
  m.box({ size: [0.06, 0.02, 0.31], center: [0, -0.29, 0.135], label: 'slider', tag: 'slider' });
  m.box({ size: [0.15, 0.15, 0.025], center: [-0.025, -0.225, -0.0225], label: 'hand-plate', tag: 'slider' });
  m.box({ size: [0.05, 0.03, 0.03], center: [-0.055, -0.29, rodEye], label: 'rod-bracket', tag: 'slider' });
  // Claw: a knuckle on X below the plate and two fingers folded along -Z.
  m.cylinder({ radiusTop: 0.01, radiusBottom: 0.01, height: 0.09, radialSegments: 16, label: 'claw-knuckle', tag: 'claw' });
  m.rotate(sel.createdBy('claw-knuckle'), 'z', 90);
  m.translate(sel.createdBy('claw-knuckle'), [0, -0.29, -0.05]);
  m.box({ size: [0.025, 0.02, 0.14], center: [-0.0275, -0.29, -0.12], label: 'finger-0', tag: 'claw' });
  m.box({ size: [0.025, 0.02, 0.14], center: [0.0275, -0.29, -0.12], label: 'finger-1', tag: 'claw' });
  m.checkpoint('hand');

  // Wheel: tire, rim and hub on a swing arm whose pivot hole rides the forearm's swing pin.
  m.torus({ radius: 0.19, tube: 0.05, radialSegments: 12, tubularSegments: 36, label: 'tire', tag: 'wheel' });
  m.rotate(sel.createdBy('tire'), 'y', 90);
  m.translate(sel.createdBy('tire'), [...WHEEL]);
  m.cylinder({ radiusTop: 0.15, radiusBottom: 0.15, height: 0.08, radialSegments: 36, label: 'rim', tag: 'wheel' });
  m.cylinder({ radiusTop: 0.04, radiusBottom: 0.04, height: 0.15, radialSegments: 24, label: 'hub', tag: 'wheel' });
  m.rotate(sel.createdBy('rim').or(sel.createdBy('hub')), 'z', 90);
  m.translate(sel.createdBy('rim'), [...WHEEL]);
  m.translate(sel.createdBy('hub'), [0.185, WHEEL[1], WHEEL[2]]);
  m.extrudePolygon({ points: stadium([SWING[2], SWING[1]], [WHEEL[2], WHEEL[1]], 0.025), holes: [circle([SWING[2], SWING[1]], 0.0105)], depth: 0.012, label: 'swing-arm', tag: 'wheel' });
  m.rotate(sel.createdBy('swing-arm'), 'y', -90);
  m.translate(sel.createdBy('swing-arm'), [0.122, 0, 0]);
  m.checkpoint('wheel');

  m.assign(sel.tag('chassis').or(sel.tag('bearing')), 'steel');
  m.assign(sel.tag('fender'), 'paint');
  m.assign(sel.tag('upper-arm').or(sel.tag('forearm')).or(sel.tag('slider')), 'alu');
  m.assign(sel.tag('claw'), 'dark');
  m.assign(sel.createdBy('tire'), 'rubber');
  m.assign(sel.createdBy('rim').or(sel.createdBy('hub')).or(sel.createdBy('swing-arm')), 'rim');
  m.uv.project({ mode: 'box', scale: 0.1 });
  return m;
}

const carriage = sel.createdBy('rail-carriage').or(sel.createdBy('rail-seal-a')).or(sel.createdBy('rail-seal-b'));

/**
 * Rigid parts in binding order: everything starts on the chassis, later bindings take
 * their faces over. Recipe parts split by label: the fender carries hinge leaf A with
 * its knuckles and pin, the forearm the rail and the ram barrel, the slider the carriage
 * with its seals and the ram rod.
 */
export const LIMB_BINDINGS: readonly { readonly part: string; readonly joint: string; readonly faces: FaceSelector }[] = [
  { part: 'chassis', joint: 'root', faces: sel.all() },
  { part: 'fender', joint: 'fender-hinge', faces: sel.tag('fender').or(sel.tag('fhinge').minus(sel.tag('fhinge-b'))) },
  { part: 'upper-arm', joint: 'shoulder', faces: sel.tag('upper-arm').or(sel.createdBy('bearing-inner')) },
  { part: 'forearm', joint: 'elbow', faces: sel.tag('forearm').or(sel.createdBy('rail-rail')).or(sel.createdBy('rail-track')).or(sel.createdBy('ram-barrel')).or(sel.createdBy('ram-eye')) },
  { part: 'wheel', joint: 'wheel-swing', faces: sel.tag('wheel') },
  { part: 'slider', joint: 'telescope', faces: sel.tag('slider').or(carriage).or(sel.createdBy('ram-rod')).or(sel.createdBy('ram-rod-eye')) },
  { part: 'claw', joint: 'claw', faces: sel.tag('claw') },
];

/** The arm's joints: chassis root, fender hinge, shoulder, elbow, wheel swing, telescope and claw. */
export function limbJoints(p: LimbParameters = LIMB_DEFAULTS): JointSpec[] {
  return [
    { name: 'root', parent: null, position: [0, 0, 0] },
    { name: 'fender-hinge', parent: 'root', position: [...HINGE], kind: 'revolute', axis: 'z', limits: [0, 110] },
    { name: 'shoulder', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'x', limits: [-5, 100] },
    { name: 'elbow', parent: 'shoulder', position: [...ELBOW], kind: 'revolute', axis: 'x', limits: [-175, 0] },
    { name: 'wheel-swing', parent: 'elbow', position: [...SWING], kind: 'revolute', axis: 'x', limits: [-45, 0] },
    { name: 'telescope', parent: 'elbow', position: [0, -0.29, 0.2], kind: 'prismatic', axis: [0, 0, -1], limits: [0, p.stroke] },
    { name: 'claw', parent: 'telescope', position: [0, -0.29, -0.05], kind: 'revolute', axis: 'x', limits: [-100, 0] },
  ];
}

export function limbRig(m: Model, p: LimbParameters = LIMB_DEFAULTS, joints: readonly JointSpec[] = limbJoints(p)): Rig {
  const r = rig(m, { joints });
  for (const b of LIMB_BINDINGS) r.bindRigid(b.faces, b.joint, { part: b.part });
  return r;
}

/** Car (u = 0) to robot (u = 1): each joint moves in its own phase; phases overlap. */
export function limbPath(p: LimbParameters = LIMB_DEFAULTS): PosePath {
  return {
    interpolation: 'smooth',
    keys: [
      { u: 0, pose: { 'fender-hinge': 0 } },
      { u: 0.15, pose: { 'wheel-swing': 0 } },
      { u: 0.2, pose: { 'fender-hinge': 105 } },
      { u: 0.3, pose: { shoulder: 0 } },
      { u: 0.35, pose: { 'wheel-swing': p.wheelSwing } },
      { u: 0.5, pose: { elbow: 0 } },
      { u: 0.6, pose: { shoulder: 90 } },
      { u: 0.75, pose: { telescope: 0 } },
      { u: 0.8, pose: { elbow: -160 } },
      { u: 0.85, pose: { claw: 0 } },
      { u: 0.9, pose: { telescope: p.stroke, 'fender-hinge': 105 } },
      { u: 1, pose: { claw: -80, 'fender-hinge': 60 } },
    ],
  };
}

/** Designed contacts: none; every mechanism keeps its own running clearance. */
export const LIMB_CONTACTS: readonly DesignedContact[] = [];

export const LIMB_PARTS = LIMB_BINDINGS.map((b) => b.part);
