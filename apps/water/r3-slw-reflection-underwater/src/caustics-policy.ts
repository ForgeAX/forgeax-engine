// Authored demo policy. Runtime Engine modules select no light or receiver.
export const CAUSTICS_SUN_DIRECTION = [-0.45, -0.8, -0.3] as const;
export const CAUSTICS_SUN_INTENSITY = 2.6;
export const CAUSTICS_GRID = 192;
export const CAUSTICS_PLANE_Y = -4.5;
export const CAUSTICS_FIELD = {
  name: 'water-r3-caustics-field',
  resolution: 512,
  sourceGrid: CAUSTICS_GRID,
  encoding: 'light-scaled-irradiance',
} as const;

export { WATER_CAUSTICS_REACTIVITY_OUTPUT as CAUSTICS_REACTIVITY_OUTPUT } from '@forgeax/engine/water/caustics';
