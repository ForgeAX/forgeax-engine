import * as THREE from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';
import { validateMaterial } from '../material';
import { MeshBasicNodeMaterial } from '../node-materials';

it('retains storage attribute identity, access flags, elements and atomic operands', () => {
  const attribute = new THREE.StorageBufferAttribute(16, 1, Uint32Array);
  const buffer = new THREE.StorageBufferNode(attribute, 'uint', 16);
  expect(buffer).toBeInstanceOf(THREE.BufferNode);
  expect(buffer.value).toBe(attribute);
  expect(buffer.bufferCount).toBe(16);
  expect(buffer.setAtomic(true)).toBe(buffer);
  expect(buffer.isAtomic).toBe(true);
  expect(buffer.toReadOnly()).toBe(buffer);
  expect(buffer.access).toBe(THREE.NodeAccess.READ_ONLY);
  const index = new THREE.ConstNode(3, 'uint');
  const element = new THREE.StorageArrayElementNode(buffer, index);
  expect(element.node).toBe(buffer);
  expect(element.indexNode).toBe(index);
  const increment = new THREE.ConstNode(1, 'uint');
  const atomic = new THREE.AtomicFunctionNode(
    THREE.AtomicFunctionNode.ATOMIC_ADD,
    element,
    increment,
  );
  expect(atomic.pointerNode).toBe(element);
  expect(atomic.valueNode).toBe(increment);
  expect(atomic.method).toBe('atomicAdd');
  expect('setAtmoic' in buffer).toBe(false);
});

it('retains compute dimensions and initialization callback as caller-owned data', () => {
  const body = new THREE.ExpressionNode('', 'void'),
    group = [8, 4, 1];
  const compute = new THREE.ComputeNode(body, group),
    init = vi.fn();
  expect(compute.computeNode).toBe(body);
  expect(compute.workgroupSize).toBe(group);
  expect(compute.setName('simulation').onInit(init)).toBe(compute);
  compute.count = 129;
  expect(compute.count).toBe(129);
  compute.count = null;
  compute.dispatchSize = [4, 3, 1];
  expect(compute.dispatchSize).toEqual([4, 3, 1]);
  expect(init).not.toHaveBeenCalled();
  expect('setCount' in compute).toBe(false);
  const tsl = THREE.TSL.compute(body, 65, [8]);
  expect(tsl).toBeInstanceOf(THREE.ComputeNode);
  expect(tsl.count).toBe(65);
  const material = new MeshBasicNodeMaterial();
  Reflect.set(material, 'colorNode', compute);
  expect(() => validateMaterial(material).unwrap()).toThrow('NodeMaterial.colorNode');
  material.dispose();
});

it('keeps workgroup, subgroup, barrier and builtin metadata without executing a kernel', () => {
  const memory = new THREE.WorkgroupInfoNode('workgroup', 'uint', 32);
  expect(memory.toAtomic()).toBe(memory);
  expect(memory.isAtomic).toBe(true);
  expect(memory.bufferCount).toBe(32);
  const value = new THREE.ConstNode(1, 'uint');
  const subgroup = new THREE.SubgroupFunctionNode(THREE.SubgroupFunctionNode.SUBGROUP_ADD, value);
  expect(Reflect.get(subgroup, 'aNode')).toBe(value);
  expect(Reflect.get(subgroup, 'method')).toBe('subgroupAdd');
  const barrier = new THREE.BarrierNode('workgroup');
  expect(barrier.scope).toBe('workgroup');
  const builtin = new THREE.ComputeBuiltinNode('local_invocation_index', 'uint');
  expect(builtin.toJSON()).toMatchObject({
    type: 'ComputeBuiltinNode',
    _builtinName: 'local_invocation_index',
  });
  const ordinary = new THREE.BuiltinNode('position');
  expect(ordinary.name).toBe('position');
});

