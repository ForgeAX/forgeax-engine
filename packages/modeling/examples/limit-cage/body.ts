import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-124: a head-like all-quad cage tiled from its Catmull-Clark limit
 * surface. A box is subdivided once (eight valence-3 poles, regular elsewhere), its top is
 * tapered, and every vertex snaps onto the closed-form limit point; the cage is symmetric
 * about x = 0, so the snapped vertices mirror bitwise. Straight-line code: tools map every
 * journal entry back to the call on its source line.
 */
export interface LimitCageParameters {
  /** Box size (meters). */
  readonly size: readonly [number, number, number];
  /** Horizontal scale of the top faces about the axis. */
  readonly taper: number;
}

export const LIMIT_CAGE: LimitCageParameters = { size: [0.2, 0.16, 0.14], taper: 0.7 };

export function buildLimitCage(
  p: LimitCageParameters = LIMIT_CAGE,
  session: SessionFactory = () => model(),
): Model {
  const b = session('limit-cage');
  b.box({ size: [...p.size], label: 'block', tag: 'cage' });
  b.subdivide(undefined, { levels: 1, scheme: 'simple' });
  b.checkpoint('cage');

  b.scale(sel.facing('+y'), [p.taper, 1, p.taper]);
  b.checkpoint('taper');

  b.subdivide(undefined, { levels: 1 });
  b.snapToLimit(sel.all());
  b.checkpoint('limit');

  b.uv.project({ mode: 'box', scale: 0.1 });
  return b;
}
