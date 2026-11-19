import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';

it('preserves expression operands, branches, stack references and source JSON', () => {
  const a = new THREE.ConstNode<'float', number>(1, 'float'),
    b = new THREE.ConstNode<'float', number>(2, 'float');
  const op = new THREE.OperatorNode('+', a, b);
  const math = new THREE.MathNode('sin', op);
  const cast = new THREE.BitcastNode(a, 'uint', 'float');
  const variable = new THREE.VarNode(a, 'value');
  const assign = new THREE.AssignNode(variable, math);
  const branch = new THREE.ConditionalNode(
    new THREE.ConstNode<'bool', boolean>(true, 'bool'),
    a,
    b,
  );
  const stack = new THREE.StackNode();
  stack.nodes.push(assign);
  stack.outputNode = branch;
  const params: [] = [];
  const loop = new THREE.LoopNode(params);
  const output = new THREE.OutputStructNode(a, b);
  const sub = new THREE.SubBuildNode(math, 'surface', 'float');
  const rotate = new THREE.RotateNode(new THREE.ConstNode(new THREE.Vector2(1, 0), 'vec2'), a);
  const temp = new THREE.TempNode('float');
  for (const node of [op, math, cast, assign, branch, stack, loop, output, sub, rotate, temp])
    expect(node).toBeInstanceOf(THREE.Node);
  expect(op.aNode).toBe(a);
  expect(op.bNode).toBe(b);
  expect(math.aNode).toBe(op);
  expect(cast.valueNode).toBe(a);
  expect(assign.targetNode).toBe(variable);
  expect(assign.sourceNode).toBe(math);
  expect(branch.ifNode).toBe(a);
  expect(branch.elseNode).toBe(b);
  expect(stack.nodes).toContain(assign);
  expect(stack.outputNode).toBe(branch);
  expect(loop.params).toBe(params);
  expect(output.members).toEqual([a, b]);
  expect(sub.node).toBe(math);
  expect(rotate.positionNode).toBeInstanceOf(THREE.Node);
  expect(op.toJSON()).toMatchObject({ type: 'OperatorNode', op: '+' });
});

it('retains reference objects and reads current caller-owned values without a renderer', () => {
  const source = { settings: { gain: 0.5 }, samples: [1, 2] };
  const reference = new THREE.ReferenceNode('settings.gain', 'float', source);
  const base = new THREE.ReferenceBaseNode('settings.gain', 'float', source);
  for (const node of [reference, base]) {
    expect(node.object).toBe(source);
    node.update(new THREE.NodeFrame());
    expect(node.node).toBeInstanceOf(THREE.UniformNode);
    expect((node.node as THREE.UniformNode<'float'>).value).toBe(0.5);
    source.settings.gain = 0.7;
    node.update(new THREE.NodeFrame());
    expect((node.node as THREE.UniformNode<'float'>).value).toBe(0.7);
    source.settings.gain = 0.5;
  }
  const index = new THREE.ConstNode<'uint', number>(0, 'uint');
  const element = new THREE.ReferenceElementNode(
    new THREE.ReferenceNode('samples', 'float', source, 2),
    index,
  );
  expect(element.referenceNode?.object).toBe(source);
  const userData = new THREE.UserDataNode('gain', 'float', { gain: 2 });
  expect(userData).toBeInstanceOf(THREE.ReferenceNode);
  const values = [new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6)];
  const uniform = new THREE.UniformArrayNode(values, 'vec3');
  expect(uniform.array).toBe(values);
});

it('keeps texture and geometry accessors as authoring data in the same constructor family', () => {
  const texture = new THREE.Texture(),
    cube = new THREE.CubeTexture(),
    volume = new THREE.Data3DTexture();
  const nodes = [
    new THREE.TextureNode(texture),
    new THREE.CubeTextureNode(cube),
    new THREE.Texture3DNode(volume),
  ];
  expect(nodes.map((node) => node.value)).toEqual([texture, cube, volume]);
  const index = new THREE.IndexNode('vertex'),
    color = new THREE.VertexColorNode(0),
    front = new THREE.FrontFacingNode();
  for (const node of [...nodes, index, color, front]) expect(node).toBeInstanceOf(THREE.Node);
  expect(index.scope).toBe('vertex');
  expect(color.index).toBe(0);
  texture.dispose();
  cube.dispose();
  volume.dispose();
});
