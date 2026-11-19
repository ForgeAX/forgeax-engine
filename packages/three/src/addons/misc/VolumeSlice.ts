import { VolumeSlice as OriginalVolumeSlice } from 'three/examples/jsm/misc/VolumeSlice.js';
import type { Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three/src/Three.Core.js';
import type { Volume } from './Volume';

export interface VolumeSlice extends Omit<OriginalVolumeSlice, 'sliceAccess' | 'matrix' | 'mesh'> {
  volume: Volume;
  geometry: PlaneGeometry;
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  sliceAccess(i: number, j: number): number;
  matrix: Matrix4;
}
export const VolumeSlice = OriginalVolumeSlice as unknown as Omit<
  typeof OriginalVolumeSlice,
  'prototype'
> & {
  new (volume: Volume, index?: number, axis?: string): VolumeSlice;
  readonly prototype: VolumeSlice;
};
