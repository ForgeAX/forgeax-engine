// Original function identities with corrected facade result types; no runtime wrapper.

import { storage as upstreamStorage } from 'three/src/nodes/accessors/StorageBufferNode.js';
import type Node from 'three/src/nodes/core/Node.js';
import type { Struct } from 'three/src/nodes/core/StructNode.js';
import {
  compute as upstreamCompute,
  computeKernel as upstreamComputeKernel,
} from 'three/src/nodes/gpgpu/ComputeNode.js';
import { storageElement as upstreamStorageElement } from 'three/src/nodes/utils/StorageArrayElementNode.js';
import type { BufferAttribute } from 'three/src/Three.Core.js';
import type { ComputeNode, StorageArrayElementNode, StorageBufferNode } from './node-compute';
import type { StorageBufferAttribute, StorageInstancedBufferAttribute } from './storage-attributes';

export const compute = upstreamCompute as unknown as (
  node: Node,
  count: number | number[],
  workgroupSize?: number[],
) => ComputeNode;
export const computeKernel = upstreamComputeKernel as unknown as (
  node: Node,
  workgroupSize?: number[],
) => ComputeNode;
interface StorageFactory {
  <T extends string>(value: BufferAttribute, type: T, count: number): StorageBufferNode<T>;
  (value: BufferAttribute, type: Struct, count: number): StorageBufferNode<'struct'>;
  (
    value: StorageBufferAttribute | StorageInstancedBufferAttribute,
    type?: null,
    count?: number,
  ): StorageBufferNode;
}
export const storage = upstreamStorage as unknown as StorageFactory;
export const storageElement = upstreamStorageElement as unknown as <T = unknown>(
  node: StorageBufferNode<T>,
  index: Node | number,
) => StorageArrayElementNode<T>;
