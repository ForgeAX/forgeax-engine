import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { GI_MATERIALS, type GiMaterialName, type GiMaterialSpec } from './scenes.ts';

/** Authored Standard root for one GI table entry; both Pack and the Node harness cook it. */
export function giMaterialAsset(name: GiMaterialName): MaterialAsset {
  const spec: GiMaterialSpec = GI_MATERIALS[name];
  return Materials.standard({
    baseColor: [...spec.baseColor, 1],
    roughness: spec.roughness,
    metallic: 0,
    specular: 0,
    ...(spec.emissive === undefined
      ? {}
      : { emissive: [...spec.emissive], emissiveIntensity: spec.emissiveIntensity ?? 1 }),
  });
}
