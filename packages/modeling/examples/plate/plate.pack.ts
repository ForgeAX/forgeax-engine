import { meshJobSources } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { PLATE_JOB } from './plate.ts';

/**
 * Case C-700 as an ordinary procedural asset: `mesh/plate`, an exact-stage plate
 * tessellated and textured, as a `modeling-mesh-job` cook source (register
 * `createMeshJobCooker([PLATE_JOB])` in the build plugin).
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0700'),
  parameters: [
    { name: 'width', type: 'f32', default: 0.24, minimum: 0.05, maximum: 1 },
    { name: 'depth', type: 'f32', default: 0.16, minimum: 0.05, maximum: 1 },
    { name: 'thickness', type: 'f32', default: 0.012, minimum: 0.002, maximum: 0.1 },
  ],
  build: ({ values }) =>
    meshJobSources(PLATE_JOB, {
      key: 'plate',
      params: { width: values.width as number, depth: values.depth as number, thickness: values.thickness as number },
    }),
});
