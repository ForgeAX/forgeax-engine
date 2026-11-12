import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import joints from './joints.json' with { type: 'json' };

/**
 * Case C-100 stage S1 (F1, code name mech-gt): the proportion frames both forms are
 * measured against. The car frame is the body envelope as a bar cage, the four wheel
 * envelopes, the axle lines, a wheelbase marker on the ground and the cabin, engine
 * bay and front trunk zones. The mech frame is the `joints.json` skeleton as joint
 * markers and bones, the head envelope and a head-unit ruler. Meters, Y up, the car
 * nose and the mech face +Z, wheelbase center (car) and feet (mech) on the origin.
 */
export interface Dimension {
  readonly value: number;
  /**
   * `public`: published vehicle data; `blueprint`: measured from the public three-view
   * blueprint (`reference/blueprint.json`, criterion 9); `estimate`: chosen for the frame.
   */
  readonly basis: 'public' | 'blueprint' | 'estimate';
}

const pub = (value: number): Dimension => ({ value, basis: 'public' });
const bp = (value: number): Dimension => ({ value, basis: 'blueprint' });

/** Tire outer diameter from its ISO size: rim inches plus two sidewalls (width x aspect). */
function tireDiameter(width: number, aspect: number, rimInches: number): number {
  return rimInches * 0.0254 + 2 * width * aspect;
}

export const CAR = {
  length: pub(4.947),
  width: pub(2.033),
  height: pub(1.16),
  wheelbase: pub(2.779),
  frontRimInches: pub(20),
  rearRimInches: pub(21),
  frontTireWidth: pub(0.265),
  frontTireAspect: pub(0.35),
  rearTireWidth: pub(0.345),
  rearTireAspect: pub(0.3),
  // Blueprint: nose 2.5586 m ahead of the axle midpoint (front overhang at the public
  // wheelbase), outer tire faces at 0.995 m, sill 0.131-0.142 m above the ground.
  frontOverhang: bp(1.169),
  frontTrack: bp(1.725),
  rearTrack: bp(1.645),
  groundClearance: bp(0.13),
} as const;

/**
 * The car every absolute position in the C-100 data was authored against: the CAR values
 * of S1. `fit` carries such a point onto the current CAR, so zones, splits, compartments,
 * frames and mechanism anchors follow a change of the proportions instead of staying put.
 */
const NOMINAL = { length: 4.947, width: 2.033, height: 1.16, wheelbase: 2.779, frontOverhang: 1.095 } as const;

/** Stations along z (tail, rear axle, front axle, nose) of a car. */
function stations(c: { readonly length: number; readonly wheelbase: number; readonly frontOverhang: number }): readonly [number, number, number, number] {
  const nose = c.wheelbase / 2 + c.frontOverhang;
  return [nose - c.length, -c.wheelbase / 2, c.wheelbase / 2, nose];
}
const FROM = stations(NOMINAL);
/** Stations along z (tail, rear axle, front axle, nose) of the current car. */
export const CAR_STATIONS = stations({ length: CAR.length.value, wheelbase: CAR.wheelbase.value, frontOverhang: CAR.frontOverhang.value });
const TO = CAR_STATIONS;

/** A nominal z on the current car: piecewise linear over tail, rear axle, front axle and nose (extrapolated past the ends). */
export function fitZ(z: number, to: readonly [number, number, number, number] = TO): number {
  const k = z < FROM[1] ? 0 : z < FROM[2] ? 1 : 2;
  const a = FROM[k] as number;
  const b = FROM[k + 1] as number;
  return (to[k] as number) + ((z - a) * ((to[k + 1] as number) - (to[k] as number))) / (b - a);
}
export const fitX = (x: number): number => (x * CAR.width.value) / NOMINAL.width;
export const fitY = (y: number): number => (y * CAR.height.value) / NOMINAL.height;
/** The current car with the nominal wheelbase: where a rigid assembly sits unmoved. */
const AT_NOMINAL_WHEELBASE = stations({ length: CAR.length.value, wheelbase: NOMINAL.wheelbase, frontOverhang: CAR.frontOverhang.value });
/**
 * A point of a rigid assembly authored against the nominal car: scaled across, and moved
 * along z as far as its station `pivot` moves when the wheelbase leaves the nominal one.
 */
