import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { buildGrid, buildLayout } from './body.ts';

/**
 * Case C-115 as an ordinary procedural asset: the patch-layout door side, C-pillar and
 * rear deck as `mesh/patch-network`, and the same region traced and interpolated as one
 * patch (the old way) as `mesh/patch-network-wrong`.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0115'),
  build: () => {
    const layout = buildLayout().finish({ key: 'patch-network', normals: { mode: 'weighted' } });
    if (!layout.ok) return layout;
    const grid = buildGrid().finish({ key: 'patch-network-wrong', normals: { mode: 'weighted' } });
    if (!grid.ok) return grid;
    return ok({ ...layout.value, ...grid.value });
  },
});
