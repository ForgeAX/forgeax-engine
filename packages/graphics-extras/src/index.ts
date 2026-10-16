// @forgeax/engine-graphics-extras -- public barrel.
//
// feat-20260705-runtime-tier2-decomposition M3: pure-logic graphics-adjacent
// modules extracted from @forgeax/engine-runtime. System entry points
// (tilemapChunkExtractSystem / glyphTextLayoutSystem) stay in runtime and
// import from here -- see README.md for the package boundary declaration.

// ─── glyph text layout (feat-20260531-world-space-msdf-text-rendering) ─────
export {
  FONT_CONCURRENCY_LIMIT,
  type GlyphLayoutResult,
  layoutGlyphText,
  resetFontConcurrency,
  trackFontConcurrency,
  VERTEX_OFFSET,
} from './glyph-layout';
export {
  bakeGlyphMesh,
  buildGlyphMeshAsset,
  conservativeCubeAabb,
  type GlyphMeshBakeResult,
} from './glyph-mesh-bake';

// ─── tile-bits SSOT (feat-20260608-tilemap-object-layer-rendering) ─────────
export { decodeTileBits, encodeTileBits } from './tile-bits';
export { tilesetContribution } from './tileset-decoder';
export { videoContribution, videoLoader } from './video-loader';
// ─── VideoPlayer component ────────────────────────────────────────────────
export { VideoPlayer } from './video-player';
// ─── video high-perf upload capability probe ──────────────────────────────
export { probeVideoHighPerfUpload } from './video-player-system';
// ─── VideoSourceProvider host bridge ─────────────────────────────────────
export {
  VIDEO_SOURCE_PROVIDER_KEY,
  type VideoSourceProvider,
  videoSourceExtent,
} from './video-source-provider';
