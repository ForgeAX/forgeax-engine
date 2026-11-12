import { type Model, model, path, type Point2, type RecipePart, recipes, sel, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { CAR, fit, fitX, FRONT_TIRE_DIAMETER, REAR_TIRE_DIAMETER } from './proportions.ts';
import { carFormJoints } from './pose.ts';
import { buildS3Car, buildS3Mech } from './s3-rough.ts';
import { hardwareRadius } from './s5-joints.ts';

/**
 * Case C-100 stage S5, car form (code name mech-gt): the internal mechanics inside the S3
 * body, whose panels are closed 3 mm walls over an open frame (no solid hull). Each part
 * lies fully inside a compartment or a wheel well and keeps a clearance to every other
 * part and panel, so the assembly validates with no crossing. Mechanical parts come from
 * the B4 recipes (bearings, dampers, springs); frames, arms and the powertrain are sweeps,
 * boxes and revolves. Every part is tagged with its `parts.json` id (`part:<id>`; discs and
 * hubs join their wheel). Positions are authored against the nominal S1 car and placed
 * through `fit`, so they follow the CAR proportions. Meters, the S1/S2 frame.
 */
const HALF_BASE = CAR.wheelbase.value / 2;
type Box = readonly [Tuple3, Tuple3];
const region = (min: Tuple3, max: Tuple3): Box => [fit(min), fit(max)];

/** Compartments the internals stay in (`[min, max]`), inside the S3 panel walls. */
export const COMPARTMENTS: Readonly<Record<'front-bay' | 'front-towers' | 'cabin' | 'engine-bay', Box>> = {
  'front-bay': region([-0.7, 0.18, 1.05], [0.7, 0.52, 1.9]),
  'front-towers': region([-0.7, 0.18, 1.15], [0.7, 0.58, 1.65]),
  cabin: region([-0.72, 0.18, -0.5], [0.72, 0.84, 0.6]),
  'engine-bay': region([-0.66, 0.17, -1.9], [0.66, 0.86, -0.6]),
};

/** The `parts.json` internal parts S5 builds. */
export const INTERNAL = [
  'monocoque', 'battery', 'harness-main', 'front-subframe', 'rear-subframe-l', 'rear-subframe-r', 'rear-subframe-center',
  'v12-engine', 'gearbox', 'rear-motor', 'front-motor-l', 'front-motor-r', 'front-halfshaft-l', 'front-halfshaft-r',
  'rear-halfshaft-l', 'rear-halfshaft-r', 'front-wishbones-l', 'front-wishbones-r', 'rear-wishbones-l', 'rear-wishbones-r',
  'front-damper-l', 'front-damper-r', 'rear-damper-l', 'rear-damper-r',
] as const;

/** Wheel corners from the S1 frame: center, tire inner face and radius. */
export const CORNERS = [
  { axle: 'front', side: 'l', z: HALF_BASE, x: CAR.frontTrack.value / 2, r: FRONT_TIRE_DIAMETER / 2, w: CAR.frontTireWidth.value },
  { axle: 'front', side: 'r', z: HALF_BASE, x: -CAR.frontTrack.value / 2, r: FRONT_TIRE_DIAMETER / 2, w: CAR.frontTireWidth.value },
  { axle: 'rear', side: 'l', z: -HALF_BASE, x: CAR.rearTrack.value / 2, r: REAR_TIRE_DIAMETER / 2, w: CAR.rearTireWidth.value },
  { axle: 'rear', side: 'r', z: -HALF_BASE, x: -CAR.rearTrack.value / 2, r: REAR_TIRE_DIAMETER / 2, w: CAR.rearTireWidth.value },
] as const;
type Corner = (typeof CORNERS)[number];

/**
 * Inner pivots of both arms (|x|), the damper line (|x|) and the arm heights from the hub
 * center, per axle. The rear arms sit low and the rear coil-over lies along the car between
 * them (inboard pushrod layout), so the stowed knees and thighs pass above the rear corners.
 */
const PIVOT_X = fitX(0.3);
const DAMPER_X = fitX(0.45);
const SPREAD = 0.18;
const ARMS = { front: { upper: 0.2, lower: -0.13 }, rear: { upper: 0.02, lower: -0.15 } } as const;

function part(r: ReturnType<typeof recipes.gear>): RecipePart {
  if (!r.ok) throw r.error;
  return r.value;
}

function circle(radius: number, n: number): Point2[] {
  return Array.from({ length: n }, (_, k) => [radius * Math.cos((k * 2 * Math.PI) / n), radius * Math.sin((k * 2 * Math.PI) / n)] as Point2);
}

const tube = (radius: number) => circle(radius, 10);

/** A box from its two corners, already on the current car. */
function block(m: Model, min: Tuple3, max: Tuple3, options: { label: string; tag: string; material: string }): void {
  m.box({ size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], ...options });
}

