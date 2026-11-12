import { type DesignedContact, type FaceSelector, type JointSpec, type Model, type PosePath, type Rig, rig, sel } from '@forgeax/engine-modeling';
import parts from './parts.json' with { type: 'json' };
import { type Angles, carFormFrames, type Mechanism, TRANSFORM } from './pose.ts';
import { MECH } from './proportions.ts';

/**
 * Case C-100 stage S4 (code name mech-gt): the transformation as a B7 rig. `rigOver` puts
 * any car-form session whose rigid parts are tagged `part:<name>` on the joints.json
 * skeleton: the rest pose is the car form (each joint at its car-form frame from
 * `pose.ts`, under a lift slide for the stand-up), every `transform.json` mechanism is a
 * revolute or prismatic joint chained under the joint of the pieces it moves, and the path
 * keys the transformation phases. The S3 rough model (`s3-rough.ts`) is the geometry it
 * is verified on.
 */

/** The joint a unit rides in the mech form: its S4 piece entry, else its parts.json entry. */
function mechJoint(unit: string): string {
  const piece = TRANSFORM.pieces.find((p) => p.id === unit);
  if (piece !== undefined) return piece.mech.joint;
  const part = parts.parts.find((p) => p.id === unit);
  if (part === undefined) throw new Error(`unknown unit ${unit}`);
  return part.mech.joint;
}

/** Mechanism travel in the mech form: the range end away from zero. */
const travel = (m: Mechanism) => (Math.abs(m.range[1]) >= Math.abs(m.range[0]) ? m.range[1] : m.range[0]);

export interface TransformRig {
  readonly model: Model;
  readonly rig: Rig;
  readonly path: PosePath;
  /** Rigid part -> rig joint it is bound to. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Phase name -> [u0, u1] of the path. */
  readonly phases: Readonly<Record<string, readonly [number, number]>>;
}

/** Joints and rigid parts a later stage hangs on the S4 joint table (S7 drives and hardware). */
export interface RigExtension {
  readonly joints?: readonly JointSpec[];
  readonly parts?: readonly { readonly faces: FaceSelector; readonly joint: string; readonly part: string }[];
  readonly contacts?: readonly DesignedContact[];
  /** Extension joints the path moves: from rest to `value` within `phase`, held after it. */
  readonly keys?: readonly { readonly joint: string; readonly value: number | Angles; readonly phase: string }[];
}

/** Root lift: the slide from the car-form root to the mech-form pelvis, and its length. */
const RISE = [0, 1, 2].map((k) => ((MECH.joints[0]?.position[k] as number) ?? 0) - (TRANSFORM.carRoot.position[k] as number));
const LIFT = Math.hypot(...RISE);
/**
 * The S4 rig over any car-form session whose rigid parts are tagged `part:<name>`: joints at
 * their car-form frames under a lift slide, mechanisms chained under the joint of the
 * pieces they move, and the phase path. `units` names the parts (parts.json or S4 pieces).
 */
