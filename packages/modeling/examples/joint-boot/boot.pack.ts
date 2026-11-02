import { meshJobSources } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { BOOT_JOB } from './boot.ts';

/**
 * Case C-108 as an ordinary procedural asset: `mesh/knee-boot`, the voxel-blended,
 * remeshed and simplified mech knee boot, as a `modeling-mesh-job` cook source (built by
 * the NativeCooker outside the build timeout; register `createMeshJobCooker([BOOT_JOB])`
 * in the build plugin).
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0108'),
  parameters: [
    { name: 'folds', type: 'u32', default: 5, minimum: 3, maximum: 7 },
    { name: 'blend', type: 'f32', default: 0.016, minimum: 0.008, maximum: 0.024 },
    { name: 'budget', type: 'u32', default: 4000, minimum: 1500, maximum: 8000 },
  ],
  build: ({ values }) =>
    meshJobSources(BOOT_JOB, {
      key: 'knee-boot',
      params: { folds: values.folds as number, blend: values.blend as number, budget: values.budget as number },
    }),
});
