import { type Model, model, sel } from '@forgeax/engine-modeling';

/**
 * C-114 subdivision route: a 40 degree crease across a panel, subdivided twice with
 * and without support loops (2 mm and 5 mm). The tool card shows how the loops keep the
 * crease line crisp.
 */
export function buildCrease(support: boolean): Model {
  const panel = model();
  panel.plane({ width: 0.4, height: 0.3, widthSegments: 8, heightSegments: 6 });
  panel.rotate(sel.inBox([-1, 0.001, -1], [1, 1, 1], { by: 'centroid' }), 'x', 40);
  if (support) panel.supportLoops(sel.edges.dihedral('>', 20), { offset: [0.002, 0.005] });
  panel.subdivide(undefined, { levels: 2 });
  panel.uv.project({ mode: 'box', scale: 1 });
  return panel;
}
