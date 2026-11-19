import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { resolveWebGPUVertexBufferLayouts } from '../assembly/webgpu-vertex-layouts';

it('seals a real 32-byte packed terrain layout with integer input and zero-copy UV aliases', () => {
  const projection = deriveVertexLayoutProjection({
    position: new Float32Array(0),
    uv: new Float32Array(0),
    uv1: new Float32Array(0),
    tangentFrame: new Uint32Array(0),
  });
  const buffers = resolveWebGPUVertexBufferLayouts({
    vertexInputContract: 'render-material',
    vertexLayout: undefined,
    vertexLayoutProjection: projection,
    resolvedUvSetCount: 8,
    layoutKind: 'gpu-driven-pbr',
    meshAttributes: undefined,
    particleInputLanes: undefined,
  });
  expect(buffers).toHaveLength(1);
  expect(buffers[0]?.arrayStride).toBe(32);
  const attributes = Array.from(buffers[0]?.attributes ?? []);
  expect(attributes.find((attribute) => attribute.shaderLocation === 14)).toEqual({
    shaderLocation: 14,
    offset: 28,
    format: 'uint32',
  });
  expect(
    attributes.some(
      (attribute) => attribute.shaderLocation === 1 || attribute.shaderLocation === 3,
    ),
  ).toBe(false);
  for (const location of [6, 7, 8, 9, 10, 11, 12])
    expect(attributes.find((attribute) => attribute.shaderLocation === location)?.offset).toBe(20);
});
