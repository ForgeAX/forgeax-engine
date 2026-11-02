import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine-animation';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { buildLimb, limbPath, limbRig } from './limb.ts';

/**
 * Case C-107 as an ordinary procedural asset: one mesh per rigid part in its joint's
 * frame, `scene/limb` with the joint hierarchy and `animation-clip/limb`, the car-to-robot
 * transformation played by the scene's AnimationPlayer.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0107'),
  // The components rig.finish() writes into scene/limb; the Pack producer externalizes them.
  sceneComponents: [AnimationPlayer, AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Transform],
  parameters: [
    { name: 'stroke', type: 'f32', default: 0.1, minimum: 0.06, maximum: 0.1 },
    { name: 'wheelSwing', type: 'f32', default: -35, minimum: -45, maximum: -25 },
    { name: 'beamEnd', type: 'f32', default: 0.37, minimum: 0.34, maximum: 0.45 },
  ],
  build: ({ values, packageId }) => {
    const p = {
      stroke: values.stroke as number,
      wheelSwing: values.wheelSwing as number,
      beamEnd: values.beamEnd as number,
    };
    return limbRig(buildLimb(p), p).finish({ key: 'limb', packageId, path: limbPath(p), duration: 6 });
  },
});
