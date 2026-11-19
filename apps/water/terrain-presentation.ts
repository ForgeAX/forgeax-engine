import { Materials } from '@forgeax/engine/render';
import { surfaceTexture } from './r8-integration-acceptance/assets/procedural';

/** Ordinary authored Terrain layers: the Terrain owner retains projection and streaming. */
export function terrainPresentation(guid: (key: string) => string) {
  const textures = {
    'texture/terrain-rock': surfaceTexture('rock'),
    'texture/terrain-sand': surfaceTexture('sand'),
  };
  const material = (color: readonly [number, number, number, number], texture: string) =>
    Materials.standard({ baseColor: color, roughness: 0.94, baseColorTexture: guid(texture) });
  return {
    textures,
    shore: material([0.55, 0.46, 0.3, 1], 'texture/terrain-sand'),
    grass: material([0.18, 0.27, 0.12, 1], 'texture/terrain-rock'),
    rock: material([0.38, 0.4, 0.34, 1], 'texture/terrain-rock'),
  };
}
