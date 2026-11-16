import { standardSurfaceParameters, type MaterialAsset } from '@forgeax/engine/types';

export function standardWaterMaterial(
  color: readonly [number, number, number, number],
  roughness = 0.16,
): MaterialAsset {
  return {
    kind: 'material',
    colorSpace: 'linear',
    parameters: standardSurfaceParameters([]),
    values: { baseColor: color, metallic: 0.02, roughness },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
  };
}
