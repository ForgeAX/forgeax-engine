import { CONVOY_HARDWARE_SLOTS } from './convoy-surfaces.ts';
import { type AssetsJob, bakeMaps } from '@forgeax/engine/modeling';
import { ok } from '@forgeax/engine/types';
import { convoyBakeSettings, prepareConvoyAssets } from './convoy-model.ts';
import { finishConvoyTextures } from './convoy-finish.ts';
import { playerWalkClip } from './player-walk.ts';

export const CONVOY_DELIVERY_MAPS = { normal: 'normal', ormh: 'ormh', baseColor: 'base-color', emissive: 'emissive', coat: 'coat' } as const;
export const CONVOY_OUTPUT_KEYS = [
  'mesh/player', 'rig/player-skeleton', 'rig/player-skin',
  'animation/player-transform', 'animation/player-wheels', 'animation/player-walk',
  'material/convoy', ...CONVOY_HARDWARE_SLOTS.map(slot => `material/${slot}`),
  ...['brushed-normal', 'rubber-normal', 'hardware-ormh', ...Object.values(CONVOY_DELIVERY_MAPS)].map(map => `texture/convoy-${map}`),
] as const;

/** One deferred asset set shares geometry, bake correspondence and delivery maps. */
export const CONVOY_JOB: AssetsJob<{ readonly resolution: number }> = {
  kind: 'assets', name: 'game-3d-convoy',
  build: ({ resolution }, { packageId, cache }) => {
    const { assets, bakeBase: base, bakeDetail: detail } = prepareConvoyAssets(resolution, packageId);
    const baked = bakeMaps({ base, detail, ...convoyBakeSettings(resolution), resolution, mips: false, ...(cache === undefined ? {} : { cache }) });
    if (!baked.ok) return baked;
    const maps = finishConvoyTextures(baked.value.textures);
    return ok({ ...assets,
      ...Object.fromEntries(Object.entries(CONVOY_DELIVERY_MAPS).map(([map, suffix]) => [`texture/convoy-${suffix}`, maps[map]!])),
      'animation/player-walk': playerWalkClip(),
    });
  },
};
