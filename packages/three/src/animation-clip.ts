import { AnimationClip as OriginalAnimationClip } from 'three/src/Three.Core.js';

export type AnimationClip = OriginalAnimationClip;
/** r187 only reads target names; legacy vertex arrays are not required. */
export const AnimationClip = OriginalAnimationClip as typeof OriginalAnimationClip & {
  CreateFromMorphTargetSequence(
    name: string,
    targets: readonly { name: string }[],
    fps: number,
    noLoop?: boolean,
  ): AnimationClip;
  CreateClipsFromMorphTargetSequences(
    targets: readonly { name: string }[],
    fps: number,
    noLoop?: boolean,
  ): AnimationClip[];
};
