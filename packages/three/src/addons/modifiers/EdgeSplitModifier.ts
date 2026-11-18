import { EdgeSplitModifier as OriginalEdgeSplitModifier } from 'three/examples/jsm/modifiers/EdgeSplitModifier.js';
import type { BufferGeometry } from 'three/src/Three.Core.js';
/** r187 defaults tryKeepNormals to true. */
export interface EdgeSplitModifier {
  modify(geometry: BufferGeometry, cutOffAngle: number, tryKeepNormals?: boolean): BufferGeometry;
}
export const EdgeSplitModifier = OriginalEdgeSplitModifier as unknown as Omit<
  typeof OriginalEdgeSplitModifier,
  'prototype'
> & { new (): EdgeSplitModifier; readonly prototype: EdgeSplitModifier };
