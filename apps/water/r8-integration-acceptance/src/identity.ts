import { definePackageId } from '@forgeax/engine/pack/source';
export const WATER_R8_PACKAGE = definePackageId('019fcf2d-8100-7000-8000-000000000281');
export const WATER_R8_SCOPE = 'water-r8-integration-acceptance';
export const COAST_SEED = 0x831fa27;
export const SUN_DIRECTION = [-0.45, -0.8, -0.32] as const;
export const COAST_MESH_PROFILES = {
  coast64: { tessellationFactor: 3, quadsPerEdge: 64 },
  reference256: { tessellationFactor: 8, quadsPerEdge: 256 },
} as const;
export const IRON_BALL_RADIUS_M = 0.6;
export const IRON_BALL_MASS_KG = 7800 * (4 / 3) * Math.PI * IRON_BALL_RADIUS_M ** 3;
export const COAST_SHIP_ROUTE = { centerXZ: [-16, -62] as const, radiusM: Math.hypot(16, 62) };
export const COAST_FOAM_CAPTURE = {
  centerM: [COAST_SHIP_ROUTE.centerXZ[0], 0, COAST_SHIP_ROUTE.centerXZ[1]] as const,
  extentM: 224,
  resolution: 1280,
};
// Without renewed emission, coverage falls to five percent in approximately 1.7 seconds.
export const COAST_FOAM_DECAY_PER_SECOND = 1.8;