export const fitRigid = (p: readonly [number, number, number], pivot: number): [number, number, number] => [fitX(p[0]), fitY(p[1]), p[2] + fitZ(pivot) - fitZ(pivot, AT_NOMINAL_WHEELBASE)];
/** A point authored against the nominal car, on the current car. */
export const fit = (p: readonly [number, number, number]): [number, number, number] => [fitX(p[0]), fitY(p[1]), fitZ(p[2])];

export const FRONT_TIRE_DIAMETER = tireDiameter(
  CAR.frontTireWidth.value,
  CAR.frontTireAspect.value,
  CAR.frontRimInches.value,
);
export const REAR_TIRE_DIAMETER = tireDiameter(
  CAR.rearTireWidth.value,
  CAR.rearTireAspect.value,
  CAR.rearRimInches.value,
);

/** Car proportion-frame labels that `parts.json` zones refer to. */
export const CAR_ZONES = ['body-envelope', 'frunk', 'cabin', 'engine-bay', 'front-axle', 'rear-axle'] as const;

export interface JointDof {
  readonly axis: 'x' | 'y' | 'z';
  readonly min: number;
  readonly max: number;
}
export interface Joint {
  readonly name: string;
  readonly parent: string | null;
  readonly position: readonly [number, number, number];
  readonly dof: readonly JointDof[];
}
export interface JointTable {
  readonly schema: string;
  readonly height: number;
  readonly headsPerBody: number;
  readonly joints: readonly Joint[];
}

export const MECH = joints as unknown as JointTable;

/** Bar cross-section of the envelope cage, and the clearance kept between separate pieces. */
// Thin enough that the bars clear the tires, whose outer faces reach 0.995 m (blueprint).
const BAR = 0.018;
const GAP = 0.004;

/** The body envelope as a bar cage, kept GAP inside the overall car dimensions. */
export function carEnvelope(m: Model): void {
  const L = CAR.length.value;
  const W = CAR.width.value;
  const H = CAR.height.value;
  const nose = CAR.wheelbase.value / 2 + CAR.frontOverhang.value;
  const tail = nose - L;
  const floor = CAR.groundClearance.value;
  const postX = W / 2 - BAR / 2;
  const span = L - 2 * BAR - 2 * GAP;
  const across = W - 2 * BAR - 2 * GAP;
  const lowY = floor + BAR / 2;
  const topY = H - BAR / 2;
  const midZ = (nose + tail) / 2;
  // Body envelope: corner posts and side bars on +X mirrored, then the cross bars; pieces keep GAP apart.
  m.box({ size: [BAR, H - floor, BAR], center: [postX, (floor + H) / 2, nose - BAR / 2], label: 'post', tag: 'body-envelope', material: 'frame' });
  m.duplicate(sel.createdBy('post'), { label: 'post-tail' });
  m.translate(sel.createdBy('post-tail'), [0, 0, tail - nose + BAR]);
  m.box({ size: [BAR, BAR, span], center: [postX, lowY, midZ], label: 'sill', tag: 'body-envelope', material: 'frame' });
  m.box({ size: [BAR, BAR, span], center: [postX, topY, midZ], label: 'roofline', tag: 'body-envelope', material: 'frame' });
  m.mirror({ axis: 'x' });
  m.box({ size: [across, BAR, BAR], center: [0, lowY, nose - BAR / 2], label: 'nose-low', tag: 'body-envelope', material: 'frame' });
  m.box({ size: [across, BAR, BAR], center: [0, topY, nose - BAR / 2], label: 'nose-high', tag: 'body-envelope', material: 'frame' });
  m.box({ size: [across, BAR, BAR], center: [0, lowY, tail + BAR / 2], label: 'tail-low', tag: 'body-envelope', material: 'frame' });
  m.box({ size: [across, BAR, BAR], center: [0, topY, tail + BAR / 2], label: 'tail-high', tag: 'body-envelope', material: 'frame' });
}

