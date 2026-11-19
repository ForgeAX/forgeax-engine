import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';

it('retains struct, variable, isolation and override source graph data', () => {
  const layout = new THREE.StructTypeNode({ tint: 'vec3', gain: 'float' }, 'Surface');
  const tint = new THREE.ConstNode(new THREE.Vector3(1, 0.5, 0.25), 'vec3');
  const gain = new THREE.ConstNode(0.8, 'float');
  const structure = new THREE.StructNode(layout, { tint, gain });
  const variable = new THREE.VarNode(gain, 'gain');
  const isolated = new THREE.IsolateNode(variable);
  const overrides = new Map([[gain, () => tint]]);
  const context = new THREE.OverrideContextNode(overrides, isolated);
  for (const node of [structure, variable, isolated, context])
    expect(node).toBeInstanceOf(THREE.Node);
  expect(structure.structTypeNode).toBe(layout);
  expect(structure.values).toEqual({ tint, gain });
  expect(variable.node).toBe(gain);
  expect(variable.name).toBe('gain');
  expect(context).toBeInstanceOf(THREE.ContextNode);
  expect(context.value).toEqual({ overrideNodes: overrides });
  expect(structure.toJSON().type).toBe('StructNode');
});

it('keeps buffer/attribute references and code/function authoring objects without invoking a builder', () => {
  const data = new Float32Array([1, 2, 3, 4]);
  const buffer = new THREE.BufferNode(data, 'vec4', 1);
  expect(buffer).toBeInstanceOf(THREE.UniformNode);
  expect(buffer.value).toBe(data);
  const attribute = new THREE.AttributeNode('position', 'vec3');
  expect(attribute).toBeInstanceOf(THREE.Node);
  expect(attribute.getAttributeName()).toBe('position');
  const included = new THREE.CodeNode('const SCALE = 0.5;', [], 'wgsl');
  const fn = new THREE.FunctionNode<{ value: THREE.Node }>(
    'fn gain(value: f32) -> f32 { return value * SCALE; }',
    [included],
    'wgsl',
  );
  const parameter = new THREE.ConstNode(1, 'float');
  const call = new THREE.FunctionCallNode<{ value: THREE.Node }>(fn, { value: parameter });
  const overload = new THREE.FunctionOverloadingNode();
  expect(fn).toBeInstanceOf(THREE.CodeNode);
  expect(fn.includes[0]).toBe(included);
  expect(call.functionNode).toBe(fn);
  expect(call.parameters).toEqual({ value: parameter });
  expect(overload).toBeInstanceOf(THREE.Node);
  expect(overload.parametersNodes).toEqual([]);
  expect(call.toJSON().type).toBe('FunctionCallNode');
});
