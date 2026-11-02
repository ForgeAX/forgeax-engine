import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { buildBlockout } from './blockout.ts';
import { withDetails } from './g4-details.pack.ts';

/**
 * Case C-200 stage G5 (low-poly faceting). Facet density measured on the sheet
 * (seed-color regions of flat-shaded facets, calibrate thresholds 8 and 12): projected
 * facet edges 0.023-0.051 m, 770-3700 facets per square meter; strands are finer,
 * the back hair, skirt and tail coarser. Each large part is reduced by QEM edge
 * collapses to its surface area over the facet area of its target edge length, with
 * label and material borders kept, then isotropically remeshed to that edge length, and
 * the asset exports with flat normals.
 */
export const FACET_EDGE: Readonly<Record<string, number>> = {
  hair: 0.055,
  dress: 0.034,
  tail: 0.036,
  head: 0.03,
  'arm-l': 0.03,
  'arm-r': 0.03,
};

/** Equilateral triangle area of edge length e. */
const facetArea = (e: number) => (Math.sqrt(3) / 4) * e * e;

/** Surface area of the selected faces (Newell area of each n-gon). */
export function surfaceArea(m: Model, faces: FaceSelector): number {
  let area = 0;
  for (const f of faces.evaluate(m.editMesh)) {
    const p = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i] as number[];
      const b = p[(i + 1) % p.length] as number[];
      nx += ((a[1] as number) - (b[1] as number)) * ((a[2] as number) + (b[2] as number));
      ny += ((a[2] as number) - (b[2] as number)) * ((a[0] as number) + (b[0] as number));
      nz += ((a[0] as number) - (b[0] as number)) * ((a[1] as number) + (b[1] as number));
    }
    area += Math.hypot(nx, ny, nz) / 2;
  }
  return area;
}

/** Target triangle count of a part from its area and facet edge. */
export function facetTarget(m: Model, tag: string): number {
  return Math.max(24, Math.round(surfaceArea(m, sel.tag(tag)) / facetArea(FACET_EDGE[tag] as number)));
}

export function buildLowpoly(): Model {
  const m = buildBlockout(withDetails(), { 'back-bow': 'assembled' });
  for (const tag of Object.keys(FACET_EDGE)) {
    const target = facetTarget(m, tag);
    const triangles = sel
      .tag(tag)
      .evaluate(m.editMesh)
      .reduce((n, f) => n + m.editMesh.faceVertices(f).length - 2, 0);
    // Parts already at or below the measured density (the head) keep their facets.
    if (triangles <= target) continue;
    // QEM alone flattens rounded crowns at this density: reduce to three times the
    // target, then remesh isotropically onto that surface at the facet edge length.
    m.simplify(sel.tag(tag), { targetFaces: Math.min(triangles - 1, target * 3), preserve: { labels: true, materials: true } });
    m.remesh(sel.tag(tag), { targetEdgeLength: FACET_EDGE[tag] as number, iterations: 3, preserve: { labels: true, materials: true } });
    m.checkpoint(`faceted-${tag}`);
  }
  m.triangulate(sel.all());
  return m;
}
