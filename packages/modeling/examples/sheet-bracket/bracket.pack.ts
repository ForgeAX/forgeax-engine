import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildSheetBracket } from './body.ts';

/** Sheet-metal U bracket (folded from its flat pattern) as an ordinary procedural asset: `mesh/sheet-bracket`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c5011'),
  parameters: [{ name: 'fold', type: 'f32', default: 90, minimum: 20, maximum: 120 }],
  build: ({ values }) =>
    buildSheetBracket(values.fold as number).finish({ key: 'sheet-bracket', normals: { mode: 'weighted' } }),
});
