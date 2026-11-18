import type { Chunk } from 'three/examples/jsm/loaders/VOXLoader.js';
import { VOXLoader as OriginalVOXLoader } from 'three/examples/jsm/loaders/VOXLoader.js';
import type { Loader, LoadingManager, Object3D } from 'three/src/Three.Core.js';

export type { Chunk } from 'three/examples/jsm/loaders/VOXLoader.js';
export {
  buildData3DTexture,
  buildMesh,
  VOXData3DTexture,
  VOXMesh,
} from 'three/examples/jsm/loaders/VOXLoader.js';
export interface VOXLoaderResult extends Iterable<Chunk> {
  chunks: Chunk[];
  scene: Object3D | null;
  /** @deprecated Read chunks directly. */
  readonly length: number;
  /** @deprecated Read chunks directly. */
  readonly [index: number]: Chunk;
}
/** Invalid headers return undefined; legacy chunks need not contain a scene graph. */
export interface VOXLoader extends Loader<VOXLoaderResult | undefined> {
  parse(data: ArrayBuffer): VOXLoaderResult | undefined;
}
export const VOXLoader = OriginalVOXLoader as unknown as Omit<
  typeof OriginalVOXLoader,
  'prototype'
> & { new (manager?: LoadingManager): VOXLoader; readonly prototype: VOXLoader };
