import { Volume as OriginalVolume } from 'three/examples/jsm/misc/Volume.js';
import type { Matrix3, Matrix4, TypedArray } from 'three/src/Three.Core.js';
import type { VolumeSlice } from './VolumeSlice';

export interface VolumePlane {
  iLength: number;
  jLength: number;
  planeWidth: number;
  planeHeight: number;
  sliceAccess(i: number, j: number): number;
  matrix: Matrix4;
}
/** NRRD supplies orientation/window metadata before extracting slices. */
export interface Volume
  extends Omit<
    OriginalVolume,
    | 'matrix'
    | 'map'
    | 'extractPerpendicularPlane'
    | 'extractSlice'
    | 'sliceList'
    | 'repaintAllSlices'
  > {
  matrix: Matrix3 | Matrix4;
  inverseMatrix?: Matrix4;
  RASDimensions: number[];
  segmentation: boolean;
  windowLow?: number;
  windowHigh?: number;
  min?: number;
  max?: number;
  dataType?: string;
  sliceList: VolumeSlice[];
  map<T = this>(
    callback: (this: T, value: number, index: number, data: TypedArray) => number,
    context?: T,
  ): this;
  extractPerpendicularPlane(axis: string, index: number): VolumePlane;
  extractSlice(axis: string, index: number): VolumeSlice;
  repaintAllSlices(): this;
}
export const Volume = OriginalVolume as unknown as Omit<typeof OriginalVolume, 'prototype'> & {
  new (
    xLength?: number,
    yLength?: number,
    zLength?: number,
    type?: string,
    data?: ArrayBuffer | ArrayLike<number>,
  ): Volume;
  readonly prototype: Volume;
};
