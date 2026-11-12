import { type Angles, type DesignedContact, type JointSpec, type Model, model, type Pose, type PosePath, type Rig, sel } from '@forgeax/engine-modeling';
import type { PanelForm } from './s3-rough.ts';
import { type RigExtension, rigOver } from './s4-transform.ts';
import { buildAssembly, MOUNT_TOLERANCE, type MechSource, resolveJoint } from './s7-assembly.ts';
import { type Affine, type CylinderLink, type CylinderSpan, cylinder, cylinderValues, type GearLink, gearPair, gearTurn, type Moved, pinDistance, type RackLink, rackPinion, rackTurn, restBarrel, swingLengths, turnAbout } from './s7-drives.ts';

/**
 * Case C-100 stage S7 (code name mech-gt): the transformation animation of the single
 * assembly (`s7-assembly.ts`) on the S4 rig. A first rig without drives measures what every
 * cylinder and gear must cover along the S4 path; the drives are then sized, built and hung
 * on the final rig. Within each phase the joints it moves follow the S4 values in a
 * quintic-eased time (zero velocity and acceleration at both ends), and every drive is keyed
 * with the value the posed links imply, so the linkages close at every key.
 */

/** Quintic ease: zero velocity and acceleration at both ends of a phase. */
export const ease = (t: number) => t * t * t * (t * (6 * t - 15) + 10);

/** Forward run (car to mech) and the pause of the round trip, in seconds. */
export const TIMING = { run: 12, hold: 1 } as const;

/** Key spacing in u within a phase: fine enough that linkages stay closed between keys. */
const KEY_STEP = 0.004;
/** Spacing in u of the samples that size the drives. */
const SIZE_STEP = 0.0025;

