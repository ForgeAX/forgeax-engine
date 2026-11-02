import { type Model, model, type RecipePart, recipes, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { align, axisOf, support } from './mechanics.ts';
import { carFormFrames, carTable, type Frame, type JointHardware, TRANSFORM } from './pose.ts';
import { bone, MECH } from './proportions.ts';

/**
 * Case C-100 stage S5, mech form (code name mech-gt): every movable joint of the
 * `joints.json` skeleton gets its mechanism from the B4 recipes, replacing the S4
 * placeholders. Spherical joints turn in a ball bearing; universal joints carry the
 * crossed pins (boolean union), the X pin in two bearings; revolute joints keep the slotted
 * clevis (boolean differences) with a hex bolt and nut as the pin. A joint whose
 * hardware lists pistons gets a hydraulic cylinder alongside its parent bone when that
 * bone is long enough. Bones stop at the support distance of the blocks.
 */
type Tuple3 = readonly [number, number, number];
type Axis = 'x' | 'y' | 'z';

const GAP = 0.008;
const BEARING = { bore: 0.1, outer: 0.22, width: 0.06, segments: 24, balls: 10 };
const CROSS = { radius: 0.02, length: 0.2, bearing: { bore: 0.05, outer: 0.09, width: 0.02, segments: 24, balls: 6 }, at: 0.075 };
const CLEVIS = { size: [0.16, 0.14, 0.14] as [number, number, number], slot: [0.06, 0.08, 0.16] as [number, number, number], bore: 0.022, boreY: 0.035 };
const ROOT_MARKER = 0.05;
/** An actuator spans the middle of its parent bone and stands this far off its axis. */
const ACTUATOR = { bore: 0.04, rod: 0.022, offset: 0.12, span: 0.5, minBone: 0.5 };

function part(r: ReturnType<typeof recipes.gear>): RecipePart {
  if (!r.ok) throw r.error;
  return r.value;
}

function extent(hardware: JointHardware | undefined, ring: Axis): Tuple3 {
  if (hardware === undefined) return [ROOT_MARKER, ROOT_MARKER, ROOT_MARKER];
  if (hardware.kind === 'universal') return [CROSS.length / 2, CROSS.bearing.outer / 2, CROSS.length / 2];
  if (hardware.kind === 'revolute') return [0.1, CLEVIS.size[1] / 2, CLEVIS.size[2] / 2];
  const r = BEARING.outer / 2;
  const h = BEARING.width / 2;
  return ring === 'x' ? [h, r, r] : ring === 'y' ? [r, h, r] : [r, r, h];
}

/**
 * Radius of the sphere around a joint that holds its mechanism whatever its pose: the bearing
 * disc, the crossed pins or the clevis block (the root marker for a joint without hardware).
 * Anything another part puts near the joint keeps out of it.
 */
export function hardwareRadius(joint: string): number {
  const hardware = TRANSFORM.jointHardware.find((h) => h.joint === joint);
  if (hardware === undefined) return ROOT_MARKER;
  if (hardware.kind === 'universal') return Math.hypot(CROSS.length / 2, CROSS.radius);
  if (hardware.kind === 'revolute') return Math.hypot(...CLEVIS.size) / 2;
  return Math.hypot(BEARING.outer / 2, BEARING.width / 2);
}

/** Turn +Y onto the unit direction `d`, about the origin of the selected faces' session. */
function pointAlong(m: Model, tag: string, d: Tuple3): void {
  const pitch = (Math.atan2(d[0], Math.hypot(d[1], d[2])) * 180) / Math.PI;
  const turn = (Math.atan2(d[2], d[1]) * 180) / Math.PI;
  m.rotate(sel.tag(tag), 'z', -pitch);
  m.rotate(sel.tag(tag), 'x', turn);
}

function jointBlock(session: SessionFactory, name: string, hardware: JointHardware, ring: Axis, at: Tuple3): Model {
  const p = session(`joint-${name}`);
  if (hardware.kind === 'spherical') {
    const b = part(recipes.ballBearing({ ...BEARING, name: `${name}-bearing` }));
    p.append(b.model, { tag: `${name}-mechanism` });
    align(p, sel.all(), ring);
  } else if (hardware.kind === 'universal') {
    p.cylinder({ radiusTop: CROSS.radius, radiusBottom: CROSS.radius, height: CROSS.length, radialSegments: 12, label: `${name}-pin-x`, tag: `${name}-mechanism`, material: 'steel' });
    align(p, sel.createdBy(`${name}-pin-x`), 'x');
    p.cylinder({ radiusTop: CROSS.radius, radiusBottom: CROSS.radius, height: CROSS.length, radialSegments: 12, label: `${name}-pin-z`, tag: `${name}-mechanism`, material: 'steel' });
    align(p, sel.createdBy(`${name}-pin-z`), 'z');
    p.union(sel.createdBy(`${name}-pin-z`), { label: `${name}-cross`, material: 'steel' });
    for (const [axis, sign] of [['x', 1], ['x', -1]] as const) {
      const tag = `${name}-cup-${axis}${sign > 0 ? '+' : '-'}`;
      const b = part(recipes.ballBearing({ ...CROSS.bearing, name: tag }));
      p.append(b.model, { tag: `${name}-mechanism` });
      align(p, sel.tag(tag), axis);
      p.translate(sel.tag(tag), axis === 'x' ? [sign * CROSS.at, 0, 0] : [0, 0, sign * CROSS.at]);
    }
  } else {
    p.box({ size: [...CLEVIS.size], label: `${name}-clevis`, tag: `${name}-mechanism`, material: 'steel' });
    p.box({ size: [...CLEVIS.slot], center: [0, -CLEVIS.size[1] / 2 + CLEVIS.slot[1] / 2 - 0.01, 0], label: `${name}-slot` });
    // Cut faces take their corner values from the cutter, so cutters carry uv0 too.
    p.uv.project({ mode: 'box', scale: 0.25 });
    p.difference(sel.createdBy(`${name}-slot`), { label: `${name}-fork`, material: 'steel' });
    p.cylinder({ radiusTop: CLEVIS.bore, radiusBottom: CLEVIS.bore, height: CLEVIS.size[0] * 1.5, radialSegments: 16, center: [0, CLEVIS.boreY, 0], label: `${name}-bore` });
    p.uv.project({ mode: 'box', scale: 0.25, faces: sel.createdBy(`${name}-bore`) });
    p.rotate(sel.createdBy(`${name}-bore`), 'z', 90, [0, CLEVIS.boreY, 0]);
    p.difference(sel.createdBy(`${name}-bore`), { label: `${name}-bored`, material: 'steel' });
    // Pin: an M16 bolt through the bore, head and nut standing 2 mm off the cheeks.
    const half = CLEVIS.size[0] / 2;
    const bolt = part(recipes.hexBolt({ size: 'M16', length: CLEVIS.size[0] + 0.03, name: `${name}-pin` }));
    p.append(bolt.model, { tag: `${name}-mechanism` });
    p.rotate(sel.tag(`${name}-pin`), 'z', -90);
    p.translate(sel.tag(`${name}-pin`), [half + 0.002, CLEVIS.boreY, 0]);
    const nut = part(recipes.hexNut({ size: 'M16', name: `${name}-nut` }));
    p.append(nut.model, { tag: `${name}-mechanism` });
    p.rotate(sel.tag(`${name}-nut`), 'z', 90);
    p.translate(sel.tag(`${name}-nut`), [-half - 0.002, CLEVIS.boreY, 0]);
  }
  p.translate(sel.all(), [...at]);
  return p;
}

/** A hydraulic cylinder beside the bone `from -> to`, pin to pin over ACTUATOR.span of it. */
function actuator(session: SessionFactory, name: string, from: Tuple3, to: Tuple3): Model | undefined {
  const d = [0, 1, 2].map((k) => (to[k] as number) - (from[k] as number));
  const length = Math.hypot(...d);
  if (length < ACTUATOR.minBone) return undefined;
  const u = d.map((c) => c / length) as unknown as Tuple3;
  const probe = part(recipes.hydraulicCylinder({ bore: ACTUATOR.bore, rod: ACTUATOR.rod, stroke: ACTUATOR.bore, extension: 0.5, name: 'probe' }));
  const longer = part(recipes.hydraulicCylinder({ bore: ACTUATOR.bore, rod: ACTUATOR.rod, stroke: ACTUATOR.bore * 2, extension: 0.5, name: 'probe' }));
  const perStroke = ((longer.dimensions.pinToPin as number) - (probe.dimensions.pinToPin as number)) / ACTUATOR.bore;
  const stroke = Math.max(ACTUATOR.bore, ACTUATOR.bore + (ACTUATOR.span * length - (probe.dimensions.pinToPin as number)) / perStroke);
  const c = part(recipes.hydraulicCylinder({ bore: ACTUATOR.bore, rod: ACTUATOR.rod, stroke, extension: 0.5, name: `${name}-actuator` }));
  // Mirror-symmetric: a bone and its mirror image get mirrored sides.
  const side = Math.abs(u[0]) < 0.8 ? [0, u[2], -u[1]] : [-u[1] * Math.sign(u[0]), Math.abs(u[0]), 0];
  const sl = Math.hypot(...side);
  const off = side.map((v) => (v / sl) * ACTUATOR.offset);
  const mid = (c.dimensions.pinToPin as number) / 2 + (c.anchors.baseEye?.[1] ?? 0);
  const p = session(`actuator-${name}`);
  p.append(c.model, { tag: `${name}-actuator` });
  p.translate(sel.all(), [0, -mid, 0]);
  pointAlong(p, `${name}-actuator`, u);
  p.translate(sel.all(), [0, 1, 2].map((k) => ((from[k] as number) + (to[k] as number)) / 2 + (off[k] as number)) as unknown as [number, number, number]);
  return p;
}

export function buildS5Joints(session: SessionFactory = () => model()): Model {
  const head = MECH.height / MECH.headsPerBody;
  const at = new Map(MECH.joints.map((j) => [j.name, j.position as Tuple3]));
  const hardware = new Map(TRANSFORM.jointHardware.map((h) => [h.joint, h]));
  const ring = new Map(
    MECH.joints.map((j) => {
      if (j.parent === null) return [j.name, 'y' as Axis];
      const from = at.get(j.parent) as Tuple3;
      return [j.name, axisOf([0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number)) as unknown as Tuple3)];
    }),
  );

  const m = session('mech-joints');
  m.sphere({ radius: ROOT_MARKER, widthSegments: 12, heightSegments: 8, center: [...(at.get('root') as Tuple3)], label: 'joint-root', tag: 'joint', material: 'joint' });
  for (const j of MECH.joints) {
    if (j.parent === null) continue;
    const from = at.get(j.parent) as Tuple3;
    const d = [0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number));
    const l = Math.hypot(...d);
    const u = d.map((c) => c / l) as unknown as Tuple3;
    bone(m, `bone-${j.name}`, from, j.position, support(extent(hardware.get(j.parent), ring.get(j.parent) as Axis), u) + GAP, support(extent(hardware.get(j.name), ring.get(j.name) as Axis), u) + GAP);
  }
  m.box({ size: [head * 0.75, head, head * 0.85], center: [0, MECH.height - head / 2, 0], label: 'head', tag: 'head', material: 'head' });
  m.checkpoint('skeleton');
  for (const kind of ['spherical', 'universal', 'revolute'] as const) {
    for (const j of MECH.joints) {
      const h = hardware.get(j.name);
      if (h?.kind === kind) m.append(jointBlock(session, j.name, h, ring.get(j.name) as Axis, j.position));
    }
    m.checkpoint(kind);
  }
  // Actuators ride the parent bone over its car-form (telescoped shut) length, so they fit both forms.
  const shut = new Map(carTable().joints.map((j) => [j.name, j.position]));
  for (const j of MECH.joints) {
    const pistons = hardware.get(j.name)?.hardware.find((x) => x.recipe === 'piston')?.count ?? 0;
    if (pistons === 0 || j.parent === null) continue;
    const from = at.get(j.parent) as Tuple3;
    const bone = [0, 1, 2].map((k) => ((shut.get(j.name) as Tuple3)[k] as number) - ((shut.get(j.parent as string) as Tuple3)[k] as number));
    const a = actuator(session, j.name, from, [0, 1, 2].map((k) => (from[k] as number) + (bone[k] as number)) as unknown as Tuple3);
    if (a !== undefined) m.append(a);
  }
  m.checkpoint('actuators');
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 0.25 });
  return m;
}

