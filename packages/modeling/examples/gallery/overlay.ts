// Shaded mesh + quad edges + B-rep feature lines in one scene: the "mesh edges drawn" look used by the hero and by the
// before/after sheets.
import type { QuadResult } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { EdgeKind } from '../brep-kit/colors.ts';
import type { Image } from '../brep-kit/image.ts';
import { drawLegend, edgeLegend } from '../brep-kit/legend.ts';
import { asPolyMesh, meshSurface, quadNetwork } from '../brep-kit/mesh-scene.ts';
import { renderScene } from '../brep-kit/raster.ts';
import { mergeScenes, type Scene } from '../brep-kit/scene.ts';
import { featureLines } from '../brep-kit/shape-lines.ts';

const KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['convex', 'concave', 'boundary']);
const EDGE_COLOR = [214, 220, 232] as const;

export function overlayScene(shape: Shape, mesh: QuadResult['mesh'], featureWidth = 3.4): Scene {
  const poly = asPolyMesh(mesh);
  const feat = featureLines(shape, { kinds: KINDS }).map((l) => ({
    ...l,
    width: featureWidth,
    bias: 4,
  }));
  const net = quadNetwork(poly, {
    shading: 'plain',
    singularities: true,
    edgeColor: [...EDGE_COLOR],
    edgeWidth: 1,
  });
  return mergeScenes(
    {
      tris: meshSurface(poly, { colorBy: 'part', color: [96, 108, 130], dim: 0.85 }),
      lines: [],
      markers: [],
    },
    { tris: [], lines: net.lines, markers: net.markers },
    { tris: [], lines: feat, markers: [] },
  );
}

export function overlayImage(
  shape: Shape,
  mesh: QuadResult['mesh'],
  view: 'iso' | 'top',
  size: number,
): Image {
  const image = renderScene(overlayScene(shape, mesh, size >= 900 ? 3.4 : 2.2), view, { size });
  if (size < 900) overlayLegend(image, 1);
  return image;
}

export function overlayLegend(image: Image, scale: number): void {
  const entries = [
    ...edgeLegend(['convex', 'concave', 'boundary']),
    { label: 'quad network edge', color: [...EDGE_COLOR] as [number, number, number] },
  ];
  drawLegend(image, 8, image.height - (scale === 1 ? 62 : 116), 'overlay', entries, scale);
}
