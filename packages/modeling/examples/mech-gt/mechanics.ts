import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { type JointHardware, type Mechanism, TRANSFORM } from './pose.ts';
import { bone, carEnvelope, MECH } from './proportions.ts';

/**
 * Case C-100 stage S4 placeholders: the `transform.json` design attached to the S1
 * skeleton with today's operators. Each joint gets a block for its hardware kind
 * (spherical: bored bearing ring and ball; universal: crossed pins; revolute: slotted
 * clevis with a pin bore and its pin) and each car-form mechanism a hinge knuckle or a
 * slide rail with its carriage. S5 replaces them with the B4 recipes.
 */
type Tuple3 = readonly [number, number, number];
type Axis = 'x' | 'y' | 'z';

const GAP = 0.008;
const RING = { radius: 0.11, height: 0.06, bore: 0.06, ball: 0.05 };
const CROSS = { radius: 0.02, length: 0.2 };
const CLEVIS = { size: [0.16, 0.14, 0.14] as Tuple3, slot: [0.06, 0.08, 0.16] as Tuple3, bore: 0.022, boreY: 0.035, pin: 0.016, pinLength: 0.2 };
const ROOT_MARKER = 0.05;
const KNUCKLE = { radius: 0.035, length: 0.08, bore: 0.022, pin: 0.015, pinLength: 0.16 };
const RAIL = { section: 0.03, carriage: [0.05, 0.05, 0.07] as Tuple3, extra: 0.12 };

/** Primitives are built along +Y; turn the selected faces onto a world axis. */
export function align(m: Model, faces: ReturnType<typeof sel.all>, axis: Axis): void {
  if (axis === 'x') m.rotate(faces, 'z', 90);
  if (axis === 'z') m.rotate(faces, 'x', 90);
}

export function axisOf(v: Tuple3): Axis {
  const a = v.map(Math.abs);
  const k = a.indexOf(Math.max(...a));
  return (['x', 'y', 'z'] as const)[k] as Axis;
}

/** Half extents of a joint's hardware block, for bone clearances (support of a box). */
function extent(hardware: JointHardware | undefined, ring: Axis): Tuple3 {
  if (hardware === undefined) return [ROOT_MARKER, ROOT_MARKER, ROOT_MARKER];
  if (hardware.kind === 'universal') return [CROSS.length / 2, CROSS.radius, CROSS.length / 2];
  if (hardware.kind === 'revolute') return [CLEVIS.pinLength / 2, CLEVIS.size[1] / 2, CLEVIS.size[2] / 2];
  const h = Math.max(RING.height / 2, RING.ball);
  return ring === 'x' ? [h, RING.radius, RING.radius] : ring === 'y' ? [RING.radius, h, RING.radius] : [RING.radius, RING.radius, h];
}

export const support = (e: Tuple3, d: Tuple3) => Math.abs(d[0]) * e[0] + Math.abs(d[1]) * e[1] + Math.abs(d[2]) * e[2];

function jointBlock(session: SessionFactory, name: string, hardware: JointHardware, ring: Axis, at: Tuple3): Model {
  const p = session(`hw-${name}`);
  if (hardware.kind === 'spherical') {
    p.cylinder({ radiusTop: RING.radius, radiusBottom: RING.radius, height: RING.height, radialSegments: 24, label: `${name}-ring`, tag: 'bearing', material: 'bearing' });
    p.cylinder({ radiusTop: RING.bore, radiusBottom: RING.bore, height: RING.height * 2, radialSegments: 24, label: `${name}-bore` });
    p.difference(sel.createdBy(`${name}-bore`), { label: `${name}-bored`, material: 'bearing' });
    p.sphere({ radius: RING.ball, widthSegments: 16, heightSegments: 10, label: `${name}-ball`, tag: 'bearing', material: 'pin' });
    // The ring, its bore walls and the ball turn together.
    align(p, sel.all(), ring);
  } else if (hardware.kind === 'universal') {
    p.cylinder({ radiusTop: CROSS.radius, radiusBottom: CROSS.radius, height: CROSS.length, radialSegments: 12, label: `${name}-pin-x`, tag: 'cross', material: 'pin' });
    align(p, sel.createdBy(`${name}-pin-x`), 'x');
    p.cylinder({ radiusTop: CROSS.radius, radiusBottom: CROSS.radius, height: CROSS.length, radialSegments: 12, label: `${name}-pin-z`, tag: 'cross', material: 'pin' });
    align(p, sel.createdBy(`${name}-pin-z`), 'z');
    p.union(sel.createdBy(`${name}-pin-z`), { label: `${name}-cross`, material: 'pin' });
  } else {
    p.box({ size: [...CLEVIS.size], label: `${name}-clevis`, tag: 'hinge', material: 'hinge' });
    p.box({ size: [...CLEVIS.slot], center: [0, -CLEVIS.size[1] / 2 + CLEVIS.slot[1] / 2 - 0.01, 0], label: `${name}-slot` });
    p.difference(sel.createdBy(`${name}-slot`), { label: `${name}-fork`, material: 'hinge' });
    p.cylinder({ radiusTop: CLEVIS.bore, radiusBottom: CLEVIS.bore, height: CLEVIS.size[0] * 1.5, radialSegments: 16, center: [0, CLEVIS.boreY, 0], label: `${name}-bore` });
    p.rotate(sel.createdBy(`${name}-bore`), 'z', 90, [0, CLEVIS.boreY, 0]);
    p.difference(sel.createdBy(`${name}-bore`), { label: `${name}-bored`, material: 'hinge' });
    p.cylinder({ radiusTop: CLEVIS.pin, radiusBottom: CLEVIS.pin, height: CLEVIS.pinLength, radialSegments: 12, center: [0, CLEVIS.boreY, 0], label: `${name}-pin`, tag: 'hinge', material: 'pin' });
    p.rotate(sel.createdBy(`${name}-pin`), 'z', 90, [0, CLEVIS.boreY, 0]);
  }
  p.translate(sel.all(), [...at]);
  return p;
}

