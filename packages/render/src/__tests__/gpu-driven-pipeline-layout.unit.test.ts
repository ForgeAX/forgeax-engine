import * as geometry from '@forgeax/engine-geometry';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { VertexAttributeMap } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import type { RenderSystemInternals } from '../record/render-context';
import { standardPbrInputs } from './gpu-driven-production-fixture';

vi.mock('@forgeax/engine-geometry', async (importOriginal) => {
  const original = await importOriginal<typeof geometry>();
  return {
    ...original,
    deriveVertexBufferLayoutFromProjection: vi.fn(original.deriveVertexBufferLayoutFromProjection),
  };
});

afterEach(() => vi.clearAllMocks());

type PipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;
const empty = new Float32Array(0);
const positionOnly = geometry.deriveVertexLayoutProjection({ position: empty });

async function raster(useFactory = false) {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const colorShader = (await rhi.createShaderModule(device, { code: 'synthetic-color' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const inputs = standardPbrInputs(device, shader, viewLayout);
  const pipelineState = inputs.materialPipelineState;
  const baseArtifact = inputs.materialArtifact;
  if (pipelineState === undefined || baseArtifact === undefined) throw new Error('missing fixture');
  const artifact: MaterialShaderArtifact = useFactory
    ? {
        ...baseArtifact,
        material: 'game::layout',
        specializationKey: 'game::layout-selected',
        uvSetCount: 3,
      }
    : baseArtifact;
  const programs = new Map(pipelineState.gpuDrivenPbrPrograms);
  const colorKey = standardPbrProgramKey(baseArtifact.material, true);
  if (colorKey === undefined) throw new Error('missing Standard program key');
  programs.set(colorKey, { module: colorShader, artifact: baseArtifact });
  const actualGeometry = await vi.importActual<typeof geometry>('@forgeax/engine-geometry');
  const createPipeline = vi.spyOn(device, 'createRenderPipeline');
  // Exercise the real factory seam and RHI handles. Only the adapter's duplicate
  // derivation is observed; the factory owns its descriptor construction.
  const factory = vi.fn<PipelineFactory>((...args) => {
    const projection = args[13];
    if (projection === undefined) throw new Error('factory lost the projection');
    const vertexLayout = actualGeometry.deriveVertexBufferLayoutFromProjection(projection, {
      shaderUvSetCount: args[10] ?? 0,
    })[0];
    if (vertexLayout === undefined) throw new Error('factory received an empty layout');
    return {
      pipeline: device
        .createRenderPipeline({
          layout: pipelineState.pbrPipelineLayout ?? 'auto',
          vertex: {
            module: shader,
            entryPoint: args[16] ?? 'vs_scene',
            buffers: [
              {
                arrayStride: vertexLayout.arrayStride,
                attributes: vertexLayout.attributes.map((attribute) => ({
                  ...attribute,
                  format: attribute.format as GPUVertexFormat,
                })),
              },
            ],
          },
          fragment: {
            module: shader,
            entryPoint: 'fs_main',
            targets: [{ format: args[9] ?? 'rgba16float' }],
          },
        })
        .unwrap(),
      group2Contract: 'mesh',
    };
  });
  const adapter = MaterialAbiRasterAdapter.create({
    device,
    pipelineState: { ...pipelineState, gpuDrivenPbrPrograms: programs },
    artifact,
    visibleBuffer: device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE }).unwrap(),
    ...(useFactory ? { pipelineFactory: factory } : {}),
  }).unwrap();
  const request = (projection = positionOnly, uvCount = 0, selected = artifact) =>
    adapter.pipeline(
      'rgba16float',
      1,
      projection,
      uvCount,
      'triangle-list',
      undefined,
      undefined,
      selected,
    );
  return { adapter, artifact, request, factory, createPipeline, shader, colorShader };
}

describe('GPU-driven pipeline vertex layout ownership', () => {
  it('derives a descriptor only on a legacy pipeline miss, including explicit invalidation', async () => {
    const owner = await raster();
    try {
      const first = owner.request().unwrap();
      for (let draw = 0; draw < 256; draw += 1) expect(owner.request().unwrap()).toBe(first);
      expect(owner.createPipeline.mock.calls.length).toBe(1);
      expect(vi.mocked(geometry.deriveVertexBufferLayoutFromProjection).mock.calls.length).toBe(1);
      owner.adapter.invalidatePipelineCache();
      expect(owner.request().unwrap()).not.toBe(first);
      expect(owner.createPipeline.mock.calls.length).toBe(2);
      expect(vi.mocked(geometry.deriveVertexBufferLayoutFromProjection).mock.calls.length).toBe(2);
    } finally {
      owner.adapter.dispose();
    }
  });

  it('passes the exact projection to the selected custom factory without deriving an unused descriptor', async () => {
    const owner = await raster(true);
    try {
      const first = owner.request(positionOnly, 1).unwrap();
      for (let draw = 0; draw < 256; draw += 1)
        expect(owner.request(positionOnly, 1).unwrap()).toBe(first);
      expect(owner.factory.mock.calls.length).toBe(1);
      const call = owner.factory.mock.calls[0];
      expect(call?.[0]).toBe('game::layout-selected');
      expect(call?.[10]).toBe(3);
      expect(call?.[13]).toBe(positionOnly);
      expect(call?.[14]).toBe('immediate');
      expect(call?.[15]).toBe('gpu-driven-pbr');
      expect(owner.createPipeline.mock.calls[0]?.[0].vertex.buffers?.[0]).toMatchObject({
        arrayStride: 20,
      });
      expect(vi.mocked(geometry.deriveVertexBufferLayoutFromProjection).mock.calls.length).toBe(0);
    } finally {
      owner.adapter.dispose();
    }
  });

  it.each([
    { map: { position: empty }, uvCount: 0, stride: 12, locations: [0], offsets: [0] },
    {
      map: { position: empty },
      uvCount: 3,
      stride: 20,
      locations: [0, 2, 6, 7],
      offsets: [0, 12, 12, 12],
    },
    {
      map: { position: empty, uv: empty },
      uvCount: 3,
      stride: 20,
      locations: [0, 2, 6, 7],
      offsets: [0, 12, 12, 12],
    },
    {
      map: { position: empty, uv: empty, uv2: empty },
      uvCount: 4,
      stride: 28,
      locations: [0, 2, 6, 7, 8],
      offsets: [0, 12, 20, 20, 20],
    },
  ])('retains the GPU descriptor for stride $stride and UV count $uvCount', async ({
    map,
    uvCount,
    stride,
    locations,
    offsets,
  }) => {
    const owner = await raster();
    try {
      const layout = geometry.deriveVertexLayoutProjection(map);
      const pipeline = owner.request(layout, uvCount).unwrap();
      expect(owner.request(layout, uvCount).unwrap()).toBe(pipeline);
      const vertex = owner.createPipeline.mock.calls[0]?.[0].vertex.buffers?.[0];
      expect(vertex?.arrayStride).toBe(stride);
      expect(vertex?.attributes.map((attribute) => attribute.shaderLocation)).toEqual(locations);
      expect(vertex?.attributes.map((attribute) => attribute.offset)).toEqual(offsets);
    } finally {
      owner.adapter.dispose();
    }
  });

  it('keeps UV requests, explicit stride and changed author attributes distinct', async () => {
    const owner = await raster();
    try {
      const map: VertexAttributeMap = { position: empty };
      const layout = geometry.deriveVertexLayoutProjection(map);
      const first = owner.request(layout, 0).unwrap();
      const aliased = owner.request(layout, 3).unwrap();
      expect(aliased).not.toBe(first);
      // Raw stride remains a key fact even when a caller retains the same digest.
      const padded = { ...layout, arrayStride: 16 };
      expect(owner.request(padded, 0).unwrap()).not.toBe(first);
      expect(owner.createPipeline.mock.calls[2]?.[0].vertex.buffers?.[0]?.arrayStride).toBe(16);
      map.color = empty;
      const colored = geometry.deriveVertexLayoutProjection(map);
      expect(owner.request(colored, 0).unwrap()).not.toBe(first);
      const descriptor = owner.createPipeline.mock.calls[3]?.[0];
      expect(descriptor?.vertex.module).toBe(owner.colorShader);
      expect(descriptor?.vertex.buffers?.[0]?.attributes).toContainEqual({
        shaderLocation: 13,
        offset: 12,
        format: 'float32x4',
      });
      expect(owner.request(layout, 0).unwrap()).toBe(first);
    } finally {
      owner.adapter.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('rejects empty layouts before a warm cache or factory (factory=$0)', async (useFactory) => {
    const owner = await raster(useFactory);
    try {
      owner.request(positionOnly, 3).unwrap();
      const emptyLayout = { ...positionOnly, attributes: [] };
      const rejected = owner.request(emptyLayout, 3);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe('shader-compile-failed');
      expect(owner.createPipeline.mock.calls.length).toBe(1);
      expect(owner.factory.mock.calls.length).toBe(useFactory ? 1 : 0);
    } finally {
      owner.adapter.dispose();
    }
  });
});
