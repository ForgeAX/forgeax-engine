import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { buildRight, buildWrong } from './body.ts';

/**
 * Case C-114 as an ordinary procedural asset: the CORRECT (feature-line network, lofted
 * panels, rolling-ball blends) and the WRONG (noisy trace interpolated into one dense
 * patch) surfacing of the same body corner, as `mesh/quality-body-correct` and
 * `mesh/quality-body-wrong`.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0114'),
  build: () => {
    const correct = buildRight().finish({ key: 'quality-body-correct', normals: { mode: 'weighted' } });
    if (!correct.ok) return correct;
    const wrong = buildWrong().finish({ key: 'quality-body-wrong', normals: { mode: 'weighted' } });
    if (!wrong.ok) return wrong;
    return ok({ ...correct.value, ...wrong.value });
  },
});
