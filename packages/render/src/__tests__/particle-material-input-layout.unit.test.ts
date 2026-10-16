import { describe, expect, it } from 'vitest';
import { particleMaterialInputVertexBuffers } from '../assembly/factory';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import { buildPipelineDescriptor, cacheKeyOf } from '../pipeline-spec';

const layouts = [
  {
    name: RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance,
    baseStride: 31 * 4,
    firstLocation: 9,
  },
  {
    name: RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance,
    baseStride: 12 * 4,
    firstLocation: 4,
  },
  {
    name: RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance,
    baseStride: 18 * 4,
    firstLocation: 10,
  },
];

describe('particle material input layout', () => {
  it.each(layouts)('derives the canonical ABI and cache identity for $name', (layout) => {
    const keys = new Set<string>();
    for (const lanes of [1, 2, 3, 4]) {
      const buffers = particleMaterialInputVertexBuffers(layout.name, lanes);
      if (buffers === undefined) throw new Error('Missing input layout');
      const instance = buffers.at(-1);
      if (instance === undefined) throw new Error('Missing instance stream');
      expect(instance.arrayStride).toBe(layout.baseStride + lanes * 16);
      const inputAttributes = [...instance.attributes].slice(-lanes);
      expect(inputAttributes).toEqual(
        Array.from({ length: lanes }, (_, lane) => ({
          shaderLocation: layout.firstLocation + lane,
          offset: layout.baseStride + lane * 16,
          format: 'float32x4',
        })),
      );
      keys.add(
        cacheKeyOf({
          shader: { id: 'test::same-shader', passKind: 'forward', variantSet: undefined },
          attachments: { colorFormats: ['rgba8unorm'], depthFormat: undefined, sampleCount: 1 },
          geometry: { topology: 'triangle-list', vertexLayout: {}, vertexBuffers: buffers },
          renderState: undefined,
        }),
      );
      const descriptor = buildPipelineDescriptor(
        {
          shader: { id: 'test::same-shader', passKind: 'forward', variantSet: undefined },
          attachments: { colorFormats: ['rgba8unorm'], depthFormat: undefined, sampleCount: 1 },
          geometry: { topology: 'triangle-list', vertexLayout: {}, vertexBuffers: buffers },
          renderState: undefined,
        },
        { vertex: 'vertex-module', fragment: 'fragment-module' },
      );
      expect((descriptor.vertex as { buffers: readonly unknown[] }).buffers).toEqual(buffers);
    }
    expect(keys.size).toBe(4);
  });

  it.each([
    0,
    -1,
    5,
    1.5,
    Number.NaN,
  ])('rejects invalid lane count %s before pipeline resolution', (particleInputLanes) => {
    const transaction = createPreparedGraphicsStore().beginFrame('test', 1);
    expect(
      transaction.prepare('pipeline', 'material', {
        shader: 'test::shader',
        vertexLayout: RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance,
        particleInputLanes,
        colorFormats: ['rgba8unorm'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'render-feature-preparation-failed' } });
  });

  it('rejects an omitted lane count for material-input layouts', () => {
    const transaction = createPreparedGraphicsStore().beginFrame('test', 1);
    expect(
      transaction.prepare('pipeline', 'material', {
        shader: 'test::shader',
        vertexLayout: RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance,
        colorFormats: ['rgba8unorm'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'render-feature-preparation-failed' } });
  });

  it('rejects lanes on ordinary vertex layouts', () => {
    const transaction = createPreparedGraphicsStore().beginFrame('test', 1);
    expect(
      transaction.prepare('pipeline', 'material', {
        shader: 'test::shader',
        vertexLayout: 'position',
        particleInputLanes: 1,
        colorFormats: ['rgba8unorm'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'render-feature-preparation-failed' } });
  });
});
