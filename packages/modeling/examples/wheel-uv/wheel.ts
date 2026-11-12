import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-013: UV unwrapping of a tire and a hub cap. The tire is a revolved section
 * with two circumferential grooves and two rows of tread pockets; it is first box
 * projected (the "before" state: overlapping, stretched islands), then cut by two
 * opposite radial seams and two sidewall seams into eight islands and flattened per
 * island with LSCM (pins on the longest boundary loop, solved by the solve.sparse
 * job): the pocketed, grooved tread strips cannot develop and the unwrap warns.
 * Unwrapping again with the sharp edges as seams splits ribs, grooves and pockets
 * into developable pieces, which are then packed. The hub cap (revolved dome with an
 * inset badge and 48 vent pockets) is cut along its sharp edges plus the same radial
 * lines, unwrapped with LSCM, its badge re-unwrapped with ExpMap, and packed. Both
 * parts share one atlas in the wheel session. Straight-line code: tools map every
 * journal entry back to its source line.
 */
export interface WheelParameters {
  /** Depth of the circumferential grooves (meters). */
  readonly grooveDepth: number;
  /** Depth of the tread pockets (meters). */
  readonly pocketDepth: number;
  /** Segments around the axis (rounded up to even). */
  readonly segments: number;
}

export const WHEEL_DEFAULTS: WheelParameters = { grooveDepth: 0.01, pocketDepth: 0.007, segments: 64 };

/** Atlas used by the packs (texels) and the island padding. */
export const ATLAS = { resolution: 1024, padding: 8 } as const;

/**
 * Edges on the radial half-plane x = 0 on the +z side (`side` 1, angle 0) or the -z
 * side (`side` -1, angle 180; needs an even segment count). Two opposite cuts keep
 * every full ring under 180 degrees: a planar ring cut once would flatten onto itself
 * with its two cut sides touching.
 */
export function radialLine(side: 1 | -1 = 1) {
  const [z0, z1] = side === 1 ? [0, 1] : [-1, 0];
  const right = sel.inBox([0, -1, z0], [1, 1, z1], { by: 'centroid' });
  const left = sel.inBox([-1, -1, z0], [0, 1, z1], { by: 'centroid' });
  return right.boundary().and(left.boundary());
}

export function buildWheel(
  p: WheelParameters = WHEEL_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const g = p.grooveDepth;
  const r = 0.33;
  const n = 2 * Math.ceil(p.segments / 2);
  // Sidewalls with their shoulders: faces turned less than 65 degrees from the axis near either rim, minus the tread pockets.
  const tread = sel.createdBy('pocket').or(sel.createdBy('block'));
  const lowerWall = sel.facing('-y', 65).and(sel.inBox([-1, -1, -1], [1, -0.08, 1], { by: 'all' })).minus(tread);
  const upperWall = sel.facing('+y', 65).and(sel.inBox([-1, 0.08, -1], [1, 1, 1], { by: 'all' })).minus(tread);
  const flanks = sel.facing('+y', 45).or(sel.facing('-y', 45));
  const ribs = sel.inBox([-1, -0.0951, -1], [1, -0.0409, 1], { by: 'all' }).or(sel.inBox([-1, 0.0409, -1], [1, 0.0951, 1], { by: 'all' })).minus(flanks);

  // Tire: closed section revolved about +Y (bead, sidewall, shoulder, grooved tread).
  const tire = session('tire');
  tire.revolve({ points: [[0.235, -0.085], [0.25, -0.095], [0.28, -0.105], [0.31, -0.11], [0.325, -0.105], [r, -0.095], [r, -0.041], [r - g, -0.041], [r - g, -0.029], [r, -0.029], [r, 0.029], [r - g, 0.029], [r - g, 0.041], [r, 0.041], [r, 0.095], [0.325, 0.105], [0.31, 0.11], [0.28, 0.105], [0.25, 0.095], [0.235, 0.085], [0.235, -0.085]], segments: n, label: 'tire', material: 'rubber' });
  tire.inset(ribs, { thickness: 0.006, region: 'perFace', label: 'block' });
  tire.extrude(sel.createdBy('block', 'inner'), { distance: -p.pocketDepth, region: 'perFace', label: 'pocket' });
  tire.markSharp(sel.edges.dihedral('>', 40));
  // Before: box projection at the atlas texel density (overlapping, stretched islands).
  tire.uv.project({ mode: 'box', scale: 2 });
  tire.markSeam(radialLine(1).or(radialLine(-1)));
  tire.markSeam(lowerWall.boundary().or(upperWall.boundary()));
  // First attempt: pockets and groove walls keep the long tread strip from developing (the metrics and a warning say so).
  tire.uv.unwrap({ method: 'lscm' });
  // Hard edges become seams too: ribs, groove walls and floors, pocket walls and floors develop on their own.
  tire.uv.unwrap({ method: 'lscm', seams: 'sharp' });
  tire.uv.pack(ATLAS);

  // Hub cap: dome with a chamfered rim, an inset raised badge and 48 vent pockets.
  const cap = session('cap');
  cap.revolve({ points: [[0, -0.01], [0.19, -0.01], [0.2, 0], [0.2, 0.012], [0.19, 0.02], [0.14, 0.035], [0.08, 0.045], [0, 0.05]], segments: 48, label: 'cap', material: 'chrome' });
  cap.inset(sel.inBox([-1, 0.0449, -1], [1, 1, 1], { by: 'all' }), { thickness: 0.012, region: 'merged', label: 'emblem' });
  cap.extrude(sel.createdBy('emblem', 'inner'), { distance: 0.004, region: 'merged', label: 'badge' });
  cap.inset(sel.inBox([-1, 0.0199, -1], [1, 0.0351, 1], { by: 'all' }), { thickness: 0.003, region: 'perFace', label: 'vent' });
  cap.extrude(sel.createdBy('vent', 'inner'), { distance: -0.004, region: 'perFace', label: 'vent-depth' });
  cap.assign(sel.createdBy('badge'), 'badge');
  cap.assign(sel.createdBy('vent-depth'), 'vent');
  cap.markSharp(sel.edges.dihedral('>', 35));
  cap.markSeam(radialLine(1).or(radialLine(-1)));
  cap.uv.unwrap({ method: 'lscm', seams: 'sharp' });
  cap.uv.unwrap({ method: 'expmap', faces: sel.createdBy('badge', 'top') });
  cap.uv.pack(ATLAS);

  // Wheel: both parts in one session and one shared atlas.
  const wheel = session('wheel');
  wheel.append(tire, { tag: 'tire' });
  wheel.append(cap, { translate: [0, 0.09, 0], tag: 'cap' });
  wheel.uv.pack({ resolution: 2048, padding: 8 });
  return wheel;
}
