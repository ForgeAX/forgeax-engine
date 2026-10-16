import {
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import type { VertexAttributeMap } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  buildPipelineDescriptor,
  cacheKeyOf,
  type PipelineSpec,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';

const baseAttributes = (): VertexAttributeMap => ({
  position: new Float32Array([0, 0, 0]),
  normal: new Float32Array([0, 1, 0]),
  uv: new Float32Array([0, 0]),
  tangent: new Float32Array([1, 0, 0, 1]),
});

function spec(
  vertexLayout: VertexAttributeMap,
  projection = deriveVertexLayoutProjection(vertexLayout),
): PipelineSpec {
  return {
    shader: {
      id: 'forgeax::default-standard-pbr',
      passKind: 'forward',
      variantSet: 'VERTEX_COLOR_AVAILABLE=false',
    },
    attachments: { colorFormats: ['rgba8unorm'], depthFormat: 'depth24plus', sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout, vertexLayoutProjection: projection },
    renderState: undefined,
  };
}

describe('render vertex-color projection contract', () => {
  it('builds the GPU vertex descriptor from the immutable projection, not a parallel map', () => {
    const plain = baseAttributes();
    const coloredProjection = deriveVertexLayoutProjection({
      ...plain,
      color: new Float32Array([1, 1, 1, 1]),
    });
    const descriptor = buildPipelineDescriptor(spec(plain, coloredProjection), {
      vertex: 'vertex-module',
      fragment: 'fragment-module',
    });
    expect(descriptor.vertex).toMatchObject({
      buffers: [
        {
          arrayStride: coloredProjection.arrayStride,
          attributes: expect.arrayContaining([
            { shaderLocation: 13, offset: 48, format: 'float32x4' },
          ]),
        },
      ],
    });
  });

  it('uses the same projection digest for PSO identity and variant selection', () => {
    const plain = baseAttributes();
    const colored = { ...plain, color: new Float32Array([1, 1, 1, 1]) };
    const plainSpec = spec(plain);
    const coloredSpec = spec(colored);
    expect(cacheKeyOf(plainSpec)).not.toBe(cacheKeyOf(coloredSpec));
    expect(
      cacheKeyOf({
        ...coloredSpec,
        shader: { ...coloredSpec.shader, variantSet: 'VERTEX_COLOR_AVAILABLE=true' },
      }),
    ).not.toBe(cacheKeyOf(coloredSpec));
  });

  it('derives the default-unlit color axis from the mesh projection', () => {
    const plain = deriveVertexLayoutProjection(baseAttributes());
    const colored = deriveVertexLayoutProjection({
      ...baseAttributes(),
      color: new Float32Array([1, 0, 0, 1]),
    });
    expect(variantSetFromVertexLayoutProjection(plain, undefined)).toEqual({
      ok: true,
      value: 'VERTEX_COLOR_AVAILABLE=false',
    });
    expect(variantSetFromVertexLayoutProjection(colored, undefined)).toEqual({
      ok: true,
      value: 'VERTEX_COLOR_AVAILABLE=true',
    });
    const capabilityVariantSet = 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';
    expect(variantSetFromVertexLayoutProjection(plain, capabilityVariantSet)).toEqual({
      ok: true,
      value:
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    });
    expect(variantSetFromVertexLayoutProjection(colored, capabilityVariantSet)).toEqual({
      ok: true,
      value:
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true',
    });
    expect(variantSetFromVertexLayoutProjection(colored, '')).toEqual({ ok: true, value: '' });
    expect(variantSetFromVertexLayoutProjection(plain, '')).toEqual({
      ok: true,
      value: 'VERTEX_COLOR_AVAILABLE=false',
    });
  });

  it('does not allocate color stream bytes for a plain mesh', () => {
    const plain = packInterleavedVertexAttributes(baseAttributes(), 1);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.value.projection.attributes.some((attribute) => attribute.key === 'color')).toBe(
      false,
    );
    expect(plain.value.projection.arrayStride).toBe(48);
    expect(plain.value.vertices.byteLength).toBe(48);
  });

  it('rejects an authored VERTEX_COLOR_AVAILABLE axis that disagrees with geometry', () => {
    const plainProjection = deriveVertexLayoutProjection(baseAttributes());
    const result = variantSetFromVertexLayoutProjection(
      plainProjection,
      'VERTEX_COLOR_AVAILABLE=true',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('vertex-color-variant-conflict');
    expect(result.error.detail).toMatchObject({
      authored: true,
      authoredValue: 'true',
      projected: false,
    });
  });
});
