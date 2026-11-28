// Renders the housing with brep-kit: shaded, feature lines, iso lines, quad network.
// `quadrangulate` is exact-stage L2 and does not yet accept planar faces with holes; parts it
// rejects are reported (not hidden) and left out of the quad views.

import { quadrangulate } from '../../src/brep/quad.ts';
import type { Face, Shape } from '../../src/brep/types.ts';
import { contactSheet, type PolyMesh, renderShape, type SheetCell } from '../brep-kit/index.ts';
import { asPolyMesh } from '../brep-kit/mesh-scene.ts';
import { buildHousing, type HousingPart } from './housing.ts';

export interface ShowcaseResult {
  readonly parts: readonly HousingPart[];
  readonly quadParts: readonly string[];
  readonly quadRejected: readonly { readonly name: string; readonly reason: string }[];
  readonly edgeCounts: Record<string, number>;
  readonly sheet: string;
}

/** Narrow four-sided planar walls (flange rim facets, ribs) get one line per direction; everything else 6. */
function isoCount(face: Face, _index: number, shape: Shape): number {
  const outer = shape.loops[face.loops[0] as number];
  const plane = shape.surfaces[face.surface]?.kind === 'plane';
  return plane && outer?.coedges.length === 4 ? 1 : 6;
}

export function renderHousing(outDir: string, size = 640): ShowcaseResult {
  const parts = buildHousing();
  const shapes = parts.map((p) => p.shape);
  const cells: SheetCell[] = [];
  const common = { outDir, size, silhouette: false } as const;

  const exact = renderShape(shapes, {
    ...common,
    modes: ['shaded', 'features', 'iso'],
    iso: { count: isoCount },
  });
  if (!exact.ok) throw new Error(JSON.stringify(exact.error));
  for (const v of exact.value.views)
    cells.push({ image: v.image, caption: `exact ${v.mode} ${v.view}` });

  const quadParts: string[] = [];
  const quadRejected: { name: string; reason: string }[] = [];
  const meshes: PolyMesh[] = [];
  for (const p of parts) {
    const q = quadrangulate(p.shape, { size: 4 });
    if (q.ok) {
      quadParts.push(p.name);
      meshes.push(asPolyMesh(q.value.mesh));
    } else {
      const d = q.error.detail as { reason?: string } | undefined;
      quadRejected.push({ name: p.name, reason: d?.reason ?? q.error.code });
    }
  }
  if (meshes.length > 0) {
    const ghost = parts
      .filter((p) => quadRejected.some((r) => r.name === p.name))
      .map((p) => p.shape);
    const quad = renderShape(meshes, {
      ...common,
      name: 'quad-',
      modes: ['network', 'jacobian'],
      ghost,
    });
    if (!quad.ok) throw new Error(JSON.stringify(quad.error));
    for (const v of quad.value.views)
      cells.push({ image: v.image, caption: `quad ${v.mode} ${v.view}` });
  }
  const sheet = `${outDir}/housing-sheet.png`;
  contactSheet(cells, {
    columns: 4,
    cell: 360,
    title: 'Flanged housing: exact views and quad networks',
    path: sheet,
  });
  return { parts, quadParts, quadRejected, edgeCounts: { ...exact.value.summary.edges }, sheet };
}
