import { Materials } from '@forgeax/engine/render';
import type { MaterialAsset } from '@forgeax/engine/types';

export function standardWaterMaterial(
  color: readonly [number, number, number, number],
  roughness = 0.16,
): MaterialAsset {
  return Materials.standard({ baseColor: color, metallic: 0.02, roughness });
}
