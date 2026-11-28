import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { analyticUniformCloudRef, referenceCloudRef, bandCloudRef, bandWideInstanceRef } from '@forgeax-assets/volumetric-clouds/references';
import { alpineTextureSetRef, ueTextureSetRef } from './cloud-texture-sets.pack.ts';
import { GROUND_SCENE_COMPONENTS, GROUND_SCENE_KEY, groundReferenceScene } from './ground-scene.ts';
import { terrainRefs } from './terrain.pack.ts';
import { nubisInstanceGuid } from './nubis/clouds.pack.ts';
import { NUBIS_MODES } from './nubis/presets.ts';

const packageId = definePackageId('019a50a5-0000-7000-8000-000000000001');

export default definePack({
  schemaVersion: '2.0.0',
  plugins: true,
  packageId,
  sceneComponents: GROUND_SCENE_COMPONENTS,
  build: () => ok({
    [GROUND_SCENE_KEY]: groundReferenceScene({
      ground: terrainRefs.ground.$asset,
      groundMaterial: terrainRefs.groundMaterial.$asset,
      occluder: terrainRefs.occluder.$asset,
      occluderMaterial: terrainRefs.occluderMaterial.$asset,
      cloudMaterial: referenceCloudRef.$asset,
    }),
    'plugin/build': {
      kind: 'plugin', module: { specifier: './build.ts', export: 'build' },
    },
    'plugin/engine': {
      kind: 'plugin', module: { specifier: './game.ts', export: 'engine' },
      config: {
        scene: { $asset: AssetGuid.format(AssetGuid.derive(packageId, GROUND_SCENE_KEY)) },
        cloudMaterial: analyticUniformCloudRef, referenceCloudMaterial: referenceCloudRef,
        sampleUeTextureSet: ueTextureSetRef,
        alpineTextureSet: alpineTextureSetRef,
        bandCloudMaterial: bandCloudRef, bandWideInstance: bandWideInstanceRef,
        nubisInstances: Object.fromEntries(NUBIS_MODES.map(mode => [mode, nubisInstanceGuid(mode)])),
      },
    },
    'plugin/frontend': {
      kind: 'plugin', module: { specifier: './ui/hud.ts', export: 'frontend' },
      config: { hud: { $asset: '019a50a5-0000-7000-8000-000000000003' } },
    },
  }),
});
