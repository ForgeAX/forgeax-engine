// brep-kit: headless, deterministic pictures of B-rep Shapes and quad meshes (pure TypeScript, no GPU).
//
//   import { renderShape, contactSheet } from '../brep-kit/index.ts';
//   const r = renderShape(shape, { outDir, name: 'part-' });              // shaded + features + iso x iso/front/top/side
//   renderShape(quadMesh, { outDir, modes: ['network', 'jacobian'] });  // quad network, singular vertices, Jacobian heat
//   renderShape([a, b], { modes: ['shaded'], views: ['iso', 'iso-back'] }); // assemblies get one colour per part
//   contactSheet(r.value.views.map((v) => ({ image: v.image, caption: `${v.mode} ${v.view}` })), { columns: 4, path });
//   r.value.summary.edges / r.value.summary.quad: edge counts per kind, quad valence and Jacobian statistics.
export { STANDARD_VIEWS, type ViewSpec, viewBasis } from './camera.ts';
export { EDGE_KINDS, EDGE_STYLES, type EdgeKind, heatColor } from './colors.ts';
export { createImage, drawText, type Image, type RGB, resize, toPng } from './image.ts';
export { drawHeatBar, drawLegend, edgeLegend, type LegendEntry, valenceLegend } from './legend.ts';
export {
  asPolyMesh,
  type NetworkOptions,
  type PolyMesh,
  polyMeshOf,
  type QuadStats,
  quadNetwork,
  quadStats,
  scaledJacobian,
  silhouetteLines,
} from './mesh-scene.ts';
export { type RenderOptions, renderScene } from './raster.ts';
export {
  type Mode,
  type Part,
  type RenderedView,
  type RenderResult,
  type RenderShapeOptions,
  renderShape,
} from './render.ts';
export {
  mergeScenes,
  type Scene,
  type SceneLine,
  type SceneMarker,
  type SceneTri,
} from './scene.ts';
export {
  type ClassifiedEdge,
  classifyEdges,
  countByKind,
  faceUvLoops,
  featureLines,
  type IsoCount,
  type IsoOptions,
  isoLines,
} from './shape-lines.ts';
export { contactSheet, type SheetCell, type SheetOptions } from './sheet.ts';
