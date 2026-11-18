import { NRRDLoader as OriginalNRRDLoader } from 'three/examples/jsm/loaders/NRRDLoader.js';
import type { Volume } from 'three/examples/jsm/misc/Volume.js';
import type { Loader, LoadingManager } from 'three/src/Three.Core.js';
/** r187 consumes bytes and exposes segmentation; parser helpers remain module-private. */
export interface NRRDLoader extends Loader<Volume> {
  segmentation?: boolean;
  setSegmentation(segmentation: boolean): void;
  parse(data: ArrayBuffer): Volume;
}
export const NRRDLoader = OriginalNRRDLoader as unknown as Omit<
  typeof OriginalNRRDLoader,
  'prototype'
> & { new (manager?: LoadingManager): NRRDLoader; readonly prototype: NRRDLoader };
