import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  RenderPipeline,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GPU_TEXTURE_USAGE_TEXTURE_BINDING } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { StandardClusterGraphBuffers } from '../pipeline/standard-lighting/graph';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { VolumetricFogFrameContext, VolumetricFogShaderSources } from '../render-contract';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { MAX_VOLUMETRIC_FOG_OWNERS } from './component';
import type { VolumetricFogResources } from './resources';
import {
  createVolumetricFogResources,
  VOLUME_FROXEL_FORMAT,
  VOLUME_HISTORY_FORMAT,
  VOLUME_PACKING_Z,
  VOLUME_RESOLVED_FORMAT,
  VOLUMETRIC_FOG_PARAMS_BYTES,
} from './resources';
export interface VolumetricFogPassInputs {
  readonly resources: VolumetricFogResources;
  readonly linearHdr: RenderPipelineTarget;
  readonly sceneDepth: GraphTextureView;
  readonly density: GraphTextureView;
  readonly additionalDensities?: readonly GraphTextureView[];
  readonly params: GraphBuffer;
  readonly view: GraphBuffer;
  readonly directionalShadow?: GraphTextureView;
  readonly spotShadow: GraphTextureView;
  /** The single Standard Cluster light payload consumed by all volume stages. */
  readonly lightData: GraphBuffer;
  /** The Cluster uniform carries the admitted light count for slot guards. */
  readonly clusterUniform: GraphBuffer;
  readonly atmosphereTransmittance?: GraphTextureView | undefined;
  readonly selectedLightKind: 'directional' | 'point' | 'spot';
  readonly projector?: GraphTextureView;
  /** Stable world-space cloud shadow map sampled at each volume point. */
  readonly cloudShadow?: GraphTextureView;
}
function pipelineError(stage: string): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: `volumetric fog ${stage} pipeline to be available`,
    hint: 'construct the renderer through a backend pack with shader module support',
  });
}
function shaderSource(frame: RenderPipelineFrame, stage: keyof VolumetricFogShaderSources): string {
  const source = frame.volumetricFogShaders?.[stage];
  if (source === undefined) throw pipelineError(`${stage} shader source`);
  return source;
}
interface ComputeState {
  readonly pipeline: ComputePipeline;
  readonly layout: BindGroupLayout;
}
/** Density slots continue after the atmosphere texture/sampler at 25/26. */
export function additionalVolumeDensityBinding(index: number): number {
  return index < 7 ? 18 + index : 20 + index;
}
function computeState(
  frame: RenderPipelineFrame,
  source: string,
  label: string,
  entries: readonly unknown[],
  entryPoint = label,
): ComputeState {
  const factory = frame.runtime.shaderModuleFactory;
  if (factory === undefined) throw pipelineError(label);
  const module = factory.createShaderModule({ code: source, label });
  if (!module.ok) throw module.error;
  const layout = frame.runtime.device.createBindGroupLayout({ entries: entries as never });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = frame.runtime.device.createPipelineLayout({
    label: `${label}.layout`,
    bindGroupLayouts: [layout.value],
  });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  const pipeline = frame.runtime.device.createComputePipeline({
    label,
    layout: pipelineLayout.value,
    compute: { module: module.value, entryPoint },
  });
  if (!pipeline.ok) throw pipeline.error;
  return { pipeline: pipeline.value, layout: layout.value };
}
type VolumeBinding =
  | {
      readonly binding: number;
      readonly resource: { readonly kind: 'textureView'; readonly value: TextureView };
    }
  | {
      readonly binding: number;
      readonly resource: { readonly kind: 'sampler'; readonly value: Sampler };
    }
  | {
      readonly binding: number;
      readonly resource: {
        readonly kind: 'buffer';
        readonly value: { readonly buffer: Buffer; readonly size?: number };
      };
    };
