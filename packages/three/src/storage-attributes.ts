import UpstreamIndirect from 'three/src/renderers/common/IndirectStorageBufferAttribute.js';
import UpstreamStorage from 'three/src/renderers/common/StorageBufferAttribute.js';
import UpstreamInstanced from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';
import type { TypedArray, TypedArrayConstructor } from 'three/src/Three.Core.js';

// Preserve the actual upstream constructors. r187 declarations omit supported
// count/typeClass forms; these signatures describe the tested runtime overloads.
export const StorageBufferAttribute = UpstreamStorage as typeof UpstreamStorage & {
  new (
    count: number | TypedArray,
    itemSize: number,
    typeClass?: TypedArrayConstructor,
  ): UpstreamStorage;
};
export type StorageBufferAttribute = UpstreamStorage;
export const StorageInstancedBufferAttribute = UpstreamInstanced as typeof UpstreamInstanced & {
  new (
    count: number | TypedArray,
    itemSize: number,
    typeClass?: TypedArrayConstructor,
  ): UpstreamInstanced;
};
export type StorageInstancedBufferAttribute = UpstreamInstanced;
export const IndirectStorageBufferAttribute = UpstreamIndirect as typeof UpstreamIndirect & {
  new (count: number | Uint32Array, itemSize: number): UpstreamIndirect;
};
export type IndirectStorageBufferAttribute = UpstreamIndirect;
