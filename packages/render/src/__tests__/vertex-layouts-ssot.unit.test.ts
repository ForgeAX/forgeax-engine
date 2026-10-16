import { deriveVertexBufferLayout } from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import {
  BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS,
  MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS,
  POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS,
  TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS,
  toGpuVertexBufferLayouts,
} from '../assembly/webgpu-vertex-layouts';

const FLOAT32_COMPONENT_COUNT = {
  float32x2: 2,
  float32x3: 3,
  float32x4: 4,
} as const;

describe('prepared feature vertex layout SSOT', () => {
  it('derives the mesh vertex stream from geometry layout ownership', () => {
    const [expected] = toGpuVertexBufferLayouts(
      deriveVertexBufferLayout({
        position: new Float32Array(),
        normal: new Float32Array(),
        uv: new Float32Array(),
        tangent: new Float32Array(),
        uv1: new Float32Array(),
        color: new Float32Array(),
      }),
    );
    const [actual] = MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS;

    if (expected === undefined) throw new Error('Missing geometry descriptor');
    expect(actual).toEqual({
      ...expected,
      stepMode: 'vertex',
      attributes: expected.attributes.map((attribute) => ({
        ...attribute,
        shaderLocation:
          attribute.shaderLocation === 6
            ? 15
            : attribute.shaderLocation === 13
              ? 14
              : attribute.shaderLocation,
      })),
    });
  });

  it.each([
    ['position-size-color', POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS],
    ['billboard-material', BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS],
    ['topology-segment', TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS],
    ['mesh-material-instance', [MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS[1]]],
  ] as const)('%s derives stride from its declared attributes', (_name, buffers) => {
    for (const buffer of buffers) {
      if (buffer === undefined) {
        throw new Error('vertex layout fixture is missing its buffer declaration');
      }
      const end = Math.max(
        ...buffer.attributes.map(
          (attribute) =>
            attribute.offset +
            FLOAT32_COMPONENT_COUNT[attribute.format as keyof typeof FLOAT32_COMPONENT_COUNT] * 4,
        ),
      );
      expect(buffer.arrayStride).toBe(end);
    }
  });
});
