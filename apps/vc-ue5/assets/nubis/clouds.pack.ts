import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { referenceCloudRef } from '@forgeax-assets/volumetric-clouds/references';
import { referenceParameters } from '../../../../forgeax-engine-assets/demo-assets/volumetric-clouds/assets/clouds.pack.ts';
import { NUBIS_MODES, type NubisMode } from './presets.ts';
import { bakeCloudTextures } from './gpu-bake.ts';
import { nubisGpuRecipe } from './nubis-gpu.ts';
import { NUBIS_ROLES, type NubisRole } from './textures.ts';

const packageId = definePackageId('2d3ae2e5-36e2-48cb-a842-6cfc6661c026');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const textureKey = (mode: NubisMode, role: NubisRole) => `${mode}/texture/${role}`;
const materialKey = (mode: NubisMode) => `${mode}/material`;
export const nubisInstanceGuid = (mode: NubisMode) => guid(materialKey(mode));

const textureRoles = {
  layoutPattern: 'layout-pattern',
  layoutMask: 'layout-mask',
  heightProfile: 'height-profile',
  bodyNoise: 'body-noise',
} as const satisfies Record<string, NubisRole>;

export function nubisInstanceSource(mode: NubisMode) {
  const overrides = Object.fromEntries(Object.entries(textureRoles).map(([name, role]) =>
    [name, guid(textureKey(mode, role))]));
  return {
    version: 1 as const, material: referenceCloudRef.$asset, parameters: referenceParameters, overrides,
  };
}

async function buildNubisClouds(modes: readonly NubisMode[]) {
  const recipes = Object.fromEntries(modes.flatMap(mode =>
    NUBIS_ROLES.map(role => [textureKey(mode, role), nubisGpuRecipe(mode, role)] as const)));
  const textures = await bakeCloudTextures(recipes);
  return ok({
    ...textures,
    ...Object.fromEntries(modes.map(mode => [materialKey(mode), {
      kind: 'cloud-material-instance', execution: 'cooked', source: nubisInstanceSource(mode),
    }] as const)),
  });
}

export default definePack({
  schemaVersion: '2.0.0', packageId,
  build: () => buildNubisClouds(NUBIS_MODES),
});
