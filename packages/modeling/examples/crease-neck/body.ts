import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-126: a head-like all-quad cage whose top rim is a half-sharp crease. A box is
 * subdivided once (eight valence-3 poles), its top is tapered so the rim folds, the rim edges
 * get a fractional crease sharpness, and the refined cage snaps onto the closed-form limit with
 * the rim kept as a tight but not razor-sharp edge. Straight-line code: tools map every journal
 * entry back to the call on its source line.
 */
export interface CreaseNeckParameters {
  /** Box size (meters). */
  readonly size: readonly [number, number, number];
  /** Horizontal scale of the top faces about the axis. */
  readonly taper: number;
  /** DeRose crease sharpness of the rim (levels of full crease). */
  readonly sharpness: number;
}

export const CREASE_NECK: CreaseNeckParameters = {
  size: [0.2, 0.16, 0.14],
  taper: 0.7,
  sharpness: 1.5,
};

export function buildCreaseNeck(
  p: CreaseNeckParameters = CREASE_NECK,
  session: SessionFactory = () => model(),
): Model {
  const b = session('crease-neck');
  b.box({ size: [...p.size], label: 'block', tag: 'cage' });
  b.subdivide(undefined, { levels: 1, scheme: 'simple' });
  b.checkpoint('cage');

  b.scale(sel.facing('+y'), [p.taper, 1, p.taper]);
  b.markCrease(sel.facing('+y').boundary(), p.sharpness);
  b.checkpoint('rim-crease');

  b.subdivide(undefined, { levels: 1 });
  b.snapToLimit(sel.all());
  b.checkpoint('limit');

  b.uv.project({ mode: 'box', scale: 0.1 });
  return b;
}
