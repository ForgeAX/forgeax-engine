import { assetsJobSources } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { G7_JOB, G7_KEY, G7_OUTPUTS } from './g7-face-job.ts';

/**
 * C-200 stage G7 (materials, hair ombre, face and apron-emblem decals) of the G6 faceted
 * figure: `mesh/maid-whale-g7` and one `mesh/maid-whale-g7.<part>` per body part, a Standard
 * `material/<slot>` for every slot and the mipmapped decal textures. Every output is a
 * `modeling-mesh-job` cook source of G7_JOB: register `createMeshJobCooker([G7_JOB])` in the
 * project's build plugin (the build itself returns at once).
 */
const packageId = definePackageId('01900000-0000-7000-8000-0000000c2020');

export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  build: () => assetsJobSources(G7_JOB, { key: G7_KEY, packageId, params: {}, outputs: G7_OUTPUTS }),
});