export function rigOver(m: Model, units: readonly string[], extend?: (joints: readonly JointSpec[]) => RigExtension): TransformRig {
  const frames = carFormFrames();
  const joints: JointSpec[] = [
    { name: 'ground', parent: null, position: [0, 0, 0] },
    { name: 'lift', parent: 'ground', position: [0, 0, 0], kind: 'prismatic', axis: RISE.map((c) => c / LIFT) as [number, number, number], limits: [0, LIFT] },
  ];
  const mechValues: Record<string, number | Angles> = { lift: LIFT };
  for (const j of MECH.joints) {
    const frame = frames.get(j.name);
    if (frame === undefined) throw new Error(j.name);
    const car = j.parent === null ? TRANSFORM.carRoot.rotation : (TRANSFORM.carPose[j.name] ?? {});
    const target = j.parent === null ? {} : (TRANSFORM.mechPose[j.name] ?? {});
    const limits: Partial<Record<'x' | 'y' | 'z', [number, number]>> = {};
    for (const d of j.dof) limits[d.axis] = [d.min - (car[d.axis] ?? 0), d.max - (car[d.axis] ?? 0)];
    if (j.parent === null) limits.x = [-(car.x ?? 0), 0];
    // A telescoped bone: a slide between the parent and the joint, shut in car form, opened by its phase.
    const tele = TRANSFORM.telescopes.find((t) => t.joint === j.name);
    let parent = j.parent ?? 'lift';
    if (tele !== undefined && j.parent !== null) {
      const up = frames.get(j.parent);
      const from = MECH.joints.find((x) => x.name === j.parent)?.position as readonly number[];
      const d = [0, 1, 2].map((k) => (j.position[k] as number) - (from[k] as number));
      const l = Math.hypot(...d);
      if (up === undefined) throw new Error(j.parent);
      // Two nested stages, each half the travel: stage 1 slides on the parent bone, stage 2 on stage 1.
      const axis = d.map((c) => c / l) as [number, number, number];
      const half = tele.length / 2;
      joints.push({ name: `${j.name}-telescope-1`, parent: j.parent, position: [...frame.position], rotation: up.rotation, kind: 'prismatic', axis, limits: [0, half] });
      joints.push({ name: `${j.name}-telescope`, parent: `${j.name}-telescope-1`, position: [...frame.position], rotation: up.rotation, kind: 'prismatic', axis, limits: [0, half] });
      mechValues[`${j.name}-telescope-1`] = half;
      mechValues[`${j.name}-telescope`] = half;
      parent = `${j.name}-telescope`;
    }
    joints.push({ name: j.name, parent, position: [...frame.position], rotation: frame.rotation, kind: 'spherical', limits });
    // The path moves each axis from its car angle to its mech angle; both path ends are exact.
    const axes = [...new Set([...Object.keys(car), ...Object.keys(target)])] as ('x' | 'y' | 'z')[];
    mechValues[j.name] = Object.fromEntries(axes.map((a) => [a, (target[a] ?? 0) - (car[a] ?? 0)]));
  }

  // Mechanism chains: each unit rides its mech joint through the mechanisms that move it, in phase order.
  const phaseOrder = TRANSFORM.phases.map((p) => p.name);
  const bindings: Record<string, string> = {};
  const created = new Set<string>();
  for (const unit of units) {
    let parent = mechJoint(unit);
    const chain = TRANSFORM.mechanisms.filter((x) => x.moves.includes(unit)).sort((a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase));
    for (const mech of chain) {
      const name = `${mech.id}-on-${parent}`;
      if (!created.has(name)) {
        created.add(name);
        const kind = mech.kind === 'hinge' ? 'revolute' : 'prismatic';
        const lo = Math.min(0, mech.range[0]);
        const hi = Math.max(0, mech.range[1]);
        joints.push({ name, parent, position: [...mech.anchor], kind, axis: [...mech.axis], limits: [lo, hi] });
        mechValues[name] = travel(mech);
      }
      parent = name;
    }
    bindings[unit] = parent;
  }

  const extension = extend?.(joints) ?? {};
  for (const k of extension.keys ?? []) mechValues[k.joint] = k.value;
  const r = rig(m, { joints: [...joints, ...(extension.joints ?? [])], ...(extension.contacts === undefined ? {} : { contacts: extension.contacts }) });
  for (const unit of units) r.bindRigid(sel.tag(`part:${unit}`), bindings[unit] as string, { part: unit });
  for (const p of extension.parts ?? []) {
    r.bindRigid(p.faces, p.joint, { part: p.part });
    bindings[p.part] = p.joint;
  }

  // Path: every joint is keyed explicitly at u = 0 (rest) and at the start and end of the
  // phase that moves it, so a phase moves only its own mechanisms, joints or root.
  const phases: Record<string, readonly [number, number]> = {};
  const rest = (v: number | Angles): number | Angles => (typeof v === 'number' ? 0 : Object.fromEntries(Object.keys(v).map((a) => [a, 0])));
  const movers = (name: string): string[] => {
    const p = TRANSFORM.phases.find((x) => x.name === name);
    if (p === undefined) return [];
    const mech = Object.keys(mechValues).filter((j) => {
      const at = j.indexOf('-on-');
      return at > 0 && TRANSFORM.mechanisms.find((x) => x.id === j.slice(0, at))?.phase === name;
    });
    const telescopes = TRANSFORM.telescopes.filter((t) => t.phase === name).flatMap((t) => [`${t.joint}-telescope-1`, `${t.joint}-telescope`]);
    const keyed = (extension.keys ?? []).filter((k) => k.phase === name).map((k) => k.joint);
    return [...mech, ...telescopes, ...keyed, ...p.joints, ...(p.root ? ['lift', 'root'] : [])];
  };
  const keys: { u: number; pose: Record<string, number | Angles> }[] = [
    { u: 0, pose: Object.fromEntries(Object.entries(mechValues).map(([j, v]) => [j, rest(v)])) },
  ];
  for (const [i, p] of TRANSFORM.phases.entries()) {
    phases[p.name] = p.u;
    const pose: Record<string, number | Angles> = {};
    for (const j of movers(p.name)) pose[j] = mechValues[j] as number | Angles;
    const next = TRANSFORM.phases[i + 1];
    if (next !== undefined) for (const j of movers(next.name)) pose[j] ??= rest(mechValues[j] as number | Angles);
    keys.push({ u: p.u[1], pose });
  }
  const path: PosePath = { keys, interpolation: 'smooth' };
  return { model: m, rig: r, path, bindings, phases };
}
