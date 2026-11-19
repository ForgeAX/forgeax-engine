import { MorphAnimMesh as OriginalMorphAnimMesh } from 'three/examples/jsm/misc/MorphAnimMesh.js';
import type { BufferGeometry, Material } from 'three/src/Three.Core.js';

export type MorphAnimMesh = OriginalMorphAnimMesh;
export const MorphAnimMesh = OriginalMorphAnimMesh as unknown as Omit<
  typeof OriginalMorphAnimMesh,
  'prototype'
> & {
  new (geometry?: BufferGeometry, material?: Material | Material[]): MorphAnimMesh;
  readonly prototype: MorphAnimMesh;
};
