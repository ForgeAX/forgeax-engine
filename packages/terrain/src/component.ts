import { defineComponent } from '@forgeax/engine-ecs';

/** Terrain pose is supplied by the ordinary Scene Transform. */
export const Terrain = defineComponent('Terrain', {
  asset: { type: 'shared<TerrainAsset>' },
  /** Projected screen diameter at which a subsection uses LOD0. */
  lod0Diameter: { type: 'f32', default: 1 },
  /** Negative selects from screen size; nonnegative freezes a fractional LOD. */
  forcedLod: { type: 'f32', default: -1 },
});
