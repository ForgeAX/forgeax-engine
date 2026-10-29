import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { BindGroup, BindGroupLayout, Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { vi } from 'vitest';
import { PreparedRasterBundleCache } from '../gpu-driven/prepared-raster-bundle';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { GpuDrivenShadowBatch } from '../record/shadow-pass';
import { captureShadowBundles, preparedShadowView } from './shadow-bundle.fixture';

/** Prepared frame shared by structural and native depth witnesses; the recorder is never mocked. */
export function preparedShadowFixture({
  device,
  buffer,
  layout,
  shared,
  view,
  shaderModuleFactory,
}: {
  readonly device: RhiDevice;
  readonly buffer: Buffer;
  readonly layout: BindGroupLayout;
  readonly shared: GpuDrivenShadowBatch;
  readonly view: BindGroup;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
}) {
  const pipelineLookup = vi.fn(() => shared.pipeline);
  const counts = { createBindGroup: 0, keys: [] as string[] };
  const materialBuffer = { buffer };
  const pipelineState = {
    projectorAvailable: false,
    perPassResources: { shadowSampler: {} },
    viewUniformBuffer: buffer,
    shadowArrayFallbackTextureView: {},
    shadowAtlasFallbackTextureView: {},
    shadowParamsBuffer: buffer,
    shadowCasterCascadeBuffer: buffer,
    viewBindGroupLayout: layout,
    skylightFallback: null,
    materialBindGroupLayout: layout,
    materialUniformBuffer: materialBuffer,
    meshStorageBuffer: { buffer },
    defaultSampler: {},
    defaultNormalTextureView: {},
    fallbackTextureView: {},
  };
  const viewBindGroupCache = new WeakMap<object, unknown>();
  const shadowMaterialBindGroups = new WeakMap<object, unknown>();
  getOrCreateFromChain(
    viewBindGroupCache,
    [
      buffer,
      pipelineState.shadowArrayFallbackTextureView,
      pipelineState.perPassResources.shadowSampler,
      pipelineState.shadowAtlasFallbackTextureView,
      buffer,
      buffer,
      pipelineState.shadowArrayFallbackTextureView,
      buffer,
    ],
    'view-shadow-directional-0',
    () => view,
    counts,
  );
  const seedMaterial = (group: BindGroup) =>
    getOrCreateFromChain(
      shadowMaterialBindGroups,
      [
        layout,
        materialBuffer.buffer,
        pipelineState.defaultSampler,
        pipelineState.defaultNormalTextureView,
        pipelineState.fallbackTextureView,
        buffer,
      ],
      'shadow-material-singleton',
      () => group,
      counts,
    );
  seedMaterial(shared.materialGroup);
  const batches = Array.from({ length: 64 }, (_, index) => ({
    batchId: index * 7 + 3,
    indirectOffset: index * 20,
    key: { admission: 'opaque', topology: 'triangle-list', drawKind: 'non-indexed' },
  }));
  const shadowArtifact = {
    material: 'forgeax::default-shadow-caster',
    receipt: { sceneIndexEntry: 'vs_main' },
    variantSet: 'GPU_SCENE_AVAILABLE=true',
  };
  const layoutProjection = deriveVertexLayoutProjection({ position: new Float32Array(0) });
  const projections = new Map(
    batches.map(({ batchId }) => [
      batchId,
      {
        bundles: new PreparedRasterBundleCache(),
        shadowArtifact,
        deformation: shared.deformation,
        meshBindGroup: shared.meshBindGroup,
        visibleBindGroups: shared.visibleBindGroups,
        material: {},
        mesh: {
          vertexBuffer: { handle: shared.vertexBuffer },
          indexBuffer: null,
          layoutProjection,
        },
      },
    ]),
  );
  const bundleRecording = captureShadowBundles(device);
  const shadowView = preparedShadowView(device, buffer);
  shadowView.skinTaskBinding = () => ({
    data: buffer,
    auxiliary: buffer,
    dataOffset: 0,
    auxiliaryOffset: 768,
    dataSize: 160,
    auxiliarySize: 16,
    jointCount: 1,
    flags: 1,
  });
  const context = {
    validatedOrdered: [],
    runtime: {
      device,
      getMaterialShaderPipeline: pipelineLookup,
      immediateShaderModuleFactory: shaderModuleFactory,
    },
    pipelineState,
    frameState: { viewBindGroupCache, shadowMaterialBindGroups },
    gpuDrivenShadowViews: {
      submission: () => ({ view: shadowView, plan: { batches } }),
    },
    gpuDrivenShadowBatchProjections: new Map([
      ['directional:0:', projections],
      ['directional:0::static', projections],
    ]),
    bindGroupCounts: counts,
  } as unknown as _InternalRenderPipelineContext;
  return {
    context,
    bundleRecording,
    shadowView,
    batches,
    projections,
    materialBuffer,
    seedMaterial,
    shadowMaterialBindGroups,
    pipelineLookup,
  };
}
