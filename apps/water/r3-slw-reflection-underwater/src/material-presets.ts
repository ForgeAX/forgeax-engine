import type { MaterialValue } from '@forgeax/engine/types';
import type { WaterMaterialFamilyKey } from '@forgeax/engine/water';

export const CLEAR_WATER_MATERIAL_KEYS = [
  'river',
  'lake',
  'ocean',
  'custom',
  'river-to-lake',
  'river-to-ocean',
  'river-lod',
  'lake-lod',
  'ocean-lod',
  'custom-lod',
  'far',
  'hlod',
] as const satisfies readonly WaterMaterialFamilyKey[];

export const CLEAR_WATER_VALUES = {
  criticalAngleWidth: 0.3,
  refractionPixelNormalStrength: 1.02,
  distantRefractionPixelNormalStrength: 1.005,
  refractionBottomAmount: 0.25,
  lipRefraction: 1,
} satisfies Readonly<Record<string, MaterialValue>>;
