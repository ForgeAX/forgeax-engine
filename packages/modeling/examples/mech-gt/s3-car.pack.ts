import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildS3Car } from './s3-rough.ts';

/** C-100 stage S3, car form: the rough model as NURBS panels, `mesh/s3-car`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1010'),
  build: () => buildS3Car().finish({ key: 's3-car', normals: { mode: 'weighted' } }),
});
