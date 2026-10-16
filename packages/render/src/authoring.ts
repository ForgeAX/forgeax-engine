// Optional authoring features intentionally live outside the base render vocabulary.
// Systems, asset resolution, and registry details remain owner-local.

export { GlyphText } from './components/glyph-text';
export { SpriteAnimation } from './components/sprite-animation';
export { SpriteInstances, type SpriteInstancesData } from './components/sprite-instances';
export { SpritePlayback, spritePlaybackModeFromU32 } from './components/sprite-playback-mode';
export { SpriteRegionOverride } from './components/sprite-region-override';
export { TileLayer, TilemapSort } from './components/tile-layer';
export { Tilemap } from './components/tilemap';
export {
  createFullscreenRenderFeature,
  type FullscreenRenderFeatureOptions,
} from './features/fullscreen';
export { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from './materials';
// Typed graph composition for custom material outputs. Renderer owns execution.
export {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
  type RenderPipelineTarget,
} from './render-pipeline';
export { setActiveCamera } from './systems/active-camera';
export { TransparentSort } from './systems/transparent-sort-config';
export {
  addTypedOutputTransformPass,
  addTypedScenePass,
  type TypedScenePassOptions,
} from './typed-render-graph-primitives';
