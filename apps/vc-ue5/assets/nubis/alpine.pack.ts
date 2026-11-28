import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { ALPINE_ROLES, type AlpineTextureRole } from './alpine-textures.ts';

import { bakeCloudTextures } from './gpu-bake.ts';
import { alpineGpuRecipe } from './alpine-gpu.ts';

const packageId = definePackageId('ea4f34ea-9df6-4d19-84e5-90d2740d2d6d');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
const textureKey = (role: AlpineTextureRole) => `alpine-valley/texture/${role}`;
export const alpineTextureGuid = (role: AlpineTextureRole) => guid(textureKey(role));

export default definePack({
  schemaVersion: '2.0.0', packageId,
  build: async () => ok(await bakeCloudTextures(Object.fromEntries(
    ALPINE_ROLES.map(role => [textureKey(role), alpineGpuRecipe(role)]),
  ))),
});
