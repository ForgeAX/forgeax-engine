import { model, sel } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildS3Car, buildS3Mech } from './s3-rough.ts';
import { buildS5Internals } from './s5-chassis.ts';
import { buildS5JointsStowed } from './s5-joints.ts';

/**
 * C-100 car form at rest (S4 v2 stow): the S3 panels (sheet form, as the interference
 * checks see them) and wheels, the stowed mech volumes, the S5 internals and the S5 joint
 * mechanisms at their car-form joints, `mesh/car-form`. Evidence for `model render`;
 * `__tests__/car-form.unit.test.ts` checks it has no confirmed interference.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1014'),
  build: () => {
    const m = model();
    m.append(buildS3Car(() => model(), 'sheet').snapshot());
    m.checkpoint('body');
    m.append(buildS3Mech().snapshot());
    m.checkpoint('core');
    m.append(buildS5Internals().snapshot());
    m.checkpoint('internals');
    m.append(buildS5JointsStowed().snapshot());
    m.uv.project({ mode: 'box', scale: 0.5, faces: sel.all(), channel: 'uv1' });
    return m.finish({ key: 'car-form', normals: { mode: 'weighted' } });
  },
});
