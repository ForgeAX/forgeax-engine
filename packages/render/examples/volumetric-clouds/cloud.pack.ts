import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('019bc95b-8c00-7ef4-a170-aba2bc816c84');
const parameters = {
  density: { kind: 'scalar', unit: 'm^-1', default: 0.0005 },
  detail: { kind: 'static', default: false },
} as const;

export const cloudGuids = {
  material: AssetGuid.format(AssetGuid.derive(packageId, 'cloud')),
  light: AssetGuid.format(AssetGuid.derive(packageId, 'light')),
  dense: AssetGuid.format(AssetGuid.derive(packageId, 'dense')),
};

function instance(overrides: { density: number; detail: boolean }) {
  return {
    kind: 'cloud-material-instance',
    execution: 'cooked',
    source: { version: 1, material: cloudGuids.material, parameters, overrides },
  } as const;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: () => ok({
    cloud: {
      kind: 'cloud-material',
      execution: 'cooked',
      source: { version: 1, model: { kind: 'program', source: 'cloud.wgsl' }, parameters },
    },
    light: instance({ density: 0.00022, detail: false }),
    dense: instance({ density: 0.0012, detail: true }),
  }),
});
