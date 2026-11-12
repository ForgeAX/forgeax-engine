import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine-animation';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { buildHood, hoodPath, hoodRig } from './hood.ts';

/**
 * Case C-116 as an ordinary procedural asset: one mesh per rigid part (skin, hood, links,
 * cylinder and six pin joints) in its joint's frame, `scene/hood-linkage` with the joint
 * hierarchy and `animation-clip/hood-linkage`, the cylinder's full stroke with both loops
 * solved per frame, played by the scene's AnimationPlayer.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0116'),
  // The components rig.finish() writes into scene/hood-linkage; the Pack producer externalizes them.
  sceneComponents: [AnimationPlayer, AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Transform],
  build: ({ packageId }) =>
    hoodRig(buildHood()).finish({ key: 'hood-linkage', packageId, path: hoodPath(), duration: 6 }),
});