it('keeps storage texture operands, access and mip selection in the public constructor family', () => {
  const uv = new THREE.ConstNode<'vec3', THREE.Vector3>(new THREE.Vector3(1, 2, 0), 'vec3');
  const value = new THREE.ConstNode(new THREE.Vector4(0.2, 0.4, 0.6, 1), 'vec4');
  const image = new THREE.StorageTexture(8, 8),
    volume = new THREE.Storage3DTexture(8, 8, 4);
  const node = new THREE.StorageTextureNode(image, uv, value);
  const node3d = new THREE.StorageTexture3DNode(volume, uv, value);
  for (const [texture, leaf] of [
    [image, node],
    [volume, node3d],
  ] as const) {
    expect(leaf).toBeInstanceOf(THREE.TextureNode);
    expect(leaf.value).toBe(texture);
    expect(leaf.storeNode).toBe(value);
    expect(leaf.toReadWrite().setMipLevel(2)).toBe(leaf);
    expect(leaf.access).toBe(THREE.NodeAccess.READ_WRITE);
    expect(leaf.mipLevel).toBe(2);
    texture.dispose();
  }
});

it('retains MRT outputs, blending and clear colors as CPU authoring data', () => {
  const color = new THREE.UniformNode<'color', THREE.Color>(new THREE.Color('red'));
  const mrt = new THREE.MRTNode({ output: color });
  expect(mrt).toBeInstanceOf(THREE.OutputStructNode);
  expect(mrt.has('output')).toBe(true);
  expect(mrt.get('output')).toBe(color);
  const blend = new THREE.BlendMode(THREE.NoBlending);
  expect(mrt.setBlendMode('output', blend)).toBe(mrt);
  expect(mrt.getBlendMode('output')).toBe(blend);
  mrt.setClearColor('output', 0xff0000, 0.5);
  expect(mrt.getClearColor('output')?.a).toBe(0.5);
  const secondary = new THREE.MRTNode({ normal: color });
  expect(mrt.merge(secondary).get('normal')).toBe(color);
});

it('retains lighting and render-output operands without installing a native lighting model', () => {
  const value = new THREE.ConstNode(0.5, 'float');
  const ao = new THREE.AONode(value),
    irradiance = new THREE.IrradianceNode(value);
  expect(ao).toBeInstanceOf(THREE.LightingNode);
  expect(ao.aoNode).toBe(value);
  expect(irradiance.node).toBe(value);
  const physical = new THREE.PhysicalLightingModel(true, true, true);
  const phong = new THREE.PhongLightingModel(false);
  expect(physical).toBeInstanceOf(THREE.LightingModel);
  expect(physical.clearcoat).toBe(true);
  expect(phong.specular).toBe(false);
  const context = new THREE.LightingContextNode(new THREE.LightsNode(), physical, [ao]);
  expect(context.lightingModel).toBe(physical);
  expect(context.getContext().materialLightings[0]).toBe(ao);
  const output = new THREE.RenderOutputNode(value, THREE.NoToneMapping, THREE.SRGBColorSpace);
  expect(output.colorNode).toBe(value);
  expect(output.outputColorSpace).toBe(THREE.SRGBColorSpace);
  const clipping = new THREE.ClippingNode();
  expect(clipping.scope).toBe(THREE.ClippingNode.DEFAULT);
});

it('keeps debug callbacks and inspector state dormant until explicitly driven', () => {
  const value = new THREE.ConstNode(1),
    callback = vi.fn();
  const debug = new THREE.DebugNode(value, callback);
  const inspected = new THREE.InspectorNode(value, 'value', callback);
  expect(Reflect.get(debug, 'node')).toBe(value);
  expect(Reflect.get(inspected, 'node')).toBe(value);
  expect(inspected.name).toBe('value');
  expect(callback).not.toHaveBeenCalled();
  const inspector = new THREE.InspectorBase();
  expect(inspector).toBeInstanceOf(THREE.EventDispatcher);
  expect(inspector.isRunning).toBe(false);
  const dispose = vi.fn();
  inspector.addEventListener('dispose', dispose);
  inspector.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  const projector = new THREE.ProjectorLight(0xffddaa, 2);
  projector.aspect = 2;
  expect(projector).toBeInstanceOf(THREE.SpotLight);
  expect(projector.clone().aspect).toBe(2);
  projector.dispose();
});

function computeTypes() {
  const node = new THREE.ComputeNode(new THREE.ExpressionNode('', 'void'), [8]);
  // @ts-expect-error r187 has mutable count/dispatchSize data, not setCount/getCount methods.
  node.setCount(1);
  // @ts-expect-error the obsolete setter also stays absent after fluent naming.
  node.setName('data').setCount(1);
}
void computeTypes;
