import { MD2Loader as OriginalMD2Loader } from 'three/examples/jsm/loaders/MD2Loader.js';
import type {
  AnimationClip,
  BufferGeometry,
  Loader,
  LoadingManager,
} from 'three/src/Three.Core.js';

export interface MD2Geometry extends BufferGeometry {
  animations: AnimationClip[];
}
/** Rejected headers or file-size mismatches return undefined in the original parser. */
export interface MD2Loader extends Loader<MD2Geometry | undefined> {
  parse(data: ArrayBuffer): MD2Geometry | undefined;
}
export const MD2Loader = OriginalMD2Loader as unknown as Omit<
  typeof OriginalMD2Loader,
  'prototype'
> & {
  new (manager?: LoadingManager): MD2Loader;
  readonly prototype: MD2Loader;
};
