import { meshJobSources } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildFaceted, G6_JOB } from './faceting.ts';

/**
 * C-200 stage G6 (low-poly faceting) of the G5 assembly: `mesh/maid-whale-faceted`,
 * flat-shaded, as a `modeling-mesh-job` cook source (built by the NativeCooker outside the
 * Pack build budget; register `createMeshJobCooker([G6_JOB])` in the build plugin).
 */
export { buildFaceted };

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2016'),
  build: () => meshJobSources(G6_JOB, { key: 'maid-whale-faceted', params: {} }),
});
