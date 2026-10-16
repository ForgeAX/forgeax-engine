import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
import { CLEARCOAT_PACKAGE_ID } from '../src/material-identity.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CLEARCOAT_PACKAGE_ID,
  name: 'Bevy Clearcoat',
  build: () => ok({
    'material/clearcoat': Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [0.62, 0.045, 0.018, 1],
      metallic: 0.15,
      roughness: 0.4,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    }),
  }),
});