function volumeBindGroup(
  frame: RenderPipelineFrame,
  layout: BindGroupLayout,
  entries: readonly VolumeBinding[],
): BindGroup {
  const group = frame.runtime.device.createBindGroup({ layout, entries });
  if (!group.ok) throw group.error;
  return group.value;
}
type ImportedVolumeInputs = Omit<VolumetricFogPassInputs, 'resources'>;
function importVolumeInputs(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  linearHdr: RenderPipelineTarget,
  sceneDepth: GraphTextureView,
  directionalShadow: GraphTextureView | undefined,
  spotShadow: GraphTextureView,
  selectedLightKind: 'directional' | 'point' | 'spot' | undefined,
  clusterBuffers: StandardClusterGraphBuffers | null,
  cloudShadow: GraphTextureView | undefined,
): Result<ImportedVolumeInputs | undefined, RenderGraphError> {
  const volume = topology.volumetricFog;
  if (volume?.enabled !== true || volume.format === undefined || volume.extent === undefined)
    return ok(undefined);
  if (clusterBuffers === null || clusterBuffers.kind !== 'storage') {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'volumetric fog consumes the Standard Cluster light buffers',
        hint: 'enable the storage-backed Standard Cluster transport before enabling volumetric fog',
        detail: {
          resourceLabel: 'volumetric-fog',
          field: 'clusterBuffers',
          expected: 'StandardClusterGraphBuffers',
          actual: 'missing',
        },
      }),
    );
  }
  const texture = graph.importTexture(
    'volume-density',
    {
      format: volume.format,
      size: {
        width: volume.extent.width,
        height: volume.extent.height,
        depthOrArrayLayers: volume.extent.depth,
      },
      dimension: '3d',
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    },
    (frame) => {
      const context = frame.volumetricFog as VolumetricFogFrameContext | undefined;
      if (context === undefined) throw pipelineError('density residency');
      return context.densityTexture;
    },
  );
  if (!texture.ok) return texture;
  const density = graph.importView(
    texture.value,
    { label: 'volume-density.view', dimension: '3d' },
    (frame) => {
      const context = frame.volumetricFog as VolumetricFogFrameContext | undefined;
      if (context === undefined) throw pipelineError('density view residency');
      return context.densityView;
    },
  );
  if (!density.ok) return density;
  const additionalDensities: GraphTextureView[] = [];
  for (const [index, member] of (volume.additional ?? []).entries()) {
    const texture = graph.importTexture(
      `volume-density-${index + 1}`,
      {
        format: member.format,
        size: {
          width: member.extent.width,
          height: member.extent.height,
          depthOrArrayLayers: member.extent.depth,
        },
        dimension: '3d',
        usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      },
      (frame) => {
        const value = frame.volumetricFog?.additional?.[index];
        if (value === undefined) throw pipelineError('local density residency');
        return value.densityTexture;
      },
    );
    if (!texture.ok) return texture;
    const view = graph.importView(
      texture.value,
      { label: `volume-density-${index + 1}.view`, dimension: '3d' },
      (frame) => {
        const value = frame.volumetricFog?.additional?.[index];
        if (value === undefined) throw pipelineError('local density view residency');
        return value.densityView;
      },
    );
    if (!view.ok) return view;
    additionalDensities.push(view.value);
  }
  const params = graph.importBuffer(
    'volume-params',
    {
      size: VOLUMETRIC_FOG_PARAMS_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    },
    (frame) => {
      const context = frame.volumetricFog as VolumetricFogFrameContext | undefined;
      if (context === undefined) throw pipelineError('parameter residency');
      return context.paramsBuffer;
    },
  );
  if (!params.ok) return params;
  const view = graph.importBuffer(
    'volume-view',
    { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  let projector: GraphTextureView | undefined;
  if (volume.projector !== undefined) {
    const projectorTexture = graph.importTexture(
      'spot-projector',
      {
        format: 'rgba8unorm-srgb',
        size: { width: 128, height: 128, depthOrArrayLayers: 1 },
        dimension: '2d',
        usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      },
      (frame) => {
        const context = frame.volumetricFog as VolumetricFogFrameContext | undefined;
        if (context?.projectorTexture === undefined) throw pipelineError('projector residency');
        return context.projectorTexture;
      },
    );
    if (!projectorTexture.ok) return projectorTexture;
    const projectorView = graph.importView(
      projectorTexture.value,
      { label: 'spot-projector.view', dimension: '2d' },
      (frame) => {
        const context = frame.volumetricFog as VolumetricFogFrameContext | undefined;
        if (context?.projectorView === undefined) throw pipelineError('projector view residency');
        return context.projectorView;
      },
    );
    if (!projectorView.ok) return projectorView;
    projector = projectorView.value;
  }
  return ok({
    linearHdr,
    sceneDepth,
    density: density.value,
    additionalDensities,
    params: params.value,
    view: view.value,
    ...(directionalShadow === undefined ? {} : { directionalShadow }),
    spotShadow,
    lightData: clusterBuffers.lightData,
    clusterUniform: clusterBuffers.clusterUniform,
    selectedLightKind: selectedLightKind ?? 'directional',
    ...(projector === undefined ? {} : { projector }),
    ...(cloudShadow === undefined ? {} : { cloudShadow }),
  });
}
export function addAuthoredVolumetricFogPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  linearHdr: RenderPipelineTarget,
  sceneDepth: GraphTextureView,
  directionalShadow: GraphTextureView | undefined,
  spotShadow: GraphTextureView,
  clusterBuffers: StandardClusterGraphBuffers | null,
  cloudShadow?: GraphTextureView,
  atmosphereTransmittance?: GraphTextureView,
): Result<void, RenderGraphError> {
  // A paired Point+Spot volume stores the Spot shadow lane as well. The
  // topology's primary light remains PointLight for radiance selection, but
  // injection must import the spot atlas so the packed visibility can be
  // applied only to the spot term during integration.
  const shadowLightKind =
    topology.volumetricFog?.spotLightEntity === undefined
      ? topology.volumetricFog?.lightKind
      : 'spot';
  const imported = importVolumeInputs(
    graph,
    topology,
    linearHdr,
    sceneDepth,
    directionalShadow,
    spotShadow,
    shadowLightKind,
    clusterBuffers,
    cloudShadow,
  );
  if (!imported.ok) return imported;
  if (imported.value === undefined) return ok(undefined);
  const resources = createVolumetricFogResources(
    graph,
    topology.volumetricFog?.froxelExtent ?? { width: 64, height: 64, depth: 64 },
    topology.volumetricFog?.resolvedExtent,
  );
  if (!resources.ok) return resources;
  return addVolumetricFogPasses(graph, {
    ...imported.value,
    atmosphereTransmittance,
    resources: resources.value,
  });
}
export function addVolumetricFogPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  inputs: VolumetricFogPassInputs,
): Result<void, RenderGraphError> {
  const dispatchX = Math.ceil(inputs.resources.extent.width / 8);
  const dispatchY = Math.ceil(inputs.resources.extent.height / 8);
  const packedLayers = Math.ceil(inputs.resources.extent.depth / VOLUME_PACKING_Z);
  const resolvedDispatchX = Math.ceil(inputs.resources.resolvedExtent.width / 8);
  const resolvedDispatchY = Math.ceil(inputs.resources.resolvedExtent.height / 8);
  // Point-light volume injection has no cube-array shadow sampler. It keeps
  // the directional cascade count at zero and therefore needs only a valid
  // 2D depth binding; use the always-present spot target as the inert binding
  // when directional shadows are disabled. Directional selection still uses
  // its own target whenever one exists, and spot selection uses spotShadow.
  const shadowResource = inputs.directionalShadow ?? inputs.spotShadow;
  let inject: ComputeState | undefined;
  let integrate: ComputeState | undefined;
  let temporal: ComputeState | undefined;
  let composite: RenderPipeline | undefined;
  let compositeLayout: BindGroupLayout | undefined;
  const injected = graph.addComputePass('volume-inject', {
    accesses: [
      { resource: inputs.params, usage: 'uniform-read' },
      { resource: inputs.view, usage: 'uniform-read' },
      {
        resource: shadowResource,
        usage: 'sampled-read',
      },
      { resource: inputs.lightData, usage: 'storage-read' },
      { resource: inputs.clusterUniform, usage: 'uniform-read' },
      ...(inputs.projector === undefined
        ? []
        : [{ resource: inputs.projector, usage: 'sampled-read' as const }]),
      { resource: inputs.resources.froxelView, usage: 'storage-write' },
      { resource: inputs.spotShadow, usage: 'sampled-read' },
    ],
    encode: ({ pass, frame, resources }) => {
      inject ??= computeState(frame, shaderSource(frame, 'inject'), 'volume_inject', [
        { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 3, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 4, visibility: 4, sampler: { type: 'comparison' } },
        { binding: 5, visibility: 4, buffer: { type: 'uniform' } },
        {
          binding: 6,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: VOLUME_FROXEL_FORMAT,
            viewDimension: '2d-array',
          },
        },
        { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 9, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      ]);
      const shadow = resources.textureView(shadowResource);
      const spotShadow = resources.textureView(inputs.spotShadow);
      if (!spotShadow.ok) throw spotShadow.error;
      const params = resources.buffer(inputs.params);
      const view = resources.buffer(inputs.view);
      const lightData = resources.buffer(inputs.lightData);
      const clusterUniform = resources.buffer(inputs.clusterUniform);
      const froxel = resources.textureView(inputs.resources.froxelView);
      if (!shadow.ok) throw shadow.error;
      if (!params.ok) throw params.error;
      if (!view.ok) throw view.error;
      if (!lightData.ok) throw lightData.error;
      if (!clusterUniform.ok) throw clusterUniform.error;
      if (!froxel.ok) throw froxel.error;
      const shadowSampler = frame.runtime.device.createSampler({ compare: 'greater' });
      if (!shadowSampler.ok) throw shadowSampler.error;
      const bindings = volumeBindGroup(frame, inject.layout, [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: view.value, size: VIEW_UNIFORM_BYTES } },
        },
        { binding: 3, resource: { kind: 'textureView', value: shadow.value as never } },
        { binding: 4, resource: { kind: 'sampler', value: shadowSampler.value } },
        { binding: 5, resource: { kind: 'buffer', value: { buffer: params.value } } },
        { binding: 6, resource: { kind: 'textureView', value: froxel.value as never } },
        { binding: 7, resource: { kind: 'buffer', value: { buffer: lightData.value } } },
        { binding: 8, resource: { kind: 'buffer', value: { buffer: clusterUniform.value } } },
        { binding: 9, resource: { kind: 'textureView', value: spotShadow.value as never } },
      ]);
      pass.setPipeline(inject.pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(dispatchX, dispatchY, packedLayers);
    },
  });
  if (!injected.ok) return injected;
  const integratePass = graph.addComputePass('volume-integrate', {
    accesses: [
      ...(inputs.atmosphereTransmittance === undefined
        ? []
        : [{ resource: inputs.atmosphereTransmittance, usage: 'sampled-read' as const }]),
      { resource: inputs.resources.froxelView, usage: 'sampled-read' },
      { resource: inputs.sceneDepth, usage: 'sampled-read' },
      { resource: inputs.density, usage: 'sampled-read' },
      ...(inputs.additionalDensities ?? []).map((resource) => ({
        resource,
        usage: 'sampled-read' as const,
      })),
      { resource: inputs.resources.resolvedView, usage: 'storage-write' },
      { resource: inputs.resources.historyView, usage: 'storage-write' },
      { resource: inputs.resources.temporalView, usage: 'storage-write' },
      { resource: inputs.params, usage: 'uniform-read' },
      { resource: inputs.view, usage: 'uniform-read' },
      { resource: inputs.lightData, usage: 'storage-read' },
      { resource: inputs.clusterUniform, usage: 'uniform-read' },
      ...(inputs.projector === undefined
        ? []
        : [{ resource: inputs.projector, usage: 'sampled-read' as const }]),
      ...(inputs.cloudShadow === undefined
        ? []
        : [{ resource: inputs.cloudShadow, usage: 'sampled-read' as const }]),
    ],
    encode: ({ pass, frame, resources }) => {
      integrate ??= computeState(frame, shaderSource(frame, 'integrate'), 'volume_integrate', [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
        {
          binding: 2,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: VOLUME_RESOLVED_FORMAT,
            viewDimension: '2d',
          },
        },
        { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 5, visibility: 4, sampler: { type: 'filtering' } },
        { binding: 6, visibility: 4, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 7, visibility: 4, sampler: { type: 'filtering' } },
        {
          binding: 8,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: VOLUME_HISTORY_FORMAT,
            viewDimension: '2d',
          },
        },
        {
          binding: 9,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: VOLUME_HISTORY_FORMAT,
            viewDimension: '2d',
          },
        },
        { binding: 10, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 11, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 12, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 13, visibility: 4, sampler: { type: 'filtering' } },
        { binding: 16, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 17, visibility: 4, sampler: { type: 'filtering' } },
        { binding: 25, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 26, visibility: 4, sampler: { type: 'filtering' } },
        ...Array.from({ length: MAX_VOLUMETRIC_FOG_OWNERS - 1 }, (_, index) => ({
          binding: additionalVolumeDensityBinding(index),
          visibility: 4,
          texture: { sampleType: 'float' as const, viewDimension: '3d' as const },
        })),
      ]);
      const froxel = resources.textureView(inputs.resources.froxelView);
      const depth = resources.textureView(inputs.sceneDepth);
      const density = resources.textureView(inputs.density);
      const resolved = resources.textureView(inputs.resources.resolvedView);
      const historySeed = resources.textureView(inputs.resources.historyView);
      const temporalSeed = resources.textureView(inputs.resources.temporalView);
      const params = resources.buffer(inputs.params);
      const view = resources.buffer(inputs.view);
      const lightData = resources.buffer(inputs.lightData);
      const clusterUniform = resources.buffer(inputs.clusterUniform);
      const projector =
        inputs.projector === undefined ? undefined : resources.textureView(inputs.projector);
      const cloudShadow =
        inputs.cloudShadow === undefined ? undefined : resources.textureView(inputs.cloudShadow);
      if (!froxel.ok) throw froxel.error;
      if (!depth.ok) throw depth.error;
      if (!density.ok) throw density.error;
      if (!resolved.ok) throw resolved.error;
      if (!historySeed.ok) throw historySeed.error;
      if (!temporalSeed.ok) throw temporalSeed.error;
      if (!params.ok) throw params.error;
      if (!view.ok) throw view.error;
      if (!lightData.ok) throw lightData.error;
      if (!clusterUniform.ok) throw clusterUniform.error;
      if (projector !== undefined && !projector.ok) throw projector.error;
      if (cloudShadow !== undefined && !cloudShadow.ok) throw cloudShadow.error;
      const sampler = frame.runtime.device.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
      });
      if (!sampler.ok) throw sampler.error;
      const densitySampler = frame.runtime.device.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
      });
      if (!densitySampler.ok) throw densitySampler.error;
      const bindings = volumeBindGroup(frame, integrate.layout, [
        {
          binding: 25,
          resource: {
            kind: 'textureView',
            value:
              inputs.atmosphereTransmittance === undefined
                ? frame.pipelineState.defaultWhiteTextureView
                : resources.textureView(inputs.atmosphereTransmittance).unwrap(),
          },
        },
        { binding: 26, resource: { kind: 'sampler', value: frame.pipelineState.defaultSampler } },
        { binding: 0, resource: { kind: 'textureView', value: froxel.value as never } },
        { binding: 1, resource: { kind: 'textureView', value: depth.value as never } },
        { binding: 2, resource: { kind: 'textureView', value: resolved.value as never } },
        { binding: 3, resource: { kind: 'buffer', value: { buffer: params.value } } },
        {
          binding: 4,
          resource: { kind: 'buffer', value: { buffer: view.value, size: VIEW_UNIFORM_BYTES } },
        },
        { binding: 5, resource: { kind: 'sampler', value: sampler.value } },
        { binding: 6, resource: { kind: 'textureView', value: density.value as never } },
        { binding: 7, resource: { kind: 'sampler', value: densitySampler.value } },
        { binding: 8, resource: { kind: 'textureView', value: historySeed.value as never } },
        { binding: 9, resource: { kind: 'textureView', value: temporalSeed.value as never } },
        { binding: 10, resource: { kind: 'buffer', value: { buffer: lightData.value } } },
        { binding: 11, resource: { kind: 'buffer', value: { buffer: clusterUniform.value } } },
        {
          binding: 12,
          resource: {
            kind: 'textureView',
            value:
              projector === undefined
                ? frame.pipelineState.defaultWhiteTextureView
                : (projector.value as never),
          },
        },
        {
          binding: 13,
          resource: {
            kind: 'sampler',
            value: frame.volumetricFog?.projectorSampler ?? frame.pipelineState.defaultSampler,
          },
        },
        {
          binding: 16,
          resource: {
            kind: 'textureView',
            value:
              cloudShadow === undefined
                ? frame.pipelineState.defaultWhiteTextureView
                : (cloudShadow.value as never),
          },
        },
        {
          binding: 17,
          resource: { kind: 'sampler', value: frame.pipelineState.defaultSampler },
        },
        ...Array.from({ length: MAX_VOLUMETRIC_FOG_OWNERS - 1 }, (_, index) => {
          const view = resources.textureView(inputs.additionalDensities?.[index] ?? inputs.density);
          if (!view.ok) throw view.error;
          return {
            binding: additionalVolumeDensityBinding(index),
            resource: { kind: 'textureView' as const, value: view.value as never },
          };
        }),
      ]);
      pass.setPipeline(integrate.pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(resolvedDispatchX, resolvedDispatchY, 1);
    },
  });
  if (!integratePass.ok) return integratePass;
  const temporalPass = graph.addComputePass('volume-temporal', {
    accesses: [
      { resource: inputs.resources.resolvedView, usage: 'sampled-read' },
      { resource: inputs.resources.historyView, usage: 'sampled-storage-read-write' },
      { resource: inputs.resources.temporalView, usage: 'sampled-storage-read-write' },
      { resource: inputs.params, usage: 'uniform-read' },
      { resource: inputs.view, usage: 'uniform-read' },
    ],
    encode: ({ pass, frame, resources }) => {
      temporal ??= computeState(frame, shaderSource(frame, 'temporal'), 'volume_temporal', [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        {
          binding: 2,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: VOLUME_HISTORY_FORMAT,
            viewDimension: '2d',
          },
        },
        { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      ]);
      const current = resources.textureView(inputs.resources.resolvedView);
      const history = resources.textureView(
        frame.volumetricFog?.historyReadSlot === 0
          ? inputs.resources.historyView
          : inputs.resources.temporalView,
      );
      const pending = resources.textureView(
        frame.volumetricFog?.historyWriteSlot === 0
          ? inputs.resources.historyView
          : inputs.resources.temporalView,
      );
      const params = resources.buffer(inputs.params);
      const view = resources.buffer(inputs.view);
      if (!current.ok) throw current.error;
      if (!history.ok) throw history.error;
      if (!pending.ok) throw pending.error;
      if (!params.ok) throw params.error;
      if (!view.ok) throw view.error;
      const bindings = volumeBindGroup(frame, temporal.layout, [
        { binding: 0, resource: { kind: 'textureView', value: current.value as never } },
        { binding: 1, resource: { kind: 'textureView', value: history.value as never } },
        { binding: 2, resource: { kind: 'textureView', value: pending.value as never } },
        { binding: 3, resource: { kind: 'buffer', value: { buffer: params.value } } },
        {
          binding: 4,
          resource: { kind: 'buffer', value: { buffer: view.value, size: VIEW_UNIFORM_BYTES } },
        },
      ]);
      pass.setPipeline(temporal.pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(resolvedDispatchX, resolvedDispatchY, 1);
    },
  });
  if (!temporalPass.ok) return temporalPass;
  return graph.addRasterPass('volume-composite', {
    accesses: [
      { resource: inputs.resources.historyView, usage: 'sampled-read' },
      { resource: inputs.resources.temporalView, usage: 'sampled-read' },
      { resource: inputs.sceneDepth, usage: 'sampled-read' },
      { resource: inputs.view, usage: 'uniform-read' },
      { resource: inputs.linearHdr.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: inputs.linearHdr.view,
        loadOp: 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      composite ??= (() => {
        const factory = frame.runtime.shaderModuleFactory;
        if (factory === undefined) throw pipelineError('volume_composite');
        const module = factory.createShaderModule({
          code: shaderSource(frame, 'composite'),
          label: 'volume_composite',
        });
        if (!module.ok) throw module.error;
        const layout = frame.runtime.device.createBindGroupLayout({
          label: 'volume_composite.bind-group-layout',
          entries: [
            {
              binding: 0,
              visibility: 2 | 1,
              texture: { sampleType: 'float', viewDimension: '2d' },
            },
            { binding: 1, visibility: 2 | 1, sampler: { type: 'filtering' } },
            {
              binding: 2,
              visibility: 2 | 1,
              texture: { sampleType: 'depth', viewDimension: '2d' },
            },
            { binding: 3, visibility: 2 | 1, buffer: { type: 'uniform' } },
          ],
        });
        if (!layout.ok) throw layout.error;
        const pipelineLayout = frame.runtime.device.createPipelineLayout({
          label: 'volume_composite.layout',
          bindGroupLayouts: [layout.value],
        });
        if (!pipelineLayout.ok) throw pipelineLayout.error;
        const created = frame.runtime.device.createRenderPipeline({
          label: 'volume_composite',
          layout: pipelineLayout.value,
          vertex: { module: module.value, entryPoint: 'volume_vs', buffers: [] },
          fragment: {
            module: module.value,
            entryPoint: 'volume_fs',
            targets: [
              {
                format: inputs.linearHdr.format,
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
              },
            ],
          },
          primitive: { topology: 'triangle-list' },
        });
        if (!created.ok) throw created.error;
        compositeLayout = layout.value;
        return created.value;
      })();
      const resolved = resources.textureView(
        frame.volumetricFog?.historyWriteSlot === 0
          ? inputs.resources.historyView
          : inputs.resources.temporalView,
      );
      const depth = resources.textureView(inputs.sceneDepth);
      const view = resources.buffer(inputs.view);
      if (!resolved.ok) throw resolved.error;
      if (!depth.ok) throw depth.error;
      if (!view.ok) throw view.error;
      const sampler = frame.runtime.device.createSampler({
        label: 'volume_composite.sampler',
        minFilter: 'linear',
        magFilter: 'linear',
      });
      if (!sampler.ok) throw sampler.error;
      const bindings = frame.runtime.device.createBindGroup({
        layout: compositeLayout as BindGroupLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: resolved.value as never } },
          { binding: 1, resource: { kind: 'sampler', value: sampler.value } },
          { binding: 2, resource: { kind: 'textureView', value: depth.value as never } },
          {
            binding: 3,
            resource: { kind: 'buffer', value: { buffer: view.value, size: VIEW_UNIFORM_BYTES } },
          },
        ],
      });
      if (!bindings.ok) throw bindings.error;
      pass.setPipeline(composite);
      pass.setBindGroup(0, bindings.value);
      pass.draw(3);
    },
  });
}
