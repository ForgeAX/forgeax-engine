import * as THREE from '@forgeax/engine/three';
import * as TSL from '@forgeax/engine/three/tsl';
import { expect, it } from 'vitest';

it('shares the exact TSL factories and creates corrected compute/storage result families', () => {
  expect(TSL.compute).toBe(THREE.TSL.compute);
  expect(TSL.computeKernel).toBe(THREE.TSL.computeKernel);
  expect(TSL.storage).toBe(THREE.TSL.storage);
  expect(TSL.storageElement).toBe(THREE.TSL.storageElement);
  const body = new THREE.ExpressionNode('', 'void'),
    dimensions = [4, 3, 1];
  const compute = TSL.compute(body, dimensions, [8, 4]);
  expect(compute).toBeInstanceOf(THREE.ComputeNode);
  expect(compute.dispatchSize).toBe(dimensions);
  expect(compute.count).toBeNull();
  const kernel = TSL.computeKernel(body);
  expect(kernel.workgroupSize).toEqual([64, 1, 1]);
  const attribute = new THREE.StorageBufferAttribute(8, 1, Uint32Array);
  const storage = TSL.storage(attribute, 'uint', 8).toReadOnly().setAtomic(true).setName('counts');
  expect(storage).toBeInstanceOf(THREE.StorageBufferNode);
  expect(storage.value).toBe(attribute);
  expect(storage.isAtomic).toBe(true);
  const plain = new THREE.BufferAttribute(new Float32Array(8), 1);
  const plainNode = TSL.storage(plain, 'float', 8);
  expect(plainNode.value).toBe(plain);
  const typed: THREE.StorageBufferNode<'uint'> = storage;
  void typed;
  const element = TSL.storageElement(storage, 2);
  expect(element).toBeInstanceOf(THREE.StorageArrayElementNode);
  expect(element.node).toBe(storage);
  expect(Reflect.get(element.indexNode, 'value')).toBe(2);
});

function negativeFactoryTypes() {
  const body = new THREE.ExpressionNode('', 'void');
  const node = TSL.compute(body, 16).setName('test');
  // @ts-expect-error No such method exists in r187, also after a factory/fluent chain.
  node.setCount(8);
  const kernel = THREE.TSL.computeKernel(body);
  // @ts-expect-error r187 has no getCount.
  kernel.getCount();
  const storage = THREE.TSL.storage(new THREE.StorageBufferAttribute(8, 1))
    .toReadOnly()
    .setAtomic(true);
  // @ts-expect-error Only the actual setAtomic spelling is admitted.
  storage.setAtmoic(false);
  // @ts-expect-error r187 has no bufferObject field.
  void storage.bufferObject;
}
void negativeFactoryTypes;