export interface S7Rig {
  readonly model: Model;
  readonly rig: Rig;
  /** Car to mech over u in [0, 1]. */
  readonly forward: PosePath;
  /** Mech back to car over u in [0, 1]. */
  readonly reverse: PosePath;
  /** Car to mech, a pause, back to car: the exported clip. */
  readonly roundTrip: PosePath;
  /** Rigid part -> rig joint. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly phases: Readonly<Record<string, readonly [number, number]>>;
  readonly cylinders: readonly CylinderLink[];
  readonly gears: readonly GearLink[];
  readonly racks: readonly RackLink[];
}

type Value = number | Angles;
const same = (x: Value | undefined, y: Value | undefined) =>
  typeof x === 'number' || typeof y === 'number'
    ? Math.abs(((x as number) ?? 0) - ((y as number) ?? 0)) < 1e-9
    : (['x', 'y', 'z'] as const).every((k) => Math.abs((x?.[k] ?? 0) - (y?.[k] ?? 0)) < 1e-9);

/** Joint transforms of a pose by name. */
function worldsOf(r: Rig, pose: Pose): Map<string, Affine> {
  const posed = r.pose(pose);
  if (!posed.ok) throw posed.error;
  return new Map(posed.value.joints.map((j) => [j.name, j.world]));
}

export function buildS7(form: PanelForm = 'closed', mech?: MechSource): S7Rig {
  const a = buildAssembly(form, mech);
  // The mech source's sub-parts and joints join both rigs.
  const own = (t: readonly JointSpec[]): RigExtension => a.mech?.(t) ?? {};
  let table: readonly JointSpec[] = [];
  const parts = (t: readonly JointSpec[]) => a.parts.map((p) => ({ faces: sel.tag(p.tag), joint: resolveJoint(t, p.joint), part: p.part }));

  // Pass 1: the rig without drives measures each drive over the path.
  const first = rigOver(a.model, a.units, (t) => {
    table = t;
    const e = own(t);
    return { ...e, parts: [...parts(t), ...(e.parts ?? [])] };
  });
  const rest = worldsOf(first.rig, {});
  const moved = (now: Map<string, Affine>, joint: string): Moved => ({ rest: rest.get(joint) as Affine, now: now.get(joint) as Affine });
  const samples = Array.from({ length: Math.round(1 / SIZE_STEP) + 1 }, (_, k) => {
    const s = first.rig.sample(first.path, k * SIZE_STEP);
    if (!s.ok) throw s.error;
    return worldsOf(first.rig, s.value);
  });
  const geometry = model();
  const joints: JointSpec[] = [];
  const driveParts: NonNullable<RigExtension['parts']>[number][] = [];
  const cylinders: CylinderLink[] = [];
  const gears: GearLink[] = [];
  for (const spec of a.cylinders) {
    const carrier = resolveJoint(table, spec.carrier);
    const driven = resolveJoint(table, spec.driven);
    const lengths: number[] = [];
    const angles = { x: [] as number[], y: [] as number[], z: [] as number[] };
    for (const now of samples) {
      lengths.push(pinDistance(spec.base, spec.eye, moved(now, carrier), moved(now, driven)));
      const v = cylinderValues(spec, moved(now, carrier), moved(now, driven)).barrel;
      for (const k of ['x', 'y', 'z'] as const) angles[k].push(v[k] ?? 0);
    }
    if (spec.sweep !== undefined) {
      const { pivot, axis, range } = spec.sweep;
      lengths.push(...swingLengths(spec.base, spec.eye, pivot, axis, range));
      for (let k = 0; k <= 16; k++) {
        const b = restBarrel(spec.base, spec.eye, turnAbout(spec.eye, pivot, axis, range[0] + ((range[1] - range[0]) * k) / 16)).barrel;
        for (const x of ['x', 'y', 'z'] as const) angles[x].push(b[x]);
      }
    }
    const bounds = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
    const span: CylinderSpan = { dMin: Math.min(...lengths), dMax: Math.max(...lengths), angles: { x: bounds(angles.x), y: bounds(angles.y), z: bounds(angles.z) } };
    const built = cylinder(geometry, spec.name, carrier, driven, spec.base, spec.eye, spec.pinAxis, span);
    cylinders.push(built.link);
    joints.push(...built.joints);
    driveParts.push({ faces: sel.tag(`s7:${spec.name}-barrel`), joint: built.link.barrel, part: `${spec.name}-barrel` }, { faces: sel.tag(`s7:${spec.name}-rod`), joint: built.link.rod, part: `${spec.name}-rod` });
  }
  for (const spec of a.gears) {
    const carrier = resolveJoint(table, spec.carrier);
    const driven = resolveJoint(table, spec.driven);
    const turn = Math.max(spec.travel, ...samples.map((now) => Math.abs(gearTurn(spec, moved(now, carrier), moved(now, driven)))));
    const built = gearPair(geometry, spec.name, carrier, driven, spec.axis, spec.center, spec.toward, turn);
    gears.push(built.link);
    joints.push(...built.joints);
    driveParts.push({ faces: sel.tag(`s7:gear-${spec.name}`), joint: driven, part: `gear-${spec.name}` }, { faces: sel.tag(`s7:pinion-${spec.name}`), joint: built.link.pinion, part: `pinion-${spec.name}` });
  }
  const racks: RackLink[] = [];
  for (const spec of a.racks) {
    const carrier = resolveJoint(table, spec.carrier);
    const driven = resolveJoint(table, spec.driven);
    const built = rackPinion(geometry, spec.name, carrier, driven, spec.start, spec.axis, spec.up, spec.travel);
    racks.push(built.link);
    joints.push(...built.joints);
    driveParts.push({ faces: sel.tag(`s7:rack-${spec.name}`), joint: carrier, part: `rack-${spec.name}` }, { faces: sel.tag(`s7:pinion-${spec.name}`), joint: built.link.pinion, part: `pinion-${spec.name}` });
  }
  geometry.uv.project({ mode: 'box', scale: 0.25 });
  geometry.uv.project({ mode: 'box', scale: 0.25, channel: 'uv1' });
  a.model.append(geometry.snapshot());
  a.model.checkpoint('drives');

  // Fastenings hold only where hardware and part ride one rigid joint (pass 1 bindings).
  const mounts = a.mounts.filter(([h, p]) => first.bindings[h] !== undefined && first.bindings[h] === first.bindings[p]).map(([h, p]): DesignedContact => ({ parts: [h, p], tolerance: MOUNT_TOLERANCE }));

  // Pass 2: the final rig with the drives.
  const tr = rigOver(a.model, a.units, (t) => {
    const e = own(t);
    return { ...e, joints: [...(e.joints ?? []), ...joints], parts: [...parts(t), ...(e.parts ?? []), ...driveParts], contacts: [...a.contacts, ...mounts, ...(e.contacts ?? [])] };
  });
  const r = tr.rig;
  const driveValues = (pose: Pose, keyed: { c: CylinderLink[]; g: GearLink[]; k: RackLink[] }) => {
    const now = worldsOf(r, pose);
    const out: Record<string, Value> = {};
    for (const c of keyed.c) {
      const v = cylinderValues(c, moved(now, c.carrier), moved(now, c.driven));
      out[c.barrel] = v.barrel;
      out[c.rod] = v.rod;
    }
    for (const g of keyed.g) out[g.pinion] = g.ratio * gearTurn(g, moved(now, g.carrier), moved(now, g.driven));
    for (const k of keyed.k) out[k.pinion] = rackTurn(k, moved(now, k.carrier), moved(now, k.driven));
    return out;
  };

  // A joint is keyed only inside a phase that moves it (rest before it, its last value after),
  // which keeps the path small for sampling.
  const base: PosePath = { keys: tr.path.keys, interpolation: 'linear' };
  const bounds = tr.path.keys.map((k) => k.u);
  const all = { c: cylinders, g: gears, k: racks };
  const byU = new Map<number, Record<string, Value>>();
  for (let s = 0; s + 1 < bounds.length; s++) {
    const u0 = bounds[s] as number;
    const u1 = bounds[s + 1] as number;
    const at = (u: number) => {
      const p = r.sample(base, u);
      if (!p.ok) throw p.error;
      return p.value;
    };
    const ends = [at(u0), at((u0 + u1) / 2), at(u1)];
    const movers = [...new Set(ends.flatMap((p) => Object.keys(p)))].filter((j) => ends.some((p) => !same(p[j], (ends[0] as Pose)[j])));
    const drives = ends.map((p) => driveValues(p, all));
    const moving = (name: string) => drives.some((d) => !same(d[name], (drives[0] as Record<string, Value>)[name]));
    const keyed = { c: cylinders.filter((c) => moving(c.barrel) || moving(c.rod)), g: gears.filter((g) => moving(g.pinion)), k: racks.filter((k) => moving(k.pinion)) };
    const n = Math.max(16, Math.ceil((u1 - u0) / KEY_STEP));
    for (let k = 0; k <= n; k++) {
      const u = k === n ? u1 : u0 + ((u1 - u0) * k) / n;
      const sampled = at(u0 + (u1 - u0) * ease(k / n));
      const pose = byU.get(u) ?? {};
      for (const j of movers) pose[j] = sampled[j] as Value;
      Object.assign(pose, driveValues(sampled, keyed));
      byU.set(u, pose);
    }
  }
  const keys = [...byU].sort((x, y) => x[0] - y[0]).map(([u, pose]) => ({ u, pose: pose as Pose }));
  const forward: PosePath = { keys, interpolation: 'linear' };
  // The reverse starts from the whole mech pose: a joint keyed only in its own phase would otherwise start at rest.
  const end = r.sample(forward, 1);
  if (!end.ok) throw end.error;
  const back = [...keys].reverse().map((k) => ({ u: 1 - k.u, pose: k.pose }));
  back[0] = { u: 0, pose: { ...end.value, ...back[0]?.pose } };
  const reverse: PosePath = { keys: back, interpolation: 'linear' };
  const total = 2 * TIMING.run + TIMING.hold;
  const roundTrip: PosePath = {
    keys: [
      ...keys.map((k) => ({ u: (k.u * TIMING.run) / total, pose: k.pose })),
      ...back.map((k) => ({ u: (TIMING.run + TIMING.hold + k.u * TIMING.run) / total, pose: k.pose })),
    ],
    interpolation: 'linear',
  };
  return { model: a.model, rig: r, forward, reverse, roundTrip, bindings: tr.bindings, phases: tr.phases, cylinders, gears, racks };
}
