import * as THREE from '@forgeax/engine/three';
import * as constants from 'three/src/nodes/core/constants.js';
import { expect, it, vi } from 'vitest';

it('retains data constructors, mutation versions and caller-owned arrays', () => {
  const array = new Float32Array([1, 2, 3]);
  const storage = new THREE.StorageBufferAttribute(array, 3);
  expect(storage).toBeInstanceOf(THREE.BufferAttribute);
  expect(storage.array).toBe(array);
  storage.needsUpdate = true;
  expect(storage.version).toBe(1);
  const instanced = new THREE.StorageInstancedBufferAttribute(2, 16);
  expect(instanced).toBeInstanceOf(THREE.InstancedBufferAttribute);
  expect(instanced.array).toHaveLength(32);
  const doubles = new THREE.StorageBufferAttribute(2, 3, Float64Array);
  expect(doubles.array).toBeInstanceOf(Float64Array);
  expect(doubles.array).toHaveLength(6);
  const indirect = new THREE.IndirectStorageBufferAttribute(3, 1);
  expect(indirect.array).toBeInstanceOf(Uint32Array);
  const group = new THREE.BundleGroup();
  expect(group).toBeInstanceOf(THREE.Group);
  group.needsUpdate = true;
  expect(group.version).toBe(1);
  const blend = new THREE.BlendMode(THREE.CustomBlending);
  blend.blendSrc = THREE.OneFactor;
  expect(blend.clone()).toEqual(blend);
  expect(blend.clone()).not.toBe(blend);
  expect({
    NodeShaderStage: THREE.NodeShaderStage,
    NodeUpdateType: THREE.NodeUpdateType,
    NodeType: THREE.NodeType,
    NodeAccess: THREE.NodeAccess,
    defaultShaderStages: THREE.defaultShaderStages,
    defaultBuildStages: THREE.defaultBuildStages,
    shaderStages: THREE.shaderStages,
    vectorComponents: THREE.vectorComponents,
  }).toEqual({ ...constants });
});

it('reuses fullscreen geometry and renders with the selected camera/material', async () => {
  const material = new THREE.MeshBasicMaterial();
  const first = new THREE.QuadMesh(material),
    second = new THREE.QuadMesh(material);
  expect(first.geometry).toBe(second.geometry);
  expect(first.camera).toBe(second.camera);
  const renderer = { init: vi.fn(async () => undefined), render: vi.fn() };
  first.render(renderer);
  await second.renderAsync(renderer);
  expect(renderer.init).toHaveBeenCalledOnce();
  expect(renderer.render).toHaveBeenNthCalledWith(1, first, first.camera);
  expect(renderer.render).toHaveBeenNthCalledWith(2, second, second.camera);
  expect(Object.hasOwn(material, 'vertexNode')).toBe(false);
  material.dispose();
});

it('supports caller-owned node lifecycle, inherited weak caches and CPU value utilities', () => {
  const node = new THREE.Node('vec3');
  expect(node).toBeInstanceOf(THREE.EventDispatcher);
  const parent = new THREE.NodeCache(),
    child = new THREE.NodeCache(parent);
  const data = { version: 1 };
  parent.setData(node, data);
  expect(child.getData(node)).toBe(data);
  child.setData(node, { version: 2 });
  expect(child.getData(node)).toEqual({ version: 2 });
  expect(parent.getData(node)).toBe(data);
  const frame = new THREE.NodeFrame();
  node.updateType = THREE.NodeUpdateType.FRAME;
  node.update = vi.fn();
  frame.update();
  frame.updateNode(node);
  frame.updateNode(node);
  expect(node.update).toHaveBeenCalledOnce();
  frame.update();
  frame.updateNode(node);
  expect(node.update).toHaveBeenCalledTimes(2);
  node.updateType = THREE.NodeUpdateType.RENDER;
  frame.renderId++;
  frame.updateNode(node);
  frame.updateNode(node);
  expect(node.update).toHaveBeenCalledTimes(3);
  const dispose = vi.fn();
  node.addEventListener('dispose', dispose);
  node.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  const value = THREE.NodeUtils.getValueFromType('vec3', 1, 2, 3);
  expect(value).toBeInstanceOf(THREE.Vector3);
  expect(THREE.NodeUtils.getValueType(value)).toBe('vec3');
});

it('retains CPU input values, serialization and uniform-group update versions', () => {
  const value = new THREE.Vector3(1, 2, 3),
    node = new THREE.ConstNode(value, 'vec3');
  expect(node).toBeInstanceOf(THREE.InputNode);
  expect(node).toBeInstanceOf(THREE.Node);
  expect(node.value).toBe(value);
  expect(node.setPrecision('high')).toBe(node);
  const json = node.toJSON();
  expect(json).toMatchObject({
    type: 'ConstNode',
    nodeType: 'vec3',
    value: [1, 2, 3],
    valueType: 'vec3',
    precision: 'high',
  });
  const restored = new THREE.InputNode(null);
  restored.deserialize({ ...json, meta: { textures: {}, nodes: {} } });
  expect(restored.value).toBeInstanceOf(THREE.Vector3);
  expect(restored.value).toEqual(value);
  const group = new THREE.UniformGroupNode('frame', true, 0);
  expect(group).toBeInstanceOf(THREE.Node);
  const version = group.version;
  group.update(new THREE.NodeFrame());
  expect(group.version).toBe(version + 1);
  expect(group.toJSON()).toMatchObject({ name: 'frame', shared: true, version: version + 1 });
});

it('constructs scoped pose accessors while preserving Three math object behavior', () => {
  const stop = THREE.enableThreeSourceTracking();
  let node: THREE.Group, sibling: THREE.Group;
  try {
    node = new THREE.Group();
    sibling = new THREE.Group();
    expect(Object.getOwnPropertyDescriptor(new THREE.Vector3(), 'x')?.value).toBe(0);
    expect(Object.getOwnPropertyDescriptor(new THREE.Quaternion(), '_w')?.value).toBe(1);
  } finally {
    stop();
  }
  const position = node.position;
  const axis = Object.getOwnPropertyDescriptor(position, 'x');
  expect(typeof axis?.get).toBe('function');
  expect(Object.getOwnPropertyDescriptor(sibling.position, 'x')?.get).toBe(axis?.get);
  expect(Object.keys(position)).toEqual(Object.keys(new THREE.Vector3()));
  expect(Object.keys(node.quaternion)).toEqual(Object.keys(new THREE.Group().quaternion));
  expect(Object.getOwnPropertyDescriptor(new THREE.Group().position, 'x')?.value).toBe(0);
  expect(position.constructor).toBe(THREE.Vector3);
  expect(position.clone()).toBeInstanceOf(THREE.Vector3);
  position.set(2, 3, 4);
  expect(structuredClone(position)).toEqual({ x: 2, y: 3, z: 4 });
  const child = Object.create(position);
  child.x = 9;
  expect(position.x).toBe(2);
  Object.freeze(sibling.scale);
  expect(() => {
    sibling.scale.x = 2;
  }).toThrow(TypeError);
});
