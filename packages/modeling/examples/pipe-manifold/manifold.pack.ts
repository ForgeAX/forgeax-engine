import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildManifold } from './body.ts';

/** Case C-121 as an ordinary procedural asset: the pipe manifold as `mesh/pipe-manifold`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0121'),
  build: () => buildManifold().finish({ key: 'pipe-manifold', normals: { mode: 'weighted' } }),
});
