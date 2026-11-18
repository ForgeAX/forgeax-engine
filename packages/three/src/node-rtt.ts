import OriginalRTT from 'three/src/nodes/utils/RTTNode.js';
import type { RenderTarget } from 'three/src/Three.Core.js';

/** The original constructor always owns a concrete target, including after dispose. */
export interface RTTNode extends Omit<OriginalRTT, 'renderTarget'> {
  renderTarget: RenderTarget;
}
export const RTTNode = OriginalRTT as unknown as Omit<typeof OriginalRTT, 'prototype'> & {
  new (...args: ConstructorParameters<typeof OriginalRTT>): RTTNode;
  readonly prototype: RTTNode;
};
