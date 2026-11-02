import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine-animation';
import { model } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { buildS3 } from './s3-rough.ts';

/**
 * C-100 stages S3 and S4: both forms on one rig. `finish` writes one mesh per rigid part,
 * `scene/s3` with the joint hierarchy and `animation-clip/s3`, the car-to-mech path played
 * by the scene's AnimationPlayer. `sheet` 1 keeps the skin as open panels, the form
 * `forgeax model interference` scans (closed panels cannot confirm thin crossings).
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1012'),
  // The components rig.finish() writes into scene/s3; the Pack producer externalizes them.
  sceneComponents: [AnimationPlayer, AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Transform],
  parameters: [{ name: 'sheet', type: 'f32', default: 0, minimum: 0, maximum: 1 }],
  build: ({ values, packageId }) => {
    const tr = buildS3(() => model(), (values.sheet as number) >= 0.5 ? 'sheet' : 'closed');
    return tr.rig.finish({ key: 's3', packageId, path: tr.path, duration: 12 });
  },
});