/**
 * Every joint mechanism and actuator placed at the joint it rides in a pose given as joint
 * frames (default the car form), each a rigid part tagged `part:hw-<tag>`: the stowed
 * hardware the car-form clearance checks and the rig assembly use.
 */
export function buildS5JointsStowed(frames: ReadonlyMap<string, Frame> = carFormFrames(), session: SessionFactory = () => model()): Model {
  const out = session('joints-stowed');
  out.append(buildS5Joints().snapshot());
  let kept = sel.tag('__none__');
  for (const j of MECH.joints) {
    for (const [tag, rider] of [[`${j.name}-mechanism`, j.name], [`${j.name}-actuator`, j.parent]] as const) {
      if (rider === null || out.count(sel.tag(tag)) === 0) continue;
      const faces = sel.tag(tag);
      const p = MECH.joints.find((x) => x.name === rider)?.position as Tuple3;
      const f = frames.get(rider);
      if (f === undefined) throw new Error(rider);
      out.translate(faces, [-p[0], -p[1], -p[2]]);
      out.rotate(faces, 'x', f.rotation.x ?? 0, [0, 0, 0]);
      out.rotate(faces, 'y', f.rotation.y ?? 0, [0, 0, 0]);
      out.rotate(faces, 'z', f.rotation.z ?? 0, [0, 0, 0]);
      out.translate(faces, [...f.position]);
      out.tag(faces, `part:hw-${tag}`);
      kept = kept.or(faces);
    }
  }
  out.delete(sel.all().minus(kept));
  return out;
}