export function buildCarFrame(session: SessionFactory = () => model()): Model {
  const half = CAR.wheelbase.value / 2;
  const front = { z: half, track: CAR.frontTrack.value, d: FRONT_TIRE_DIAMETER, rim: CAR.frontRimInches.value * 0.0254, w: CAR.frontTireWidth.value };
  const rear = { z: -half, track: CAR.rearTrack.value, d: REAR_TIRE_DIAMETER, rim: CAR.rearRimInches.value * 0.0254, w: CAR.rearTireWidth.value };

  const m = session('car');
  carEnvelope(m);
  m.checkpoint('envelope');

  // Wheel envelopes: a tire ring around a rim disc, revolved about +Y and turned onto X.
  const fw = session('front-wheel');
  fw.revolve({ points: [[front.rim / 2, -front.w / 2], [front.d / 2, -front.w / 2], [front.d / 2, front.w / 2], [front.rim / 2, front.w / 2], [front.rim / 2, -front.w / 2]], segments: 32, label: 'tire', tag: 'front-axle', material: 'tire' });
  fw.cylinder({ radiusTop: front.rim / 2 - GAP, radiusBottom: front.rim / 2 - GAP, height: front.w * 0.8, radialSegments: 32, label: 'rim', tag: 'front-axle', material: 'rim' });
  fw.rotate(sel.all(), 'z', 90);
  fw.translate(sel.all(), [front.track / 2, front.d / 2, front.z]);
  fw.mirror({ axis: 'x' });
  fw.cylinder({ radiusTop: 0.015, radiusBottom: 0.015, height: front.track - front.w - 2 * GAP, radialSegments: 8, label: 'axle', tag: 'front-axle', material: 'axle' });
  fw.rotate(sel.createdBy('axle'), 'z', 90);
  fw.translate(sel.createdBy('axle'), [0, front.d / 2, front.z]);

  const rw = session('rear-wheel');
  rw.revolve({ points: [[rear.rim / 2, -rear.w / 2], [rear.d / 2, -rear.w / 2], [rear.d / 2, rear.w / 2], [rear.rim / 2, rear.w / 2], [rear.rim / 2, -rear.w / 2]], segments: 32, label: 'tire', tag: 'rear-axle', material: 'tire' });
  rw.cylinder({ radiusTop: rear.rim / 2 - GAP, radiusBottom: rear.rim / 2 - GAP, height: rear.w * 0.8, radialSegments: 32, label: 'rim', tag: 'rear-axle', material: 'rim' });
  rw.rotate(sel.all(), 'z', 90);
  rw.translate(sel.all(), [rear.track / 2, rear.d / 2, rear.z]);
  rw.mirror({ axis: 'x' });
  rw.cylinder({ radiusTop: 0.015, radiusBottom: 0.015, height: rear.track - rear.w - 2 * GAP, radialSegments: 8, label: 'axle', tag: 'rear-axle', material: 'axle' });
  rw.rotate(sel.createdBy('axle'), 'z', 90);
  rw.translate(sel.createdBy('axle'), [0, rear.d / 2, rear.z]);

  m.append(fw);
  m.append(rw);
  m.checkpoint('wheels');
  m.box({ size: [0.03, 0.01, 2 * half], center: [0, 0.005, 0], label: 'wheelbase', tag: 'marker', material: 'marker' });
  m.checkpoint('wheelbase');

  // Zones: front trunk ahead of the front axle, cabin between the axles, mid engine bay
  // above the rear axle line and between the rear wheels.
  for (const [zone, [min, max]] of Object.entries(ZONES)) {
    m.box({ size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], label: zone, tag: zone, material: zone === 'engine-bay' ? 'engine' : zone });
  }
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}

