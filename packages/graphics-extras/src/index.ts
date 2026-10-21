// Pure graphics helpers; native GlyphText and Tilemap rendering belong to Render.

// ─── glyph text layout (feat-20260531-world-space-msdf-text-rendering) ─────
export {
  type GlyphLayoutResult,
  layoutGlyphText,
} from './glyph-layout';
export {
  buildGlyphMeshAsset,
  conservativeCubeAabb,
} from './glyph-mesh-bake';

// ─── tile-bits SSOT (feat-20260608-tilemap-object-layer-rendering) ─────────
export { decodeTileBits, encodeTileBits } from './tile-bits';
export { tilesetContribution } from './tileset-decoder';
export { isBrowserResolvableVideoUrl, videoContribution } from './video-loader';
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
