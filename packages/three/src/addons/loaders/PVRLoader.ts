import type { PVR } from 'three/examples/jsm/loaders/PVRLoader.js';
import { PVRLoader as OriginalPVRLoader } from 'three/examples/jsm/loaders/PVRLoader.js';
import type { CompressedTextureLoader, LoadingManager } from 'three/src/Three.Core.js';

export type { PVR } from 'three/examples/jsm/loaders/PVRLoader.js';
/** An unrecognized PVR header returns undefined instead of a texture descriptor. */
export interface PVRLoader extends CompressedTextureLoader {
  parse(buffer: ArrayBuffer, loadMipmaps: boolean): PVR | undefined;
}
export const PVRLoader = OriginalPVRLoader as unknown as Omit<
  typeof OriginalPVRLoader,
  'prototype'
> & {
  new (manager?: LoadingManager): PVRLoader;
  readonly prototype: PVRLoader;
};
