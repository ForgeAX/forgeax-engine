import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-010: a machined angle bracket finished with bevels. An L section is
 * extruded, its inner corner filleted (a concave round that ends in both side
 * faces), a blind slot is cut into the base and a pad boss raised on the upright.
 * Bevels then chamfer the boss, round the slot (convex rim, concave floor and
 * walls meeting in mixed corners), round every remaining convex edge with
 * patterned corner patches, and fillet the boss foot. Straight-line code: tools map
 * every journal entry back to the call on its source line.
 */
export interface BracketParameters {
  /** Length of the base along +X (meters). */
  readonly length: number;
  /** Height of the upright (meters). */
  readonly height: number;
  /** Plate thickness (meters). */
  readonly thickness: number;
  /** Extrusion depth along +Z (meters). */
  readonly depth: number;
  /** Radius of the inner-corner fillet (meters). */
  readonly fillet: number;
}

export const BRACKET_DEFAULTS: BracketParameters = {
  length: 0.14,
  height: 0.1,
  thickness: 0.014,
  depth: 0.09,
  fillet: 0.01,
};

export function buildBracket(
  p: BracketParameters = BRACKET_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const t = p.thickness;

  // Body: the L section in XY, extruded along +Z.
  const b = session('bracket');
  b.extrudePolygon({ points: [[0, 0], [p.length, 0], [p.length, t], [t, t], [t, p.height], [0, p.height]], depth: p.depth, label: 'body', tag: 'bracket' });
  b.checkpoint('section');

  // Inner corner: a six-segment concave round that ends in the two side faces.
  b.bevel(sel.edges.concave(), { width: p.fillet, segments: 6, label: 'fillet' });

  // Blind slot in the base: inset the base top, sink the inner face (rims stay below a third of the face).
  b.inset(sel.facing('+y').largest(), { thickness: Math.min(p.depth * 0.25, (p.length - t - p.fillet) * 0.3), region: 'merged', label: 'slot' });
  b.extrude(sel.createdBy('slot', 'inner'), { distance: -t * 0.55, region: 'merged', label: 'slot-cut' });

  // Pad boss on the outer face of the upright.
  b.inset(sel.facing('-x').largest(), { thickness: Math.min(p.depth * 0.28, p.height * 0.3), region: 'merged', label: 'pad' });
  b.extrude(sel.createdBy('pad', 'inner'), { distance: t * 0.7, region: 'merged', label: 'boss' });
  b.checkpoint('features');

  // Bevels: chamfer the boss face, round the slot, round every convex edge, fillet the boss foot
  // (asked wider than the rounded boss corners allow: the clamp reports its actual width).
  b.bevel(sel.createdBy('boss', 'top').boundary(), { width: t * 0.12, segments: 1, label: 'boss-chamfer' });
  b.bevel(sel.createdBy('slot-cut', 'side').toEdges('touching').and(sel.edges.dihedral('>', 45)), { width: t * 0.12, segments: 3, label: 'slot-round' });
  b.bevel(sel.edges.dihedral('>', 60).minus(sel.edges.concave()), { width: t * 0.2, segments: 4, label: 'edge-round' });
  b.bevel(sel.createdBy('boss', 'side').toEdges('touching').and(sel.edges.concave()), { width: t * 0.1, segments: 2, label: 'boss-fillet' });
  b.checkpoint('bevelled');

  // Finish: machined surfaces get their own slot; remaining creases stay crisp.
  b.assign(sel.createdBy('slot-cut').or(sel.createdBy('slot-round')).or(sel.createdBy('boss')).or(sel.createdBy('boss-chamfer')), 'machined');
  b.markSharp(sel.edges.dihedral('>', 40));
  b.uv.project({ mode: 'box', scale: 0.1 });
  return b;
}
