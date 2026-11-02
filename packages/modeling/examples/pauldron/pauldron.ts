import { type Model, model, type Pose, type Rig, type RigSpec, rig, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { MECH } from '../mech-gt/proportions.ts';

/**
 * Case C-014 (C-100 part, code name mech-gt): the left shoulder armor of the mech. A
 * low-poly plate gets a recessed panel with a raised spine, its detail edges marked
 * sharp; Catmull-Clark subdivision rounds the plate while the creases keep the panel
 * lines crisp; a lattice domes it, a taper narrows the outer end and a bend curls it
 * over the shoulder ball. A chest-side mount bracket is built the same way. A rig over
 * the mech-gt skeleton (`joints.json`) binds the plate rigidly to `shoulder-l` and the
 * mount to `chest`, so poses move them with the mech.
 * Straight-line code: tools map every journal entry back to its source line.
 */
export interface PauldronParameters {
  /** Plate length across the shoulder before bending (meters). */
  readonly length: number;
  /** Plate width front to back (meters). */
  readonly width: number;
  /** Total curl over the shoulder (degrees). */
  readonly curl: number;
}

export const PAULDRON_DEFAULTS: PauldronParameters = { length: 0.7, width: 0.9, curl: 105 };

/** The mech-gt skeleton as a rig: spherical joints with their degree-of-freedom limits. */
export const MECH_RIG: RigSpec = {
  joints: MECH.joints.map((j) => ({
    name: j.name,
    parent: j.parent,
    position: [...j.position],
    ...(j.dof.length === 0
      ? {}
      : { kind: 'spherical' as const, limits: Object.fromEntries(j.dof.map((d) => [d.axis, [d.min, d.max] as const])) }),
  })),
};

/** Second pose of the case: the left arm raised sideways and the chest turned. */
export const RAISED: Pose = { 'shoulder-l': { z: 45, x: -15 }, chest: { y: 10 } };

export const SHOULDER = MECH.joints.find((j) => j.name === 'shoulder-l')?.position ?? [0, 0, 0];

export function buildPauldron(
  p: PauldronParameters = PAULDRON_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const half = p.length / 2;
  const band = p.width / 4 + 0.005;
  const rim = p.length / 10;
  const [sx, sy, sz] = SHOULDER as [number, number, number];

  // Low-poly plate: a 6 x 4 grid on top, a recessed panel and a raised spine.
  const m = session('pauldron');
  m.box({ size: [p.length, 0.1, p.width], segments: [6, 1, 4], label: 'plate', tag: 'pauldron' });
  m.inset(sel.tag('pauldron').and(sel.facing('+y')), { thickness: rim, region: 'merged', label: 'panel' });
  m.extrude(sel.createdBy('panel', 'inner').and(sel.inBox([-1, -1, -band], [1, 1, band])), { distance: 0.02, region: 'merged', label: 'spine' });
  m.extrude(sel.createdBy('panel', 'inner'), { distance: -0.012, region: 'perIsland', label: 'recess' });
  m.markSharp(sel.createdBy('spine').or(sel.createdBy('recess')).toEdges('touching'));

  // Smooth armor: the rim rolls into a rounded lip, the creased panel lines stay crisp.
  // (A rim much narrower than a tenth of the length folds at the corners; subdivide reports it.)
  m.subdivide(undefined, { levels: 2 });

  // Shape it to the shoulder: dome, narrow the outer end, curl it over the ball.
  m.lattice(sel.all(), { resolution: [3, 2, 3], offsets: [{ index: [1, 0, 1], offset: [0, 0.07, 0] }, { index: [1, 1, 1], offset: [0, 0.07, 0] }] });
  m.taper(sel.all(), { axis: 'x', factor: 0.72, axes: ['z'] });
  m.bend(sel.all(), { axis: 'x', toward: '-y', angle: p.curl, range: [-half + 0.1, half] });
  m.translate(sel.all(), [sx + 0.06, sy + 0.34, sz]);

  // Chest-side mount bracket with rounded ends, below the plate's swept inner edge.
  const mount = session('mount');
  mount.box({ size: [0.22, 0.16, 0.5], center: [sx - 0.2, sy - 0.22, sz], segments: [2, 1, 2], label: 'mount', tag: 'collar' });
  mount.markSharp(sel.edges.parallel('x'));
  mount.subdivide(undefined, { levels: 2 });

  // Assemble, color, bind to the mech skeleton, project UVs.
  m.append(mount);
  m.assign(sel.tag('pauldron'), 'paint');
  m.assign(sel.createdBy('spine'), 'trim');
  m.assign(sel.createdBy('recess', 'top'), 'panel');
  m.assign(sel.tag('collar'), 'steel');
  m.uv.project({ mode: 'box', scale: 0.25 });
  return m;
}

/** Bind the part to the mech skeleton: the plate follows `shoulder-l`, the mount `chest`. */
export function rigPauldron(m: Model): Rig {
  const r = rig(m, MECH_RIG);
  r.bindRigid(sel.tag('pauldron'), 'shoulder-l', { part: 'pauldron' });
  r.bindRigid(sel.tag('collar'), 'chest', { part: 'mount' });
  return r;
}
