import { VTKLoader as OriginalVTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js';
import type { BufferGeometry, Loader, LoadingManager } from 'three/src/Three.Core.js';
/** r187 reads an ArrayBuffer; it does not consume a path argument. */
export interface VTKLoader extends Loader<BufferGeometry> {
  parse(data: ArrayBuffer): BufferGeometry;
}
export const VTKLoader = OriginalVTKLoader as unknown as Omit<
  typeof OriginalVTKLoader,
  'prototype'
> & { new (manager?: LoadingManager): VTKLoader; readonly prototype: VTKLoader };