type Box = readonly [readonly [number, number, number], readonly [number, number, number]];
const box = (min: readonly [number, number, number], max: readonly [number, number, number]): Box => [fit(min), fit(max)];
/** Zones of the car frame (`[min, max]`): front trunk ahead of the front axle, cabin between the axles, mid engine bay over the rear axle. */
export const ZONES: Readonly<Record<'frunk' | 'cabin' | 'engine-bay', Box>> = {
  frunk: box([-0.75, 0.3, 1.78], [0.75, 0.8, 2.4]),
  cabin: box([-0.68, 0.3, -0.45], [0.68, 1.1, 1.0]),
  'engine-bay': box([-0.6, 0.42, -1.95], [0.6, 0.98, -0.55]),
};

const MARKER = 0.05;
const BONE = 0.022;

/**
 * A bone cylinder between two joint centers, stopping `clearFrom` / `clearTo` short of
 * them so whatever sits on the joints (markers, S4 hardware) stays separate.
 */
export function bone(
  m: Model,
  label: string,
  from: readonly number[],
  to: readonly number[],
  clearFrom = MARKER + GAP,
  clearTo = MARKER + GAP,
): void {
  const d = [0, 1, 2].map((k) => (to[k] as number) - (from[k] as number)) as [number, number, number];
  const length = Math.hypot(...d);
  const height = length - clearFrom - clearTo;
  const pitch = (Math.atan2(d[0], Math.hypot(d[1], d[2])) * 180) / Math.PI;
  const turn = (Math.atan2(d[2], d[1]) * 180) / Math.PI;
  const mid = [0, 1, 2].map((k) => (from[k] as number) + ((d[k] as number) * (clearFrom + height / 2)) / length) as [number, number, number];
  m.cylinder({ radiusTop: BONE, radiusBottom: BONE, height, radialSegments: 8, label, tag: 'bone', material: 'bone' });
  m.rotate(sel.createdBy(label), 'z', -pitch);
  m.rotate(sel.createdBy(label), 'x', turn);
  m.translate(sel.createdBy(label), mid);
}

export function buildMechFrame(session: SessionFactory = () => model()): Model {
  const head = MECH.height / MECH.headsPerBody;
  const at = new Map(MECH.joints.map((j) => [j.name, j.position]));

  const m = session('mech');
  for (const j of MECH.joints) {
    m.sphere({ radius: MARKER, widthSegments: 12, heightSegments: 8, center: [...j.position], label: `joint-${j.name}`, tag: 'joint', material: 'joint' });
  }
  m.checkpoint('joints');
  for (const j of MECH.joints) {
    if (j.parent !== null) bone(m, `bone-${j.name}`, at.get(j.parent) as readonly number[], j.position);
  }
  m.checkpoint('skeleton');

  // Head envelope: one head unit tall, ending at the mech height above the head joint.
  m.box({ size: [head * 0.75, head, head * 0.85], center: [0, MECH.height - head / 2, 0], label: 'head', tag: 'head', material: 'head' });
  m.checkpoint('head');

  // Ruler: one block per head unit, alternating slots, the last one the half unit on top.
  const ruler = session('ruler');
  for (let i = 0; i < Math.ceil(MECH.headsPerBody); i++) {
    const top = Math.min((i + 1) * head, MECH.height);
    const bottom = i * head + (i === 0 ? 0 : GAP);
    ruler.box({ size: [0.06, top - bottom - (top === MECH.height ? 0 : GAP), 0.06], center: [-1.6, (bottom + top - (top === MECH.height ? 0 : GAP)) / 2, 0], label: `unit-${i + 1}`, tag: 'ruler', material: i % 2 === 0 ? 'ruler' : 'ruler-alt' });
  }
  m.append(ruler);
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}
