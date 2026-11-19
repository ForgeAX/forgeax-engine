import { UniformsUtils as upstream } from 'three/src/renderers/shaders/UniformsUtils.js';
import { expect, it, vi } from 'vitest';
import * as THREE from '../cpu';

it('exports the original r187 addon utility with the public CPU constructor family', () => {
  expect(THREE.UniformsUtils).toBe(upstream);
  const color = new THREE.Color(0.2, 0.4, 0.6);
  const vector = new THREE.Vector3(1, 2, 3);
  const matrix = new THREE.Matrix4().makeTranslation(1, 2, 3);
  const quaternion = new THREE.Quaternion();
  const texture = new THREE.Texture();
  const plain = { nested: [1] };
  const typed = new Float32Array([1, 2]);
  const source = {
    color: { value: color },
    vector: { value: vector },
    matrix: { value: matrix },
    quaternion: { value: quaternion },
    texture: { value: texture },
    vectors: { value: [vector, new THREE.Vector3(4, 5, 6)] },
    plain: { value: plain },
    array: { value: [plain] },
    typed: { value: typed },
  };
  const cloned: typeof source = THREE.UniformsUtils.clone(source);
  for (const name of ['color', 'vector', 'matrix', 'quaternion', 'texture'] as const) {
    expect(cloned[name]).not.toBe(source[name]);
    expect(cloned[name].value).not.toBe(source[name].value);
    expect(cloned[name].value.constructor).toBe(source[name].value.constructor);
  }
  expect(cloned.texture.value.source).toBe(texture.source);
  expect(cloned.vectors.value).not.toBe(source.vectors.value);
  expect(cloned.vectors.value[0]).not.toBe(vector);
  expect(cloned.vectors.value[0]).toBeInstanceOf(THREE.Vector3);
  expect(cloned.vectors.value).toEqual(source.vectors.value);
  // Upstream shallow-copies ordinary arrays and borrows plain/typed objects.
  expect(cloned.plain.value).toBe(plain);
  expect(cloned.array.value).not.toBe(source.array.value);
  expect(cloned.array.value[0]).toBe(plain);
  expect(cloned.typed.value).toBe(typed);
  const merged = THREE.UniformsUtils.merge([source, { vector: { value: color } }]);
  expect(merged.vector?.value).toBeInstanceOf(THREE.Color);
  expect(merged.vector?.value).not.toBe(color);
  expect(source.vector.value).toBe(vector);
});

it('retains the upstream warning and null result for a render-target texture', () => {
  const texture = new THREE.Texture();
  texture.isRenderTargetTexture = true;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(THREE.UniformsUtils.clone({ target: { value: texture } }).target.value).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('cannot be cloned'));
  } finally {
    warning.mockRestore();
  }
});
