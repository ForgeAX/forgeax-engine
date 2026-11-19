import type { LUTImageResult } from 'three/examples/jsm/loaders/LUTImageLoader.js';
import { LUTImageLoader as OriginalLUTImageLoader } from 'three/examples/jsm/loaders/LUTImageLoader.js';
import type { Loader, LoadingManager } from 'three/src/Three.Core.js';

export type { LUTImageResult } from 'three/examples/jsm/loaders/LUTImageLoader.js';
/** Image extraction helpers are private upstream implementation details. */
export interface LUTImageLoader extends Loader<LUTImageResult> {
  flip: boolean;
  parse(dataArray: Uint8ClampedArray, size: number): LUTImageResult;
}
export const LUTImageLoader = OriginalLUTImageLoader as unknown as Omit<
  typeof OriginalLUTImageLoader,
  'prototype'
> & {
  new (manager?: LoadingManager): LUTImageLoader;
  readonly prototype: LUTImageLoader;
};
