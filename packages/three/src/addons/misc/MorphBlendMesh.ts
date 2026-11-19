import { MorphBlendMesh as OriginalMorphBlendMesh } from 'three/examples/jsm/misc/MorphBlendMesh.js';
import type { BufferGeometry, Material, Mesh } from 'three/src/Three.Core.js';

export interface MorphBlendAnimation {
  start: number;
  end: number;
  length: number;
  fps: number;
  duration: number;
  lastFrame: number;
  currentFrame: number;
  active: boolean;
  time: number;
  direction: number;
  weight: number;
  directionBackwards: boolean;
  mirroredLoop: boolean;
}
type AnimationMethods = Pick<
  OriginalMorphBlendMesh,
  | 'createAnimation'
  | 'autoCreateAnimations'
  | 'setAnimationDirectionForward'
  | 'setAnimationDirectionBackward'
  | 'setAnimationFPS'
  | 'setAnimationDuration'
  | 'setAnimationWeight'
  | 'setAnimationTime'
  | 'getAnimationTime'
  | 'getAnimationDuration'
  | 'playAnimation'
  | 'stopAnimation'
  | 'update'
>;
export interface MorphBlendMesh extends Mesh, AnimationMethods {
  animationsMap: Record<string, MorphBlendAnimation>;
  animationsList: MorphBlendAnimation[];
  firstAnimation?: string;
}
export const MorphBlendMesh = OriginalMorphBlendMesh as unknown as Omit<
  typeof OriginalMorphBlendMesh,
  'prototype'
> & {
  new (geometry: BufferGeometry, material?: Material | Material[]): MorphBlendMesh;
  readonly prototype: MorphBlendMesh;
};
