import type { CloudMaterialSource, CloudParameter } from '@forgeax/engine/render/authoring';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { err, ok } from '@forgeax/engine/types';
import { referenceCloudRef } from '@forgeax-assets/volumetric-clouds/references';
import { standardUeGuid } from '@forgeax-assets/ue-volumetric-clouds/references';
import { alpineTextureGuid } from './nubis/alpine.pack.ts';
import type { AlpineTextureRole } from './nubis/alpine-textures.ts';

const packageId = definePackageId('9a15e747-cf82-4e9a-9b74-7d74d3f9f064');
const instanceRef = (key: string) => ({ $asset: AssetGuid.format(AssetGuid.derive(packageId, key)) });
export const ueTextureSetRef = instanceRef('instance/sample-ue');
export const alpineTextureSetRef = instanceRef('instance/alpine-valley');

const textureSlots = {
  layoutPattern: 'layout-pattern', layoutMask: 'layout-mask',
  heightProfile: 'height-profile', bodyNoise: 'body-noise',
} as const;

type Parent = {
  readonly kind: 'cloud-material';
  readonly source?: CloudMaterialSource;
  readonly parameters?: Readonly<Record<string, CloudParameter>>;
};

export default definePack({
  schemaVersion: '2.0.0', packageId,
  async build({ readByGuid }) {
    const material = referenceCloudRef.$asset;
    const parentGuid = AssetGuid.parse(material);
    if (!parentGuid.ok) return err(parentGuid.error);
    const loaded = await readByGuid(parentGuid.value);
    if (!loaded.ok) return loaded;
    const parent = loaded.value as unknown as Parent;
    const parameters = parent.source?.parameters ?? parent.parameters;
    if (parent.kind !== 'cloud-material' || !parameters)
      return err(new Error('The shared reference material is missing its parameter interface.'));
    const instance = (textureGuid: (role: AlpineTextureRole) => string) => ({
      kind: 'cloud-material-instance', execution: 'cooked', source: {
        version: 1, material, parameters,
        overrides: Object.fromEntries(Object.entries(textureSlots).map(([name, role]) => [name, textureGuid(role)])),
      },
    } as const);
    return ok({
      'instance/sample-ue': instance(role => standardUeGuid(`texture/${role}`)),
      'instance/alpine-valley': instance(alpineTextureGuid),
    });
  },
});
