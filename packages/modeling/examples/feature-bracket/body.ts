import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-123: a cast feature bracket rebuilt under three parameter sets.
 * An L section is extruded, its inner corner filleted, a pocket sunk into the base, a boss
 * raised on the upright and a blind hole sunk into the boss. Every feature face is chosen by
 * what built it (`createdBy`), never by index, so `regen` finds the same operations, the same
 * selector match counts and the same provenance under each set. Straight-line code: tools
 * map every journal entry back to the call on its source line.
 */
export interface FeatureBracketParameters {
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
  /** Segments of the fillet and of the edge round: they change the face count, not the names. */
  readonly segments: number;
}

export const FEATURE_BRACKET_SETS: readonly FeatureBracketParameters[] = [
  { length: 0.14, height: 0.1, thickness: 0.014, depth: 0.09, fillet: 0.01, segments: 4 },
  { length: 0.18, height: 0.12, thickness: 0.016, depth: 0.11, fillet: 0.012, segments: 6 },
  { length: 0.12, height: 0.09, thickness: 0.012, depth: 0.08, fillet: 0.008, segments: 8 },
];

export function buildFeatureBracket(
  p: FeatureBracketParameters = FEATURE_BRACKET_SETS[0] as FeatureBracketParameters,
  session: SessionFactory = () => model(),
): Model {
  const t = p.thickness;

  const b = session('feature-bracket');
  b.extrudePolygon({
    points: [
      [0, 0],
      [p.length, 0],
      [p.length, t],
      [t, t],
      [t, p.height],
      [0, p.height],
    ],
    depth: p.depth,
    label: 'body',
    tag: 'bracket',
  });
  b.checkpoint('section');

  b.bevel(sel.edges.concave(), { width: p.fillet, segments: p.segments, label: 'fillet' });

  b.inset(sel.facing('+y').largest(), {
    thickness: Math.min(p.depth * 0.25, (p.length - t - p.fillet) * 0.3),
    region: 'merged',
    label: 'pocket',
  });
  b.extrude(sel.createdBy('pocket', 'inner'), {
    distance: -t * 0.55,
    region: 'merged',
    label: 'pocket-cut',
  });

  b.inset(sel.facing('-x').largest(), {
    thickness: Math.min(p.depth * 0.28, p.height * 0.3),
    region: 'merged',
    label: 'pad',
  });
  b.extrude(sel.createdBy('pad', 'inner'), { distance: t * 0.7, region: 'merged', label: 'boss' });
  b.checkpoint('features');

  b.inset(sel.createdBy('boss', 'top').one(), {
    thickness: Math.min(p.depth, p.height) * 0.1,
    region: 'merged',
    label: 'hole',
  });
  b.extrude(sel.createdBy('hole', 'inner').one(), {
    distance: -t * 0.5,
    region: 'merged',
    label: 'hole-cut',
  });
  b.checkpoint('hole');

  b.bevel(sel.createdBy('boss', 'side').toEdges('touching').and(sel.edges.concave()), {
    width: t * 0.1,
    segments: Math.max(2, p.segments / 2),
    label: 'boss-fillet',
  });
  b.assign(
    sel.createdBy('pocket-cut').or(sel.createdBy('boss')).or(sel.createdBy('hole-cut')),
    'machined',
  );
  b.uv.project({ mode: 'box', scale: 0.1 });
  return b;
}
