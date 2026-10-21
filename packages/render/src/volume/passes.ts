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
  RenderPipeline,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GPU_TEXTURE_USAGE_TEXTURE_BINDING } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { StandardClusterGraphBuffers } from '../pipeline/standard-lighting/graph';
import { resolveVolumetricFogProfile } from '../pipeline/standard-profile';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { VolumetricFogFrameContext, VolumetricFogShaderSources } from '../render-contract';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import type { VolumetricFogLightKind } from './capability';
import { MAX_VOLUMETRIC_FOG_OWNERS } from './component';
import { volumeCompositeScissor } from './composite-scissor';
import {
  additionalVolumeDensityBinding,
  type ComputeState,
  type VolumeProgramContext,
  volumeCompositeState,
  volumeComputeState,
} from './programs';
import type { VolumetricFogResources } from './resources';
import {
  createVolumetricFogResources,
  VOLUME_PACKING_Z,
  VOLUMETRIC_FOG_PARAMS_BYTES,
} from './resources';

interface VolumetricFogPassInputs {
  readonly compositeNeighbors?: 2 | 4 | 8;
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
  readonly selectedLightKind: VolumetricFogLightKind;
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
function volumeContext(frame: RenderPipelineFrame): VolumeProgramContext {
  const runtime = (frame as _InternalRenderPipelineContext).runtime;
  if (runtime.shaderModuleFactory === undefined) throw pipelineError('shader module factory');
  return {
    device: runtime.device,
    deviceScope: runtime.deviceScope,
    shaderModuleFactory: runtime.shaderModuleFactory,
  };
}

export { additionalVolumeDensityBinding } from './programs';

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
  selectedLightKind: VolumetricFogLightKind | undefined,
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
    compositeNeighbors:
      resolveVolumetricFogProfile(topology.standardProfile ?? {}).quality === 'low' ? 4 : 8,
    atmosphereTransmittance,
    resources: resources.value,
  });
}
function addVolumetricFogPasses(
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
  let shadowSampler: Sampler | undefined;
  let linearSampler: Sampler | undefined;
  let densitySampler: Sampler | undefined;
  let compositeSampler: Sampler | undefined;
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
      inject ??= volumeComputeState(
        volumeContext(frame),
        shaderSource(frame, 'inject'),
        'volume_inject',
      );
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
      shadowSampler ??= frame.runtime.device.createSampler({ compare: 'greater' }).unwrap();
      const bindings = volumeBindGroup(frame, inject.layout, [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: view.value, size: VIEW_UNIFORM_BYTES } },
        },
        { binding: 3, resource: { kind: 'textureView', value: shadow.value as never } },
        { binding: 4, resource: { kind: 'sampler', value: shadowSampler } },
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
      integrate ??= volumeComputeState(
        volumeContext(frame),
        shaderSource(frame, 'integrate'),
        'volume_integrate',
      );
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
      linearSampler ??= frame.runtime.device
        .createSampler({
          minFilter: 'linear',
          magFilter: 'linear',
        })
        .unwrap();
      densitySampler ??= frame.runtime.device
        .createSampler({
          minFilter: 'linear',
          magFilter: 'linear',
          addressModeU: 'repeat',
          addressModeV: 'repeat',
          addressModeW: 'repeat',
        })
        .unwrap();
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
        { binding: 5, resource: { kind: 'sampler', value: linearSampler } },
        { binding: 6, resource: { kind: 'textureView', value: density.value as never } },
        { binding: 7, resource: { kind: 'sampler', value: densitySampler } },
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
      temporal ??= volumeComputeState(
        volumeContext(frame),
        shaderSource(frame, 'temporal'),
        'volume_temporal',
      );
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
      if (composite === undefined) {
        const state = volumeCompositeState(
          volumeContext(frame),
          shaderSource(frame, 'composite'),
          inputs.linearHdr.format,
          inputs.compositeNeighbors ?? 8,
        );
        composite = state.pipeline;
        compositeLayout = state.layout;
      }
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
      compositeSampler ??= frame.runtime.device
        .createSampler({
          label: 'volume_composite.sampler',
          minFilter: 'linear',
          magFilter: 'linear',
        })
        .unwrap();
      const bindings = frame.runtime.device.createBindGroup({
        layout: compositeLayout as BindGroupLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: resolved.value as never } },
          { binding: 1, resource: { kind: 'sampler', value: compositeSampler } },
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
      let scissor: readonly [number, number, number, number] | undefined;
      let scissorExtent: { readonly width: number; readonly height: number } | undefined;
      if (
        frame.volumetricFog?.compositeProjectedBounds !== undefined &&
        frame.camera.captureProjection === undefined &&
        frame.camera.target === undefined &&
        frame.camera.view === undefined
      ) {
        const extent = resources.textureViewExtent(inputs.linearHdr.view);
        if (!extent.ok) throw extent.error;
        scissorExtent = extent.value;
        scissor = volumeCompositeScissor(
          frame.volumetricFog.compositeProjectedBounds,
          extent.value.width,
          extent.value.height,
          inputs.resources.resolvedExtent.width,
          inputs.resources.resolvedExtent.height,
        );
        if (scissor !== undefined) pass.setScissorRect(...scissor);
      }
      pass.draw(3);
      // Keep later commands correct if compatible raster work shares an encoder.
      if (scissor !== undefined && scissorExtent !== undefined)
        pass.setScissorRect(0, 0, scissorExtent.width, scissorExtent.height);
    },
  });
}
