import * as THREE from '@forgeax/engine/three';
import UniformNode from 'three/src/nodes/core/UniformNode.js';
import { expect, it } from 'vitest';

it('keeps descriptor identity, varying inheritance, uniform ownership and diagnostic stack information', () => {
  expect(new THREE.IESSpotLight()).toBeInstanceOf(THREE.SpotLight);
  const attribute = new THREE.NodeAttribute('position', 'vec3');
  const varying = new THREE.NodeVarying(attribute.name, attribute.type, 'flat');
  expect(varying).toBeInstanceOf(THREE.NodeVar);
  const source = new UniformNode(3, 'float');
  const uniform = new THREE.NodeUniform('roughness', 'float', source);
  uniform.value = 0.5;
  expect(source.value).toBe(0.5);
  expect(uniform.id).toBe(source.id);
  const input = new THREE.NodeFunctionInput('vec3', 'normal', null, 'in');
  expect(THREE.NodeFunctionInput.isNodeFunctionInput).toBe(true);
  expect(Object.hasOwn(input, 'isNodeFunctionInput')).toBe(false);
  const code = new THREE.NodeCode(input.name, input.type, 'return normal;');
  expect(code.isNodeCode).toBe(true);
  const trace = new THREE.StackTrace('Error\n    at consumer (https://example.test/app.js:10:20)');
  const error = new THREE.NodeError('unsupported node recipe', trace);
  expect(error).toBeInstanceOf(Error);
  expect(error.stackTrace).toBe(trace);
  expect(trace.getLocation()).toContain('app.js:10');
});