/** A cylinder along X between two x positions, centered on `[y, z]`. */
function alongX(m: Model, x0: number, x1: number, y: number, z: number, radius: number, options: { label: string; tag: string; material: string }, segments = 24): void {
  m.cylinder({ radiusTop: radius, radiusBottom: radius, height: Math.abs(x1 - x0), radialSegments: segments, ...options });
  m.rotate(sel.createdBy(options.label), 'z', 90);
  m.translate(sel.createdBy(options.label), [(x0 + x1) / 2, y, z]);
}

/** One double-wishbone corner: pivot bearings, A-arm tubes, ball joints, upright, disc, hub, coil-over. */
function corner(session: SessionFactory, c: Corner): Model {
  const s = Math.sign(c.x);
  const n = `${c.axle}-${c.side}`;
  const wishbones = `${c.axle}-wishbones-${c.side}`;
  const damperTag = `${c.axle}-damper-${c.side}`;
  const inner = Math.abs(c.x) - c.w / 2;
  const ball = inner - 0.1175;
  const k = session(`corner-${n}`);
  // Arms: two tubes per arm converging on the ball joint, each from its own pivot bearing.
  const { upper, lower } = ARMS[c.axle];
  for (const [arm, dy, radius] of [['upper', upper, 0.012], ['lower', lower, 0.015]] as const) {
    for (const [leg, dz] of [['front', SPREAD], ['rear', -SPREAD]] as const) {
      const bearing = part(recipes.ballBearing({ bore: 0.02, outer: 0.05, width: 0.018, segments: 24, balls: 6, name: `${n}-${arm}-${leg}-pivot` }));
      k.append(bearing.model, { tag: wishbones });
      k.rotate(sel.tag(`${n}-${arm}-${leg}-pivot`), 'x', 90);
      k.translate(sel.tag(`${n}-${arm}-${leg}-pivot`), [s * PIVOT_X, c.r + dy, c.z + dz]);
      k.sweep({ profile: tube(radius), path: [[s * (PIVOT_X + 0.045), c.r + dy, c.z + dz], [s * (ball - 0.035), c.r + dy, c.z + Math.sign(dz) * 0.03]], label: `${n}-${arm}-${leg}-arm`, tag: wishbones, material: 'steel' });
    }
    k.sphere({ radius: 0.02, widthSegments: 12, heightSegments: 8, center: [s * ball, c.r + dy, c.z], label: `${n}-${arm}-ball`, tag: wishbones, material: 'steel' });
  }
  // Upright between the ball joints, brake disc and hub flange toward the tire.
  block(k, [s > 0 ? inner - 0.1375 : -(inner - 0.0875), c.r + lower + 0.03, c.z - 0.05], [s > 0 ? inner - 0.0875 : -(inner - 0.1375), c.r + upper - 0.03, c.z + 0.05], { label: `${n}-upright`, tag: wishbones, material: 'alu' });
  alongX(k, s * (inner - 0.0775), s * (inner - 0.0655), c.r, c.z, 0.16, { label: `${n}-disc`, tag: `${c.axle}-wheel-${c.side}`, material: 'disc' }, 32);
  alongX(k, s * (inner - 0.0575), s * (inner - 0.0075), c.r, c.z, 0.08, { label: `${n}-hub`, tag: `${c.axle}-wheel-${c.side}`, material: 'hub' });
  // Coil-over: a recipe damper with a recipe spring around it, standing on the line above the
  // halfshaft at the front, lying along the car below it at the rear.
  const damper = part(recipes.hydraulicCylinder({ bore: 0.025, rod: 0.012, stroke: c.axle === 'front' ? 0.025 : 0.08, extension: 0.6, name: `${n}-damper` }));
  const spring = part(recipes.coilSpring({ radius: 0.036, wire: 0.004, pitch: 0.022, turns: 3, name: `${n}-spring` }));
  k.append(damper.model, { tag: damperTag });
  k.append(spring.model, { tag: damperTag });
  if (c.axle === 'front') {
    const foot = c.r + 0.045 - (damper.anchors.baseEye?.[1] ?? 0) + (damper.dimensions.eyeRadius as number);
    k.translate(sel.tag(`${n}-damper`), [s * DAMPER_X, foot, c.z]);
    k.translate(sel.tag(`${n}-spring`), [s * DAMPER_X, foot + 0.03, c.z]);
  } else {
    const length = damper.dimensions.pinToPin as number;
    const coilover = sel.tag(`${n}-damper`).or(sel.tag(`${n}-spring`));
    k.translate(sel.tag(`${n}-spring`), [0, 0.03, 0]);
    k.rotate(coilover, 'x', 90, [0, 0, 0]);
    k.translate(coilover, [s * DAMPER_X, c.r - 0.075, c.z - length / 2]);
  }
  return k;
}

