import { definePack } from '@forgeax/engine-pack/source';
import { ok, type SamplerAsset } from '@forgeax/engine-types';
import { buildWaterMaterialFamily } from '@forgeax/engine-water';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS, contentGuid, contentWaterTextureGuid } from '../../src/ids.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.water,
  name: 'Engine Content / Water',
  build: () => {
    const sampler = contentGuid(CONTENT_PACKAGE_IDS.water, CONTENT_SOURCE_KEYS.waterSampler);
    const texture = (name: Parameters<typeof CONTENT_SOURCE_KEYS.waterTexture>[0]) => ({
      texture: contentWaterTextureGuid(name), sampler,
    });
    const family = buildWaterMaterialFamily(CONTENT_PACKAGE_IDS.water, 'material/water', {
      waterNormalTexture: texture('normal'),
      waterFlowTexture: texture('river-diffuse'),
      waterFlowNormalTexture: texture('river-normal'),
      waterFoamTexture: texture('foam'),
      waterFoamNormalTexture: texture('foam-normal'),
      waterNoiseTexture: texture('noise'),
      waterVolumeNoiseTexture: texture('volume-noise'),
    });
    return ok({
      ...family.outputs,
      [CONTENT_SOURCE_KEYS.waterSampler]: {
        kind: 'sampler', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat',
        minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16,
      } satisfies SamplerAsset,
    });
  },
});
