export type {
  TerrainAsset,
  TerrainError,
  TerrainErrorCode,
  TerrainLayer,
  TerrainMaterialEncoding,
  TerrainSection,
  TerrainSource,
} from '@forgeax/engine-types';
export { terrainDerivedClosureValid } from './closure.js';
export { Terrain } from './component.js';
export {
  decodeTerrainHeight,
  encodeTerrainHeight,
  terrainHeightAtlas,
  terrainHeightMipOffset,
} from './height-atlas.js';
export {
  terrainAxisEndpoint,
  terrainHeightBounds,
  terrainTranslationValid,
} from './height-bounds.js';
export {
  createTerrainLayerPlan,
  TERRAIN_CHANNEL_TEXTURES,
  type TerrainMaterialChannels,
  terrainMaterialChannels,
} from './layer-plan.js';
export { terrainLod, terrainVertexCoordinates } from './lod.js';
export { terrainHeight, terrainHeightfield, terrainSampleHeight } from './query.js';
export {
  type TerrainSurface,
  terrainSurfaceHeight,
  terrainSurfaceVertex,
} from './submitted-surface.js';
export { terrainDerivedLayoutValid, validateTerrain } from './validation.js';
