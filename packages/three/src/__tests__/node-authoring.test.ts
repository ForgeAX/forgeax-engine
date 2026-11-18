import * as THREE from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';

it('retains source node identities, shared graph references and JSON without a shader builder', () => {
  const a = new THREE.ConstNode(1),
    b = new THREE.UniformNode(2, 'float');
  const joined = new THREE.JoinNode([a, b, a], 'vec3');
  const split = new THREE.SplitNode(joined, 'xy');
  const converted = new THREE.ConvertNode(split, 'vec2');
  const flipped = new THREE.FlipNode(converted, 'x');
  const changed = new THREE.SetNode(flipped, 'y', b);
  const context = new THREE.ContextNode(changed, { label: 'authoring' });
  const expression = new THREE.ExpressionNode('return;', 'void');
  const root = new THREE.BypassNode(context, expression);
  for (const node of [a, b, joined, split, converted, flipped, changed, context, expression, root])
    expect(node).toBeInstanceOf(THREE.Node);
  expect(b).toBeInstanceOf(THREE.InputNode);
  b.value = 4;
  expect(joined.nodes[1]).toBe(b);
  const json = root.toJSON();
  const nodes = json.nodes ?? [];
  expect(nodes.filter((node) => node.uuid === a.uuid)).toHaveLength(1);
  expect(nodes.filter((node) => node.uuid === b.uuid)).toHaveLength(1);
  expect(nodes.find((node) => node.uuid === joined.uuid)).toMatchObject({
    type: 'JoinNode',
    inputNodes: { nodes: [a.uuid, b.uuid, a.uuid] },
  });
  expect(nodes.find((node) => node.uuid === b.uuid)).toMatchObject({
    type: 'UniformNode',
    value: 4,
  });
  const property = new THREE.PropertyNode('vec3', 'surfaceColor');
  const parameter = new THREE.ParameterNode('float', 'gain');
  const member = new THREE.MemberNode(property, 'r');
  const array = new THREE.ArrayNode('float', 2, [a, b]);
  const element = new THREE.ArrayElementNode(array, new THREE.ConstNode(1, 'uint'));
  expect(parameter).toBeInstanceOf(THREE.PropertyNode);
  expect(member.structNode).toBe(property);
  expect(member.property).toBe('r');
  expect(element.node).toBe(array);
  expect(array.values).toEqual([a, b]);
  expect(array.toJSON().type).toBe('ArrayNode');
});

it('computes original struct alignment for authoring layouts', () => {
  const layout = new THREE.StructTypeNode(
    { position: 'vec3', weight: 'float', uv: 'vec2', counter: { type: 'uint', atomic: true } },
    'Particle',
  );
  expect(layout).toBeInstanceOf(THREE.Node);
  expect(layout.membersLayout).toEqual([
    { name: 'position', type: 'vec3', atomic: false },
    { name: 'weight', type: 'float', atomic: false },
    { name: 'uv', type: 'vec2', atomic: false },
    { name: 'counter', type: 'uint', atomic: true },
  ]);
  expect(layout.getLength()).toBe(8);
});

it.each([
  [THREE.EventNode.OBJECT, 'updateNode', false],
  [THREE.EventNode.MATERIAL, 'updateNode', true],
  [THREE.EventNode.FRAME, 'updateNode', true],
  [THREE.EventNode.AFTER_OBJECT, 'updateAfterNode', false],
  [THREE.EventNode.BEFORE_OBJECT, 'updateBeforeNode', false],
  [THREE.EventNode.BEFORE_MATERIAL, 'updateBeforeNode', true],
  [THREE.EventNode.BEFORE_FRAME, 'updateBeforeNode', true],
] as const)('drives %s through the caller-owned NodeFrame', (phase, method, deduplicate) => {
  const frame = new THREE.NodeFrame(),
    callback = vi.fn();
  const event = new THREE.EventNode(phase, callback);
  expect(event).toBeInstanceOf(THREE.Node);
  frame.update();
  frame.renderId++;
  frame[method](event);
  frame[method](event);
  expect(callback).toHaveBeenCalledTimes(deduplicate ? 1 : 2);
  expect(callback).toHaveBeenCalledWith(frame);
  frame.renderId++;
  frame.update();
  frame[method](event);
  expect(callback).toHaveBeenCalledTimes(deduplicate ? 2 : 3);
});

it('keeps pipeline events explicit and readback buffers as caller-managed event data', () => {
  const frame = new THREE.NodeFrame(),
    callback = vi.fn();
  for (const phase of [
    THREE.EventNode.BEFORE_RENDER_PIPELINE,
    THREE.EventNode.AFTER_RENDER_PIPELINE,
  ]) {
    const event = new THREE.EventNode(phase, callback);
    frame.updateBeforeNode(event);
    frame.updateNode(event);
    frame.updateAfterNode(event);
  }
  expect(callback).not.toHaveBeenCalled();
  const buffer = new THREE.ReadbackBuffer(64),
    released = vi.fn(),
    disposed = vi.fn();
  expect(buffer).toBeInstanceOf(THREE.EventDispatcher);
  expect(buffer.buffer).toBeNull();
  expect(buffer.maxByteLength).toBe(64);
  buffer.addEventListener('release', released);
  buffer.addEventListener('dispose', disposed);
  buffer.release();
  buffer.dispose();
  expect(released).toHaveBeenCalledOnce();
  expect(disposed).toHaveBeenCalledOnce();
});
