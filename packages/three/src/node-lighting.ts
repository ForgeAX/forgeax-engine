import OriginalLighting from 'three/src/renderers/common/Lighting.js';
import type { Object3D } from 'three/src/Three.Core.js';

/** r187 accepts Scene/Group and returns a default node for other objects. */
export interface Lighting
  extends Omit<OriginalLighting, 'getNode' | 'beginRender' | 'finishRender'> {
  getNode(scene: Object3D): ReturnType<OriginalLighting['getNode']>;
  beginRender(scene: Object3D): void;
  finishRender(scene: Object3D): void;
}
export const Lighting = OriginalLighting as unknown as Omit<
  typeof OriginalLighting,
  'prototype'
> & {
  readonly prototype: Lighting;
  new (): Lighting;
};
