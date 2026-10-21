import type { MaterialParameter } from './asset.js';
import { standardSurfaceParameters } from './standard-schema.js';

/** Fixed Terrain material ABI. Section and view values occupy this shared layout. */
export const TERRAIN_MATERIAL_PARAMETERS: readonly MaterialParameter[] = standardSurfaceParameters([
  { name: 'terrainHeightTexture', type: 'texture' },
  { name: 'terrainWeightTexture', type: 'texture' },
  { name: 'terrainColorLayers', type: 'texture_2d_array' },
  { name: 'terrainNormalHeightLayers', type: 'texture_2d_array' },
  { name: 'terrainOrmLayers', type: 'texture_2d_array' },
  { name: 'terrainEmissionLayers', type: 'texture_2d_array' },
  { name: 'terrainLayerIndices', type: 'vec4', default: [0, -1, -1, -1] },
  { name: 'terrainSection', type: 'vec4', default: [0, 0, 1, 2] },
  { name: 'terrainLod', type: 'vec4', default: [0, 0, 0, 1] },
  { name: 'terrainNeighbors', type: 'vec4', default: [0, 0, 0, 0] },
  { name: 'terrainShadowFamily', type: 'f32', default: 0 },
  { name: 'terrainLayerModes', type: 'vec4', default: [0, 3, 3, 3] },
]);
