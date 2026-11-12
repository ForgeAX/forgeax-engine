import {
  generatePackMeshLods,
  type PackMeshLodRequest,
} from '@forgeax/engine-import/mesh-lod-generator';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import {
  buildWheelRim,
  WHEEL_RIM_DEFAULTS,
} from '../../../modeling/examples/wheel-rim/wheel-rim.ts';

/**
 * Case C-015: the C-101 rim with an automatic LOD chain. Every level is an ordinary
 * `mesh/wheel-rim/lod<n>` output, and the Mesh producer links them from the root.
 * Coarser levels allow a larger error budget (relative to the rim's extent).
 */
export const WHEEL_RIM_LODS: PackMeshLodRequest = {
  maxError: 0.005,
  levels: [
    { triangleRatio: 0.6, screenCoverage: 0.5 },
    { triangleRatio: 0.4, screenCoverage: 0.25, maxError: 0.02 },
    { triangleRatio: 0.25, screenCoverage: 0.1, maxError: 0.05 },
  ],
};

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0015'),
  build: async ({ packageId }) => {
    const rim = buildWheelRim(WHEEL_RIM_DEFAULTS).finish({
      key: 'wheel-rim',
      normals: { mode: 'weighted' },
    });
    if (!rim.ok) return rim;
    const lods = await generatePackMeshLods(packageId, rim.value, {
      'mesh/wheel-rim': WHEEL_RIM_LODS,
    });
    return lods.ok ? ok(lods.value.outputs) : lods;
  },
});
