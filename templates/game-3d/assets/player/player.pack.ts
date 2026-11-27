import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { makeAmbientLoop, makeCheckpointChime } from './checkpoint-audio.ts';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
export { default as player } from './player.ts';

const playerPackage = definePackageId('019fb7ce-3b00-7000-8000-000000000000');

export default definePack({
  schemaVersion: '2.0.0', plugins: true,
  packageId: playerPackage,
  build: () => ok({
    'audio/ambient': { kind: 'audio', sourceKey: 'game-3d/ambient', mediaType: 'audio/wav', bytes: makeAmbientLoop() },
    'audio/checkpoint': { kind: 'audio', sourceKey: 'game-3d/checkpoint', mediaType: 'audio/wav', bytes: makeCheckpointChime() },
    'plugin/player': {
      kind: 'plugin',
      module: { specifier: './player.pack.ts', export: 'player' },
      config: {
        music: { $asset: guidText(assetGuid(playerPackage, 'audio/ambient')) },
        chime: { $asset: guidText(assetGuid(playerPackage, 'audio/checkpoint')) },
        speed: 5.5,
        jumpSpeed: 6.25,
        gravity: 17,
        transform: { $asset: guidText(assetGuid(PACKAGE_IDS.character, 'animation/player-transform')) },
        wheels: { $asset: guidText(assetGuid(PACKAGE_IDS.character, 'animation/player-wheels')) },
        walk: { $asset: guidText(assetGuid(PACKAGE_IDS.character, 'animation/player-walk')) },
      },
    },
  }),
});
