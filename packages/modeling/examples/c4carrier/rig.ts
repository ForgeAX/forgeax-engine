import { type DesignedContact, type FaceSelector, type JointSpec, type Model, type PosePath, type Rig, rig, sel } from '@forgeax/engine-modeling';
import { BARREL_X, ELEVATION, RECOIL, TRAVERSE, TRUNNION } from './proportions.ts';

/**
 * Rigid hierarchy of the heavy turret: barbette (fixed), house on J1 yaw, cradle with
 * mantlet and apron on J2 pitch about the trunnion, one barrel each on the recoil slides
 * J3 and J4. J1 is positive clockwise seen from above, J2 positive lifts the barrels,
 * J3/J4 move the barrels rearward (-Z).
 */
export const TURRET_JOINTS: readonly JointSpec[] = [
  { name: 'root', parent: null, position: [0, 0, 0] },
  { name: 'j1', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: [0, -1, 0], limits: [-TRAVERSE, TRAVERSE] },
  { name: 'j2', parent: 'j1', position: [...TRUNNION], kind: 'revolute', axis: [-1, 0, 0], limits: [...ELEVATION] },
  { name: 'j3', parent: 'j2', position: [BARREL_X, TRUNNION[1], TRUNNION[2]], kind: 'prismatic', axis: [0, 0, -1], limits: [0, RECOIL] },
  { name: 'j4', parent: 'j2', position: [-BARREL_X, TRUNNION[1], TRUNNION[2]], kind: 'prismatic', axis: [0, 0, -1], limits: [0, RECOIL] },
];

export const TURRET_BINDINGS: readonly { readonly part: string; readonly joint: string; readonly faces: FaceSelector }[] = [
  { part: 'barbette', joint: 'root', faces: sel.all() },
  { part: 'house', joint: 'j1', faces: sel.tag('house') },
  { part: 'cradle', joint: 'j2', faces: sel.tag('cradle') },
  { part: 'mantlet', joint: 'j2', faces: sel.tag('mantlet') },
  { part: 'apron', joint: 'j2', faces: sel.tag('apron') },
  { part: 'barrel-port', joint: 'j3', faces: sel.tag('barrel-port') },
  { part: 'barrel-starboard', joint: 'j4', faces: sel.tag('barrel-starboard') },
];

export const TURRET_PARTS = TURRET_BINDINGS.map((b) => b.part);

export function turretRig(m: Model): Rig {
  const r = rig(m, { joints: TURRET_JOINTS });
  for (const b of TURRET_BINDINGS) r.bindRigid(b.faces, b.joint, { part: b.part });
  return r;
}

/** Designed contacts: the pin seats in the house cheeks. */
export const TURRET_CONTACTS: readonly DesignedContact[] = [];

/** One-parameter sweeps: yaw, pitch, recoil at an elevation. */
export function yawPath(pitch: number): PosePath {
  return { interpolation: 'linear', keys: [{ u: 0, pose: { j1: -TRAVERSE, j2: pitch } }, { u: 1, pose: { j1: TRAVERSE, j2: pitch } }] };
}
export function pitchPath(yaw: number): PosePath {
  return { interpolation: 'linear', keys: [{ u: 0, pose: { j1: yaw, j2: ELEVATION[0] } }, { u: 1, pose: { j1: yaw, j2: ELEVATION[1] } }] };
}
export function recoilPath(pitch: number): PosePath {
  return { interpolation: 'linear', keys: [{ u: 0, pose: { j2: pitch, j3: 0, j4: 0 } }, { u: 1, pose: { j2: pitch, j3: RECOIL, j4: RECOIL } }] };
}
