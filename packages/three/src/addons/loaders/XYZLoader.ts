import { XYZLoader as OriginalXYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js';
import type { BufferGeometry, Loader, LoadingManager } from 'three/src/Three.Core.js';

/** r187 parse is synchronous; the pinned declarations invent an onLoad argument. */
export interface XYZLoader extends Loader<BufferGeometry> {
  parse(text: string): BufferGeometry;
}
export const XYZLoader = OriginalXYZLoader as unknown as Omit<
  typeof OriginalXYZLoader,
  'prototype'
> & {
  new (manager?: LoadingManager): XYZLoader;
  readonly prototype: XYZLoader;
};
