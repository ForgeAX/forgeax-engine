import type { AnimationPathHelperOptions } from 'three/examples/jsm/helpers/AnimationPathHelper.js';
import { AnimationPathHelper as OriginalAnimationPathHelper } from 'three/examples/jsm/helpers/AnimationPathHelper.js';
import type {
  AnimationClip,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Object3D,
  Points,
  PointsMaterial,
} from 'three/src/Three.Core.js';

export type { AnimationPathHelperOptions } from 'three/examples/jsm/helpers/AnimationPathHelper.js';
/** No matching UUID.position track leaves the path objects absent. */
export interface AnimationPathHelper extends Omit<OriginalAnimationPathHelper, 'line' | 'points'> {
  line?: Line<BufferGeometry, LineBasicMaterial>;
  points?: Points<BufferGeometry, PointsMaterial> | null;
}
export const AnimationPathHelper = OriginalAnimationPathHelper as unknown as Omit<
  typeof OriginalAnimationPathHelper,
  'prototype'
> & {
  new (
    root: Object3D,
    clip: AnimationClip,
    object: Object3D,
    options?: AnimationPathHelperOptions,
  ): AnimationPathHelper;
  readonly prototype: AnimationPathHelper;
};