export function buildMechHardware(session: SessionFactory = () => model()): Model {
  const head = MECH.height / MECH.headsPerBody;
  const at = new Map(MECH.joints.map((j) => [j.name, j.position]));
  const hardware = new Map(TRANSFORM.jointHardware.map((h) => [h.joint, h]));
  // A spherical ring faces along the bone from its parent (torso vertical, shoulders and hips sideways).
  const ring = new Map(
    MECH.joints.map((j) => {
      if (j.parent === null) return [j.name, 'y' as Axis];
      const from = at.get(j.parent) as Tuple3;
      return [j.name, axisOf([0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number)) as unknown as Tuple3)];
    }),
  );

  const m = session('mech-hardware');
  m.sphere({ radius: ROOT_MARKER, widthSegments: 12, heightSegments: 8, center: [...(at.get('root') as Tuple3)], label: 'joint-root', tag: 'joint', material: 'joint' });
  for (const j of MECH.joints) {
    if (j.parent === null) continue;
    const from = at.get(j.parent) as Tuple3;
    const d = [0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number));
    const l = Math.hypot(...d);
    const u = d.map((c) => c / l) as unknown as Tuple3;
    const clearFrom = support(extent(hardware.get(j.parent), ring.get(j.parent) as Axis), u) + GAP;
    const clearTo = support(extent(hardware.get(j.name), ring.get(j.name) as Axis), u) + GAP;
    bone(m, `bone-${j.name}`, from, j.position, clearFrom, clearTo);
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
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 0.25 });
  return m;
}

function mechanismBlock(session: SessionFactory, mech: Mechanism): Model {
  const p = session(`mx-${mech.id}`);
  const axis = axisOf(mech.axis);
  if (mech.kind === 'hinge') {
    p.cylinder({ radiusTop: KNUCKLE.radius, radiusBottom: KNUCKLE.radius, height: KNUCKLE.length, radialSegments: 16, label: `${mech.id}-knuckle`, tag: 'hinge', material: 'hinge' });
    p.cylinder({ radiusTop: KNUCKLE.bore, radiusBottom: KNUCKLE.bore, height: KNUCKLE.length * 1.5, radialSegments: 16, label: `${mech.id}-bore` });
    p.difference(sel.createdBy(`${mech.id}-bore`), { label: `${mech.id}-bored`, material: 'hinge' });
    p.cylinder({ radiusTop: KNUCKLE.pin, radiusBottom: KNUCKLE.pin, height: KNUCKLE.pinLength, radialSegments: 12, label: `${mech.id}-pin`, tag: 'hinge', material: 'pin' });
    if (axis !== 'y') p.rotate(sel.all(), axis === 'x' ? 'z' : 'x', 90);
  } else {
    const length = mech.range[1] - mech.range[0] + RAIL.extra;
    p.box({ size: [RAIL.section, length, RAIL.section], label: `${mech.id}-rail`, tag: 'slide', material: 'slide' });
    p.box({ size: [...RAIL.carriage], center: [0, 0, RAIL.section / 2 + RAIL.carriage[2] / 2 + GAP], label: `${mech.id}-carriage`, tag: 'slide', material: 'hinge' });
    if (axis !== 'y') p.rotate(sel.all(), axis === 'x' ? 'z' : 'x', 90);
    // The rail runs from just behind the anchor along the slide direction, as the travel does.
    const ahead = (length - RAIL.extra) / 2;
    p.translate(sel.all(), [mech.axis[0] * ahead, mech.axis[1] * ahead, mech.axis[2] * ahead]);
  }
  p.translate(sel.all(), [...mech.anchor]);
  return p;
}

export function buildCarMechanisms(session: SessionFactory = () => model()): Model {
  const m = session('car-mechanisms');
  carEnvelope(m);
  m.checkpoint('envelope');
  for (const kind of ['hinge', 'slide'] as const) {
    for (const mech of TRANSFORM.mechanisms) if (mech.kind === kind) m.append(mechanismBlock(session, mech));
    m.checkpoint(`${kind}s`);
  }
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 0.25 });
  return m;
}
