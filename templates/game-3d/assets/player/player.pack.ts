import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
export { default as player } from './player.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fb7ce-3b00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/player': {
      kind: 'plugin',
      module: { specifier: './player.pack.ts', export: 'player' },
      config: {
        speed: 5.5,
        jumpSpeed: 6.25,
        gravity: 17,
        walk: { $asset: guidText(assetGuid(PACKAGE_IDS.character, 'animation/player-walk')) },
      },
    },
  }),
});
