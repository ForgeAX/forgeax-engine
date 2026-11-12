import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildAttached } from './attachments.ts';

/** C-200 stage G5 (attached structures) on the G4 hair and G3 figure: `mesh/maid-whale-attached`. */
export { buildAttached };

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2015'),
  build: () => buildAttached().finish({ key: 'maid-whale-attached', normals: { mode: 'weighted' } }),
});
