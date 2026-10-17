/** Build-time terrain entry. Implementation modules never import this facade. */

export { buildTerrainAssets } from './closure.js';
export { type CookedTerrain, type CookedTerrainSection, cookTerrain } from './cook-terrain.js';