/** Nominal corners of a box, on the current car. */
const fitted = (min: Tuple3, max: Tuple3): [Tuple3, Tuple3] => [fit(min), fit(max)];
const fitPath = (points: readonly Tuple3[]): Tuple3[] => points.map((p) => fit(p));

/**
 * The internals alone (no body): chassis, suspension, powertrain and harness, every part
 * tagged `part:<parts.json id>`; discs and hubs carry their wheel's part tag.
 */
export function buildS5Internals(session: SessionFactory = () => model()): Model {
  const m = session('internals');
  internals(m, session);
  for (const id of INTERNAL) m.tag(sel.tag(id), `part:${id}`);
  for (const c of CORNERS) m.tag(sel.tag(`${c.axle}-wheel-${c.side}`), `part:${c.axle}-wheel-${c.side}`);
  m.markSharp(sel.edges.dihedral('>', 50));
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}

/**
 * Bulkhead notches of the tub: where the stowed mech core passes through the bulkheads (the
 * root, spine, chest and hip mechanisms and the thighs, S3/S4 car form), with the clearance
 * every part keeps.
 */
function coreChannel(): [Tuple3, Tuple3] {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (min: readonly number[], max: readonly number[]) => {
    for (const k of [0, 1, 2]) {
      lo[k] = Math.min(lo[k] as number, min[k] as number);
      hi[k] = Math.max(hi[k] as number, max[k] as number);
    }
  };
  const joints = carFormJoints();
  for (const j of ['root', 'spine', 'chest', 'hip-l', 'hip-r']) {
    const p = joints.get(j) as Tuple3;
    const r = hardwareRadius(j);
    grow(p.map((c) => c - r), p.map((c) => c + r));
  }
  const core = buildS3Mech();
  for (const part of ['core-thigh-l', 'core-thigh-r']) {
    const b = core.bounds(sel.tag(`part:${part}`));
    if (!b.ok) throw b.error;
    grow(b.value.min, b.value.max);
  }
  return [[lo[0] - CORE_CLEARANCE, lo[1] - CORE_CLEARANCE, lo[2]], [hi[0] + CORE_CLEARANCE, hi[1] + CORE_CLEARANCE, hi[2]]];
}
const CORE_CLEARANCE = 0.012;

/**
 * Append a group of internals with box-projected coordinates on both channels, so every
 * checkpoint of a session that also holds the S3 panels (uv0 and uv1) exports and renders.
 */
function addPart(m: Model, part: Model): void {
  part.uv.project({ mode: 'box', scale: 0.5 });
  part.uv.project({ mode: 'box', scale: 0.5, channel: 'uv1' });
  m.append(part);
}

