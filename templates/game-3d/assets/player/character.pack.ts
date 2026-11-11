import { assetsJobSources } from '@forgeax/engine/modeling';
import { definePack } from '@forgeax/engine/pack/source';
import { PACKAGE_IDS } from '../shared/asset-refs.ts';
import { CONVOY_JOB, CONVOY_OUTPUT_KEYS } from './convoy-job.ts';
import { CONVOY_DEFAULT_RESOLUTION } from './convoy-model.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.character,
  name: 'Game 3D / Character',
  parameters: [{ name: 'resolution', type: 'u32', default: CONVOY_DEFAULT_RESOLUTION, minimum: 512, maximum: 2048 }],
  build: context => assetsJobSources(CONVOY_JOB, {
    key: 'convoy', packageId: context.packageId,
    params: { resolution: (context.values.resolution as number | undefined) ?? CONVOY_DEFAULT_RESOLUTION },
    outputs: CONVOY_OUTPUT_KEYS,
  }),
});
