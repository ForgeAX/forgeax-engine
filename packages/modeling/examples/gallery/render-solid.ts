// The standard renders of one solid: shaded iso, feature-line iso, and the quad network (iso and top) of a result.
import type { QuadResult } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { Image } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/render.ts';
import { caption, EDGE_KINDS_SHOWN, must } from './common.ts';

const SIZE = 640;

function pick(views: readonly { mode: string; view: string; image: Image }[], mode: string): Image {
  const found = views.find((v) => v.mode === mode);
  if (found === undefined) throw new Error(`missing ${mode} view`);
  return found.image;
}

/** Shaded and feature-line iso images (kinds convex/concave/boundary), unlabeled. */
export function shapeImages(shape: Shape, view: 'iso' | 'top' | 'iso-back' = 'iso', size = SIZE) {
  const r = must(
    renderShape(shape, {
      views: [view],
      modes: ['shaded', 'features'],
      kinds: [...EDGE_KINDS_SHOWN],
      size,
      label: false,
      legend: 'none',
      silhouette: true,
    }),
  );
  return { shaded: pick(r.views, 'shaded'), features: pick(r.views, 'features') };
}

/** Quad network of a result in the requested views; Jacobian-free plain network with singular markers. */
export function networkImages(
  result: QuadResult,
  views: readonly ('iso' | 'top')[] = ['iso', 'top'],
  size = SIZE,
): Record<string, Image> {
  const r = must(
    renderShape(result.mesh, {
      views,
      modes: ['network'],
      size,
      label: false,
      legend: 'none',
    }),
  );
  return Object.fromEntries(r.views.map((v) => [v.view, v.image]));
}

export { caption };
