// Keep original runtime identities while admitting the actual pinned r187 CPU API.

import UpstreamStorageBufferNode from 'three/src/nodes/accessors/StorageBufferNode.js';
import type Node from 'three/src/nodes/core/Node.js';
import UpstreamComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js';
import UpstreamStorageArrayElementNode from 'three/src/nodes/utils/StorageArrayElementNode.js';
import type { BufferAttribute } from 'three/src/Three.Core.js';

export interface ComputeNode
  extends Omit<UpstreamComputeNode, 'setCount' | 'getCount' | 'setName' | 'label' | 'onInit'> {
  setName(name: string): this;
  label(name: string): this;
  onInit(callback: UpstreamComputeNode['onInitFunction']): this;
}
export const ComputeNode = UpstreamComputeNode as unknown as {
  new (computeNode: Node, workgroupSize: number[]): ComputeNode;
  readonly prototype: ComputeNode;
};

export type StorageBufferNode<T = unknown> = Omit<
  UpstreamStorageBufferNode<T>,
  | 'value'
  | 'setAtmoic'
  | 'bufferObject'
  | 'element'
  | 'setAccess'
  | 'setPBO'
  | 'toReadOnly'
  | 'toAtomic'
  | 'setName'
  | 'label'
> & {
  value: BufferAttribute;
  setAtomic(value: boolean): StorageBufferNode<T>;
  setAccess(value: UpstreamStorageBufferNode<T>['access']): StorageBufferNode<T>;
  setPBO(value: boolean): StorageBufferNode<T>;
  toReadOnly(): StorageBufferNode<T>;
  toAtomic(): StorageBufferNode<T>;
  setName(name: string): StorageBufferNode<T>;
  label(name: string): StorageBufferNode<T>;
  element(index: Node | number): StorageArrayElementNode<T>;
};
export const StorageBufferNode = UpstreamStorageBufferNode as unknown as {
  new <T = unknown>(
    value: BufferAttribute,
    bufferType?: ConstructorParameters<typeof UpstreamStorageBufferNode>[1],
    bufferCount?: number,
  ): StorageBufferNode<T>;
  readonly prototype: StorageBufferNode;
};

export type StorageArrayElementNode<T = unknown> = Omit<
  UpstreamStorageArrayElementNode<T>,
  'node'
> & { node: StorageBufferNode<T> };
export const StorageArrayElementNode = UpstreamStorageArrayElementNode as unknown as {
  new <T = unknown>(
    storageBufferNode: StorageBufferNode<T>,
    indexNode: Node,
  ): StorageArrayElementNode<T>;
  readonly prototype: StorageArrayElementNode;
};
