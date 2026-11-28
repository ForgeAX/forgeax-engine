import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { Atmosphere, VolumetricCloudLayer } from '@forgeax/engine/render';
import { Name } from '@forgeax/engine/scene';
import { cloudGuid as guid } from '@forgeax-assets/volumetric-clouds/references';
import { UE_CLOUD_SCENE_PRESET } from '@forgeax-assets/volumetric-clouds/reference';
import sharedPack, { referenceParameters } from '../../../../forgeax-engine-assets/demo-assets/volumetric-clouds/assets/clouds.pack.ts';
import { bakeCloudTextures } from './gpu-bake.ts';
import { referenceGpuRecipe } from './reference-gpu.ts';

// This project's GPU build uses the shared material and parameter identities.

const packageId = definePackageId(sharedPack.packageId);

const analyticUniformKey = 'material/analytic-uniform';
const referenceMaterialKey = 'material/reference-layout';

const bandParameters = {
  centerMeters: { kind: 'scalar', default: 0, unit: 'm', range: [-100_000, 100_000] },
  halfWidthMeters: { kind: 'scalar', default: 800, unit: 'm', range: [1, 100_000] },
  extinctionPerMeter: { kind: 'scalar', default: 0.002, unit: 'm^-1', range: [0, 1] },
} as const;

function material(source: object) {
  return { kind: 'cloud-material', execution: 'cooked', source } as const;
}

function instance(source: object) {
  return { kind: 'cloud-material-instance', execution: 'cooked', source } as const;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  sceneComponents: [Name, Atmosphere, VolumetricCloudLayer],
  parameters: sharedPack.parameters,
  async build({ values }) {
    const textures = await bakeCloudTextures({
      'texture/layout-pattern': referenceGpuRecipe('pattern', values),
      'texture/layout-mask': referenceGpuRecipe('mask', values),
      'texture/height-profile': referenceGpuRecipe('profile', values),
      'texture/body-noise': referenceGpuRecipe('body', values),
    });
    return ok({
      ...textures,
      'scene/sky': {
        kind: 'scene',
        entities: {
          atmosphere: { components: {
            Name: { value: 'Cloud Atmosphere' },
            Atmosphere: { backgroundOnly: false },
          } },
          clouds: { components: {
            Name: { value: 'Procedural Volumetric Clouds' },
            VolumetricCloudLayer: {
              material: guid(referenceMaterialKey),
              ...UE_CLOUD_SCENE_PRESET,
              requestRevision: 1,
            },
          } },
        },
      },
      [analyticUniformKey]: material({
        version: 1,
        model: {
          kind: 'uniform',
          sample: {
            extinctionPerMeter: 0.00012,
            albedo: [0.95, 0.95, 0.95],
            emissivePerMeter: [0, 0, 0],
            materialAO: 1,
          },
        },
        parameters: {},
      }),
      [referenceMaterialKey]: material({
        version: 1, model: { kind: 'program', source: 'reference-layout.wgsl' }, parameters: referenceParameters,
      }),
      'instance/reference-default': instance({
        version: 1, material: guid(referenceMaterialKey), parameters: referenceParameters, overrides: {},
      }),
      'instance/reference-detail': instance({
        version: 1, material: guid(referenceMaterialKey), parameters: referenceParameters, overrides: { useDetail: true },
      }),
      'material/cloud-band': material({
        version: 1, model: { kind: 'program', source: 'cloud-band.wgsl' }, parameters: bandParameters,
      }),
      'instance/cloud-band-wide': instance({
        version: 1, material: guid('material/cloud-band'), parameters: bandParameters, overrides: { halfWidthMeters: 1600 },
      }),
    });
  },
});