function internals(m: Model, session: SessionFactory): void {
  // Chassis: open-top carbon tub with the battery tunnel, front rails, rear cradle. The
  // bulkheads are notched where the stowed spine and thighs pass through.
  const tub = session('tub');
  const [tubMin, tubMax] = fitted([-0.68, 0.19, -0.46], [0.68, 0.6, 0.56]);
  block(tub, tubMin, tubMax, { label: 'tub', tag: 'monocoque', material: 'carbon' });
  block(tub, ...fitted([-0.62, 0.24, -0.4], [0.62, 0.7, 0.5]), { label: 'tub-cut-tool', tag: 'tub-cut-tool', material: 'carbon' });
  tub.uv.project({ mode: 'box', scale: 0.5 });
  tub.difference(sel.createdBy('tub-cut-tool'), { label: 'tub-cut', material: 'carbon' });
  const [lo, hi] = coreChannel();
  block(tub, [lo[0], lo[1], tubMin[2] - 0.05], [hi[0], tubMax[1] + 0.05, tubMax[2] + 0.05], { label: 'tub-channel-tool', tag: 'tub-channel-tool', material: 'carbon' });
  tub.uv.project({ mode: 'box', scale: 0.5, faces: sel.createdBy('tub-channel-tool') });
  tub.difference(sel.createdBy('tub-channel-tool'), { label: 'tub-channel', material: 'carbon' });
  tub.tag(sel.createdBy('tub-cut').or(sel.createdBy('tub-channel')), 'monocoque');
  block(tub, ...fitted([-0.12, 0.245, -0.36], [0.12, 0.38, 0.46]), { label: 'battery', tag: 'battery', material: 'battery' });
  tub.sweep({ profile: circle(0.01, 8), path: path.polyline(fitPath([[0.2, 0.26, 0.45], [0.2, 0.26, -0.34], [0.45, 0.4, -0.36]]), { radius: 0.05, segments: 6 }), label: 'harness', tag: 'harness-main', material: 'harness' });
  tub.sweep({ profile: circle(0.007, 8), path: path.polyline(fitPath([[-0.2, 0.26, 0.45], [-0.2, 0.26, -0.37], [-0.45, 0.45, -0.37]]), { radius: 0.05, segments: 6 }), label: 'harness-branch', tag: 'harness-main', material: 'harness' });
  addPart(m, tub);
  // Front subframe: two rails a side; the cross member closes them at the bulkhead end, clear of the stowed head.
  const frame = session('frame');
  for (const x of [0.22, -0.22]) {
    for (const y of [0.2, 0.48]) {
      frame.sweep({ profile: tube(0.018), path: fitPath([[x, y, 1.08], [x, y, 1.87]]), label: `front-rail-${x > 0 ? 'l' : 'r'}-${y < 0.3 ? 'low' : 'high'}`, tag: 'front-subframe', material: 'steel' });
    }
  }
  frame.sweep({ profile: tube(0.018), path: fitPath([[-0.18, 0.2, 1.11], [0.18, 0.2, 1.11]]), label: 'front-cross', tag: 'front-subframe', material: 'steel' });
  for (const [x, side] of [[0.6, 'l'], [-0.6, 'r']] as const) {
    frame.sweep({ profile: tube(0.02), path: fitPath([[x, 0.21, -0.65], [x, 0.21, -1.14]]), label: `cradle-rail-${side}`, tag: `rear-subframe-${side}`, material: 'steel' });
  }
  // The cradle beam and the gearbox stay inside x ±0.28 so they rise between the stowed shins on the S7 pelvis lift.
  frame.sweep({ profile: tube(0.02), path: fitPath([[-0.28, 0.25, -1.72], [0.28, 0.25, -1.72]]), label: 'cradle-beam', tag: 'rear-subframe-center', material: 'steel' });
  addPart(m, frame);
  m.checkpoint('chassis');

  // Suspension: four corners.
  for (const c of CORNERS) addPart(m, corner(session, c));
  m.checkpoint('suspension');

  // Powertrain and drivetrain: front motors and halfshafts, V12 with its banks and
  // plenum, transverse gearbox, rear motor and halfshafts.
  const drive = session('drive');
  for (const [s, side] of [[1, 'l'], [-1, 'r']] as const) {
    // Front motors sit outboard of the stowed head, between the subframe rails' heights.
    alongX(drive, s * fitX(0.17), s * fitX(0.27), 0.34, HALF_BASE, 0.1, { label: `front-motor-${side}`, tag: `front-motor-${side}`, material: 'motor' });
    alongX(drive, s * fitX(0.285), s * (CAR.frontTrack.value / 2 - CAR.frontTireWidth.value / 2 - 0.145), FRONT_TIRE_DIAMETER / 2, HALF_BASE, 0.018, { label: `front-halfshaft-${side}`, tag: `front-halfshaft-${side}`, material: 'steel' }, 12);
    alongX(drive, s * fitX(0.21), s * (CAR.rearTrack.value / 2 - CAR.rearTireWidth.value / 2 - 0.145), REAR_TIRE_DIAMETER / 2, -HALF_BASE, 0.02, { label: `rear-halfshaft-${side}`, tag: `rear-halfshaft-${side}`, material: 'steel' }, 12);
  }
  block(drive, ...fitted([-0.26, 0.2, -1.15], [0.26, 0.52, -0.65]), { label: 'v12-block', tag: 'v12-engine', material: 'engine' });
  for (const [s, side] of [[1, 'l'], [-1, 'r']] as const) {
    block(drive, ...fitted([s > 0 ? 0.03 : -0.25, 0.53, -1.13], [s > 0 ? 0.25 : -0.03, 0.66, -0.67]), { label: `v12-bank-${side}`, tag: 'v12-engine', material: 'engine' });
    drive.cylinder({ radiusTop: 0.025, radiusBottom: 0.025, height: 0.06, radialSegments: 12, center: fit([s * 0.14, 0.7, -0.72]), label: `v12-throttle-${side}`, tag: 'v12-engine', material: 'steel' });
    drive.array(sel.createdBy(`v12-throttle-${side}`), { linear: { count: 6, offset: [0, 0, -0.07] }, label: `v12-throttles-${side}` });
  }
  // Gearbox: a housing hollowed by boolean difference around a recipe gear pair on
  // transverse shafts (center distance = pitch radii + 1.5 mm backlash; the driven gear turns half a tooth so a gap faces the drive tooth).
  const box = session('gearbox');
  const center = fit([0, 0.35, -1.4]);
  block(box, [center[0] - 0.15, center[1] - 0.15, center[2] - 0.2], [center[0] + 0.15, center[1] + 0.15, center[2] + 0.2], { label: 'gearbox', tag: 'gearbox', material: 'engine' });
  block(box, [center[0] - 0.13, center[1] - 0.13, center[2] - 0.18], [center[0] + 0.13, center[1] + 0.13, center[2] + 0.18], { label: 'gearbox-cavity-tool', tag: 'gearbox-cavity-tool', material: 'engine' });
  box.uv.project({ mode: 'box', scale: 0.5 });
  box.difference(sel.createdBy('gearbox-cavity-tool'), { label: 'gearbox-cavity', material: 'engine' });
  box.tag(sel.createdBy('gearbox-cavity'), 'gearbox');
  const big = part(recipes.gear({ module: 0.004, teeth: 30, width: 0.03, bore: 0.02, name: 'gear-drive' }));
  const small = part(recipes.gear({ module: 0.004, teeth: 20, width: 0.03, bore: 0.016, name: 'gear-driven' }));
  const distance = (big.dimensions.pitchRadius as number) + (small.dimensions.pitchRadius as number) + 0.0015;
  for (const [g, z] of [[big, center[2] + 0.06], [small, center[2] + 0.06 - distance]] as const) {
    const name = g === big ? 'gear-drive' : 'gear-driven';
    box.append(g.model, { tag: 'gearbox' });
    if (g === small) box.rotate(sel.tag(name), 'z', 180 / 20);
    box.rotate(sel.tag(name), 'y', 90);
    box.translate(sel.tag(name), [center[0], center[1], z]);
  }
  drive.append(box);
  const motor = fit([0, 0.62, -1.4]);
  drive.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.3, radialSegments: 24, center: motor, label: 'rear-motor', tag: 'rear-motor', material: 'motor' });
  drive.rotate(sel.createdBy('rear-motor'), 'x', 90, motor);
  addPart(m, drive);
  m.checkpoint('powertrain');
}

/** The car form: the S3 rough model's closed 3 mm panels and wheels around the S5 internals. */
export function buildS5Chassis(session: SessionFactory = () => model()): Model {
  const m = session('chassis');
  m.append(buildS3Car().snapshot());
  m.checkpoint('body');
  internals(m, session);
  for (const id of INTERNAL) m.tag(sel.tag(id), `part:${id}`);
  for (const c of CORNERS) m.tag(sel.tag(`${c.axle}-wheel-${c.side}`), `part:${c.axle}-wheel-${c.side}`);
  m.markSharp(sel.edges.dihedral('>', 50));
  // The S3 panels carry their own coordinates; the internals get box projections on both channels.
  const added = INTERNAL.map((id) => sel.tag(`part:${id}`)).reduce((a, b) => a.or(b)).or(sel.material('disc')).or(sel.material('hub'));
  m.uv.project({ mode: 'box', scale: 0.5, faces: added });
  m.uv.project({ mode: 'box', scale: 0.5, faces: added, channel: 'uv1' });
  return m;
}
