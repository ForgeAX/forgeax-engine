import {
  type FrameRecording,
  recordFrameTransaction,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import type { RendererFrameTransactionSteps } from '../assembly/renderer-frame-transaction';
import { projectedDecalTopology } from '../decals/graph';
import { addAtmosphereBackground } from '../environment/background';
import {
  type AtmosphereViews,
  atmosphereBindings,
  atmosphereMaterialVisibilityBindings,
} from '../environment/bindings';
import { recordAtmosphereCaptureBackground } from '../environment/capture';
import type { GraphAtmosphere } from '../environment/luts';
import { atmosphereTextures } from '../environment/luts';
import { settleAtmospherePublish } from '../environment/storage';
import { isOutlinePostProcess } from '../features/outline/shaders';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from '../pipeline/standard-lighting/graph';
import { addBakedFieldPasses, bakedFieldGraphShape } from '../raytracing/baked-field-graph';
import { addRayDiffusePasses } from '../raytracing/diffuse-graph';
import {
  addIrradianceFieldPasses,
  irradianceFieldGraphShape,
} from '../raytracing/irradiance-field-graph';
import { addProbeGlobalPasses, probeGlobalGraphShape } from '../raytracing/probe-global-graph';
import { addProbePlacementPass } from '../raytracing/probe-placement-graph';
import { addScreenProbePasses, screenProbeGraphShape } from '../raytracing/screen-probe-graph';
import {
  type TerrainShadowReceiver,
  terrainShadowLayoutMatches,
  terrainShadowTopology,
} from '../terrain/shadow-family';
import { addTypedShadowPasses, shadowPipelinePreparationDemand } from '../typed-shadow-passes';
import { extractEntryResourceHandle, getOrCreateFromChainResult } from './mesh-ssbo';
import { scenePipelinePreparations } from './scene-pipeline-preparation';
import { addTargetCaptureGraphPasses, type CubeCaptureGraphState } from './target-capture-graph';
import { translucentViewOffset, VIEW_UNIFORM_BYTES } from './view-ubo';

export type { CubeCaptureGraphState, CubeCaptureGraphWork } from './target-capture-graph';

import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import {
  type CompiledRenderGraph,
  type GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphGenerationAllocationEntry,
  type RenderGraphGenerationAllocationInspection,
  type RenderGraphPassInstrumentation,
  type RenderGraphPassInstrumentationScope,
  type RenderGraphResourceAllocationInspection,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RhiCommandEncoder,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { standardBloomAdmitted } from '../bloom-admission';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import { depthOfFieldTopology } from '../features/depth-of-field/depth-of-field-feature';
import { resolveDepthOfFieldFrameParams } from '../features/depth-of-field/depth-of-field-params';
import {
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
  hasSubmissionSensitiveFeatures,
  type RenderFeaturePlanExecution,
} from '../features/host';
import { motionBlurTemporalDemand } from '../features/motion-blur/motion-blur-params';
import {
  type RenderFeaturePlannedFrame,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureEvidenceMatches,
} from '../features/plan';
import {
  createRenderFeatureProjectionState,
  projectRenderFeatureShadows,
} from '../features/render-graph-contribution';
import type {
  RenderFeatureGraphBindingsResolution,
  RenderFeatureGraphTargetResolver,
} from '../features/render-graph-raster';
import { isRenderFeatureTargetHandle } from '../features/targets';
import {
  inspectTransientViewGraphs,
  projectTransientViewPlans,
  selectTransientViewPlans,
} from '../features/transient-view-graph';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import {
  buildFullscreenPostProcessPass,
  createFullscreenBindGroup,
  isTemporalFullscreenBinding,
  postProcessShaderEntrySignature,
} from '../fullscreen-post-process-pass';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { createStandardSurfaceLightingBindGroup } from '../hdrp-buffers';
import type { RenderFeatureGraphInspection } from '../inspection-types';
import type { RenderExtent } from '../pipeline/render-extent';
import {
  type StandardTopologyInputValue,
  standardLightingTopologySignature,
} from '../pipeline/standard-lighting/topology';
import { importAutoExposureGraphResources } from '../pipeline/standard-output/auto-exposure/gpu';
import {
  commitStandardOutputSubmission,
  discardStandardOutputStates,
  retirePendingStandardOutputGpu,
} from '../pipeline/standard-output/resources';
import { buildStandard, standardPipeline } from '../pipeline/standard-pipeline';
import { resolveVolumetricFogProfile, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import { type ProbeBackgroundResources, recordProbeBackground } from '../reflection/background';
import type { CameraSnapshot } from '../render-contract';
import type {
  RenderPipelineFeatureTarget,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import type { ExtractedLights, ExtractedVolumetricFog } from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_FACE_SIZE, SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import type { SsrSpatialAdmission } from '../ssr/admission';
import {
  abortStagedTemporalGpuState,
  CLOUD_HISTORY_FORMATS,
  commitStagedTemporalGpuState,
  getTemporalGpuState,
  hasPendingTemporalGpuSubmit,
  retireActiveTemporalGpuState,
  stageTemporalGpuWrite,
  TEMPORAL_HISTORY_FORMATS,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import { isSceneDataTarget } from '../temporal/scene-data';
import { createTargetCoverageAttachment } from '../temporal/target-coverage-attachment';
import type { TransmissionDemand } from '../transmission/projection';
import { hasVolumetricFogCapability } from '../volume/capability';
import { deriveVolumetricFogExtent, deriveVolumetricFogResolvedExtent } from '../volume/resources';
import { frameGraphChangedDependencies, frameGraphTopologyIdentity } from './frame-graph-identity';
import { buildPerFrameBindGroups } from './frame-lighting';
import {
  type GraphTargetPassReplayPrefixReceipt,
  type GraphTargetPassReplayReceipt,
  getTextureIdentity,
  type RenderFrameState,
} from './frame-snapshot';
import { createPassTimingInstrumentation } from './gpu-pass-timing/instrumentation';

import type { GpuTimingCapture } from './gpu-timing';
import { encodeMainPass } from './main-pass';
import { deriveMotionBlurExecutionReceipt } from './motion-blur-receipt';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RenderSystemInternals,
} from './render-context';
import { resolveSurfaceFormatPair, resolveSurfaceProfile } from './render-context';

export interface TemporalGraphCapabilities {
  readonly rgba16floatRender: boolean;
  readonly rgba16floatSample: boolean;
  readonly mrt: boolean;
}

export interface TemporalGraphRoster {
  readonly enabled?: boolean;
  readonly targets: readonly string[];
  readonly passes: readonly string[];
  readonly uploads: number;
}

/** Consumers other than the main camera that may sample a frame's shadow maps. */
export interface ShadowSamplerRoster {
  readonly rayDiffuse: boolean;
  readonly volumetricFog: boolean;
  /** Physical sky and aerial perspective sample along open view rays. */
  readonly atmosphere: boolean;
  readonly cubeCaptures: number;
  readonly reflectionProbes: number;
  readonly planarReflection: boolean;
  readonly featureSceneInputs: number;
}

/**
 * The camera pyramid proves receivers hidden only for the main view, so a
 * graph binds it to the shadow caster cull only when no other consumer
 * samples the shadow maps. Every input is part of the graph key.
 */
export function shadowCameraCullAdmitted(roster: ShadowSamplerRoster): boolean {
  return (
    !roster.rayDiffuse &&
    !roster.volumetricFog &&
    !roster.atmosphere &&
    roster.cubeCaptures === 0 &&
    roster.reflectionProbes === 0 &&
    !roster.planarReflection &&
    roster.featureSceneInputs === 0
  );
}

function importTemporalHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  kind: 'color' | 'temporal' | 'stability',
  role: 'read' | 'write',
): import('../render-pipeline').RenderPipelineTarget {
  const format = TEMPORAL_HISTORY_FORMATS[kind];
  const texture = graph.importTexture(
    label,
    {
      format,
      size: 'surface',
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    },
    (frame) => {
      const internal = frame as import('./render-context')._InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        internal.runtime.device,
        internal.runtime.deviceScope,
        frame.targetW,
        frame.targetH,
      );
      const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
      return state[kind][index].texture;
    },
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => {
      const internal = frame as import('./render-context')._InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        internal.runtime.device,
        internal.runtime.deviceScope,
        frame.targetW,
        frame.targetH,
      );
      const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
      return state[kind][index].view;
    },
  );
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value, format, sampleCount: 1 };
}

function importTemporalHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['taaHistory']
> {
  return {
    currentColor: importTemporalHistoryTarget(graph, 'taa-history-current-color', 'color', 'write'),
    currentStability: importTemporalHistoryTarget(
      graph,
      'taa-history-current-stability',
      'stability',
      'write',
    ),
    previousStability: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-stability',
      'stability',
      'read',
    ),
    previousColor: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-color',
      'color',
      'read',
    ),
    currentTemporal: importTemporalHistoryTarget(
      graph,
      'taa-history-current-temporal',
      'temporal',
      'write',
    ),
    previousTemporal: importTemporalHistoryTarget(
      graph,
      'taa-history-previous-temporal',
      'temporal',
      'read',
    ),
  };
}

type CloudHistoryKind = keyof typeof CLOUD_HISTORY_FORMATS;

function cloudHistorySurface(
  state: import('../temporal/gpu').TemporalGpuState,
  kind: CloudHistoryKind,
  index: 0 | 1,
): { readonly texture: Texture; readonly view: TextureView } {
  if (!state.cloudHistoryEnabled) {
    throw new Error('cloud history target resolved without a cloud-enabled temporal state');
  }
  switch (kind) {
    case 'radiance':
      if (state.cloudRadiance === undefined)
        throw new Error('cloud radiance history is unavailable');
      return state.cloudRadiance[index];
    case 'transmittance':
      if (state.cloudTransmittance === undefined)
        throw new Error('cloud transmittance history is unavailable');
      return state.cloudTransmittance[index];
    case 'depth':
      if (state.cloudDepth === undefined) throw new Error('cloud depth history is unavailable');
      return state.cloudDepth[index];
  }
}

/** Import one renderer-owned cloud history attachment into the typed graph. */
function importCloudHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  kind: CloudHistoryKind,
  role: 'read' | 'write',
): import('../render-pipeline').RenderPipelineTarget {
  const format = CLOUD_HISTORY_FORMATS[kind];
  const texture = graph.importTexture(
    label,
    {
      format,
      // Cloud transport/history is intentionally half-resolution. The
      // renderer-owned temporal state allocates the same ceil(width/2) extent
      // and the full-resolution resolve reconstructs scene colour from it.
      size: 'half-surface',
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      domain: 'linear-hdr',
    },
    (frame) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        internal.runtime.device,
        internal.runtime.deviceScope,
        frame.targetW,
        frame.targetH,
        true,
      );
      const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
      return cloudHistorySurface(state, kind, index).texture;
    },
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => {
      const internal = frame as _InternalRenderPipelineContext;
      const state = getTemporalGpuState(
        internal.frameState,
        internal.runtime.device,
        internal.runtime.deviceScope,
        frame.targetW,
        frame.targetH,
        true,
      );
      const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
      return cloudHistorySurface(state, kind, index).view;
    },
  );
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value, format, sampleCount: 1 };
}

function importCloudHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['cloudHistory']
> {
  return {
    currentRadiance: importCloudHistoryTarget(
      graph,
      'cloud-history-radiance-current',
      'radiance',
      'write',
    ),
    previousRadiance: importCloudHistoryTarget(
      graph,
      'cloud-history-radiance-previous',
      'radiance',
      'read',
    ),
    currentTransmittance: importCloudHistoryTarget(
      graph,
      'cloud-history-transmittance-current',
      'transmittance',
      'write',
    ),
    previousTransmittance: importCloudHistoryTarget(
      graph,
      'cloud-history-transmittance-previous',
      'transmittance',
      'read',
    ),
    currentDepth: importCloudHistoryTarget(graph, 'cloud-history-depth-current', 'depth', 'write'),
    previousDepth: importCloudHistoryTarget(graph, 'cloud-history-depth-previous', 'depth', 'read'),
  };
}

function importSsrHistoryTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  role: 'read' | 'write',
  extent: RenderExtent | undefined,
  surface = false,
): import('../render-pipeline').RenderPipelineTarget {
  const texture = graph.importTexture(
    label,
    {
      format: surface ? 'rgba8unorm' : 'rgba16float',
      size:
        extent === undefined
          ? 'half-surface'
          : {
              width: Math.max(1, Math.floor(extent.internalWidth / 2)),
              height: Math.max(1, Math.floor(extent.internalHeight / 2)),
            },
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_STORAGE_BINDING |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      domain: 'linear-hdr',
    },
    (frame) => {
      const internal = frame as import('./render-context')._InternalRenderPipelineContext;
      const owner = internal.frameState.ssrHistoryOwner;
      const candidate = owner?.candidate;
      if (owner === undefined || candidate === undefined) {
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'SSR history candidate to be staged before graph execution',
          hint: 'begin the SSR history candidate before executing the admitted graph',
        });
      }
      const slot =
        role === 'read'
          ? (candidate.readSlot ?? (candidate.writeSlot === 0 ? 1 : 0))
          : candidate.writeSlot;
      return surface
        ? owner.resources.slots[slot].surfaceTexture
        : owner.resources.slots[slot].texture;
    },
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => {
      const internal = frame as import('./render-context')._InternalRenderPipelineContext;
      const owner = internal.frameState.ssrHistoryOwner;
      const candidate = owner?.candidate;
      if (owner === undefined || candidate === undefined) {
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'SSR history candidate to be staged before graph execution',
          hint: 'begin the SSR history candidate before executing the admitted graph',
        });
      }
      const slot =
        role === 'read'
          ? (candidate.readSlot ?? (candidate.writeSlot === 0 ? 1 : 0))
          : candidate.writeSlot;
      return surface ? owner.resources.slots[slot].surfaceView : owner.resources.slots[slot].view;
    },
  );
  if (!view.ok) throw view.error;
  return {
    texture: texture.value,
    view: view.value,
    format: surface ? 'rgba8unorm' : 'rgba16float',
    sampleCount: 1,
    domain: 'linear-hdr',
  };
}

function importSsrHistoryTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: RenderExtent | undefined,
): NonNullable<
  import('../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>['ssrHistory']
> {
  return {
    previous: importSsrHistoryTarget(graph, 'ssr-history-previous', 'read', extent),
    output: importSsrHistoryTarget(graph, 'ssr-history-output', 'write', extent),
    previousSurface: importSsrHistoryTarget(
      graph,
      'ssr-history-previous-surface',
      'read',
      extent,
      true,
    ),
    outputSurface: importSsrHistoryTarget(
      graph,
      'ssr-history-output-surface',
      'write',
      extent,
      true,
    ),
    params: (() => {
      const imported = graph.importBuffer(
        'ssr-history-params',
        { size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
        (frame) => {
          const internal = frame as import('./render-context')._InternalRenderPipelineContext;
          const owner = internal.frameState.ssrHistoryOwner;
          if (owner === undefined) {
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'SSR history owner to be staged before graph execution',
              hint: 'create the renderer-owned SSR history before executing the admitted graph',
            });
          }
          return owner.resources.paramsBuffer;
        },
      );
      if (!imported.ok) throw imported.error;
      return imported.value;
    })(),
  };
}

export function shouldUseTemporalFrameTransaction(
  antialias: CameraSnapshot['antialias'],
  temporalDemand = false,
): boolean {
  return antialias === 'taa' || temporalDemand;
}

export function isMotionBlurTemporalDemand(
  motionBlur: CameraSnapshot['motionBlur'] | undefined,
): boolean {
  return (
    motionBlur !== undefined &&
    motionBlurTemporalDemand({
      shutterAngle: motionBlur.shutterAngle,
      maxRadiusPixels: motionBlur.maxRadiusPixels,
      sampleCount: motionBlur.sampleCount,
      targetFps: motionBlur.targetFps ?? 60,
    })
  );
}

/**
 * Derive the TAA topology from camera POD and backend capabilities. Both
 * Standard lanes consume this declaration; the lane only affects lighting
 * work and never creates a second temporal resolve.
 */
export function createTemporalGraphRoster(input: {
  readonly antialias: 'none' | 'fxaa' | 'taa';
  readonly lane: 'direct' | 'clustered';
  readonly capabilities?: TemporalGraphCapabilities;
}): TemporalGraphRoster {
  if (input.antialias !== 'taa') return { targets: [], passes: [], uploads: 0 };
  const capabilities = input.capabilities ?? {
    rgba16floatRender: true,
    rgba16floatSample: true,
    mrt: true,
  };
  if (!capabilities.rgba16floatRender || !capabilities.rgba16floatSample || !capabilities.mrt) {
    return { enabled: false, targets: [], passes: [], uploads: 0 };
  }
  return {
    enabled: true,
    targets: [
      'standard-scene-temporal',
      'taa-history-current-color',
      'taa-history-previous-color',
      'taa-history-current-temporal',
      'taa-history-previous-temporal',
    ],
    passes: ['main', 'standard-scene-data', 'taa-resolve', 'output-transform'],
    uploads: 1,
  };
}

export interface ReflectionProbeFilterGraphWork {
  readonly probeIndex: number;
  readonly faceIndex: number;
  readonly mipLevel: number;
}

export interface ReflectionProbeFilterGraphState {
  readonly work: readonly ReflectionProbeFilterGraphWork[];
  readonly maxStepsPerFrame: number;
}

export interface ReflectionProbeGraphWork {
  readonly captureGeneration?: number;
  readonly atmosphere?: import('../environment/storage').AtmosphereStorage | undefined;
  readonly background?: ProbeBackgroundResources;
  readonly probeIndex: number;
  readonly rawTexture: Texture;
  readonly rawCubeView: TextureView;
  readonly rawFaceViews: readonly TextureView[];
  readonly rawDepthTexture: Texture;
  readonly rawCaptureFace: number | undefined;
  readonly rawDepthView: TextureView;
  readonly rawSize: number;
  readonly faceCamera?: import('../render-contract').CameraSnapshot;
  readonly viewBindGroupDynamicOffset?: number;
  readonly filteredTexture: Texture;
  readonly filteredCubeView: TextureView;
  readonly filteredFaceViewsByMip: readonly (readonly TextureView[])[];
  readonly outputFormat: TextureFormat;
  readonly sampler: Sampler;
  readonly filterPipeline: RenderPipeline;
  readonly filterGroup0: BindGroup | undefined;
  readonly filterGroup1: BindGroup;
  readonly cubeVertexBuffer: Buffer;
  readonly filteredSize: number;
  readonly step: ReflectionProbeFilterGraphWork | undefined;
}

export interface ReflectionProbeGraphState {
  readonly work: readonly ReflectionProbeGraphWork[];
}

export function boundedReflectionProbeFilterWork(
  state: ReflectionProbeFilterGraphState,
): readonly ReflectionProbeFilterGraphWork[] {
  return state.work.slice(0, Math.max(0, state.maxStepsPerFrame));
}

export function addReflectionProbeGraphPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  state: ReflectionProbeGraphState,
  environmentCube?: import('../environment/ibl').GraphEnvironment,
  captureShadows?: import('../typed-shadow-passes').TypedShadowTargets,
): Result<readonly import('@forgeax/engine-render-graph').GraphAccess[], RenderGraphError> {
  const accesses: import('@forgeax/engine-render-graph').GraphAccess[] = [];
  for (const work of state.work) {
    const frozen = work.atmosphere;
    const frozenViews: Record<string, import('@forgeax/engine-render-graph').GraphTextureView> = {};
    if (frozen !== undefined) {
      for (const [name, width, height, layers, mips, usage] of [
        ['sky', 128, 128, 6, 1, 0x14],
        ['irradiance', 16, 16, 6, 1, 0x14],
        ['prefilter', 64, 64, 6, 5, 0x14],
        ['distantSkyLight', 1, 1, 1, 1, 0x0c],
        ['transmittance', 256, 64, 1, 1, 0x0c],
        ['multipleScattering', 32, 32, 1, 1, 0x0c],
      ] as const) {
        const texture = builder.importTexture(
          `reflection-probe.${work.probeIndex}.atmosphere.${name}`,
          {
            format: 'rgba16float',
            size: { width, height, depthOrArrayLayers: layers },
            mipLevelCount: mips,
            usage,
          },
          () => frozen[name],
        );
        if (!texture.ok) return texture;
        const view = builder.view(texture.value, { dimension: layers === 6 ? 'cube' : '2d' });
        if (!view.ok) return view;
        frozenViews[name] = view.value;
      }
    }
    const raw = builder.importTexture(
      `reflection-probe.${work.probeIndex}.raw`,
      {
        format: work.outputFormat,
        size: { width: work.rawSize, height: work.rawSize, depthOrArrayLayers: 6 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => work.rawTexture,
    );
    if (!raw.ok) return raw;
    const rawCube = builder.importView(
      raw.value,
      {
        label: `reflection-probe.${work.probeIndex}.raw-cube`,
        dimension: 'cube',
        arrayLayerCount: 6,
      },
      () => work.rawCubeView,
    );
    if (!rawCube.ok) return rawCube;
    const filtered = builder.importTexture(
      `reflection-probe.${work.probeIndex}.filtered`,
      {
        format: work.outputFormat,
        size: { width: work.filteredSize, height: work.filteredSize, depthOrArrayLayers: 6 },
        mipLevelCount: work.filteredFaceViewsByMip.length,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => work.filteredTexture,
    );
    if (!filtered.ok) return filtered;
    const filteredCube = builder.importView(
      filtered.value,
      {
        label: `reflection-probe.${work.probeIndex}.filtered-cube`,
        dimension: 'cube',
        baseMipLevel: 0,
        mipLevelCount: work.filteredFaceViewsByMip.length,
        arrayLayerCount: 6,
      },
      () => work.filteredCubeView,
    );
    if (!filteredCube.ok) return filteredCube;
    if (work.rawCaptureFace !== undefined) {
      const face = work.rawCaptureFace;
      const view = builder.importView(
        raw.value,
        {
          label: `reflection-probe.${work.probeIndex}.capture-face-${face}`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        },
        () => work.rawFaceViews[face] as TextureView,
      );
      if (!view.ok) return view;
      const depthTexture = builder.importTexture(
        `reflection-probe.${work.probeIndex}.capture-depth`,
        {
          format: 'depth32float-stencil8',
          size: { width: work.rawSize, height: work.rawSize, depthOrArrayLayers: 1 },
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: '2d',
          usage: 0x10,
        },
        () => work.rawDepthTexture,
      );
      if (!depthTexture.ok) return depthTexture;
      const depth = builder.importView(
        depthTexture.value,
        { label: `reflection-probe.${work.probeIndex}.capture-depth-view`, dimension: '2d' },
        () => work.rawDepthView,
      );
      if (!depth.ok) return depth;
      if (captureShadows !== undefined && frozen !== undefined) {
        const prepared = addAtmosphereBackground(
          builder,
          { texture: raw.value, view: view.value, format: work.outputFormat, sampleCount: 1 },
          { directional: captureShadows.directional?.view },
        );
        if (!prepared.ok) return prepared;
      }
      const added = builder.addRasterPass(`reflection-probe.${work.probeIndex}.capture.${face}`, {
        accesses: [
          ...(captureShadows === undefined
            ? []
            : [
                captureShadows.directional?.view,
                captureShadows.spot.view,
                captureShadows.point?.view,
              ]
                .filter(
                  (resource): resource is import('@forgeax/engine-render-graph').GraphTextureView =>
                    resource !== undefined,
                )
                .map((resource) => ({ resource, usage: 'sampled-read' as const }))),
          ...Object.values(frozenViews).map((resource) => ({
            resource,
            usage: 'sampled-read' as const,
          })),
          ...(environmentCube === undefined
            ? []
            : [environmentCube.sky, environmentCube.irradiance, environmentCube.prefilter].map(
                (resource) => ({ resource, usage: 'sampled-read' as const }),
              )),
          { resource: view.value, usage: 'color-attachment' },
          { resource: depth.value, usage: 'depth-stencil-write' },
        ],
        colorAttachments: [
          {
            view: view.value,
            loadOp: captureShadows !== undefined && frozen !== undefined ? 'load' : 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        depthStencilAttachment: {
          view: depth.value,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'store',
        },
        encode: ({ pass, frame, resources }) => {
          const internal = frame as _InternalRenderPipelineContext;
          const captureColor = resources.textureView(view.value);
          const captureDepth = resources.textureView(depth.value);
          if (!captureColor.ok || !captureDepth.ok) return;
          if (work.faceCamera === undefined || work.viewBindGroupDynamicOffset === undefined)
            return;
          const captured = (name: string) => {
            const view = frozenViews[name];
            if (view === undefined) throw new Error(`Missing frozen atmosphere view: ${name}`);
            return resources.textureView(view).unwrap();
          };
          const neutralVolume = internal.pipelineState.atmosphereFallbackView;
          if (frozen !== undefined && neutralVolume === undefined)
            throw new Error('Atmosphere capture requires the admitted View volume');
          if (frozen !== undefined && captureShadows === undefined) {
            recordAtmosphereCaptureBackground(
              frame,
              pass,
              work.outputFormat,
              work.viewBindGroupDynamicOffset,
              captured('transmittance'),
              captured('transmittance'),
              captured('multipleScattering'),
            );
          } else if (frozen === undefined) {
            recordProbeBackground(
              work.background,
              internal,
              work.faceCamera,
              pass,
              environmentCube === undefined
                ? undefined
                : resources.textureView(environmentCube.sky).unwrap(),
            );
          }
          const captureViews =
            frozen === undefined
              ? undefined
              : {
                  distantSkyLight: captured('distantSkyLight'),
                  transmittance: captured('transmittance'),
                  multipleScattering: captured('multipleScattering'),
                  aerialPerspective: neutralVolume as TextureView,
                  aerialTransmittance: neutralVolume as TextureView,
                };
          const capturedGroups = buildPerFrameBindGroups(
            internal.runtime as RenderSystemInternals,
            internal.frameState,
            internal.pipelineState,
            true,
            internal.bindGroupCounts,
            {
              atmosphere: captureViews,
              directionalShadow:
                captureShadows?.directional === undefined
                  ? (internal.frameState.frameOutputs.directionalShadowView ?? undefined)
                  : resources.textureView(captureShadows.directional.view).unwrap(),
              spotShadow:
                captureShadows === undefined
                  ? (internal.frameState.frameOutputs.spotShadowView ?? undefined)
                  : resources.textureView(captureShadows.spot.view).unwrap(),
            },
            true,
            internal.standardLighting,
          );
          const requireEnvironmentCube = () => {
            if (environmentCube === undefined) throw new Error('Missing capture environment cube');
            return environmentCube;
          };
          const captureContext = {
            ...internal,
            viewBindGroup: capturedGroups.viewBindGroup,
            ...(environmentCube === undefined && frozen === undefined
              ? {}
              : {
                  environmentIbl: {
                    irradiance:
                      frozen === undefined
                        ? resources.textureView(requireEnvironmentCube().irradiance).unwrap()
                        : captured('irradiance'),
                    prefilter:
                      frozen === undefined
                        ? resources.textureView(requireEnvironmentCube().prefilter).unwrap()
                        : captured('prefilter'),
                  },
                }),
          };
          delete captureContext.reflectionProbes;
          delete captureContext.hdrpSsaoBlurredView;
          delete captureContext.gpuDrivenDrawReceipts;
          delete captureContext.gpuDrivenStandardPbrFrameResources;
          encodeMainPass(
            {
              ...captureContext,
              dispatch: internal.captureDispatch ?? internal.dispatch,
              foldDispatchPlan: null,
              camera: work.faceCamera,
              viewBindGroupDynamicOffset: work.viewBindGroupDynamicOffset,
              geometryColorView: captureColor.value,
              geometryDepthView: captureDepth.value,
              geometryColorResolveView: null,
              transparentColorFormat: work.outputFormat as GPUTextureFormat,
              msaaActive: false,
              splitLdrSprite: false,
              ldrSpritePassView: null,
            },
            pass,
            undefined,
            {
              colorViews: [captureColor.value],
              colorFormats: [work.outputFormat as GPUTextureFormat],
              depthView: captureDepth.value,
              passKind: 'forward',
              clearColor: [0, 0, 0, 1],
            },
          );
        },
      });
      if (!added.ok) return added;
    }
    const step = work.step;
    if (step !== undefined) {
      const mipViews = work.filteredFaceViewsByMip[step.mipLevel];
      const outputView = mipViews?.[step.faceIndex];
      if (outputView === undefined) {
        return err(
          new RenderGraphError({
            code: 'resource-resolution-failed',
            expected: 'every scheduled probe mip has a filtered face view',
            hint: 'rebuild the renderer-owned probe output before compiling the Standard graph',
            detail: {
              resourceLabel: `reflection-probe.${work.probeIndex}.filtered`,
              passName: 'pmrem',
            },
          }),
        );
      }
      const output = builder.importView(
        filtered.value,
        {
          label: `reflection-probe.${work.probeIndex}.filtered-mip${step.mipLevel}-face${step.faceIndex}`,
          dimension: '2d',
          baseMipLevel: step.mipLevel,
          mipLevelCount: 1,
          baseArrayLayer: step.faceIndex,
          arrayLayerCount: 1,
        },
        () => outputView,
      );
      if (!output.ok) return output;
      const added = builder.addRasterPass(
        `reflection-probe.${work.probeIndex}.pmrem.${step.mipLevel}.${step.faceIndex}`,
        {
          accesses: [
            { resource: rawCube.value, usage: 'sampled-read' },
            { resource: output.value, usage: 'color-attachment' },
          ],
          colorAttachments: [
            {
              view: output.value,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
          encode: ({ pass }) => {
            if (work.filterGroup0 === undefined) return;
            pass.setPipeline(work.filterPipeline);
            pass.setBindGroup(0, work.filterGroup0);
            pass.setBindGroup(1, work.filterGroup1);
            pass.setVertexBuffer(0, work.cubeVertexBuffer);
            pass.draw(6, 1, step.faceIndex * 6, 0);
          },
        },
      );
      if (!added.ok) return added;
    }
    accesses.push({ resource: filteredCube.value, usage: 'sampled-read' });
  }
  return ok(accesses);
}

export {
  projectRenderTargetGraph,
  type RenderTargetGraphInput,
  type RenderTargetGraphProjection,
  type RenderTargetGraphSubresource,
} from '../targets/graph-projection';

export interface RenderFeatureGraphRuntimeState {
  plans: readonly RenderFeaturePlannedFrame[];
  fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
  postProcessIdentities: readonly string[];
}

/** The exact fields that define one validated feature-plan collection. */
export interface RenderFeaturePlanRevisionEntry {
  readonly featureIdentity: string;
  readonly generation: number;
  readonly signature: string;
  readonly order: number;
}

/** Compact graph-owner state for a completely validated feature-plan set. */
export interface RenderFeaturePlanRevisionState {
  readonly revision: number;
  readonly entries: readonly RenderFeaturePlanRevisionEntry[];
}

/**
 * Advance the plan revision only when the complete canonical plan collection
 * changes. Equality is an exact field comparison; the canonical signatures
 * have already been recomputed by validation before this helper is called.
 */
export function updateRenderFeaturePlanRevision(
  previous: RenderFeaturePlanRevisionState,
  plans: readonly RenderFeaturePlannedFrame[],
  executions: readonly RenderFeaturePlanExecution[],
): RenderFeaturePlanRevisionState {
  if (
    plans.length === previous.entries.length &&
    plans.every((planned, index) => {
      const prior = previous.entries[index];
      return (
        prior !== undefined &&
        prior.featureIdentity === planned.featureIdentity &&
        prior.generation === planned.generation &&
        prior.signature === planned.signature &&
        prior.order === (executions[index]?.order ?? -1)
      );
    })
  ) {
    return previous;
  }
  const entries = plans.map((planned, index) => ({
    featureIdentity: planned.featureIdentity,
    generation: planned.generation,
    signature: planned.signature,
    order: executions[index]?.order ?? -1,
  }));
  return {
    revision: previous.revision + 1,
    entries: Object.freeze(entries),
  };
}

/** A frame-local graph candidate that is committed only after compilation. */
export interface RenderFeatureGraphCandidate {
  readonly plans: readonly RenderFeaturePlannedFrame[];
  readonly fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
  /** Public Standard post-effect identities; graph-local resources stay internal. */
  readonly postProcessIdentities?: readonly string[];
  /**
   * Physical transient graphics resources are imported into the compiled
   * graph. Their lease therefore needs a new graph even when the declarative
   * plan signature is unchanged; otherwise queue retirement could destroy a
   * buffer still referenced by the memoized graph. Retired GPU-work leases are
   * kept in the completion batch but are not imported by this candidate and do
   * not require a graph revision on their own.
   */
  readonly preparedResourceKey?: string;
  /** Release candidate-owned prepared resources when graph promotion fails. */
  readonly onRejected?: () => void;
  /** Publish candidate-owned runtime declarations only after graph promotion. */
  readonly onAccepted?: () => void;
  /** Consume producer frame state only after the command buffer is submitted. */
  readonly onSubmitted?: () => void;
  /** Discard producer frame state after graph execution/submission aborts. */
  readonly onAborted?: () => void;
  /** Discard candidate-only resources when a base graph is kept as fallback. */
  readonly onAbandoned?: () => void;
}

const featureGraphStates = new WeakMap<RenderSystemInternals, RenderFeatureGraphRuntimeState>();
const graphDeviceGenerations = new WeakMap<object, number>();
const graphRetirementFailures = new WeakMap<
  RenderFrameState,
  Set<CompiledRenderGraph<RenderPipelineFrame>>
>();

type GraphGenerationRole = 'active' | 'candidate' | 'retiring';
type GraphGenerationStatus = 'active' | 'retiring' | 'failed' | 'retired';

interface GraphGenerationAllocationRecord {
  readonly graph: CompiledRenderGraph<RenderPipelineFrame>;
  status: GraphGenerationStatus;
  allocation: RenderGraphResourceAllocationInspection | undefined;
}

/**
 * One stable allocation owner for a RenderSystem lifetime. Recovery builds a
 * detached frame state, but that state intentionally shares this owner before
 * it can publish a candidate into the active RenderSystem. Graph records stay
 * here across asynchronous retirement so a successful replacement cannot
 * erase the overlap peak before the next public inspection.
 */
interface GraphGenerationAllocationOwner {
  readonly records: Map<CompiledRenderGraph<RenderPipelineFrame>, GraphGenerationAllocationRecord>;
  peakBytes: number;
}

const graphGenerationAllocationOwners = new WeakMap<
  RenderFrameState,
  GraphGenerationAllocationOwner
>();

function graphGenerationAllocationOwner(
  frameState: RenderFrameState,
): GraphGenerationAllocationOwner {
  const existing = graphGenerationAllocationOwners.get(frameState);
  if (existing !== undefined) return existing;
  const created: GraphGenerationAllocationOwner = { records: new Map(), peakBytes: 0 };
  graphGenerationAllocationOwners.set(frameState, created);
  return created;
}

function graphRetirementFailureSet(
  frameState: RenderFrameState,
): Set<CompiledRenderGraph<RenderPipelineFrame>> {
  const existing = graphRetirementFailures.get(frameState);
  if (existing !== undefined) return existing;
  const created = new Set<CompiledRenderGraph<RenderPipelineFrame>>();
  graphRetirementFailures.set(frameState, created);
  return created;
}

/** Share the renderer-owned graph ledger with a detached recovery frame state. */
export function shareRenderGraphGenerationAllocationOwner(
  source: RenderFrameState,
  target: RenderFrameState,
): void {
  graphGenerationAllocationOwners.set(target, graphGenerationAllocationOwner(source));
  graphRetirementFailures.set(target, graphRetirementFailureSet(source));
}

function graphGenerationAllocationTotals(records: Iterable<GraphGenerationAllocationRecord>): {
  liveBytes: number;
  pendingRetirementBytes: number;
} {
  const physical = new Map<string, { bytes: number; live: boolean }>();
  let liveBytes = 0;
  let pendingRetirementBytes = 0;
  for (const record of records) {
    if (record.status === 'retired') continue;
    const info = record.graph.inspect();
    record.allocation = info.resourceAllocation;
    // External graph implementations may expose only aggregate evidence.
    if (!info.resources.some((resource) => resource.allocationState !== undefined)) {
      liveBytes += info.resourceAllocation?.liveBytes ?? 0;
      pendingRetirementBytes += info.resourceAllocation?.pendingRetirementBytes ?? 0;
      continue;
    }
    for (const resource of info.resources) {
      const key = resource.physicalAllocationKey;
      if (
        resource.origin !== 'created' ||
        key === undefined ||
        resource.byteSize === undefined ||
        resource.allocationState === undefined ||
        resource.allocationState === 'released'
      )
        continue;
      const prior = physical.get(key);
      physical.set(key, {
        bytes: resource.byteSize,
        live: prior?.live === true || resource.allocationState === 'live',
      });
    }
  }
  for (const allocation of physical.values()) {
    if (allocation.live) liveBytes += allocation.bytes;
    else pendingRetirementBytes += allocation.bytes;
  }
  return { liveBytes, pendingRetirementBytes };
}

function observeGraphGenerationAllocation(frameState: RenderFrameState): void {
  const owner = graphGenerationAllocationOwner(frameState);
  const allocation = graphGenerationAllocationTotals(owner.records.values());
  owner.peakBytes = Math.max(
    owner.peakBytes,
    allocation.liveBytes + allocation.pendingRetirementBytes,
  );
}

function trackGraphGeneration(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  const owner = graphGenerationAllocationOwner(frameState);
  const record = owner.records.get(graph);
  if (record === undefined) {
    owner.records.set(graph, { graph, status: 'active', allocation: undefined });
  } else if (record.status === 'retired') {
    record.status = 'active';
  }
  observeGraphGenerationAllocation(frameState);
}

function setGraphGenerationRetiring(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  const owner = graphGenerationAllocationOwner(frameState);
  const record = owner.records.get(graph);
  if (record === undefined) {
    owner.records.set(graph, { graph, status: 'retiring', allocation: undefined });
  } else if (record.status !== 'failed') {
    record.status = 'retiring';
  }
}

function setGraphGenerationRetirementResult(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  succeeded: boolean,
): void {
  const owner = graphGenerationAllocationOwner(frameState);
  const record = owner.records.get(graph);
  if (record !== undefined) record.status = succeeded ? 'retired' : 'failed';
  observeGraphGenerationAllocation(frameState);
  // A successful graph no longer owns any handles. Keep the renderer-level
  // peak scalar, but release the graph object from the generation map; failed
  // and pending owners remain retained for recovery inspection.
  if (succeeded) owner.records.delete(graph);
}

/**
 * Project the actual RenderSystem graph-generation owners as one detached
 * allocation receipt. The candidate and fallback graph can overlap before a
 * submit settles; failed retirement stays visible until the frame owner is
 * discarded instead of disappearing with the asynchronous Set entry.
 */
export function inspectRenderGraphGenerationAllocation(
  frameState: RenderFrameState,
): RenderGraphGenerationAllocationInspection {
  const rolesByGraph = new Map<
    CompiledRenderGraph<RenderPipelineFrame>,
    Set<GraphGenerationRole>
  >();
  const add = (
    graph: CompiledRenderGraph<RenderPipelineFrame> | null | undefined,
    role: GraphGenerationRole,
  ) => {
    if (graph === null || graph === undefined) return;
    const roles = rolesByGraph.get(graph);
    if (roles === undefined) rolesByGraph.set(graph, new Set([role]));
    else roles.add(role);
  };
  add(frameState.compiledFrameGraph?.graph, 'active');
  add(frameState.compiledFrameGraphCandidate?.graph, 'candidate');
  add(frameState.compiledFrameGraphCandidate?.previous.installed?.graph, 'retiring');
  for (const graph of frameState.retiredCompiledFrameGraphs) add(graph, 'retiring');
  for (const graph of graphRetirementFailureSet(frameState)) add(graph, 'retiring');

  const owner = graphGenerationAllocationOwner(frameState);
  const entries: RenderGraphGenerationAllocationEntry[] = [];
  let unavailableGenerationCount = 0;
  for (const [graph, record] of owner.records) {
    if (record.status === 'retired') continue;
    const roles = rolesByGraph.get(graph) ?? new Set<GraphGenerationRole>();
    if (record.status === 'retiring' || record.status === 'failed') roles.add('retiring');
    if (roles.size === 0) {
      // A candidate can be detached from the active state's role fields while
      // it is still being prepared. Keep its owner record observable until
      // the publication or cleanup event settles it.
      roles.add(record.status === 'active' ? 'active' : 'retiring');
    }
    // Inspection is a projection of the graph's current ledger. The cached
    // snapshot is only for event-time peak updates; using it here would make
    // a successfully fenced graph look live after its retirement started.
    const allocation = graph.inspect().resourceAllocation;
    record.allocation = allocation;
    if (allocation === undefined) {
      unavailableGenerationCount += 1;
      continue;
    }
    const retirement =
      record.status === 'failed' ? 'failed' : roles.has('retiring') ? 'pending' : 'active';
    entries.push({
      generation: graph.inspect().generation,
      roles: Object.freeze([...roles]),
      retirement,
      allocation,
    });
  }
  entries.sort((left, right) => left.generation - right.generation);
  const { liveBytes, pendingRetirementBytes } = graphGenerationAllocationTotals(
    owner.records.values(),
  );
  const peakBytes = Math.max(owner.peakBytes, liveBytes + pendingRetirementBytes);
  const failedEntries = entries.filter((entry) => entry.retirement === 'failed');
  const failedAllocation = graphGenerationAllocationTotals(
    [...owner.records.values()].filter((record) => record.status === 'failed'),
  );
  return Object.freeze({
    unit: 'engine-allocation-bytes',
    physicalResidency: 'unknown',
    availability:
      entries.length === 0
        ? unavailableGenerationCount === 0
          ? 'complete'
          : 'unavailable'
        : unavailableGenerationCount === 0
          ? 'complete'
          : 'partial',
    unavailableGenerationCount,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    liveBytes,
    pendingRetirementBytes,
    peakBytes,
    failedRetirementCount: failedEntries.length,
    failedRetirementBytes: failedAllocation.liveBytes + failedAllocation.pendingRetirementBytes,
  });
}

interface MutableRenderFeatureGraphInspection {
  planRevisionState: RenderFeaturePlanRevisionState;
  signatureValidationCalls: number;
  signatureValidationBytes: number;
  signatureValidationChars: number;
  signatureValidationCpuMs: number;
  signatureValidationCacheHits: number;
  signatureValidationCacheMisses: number;
  ensureCalls: number;
  reuseHits: number;
  rebuildAttempts: number;
  compileAttempts: number;
  compileSuccesses: number;
  compileFailures: number;
  validationFailures: number;
  buildFailures: number;
  compileCpuMs: number;
  buildCpuMs: number;
  compilePrimaryCauses: Record<string, number>;
  compileChangedDependencies: Record<string, number>;
  candidatesWithPreparedBatches: number;
  preparedKeyChanges: number;
  accepted: number;
  rejected: number;
  abandoned: number;
  lastPlanSignature: string;
  lastTopologyKey: string | undefined;
  lastPreparedResourceKey: string | undefined;
  preparedKeyObserved: boolean;
}

const featureGraphInspections = new WeakMap<
  RenderSystemInternals,
  MutableRenderFeatureGraphInspection
>();

function mutableFeatureGraphInspection(
  internals: RenderSystemInternals,
): MutableRenderFeatureGraphInspection {
  const existing = featureGraphInspections.get(internals);
  if (existing !== undefined) return existing;
  const created: MutableRenderFeatureGraphInspection = {
    planRevisionState: { revision: 0, entries: [] },
    signatureValidationCalls: 0,
    signatureValidationBytes: 0,
    signatureValidationChars: 0,
    signatureValidationCpuMs: 0,
    signatureValidationCacheHits: 0,
    signatureValidationCacheMisses: 0,
    ensureCalls: 0,
    reuseHits: 0,
    rebuildAttempts: 0,
    compileAttempts: 0,
    compileSuccesses: 0,
    compileFailures: 0,
    validationFailures: 0,
    buildFailures: 0,
    compileCpuMs: 0,
    buildCpuMs: 0,
    compilePrimaryCauses: {},
    compileChangedDependencies: {},
    candidatesWithPreparedBatches: 0,
    preparedKeyChanges: 0,
    accepted: 0,
    rejected: 0,
    abandoned: 0,
    lastPlanSignature: '',
    lastTopologyKey: undefined,
    lastPreparedResourceKey: undefined,
    preparedKeyObserved: false,
  };
  featureGraphInspections.set(internals, created);
  return created;
}

export function getRenderFeatureGraphInspection(
  internals: RenderSystemInternals,
): RenderFeatureGraphInspection {
  const metrics = mutableFeatureGraphInspection(internals);
  return Object.freeze({
    planRevision: metrics.planRevisionState.revision,
    signatureValidationCalls: metrics.signatureValidationCalls,
    signatureValidationBytes: metrics.signatureValidationBytes,
    signatureValidationChars: metrics.signatureValidationChars,
    signatureValidationCpuMs: metrics.signatureValidationCpuMs,
    signatureValidationCacheHits: metrics.signatureValidationCacheHits,
    signatureValidationCacheMisses: metrics.signatureValidationCacheMisses,
    ensureCalls: metrics.ensureCalls,
    reuseHits: metrics.reuseHits,
    rebuildAttempts: metrics.rebuildAttempts,
    compileAttempts: metrics.compileAttempts,
    compileSuccesses: metrics.compileSuccesses,
    compileFailures: metrics.compileFailures,
    validationFailures: metrics.validationFailures,
    buildFailures: metrics.buildFailures,
    compileCpuMs: metrics.compileCpuMs,
    buildCpuMs: metrics.buildCpuMs,
    compilePrimaryCauses: Object.freeze({ ...metrics.compilePrimaryCauses }),
    compileChangedDependencies: Object.freeze({ ...metrics.compileChangedDependencies }),
    candidatesWithPreparedBatches: metrics.candidatesWithPreparedBatches,
    preparedKeyChanges: metrics.preparedKeyChanges,
    accepted: metrics.accepted,
    rejected: metrics.rejected,
    abandoned: metrics.abandoned,
    transientViewGraphs: inspectTransientViewGraphs(internals),
    last: Object.freeze({
      planSignature: metrics.lastPlanSignature,
      topologyKey: metrics.lastTopologyKey,
      preparedResourceKey: metrics.lastPreparedResourceKey,
    }),
  });
}

export function recordRenderFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate,
): void {
  const metrics = mutableFeatureGraphInspection(internals);
  if (
    metrics.preparedKeyObserved &&
    metrics.lastPreparedResourceKey !== candidate.preparedResourceKey
  ) {
    metrics.preparedKeyChanges += 1;
  }
  metrics.preparedKeyObserved = true;
  metrics.lastPreparedResourceKey = candidate.preparedResourceKey;
  if (candidate.preparedResourceKey !== undefined) {
    metrics.candidatesWithPreparedBatches += 1;
  }
}

function recordRenderFeatureCandidateEvent(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate,
  event: 'accepted' | 'rejected' | 'abandoned',
): void {
  const metrics = mutableFeatureGraphInspection(internals);
  metrics[event] += 1;
  if (event === 'accepted') candidate.onAccepted?.();
  else if (event === 'rejected') candidate.onRejected?.();
  else candidate.onAbandoned?.();
}

type CompiledGraphTargetAccess = CompiledRenderGraph<RenderPipelineFrame> & {
  readonly getColorTargetDescriptor: (
    name: string,
  ) => import('@forgeax/engine-render-graph').ResolvedColorTargetDescriptor | undefined;
  readonly getColorTargetView: (name: string) => TextureView | undefined;
  readonly getColorTargetTexture: (name: string) => Texture | undefined;
};

type ResolvedDepthPassExecution =
  import('@forgeax/engine-render-graph').RenderGraphPassExecution & {
    readonly resolvedDepthStencilAttachmentView?: TextureView;
  };

export function getRenderFeatureGraphState(
  internals: RenderSystemInternals,
): RenderFeatureGraphRuntimeState {
  const existing = featureGraphStates.get(internals);
  if (existing !== undefined) return existing;
  const created: RenderFeatureGraphRuntimeState = {
    plans: [],
    fullscreenEffects: new Map(),
    postProcessIdentities: [],
  };
  featureGraphStates.set(internals, created);
  return created;
}

export function resetRenderFeatureGraphState(internals: RenderSystemInternals): void {
  const state = getRenderFeatureGraphState(internals);
  state.plans = [];
  state.fullscreenEffects = new Map();
  state.postProcessIdentities = [];
}

export function reportRenderFeatureGraphError(
  internals: RenderSystemInternals,
  error: RenderError,
): void {
  if (internals.featureHost !== undefined && 'detail' in error) {
    const detail = error.detail;
    if (detail !== undefined && 'featureIdentity' in detail && 'order' in detail) {
      const owned = internals.featureHost.recordError(detail.featureIdentity, error);
      internals.errorRegistry.fire(owned);
      return;
    }
  }
  internals.errorRegistry.fire(error);
}

export function renderFeatureGraphPlanSignature(
  plans: readonly RenderFeaturePlannedFrame[],
): string {
  return JSON.stringify(
    plans.map((planned) => [planned.featureIdentity, planned.generation, planned.signature]),
  );
}

/**
 * Admit fullscreen post-processes as one chain, never as independent passes.
 * A pass whose shader module is still compiling cannot clear a graph target and
 * leave the remainder of the chain sampling an undefined intermediate. The
 * renderer therefore keeps the base output-transform graph until every
 * requested effect is ready, then admits the complete ordered chain together.
 */
export function resolvePostProcessChainAdmission(
  effects: readonly string[],
  isReady: (identity: string) => boolean,
): { readonly admitted: readonly string[]; readonly pending: boolean } {
  // Probe every declaration even after the first miss.  A single frame may
  // introduce several effects; evaluating all of them lets the shared cache
  // start every independent compile together instead of serialising warmup on
  // array order.
  let ready = true;
  for (const identity of effects) {
    if (!isReady(identity)) ready = false;
  }
  return {
    admitted: ready ? effects : [],
    pending: !ready,
  };
}

function validateRenderFeaturePlans(
  plans: readonly RenderFeaturePlannedFrame[],
  metrics?: MutableRenderFeatureGraphInspection,
): Result<readonly RenderFeaturePlanExecution[], RenderError> {
  const identities = new Set<string>();
  const projected: RenderFeaturePlanExecution[] = [];
  let previousOrder = -1;
  for (const [order, planned] of plans.entries()) {
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    const signatureMetrics =
      metrics === undefined ? undefined : { calls: 0, typedArrayBytes: 0, outputChars: 0 };
    const started =
      metrics === undefined
        ? 0
        : typeof performance === 'undefined'
          ? Date.now()
          : performance.now();
    // The host records detached structural evidence, but graph admission must
    // check it again so a mutation between the two synchronous stages cannot
    // smuggle a stale plan into the compiled graph. Only candidates without
    // evidence fall back to the canonical serializer.
    const signatureCacheHit =
      hasNativeRenderFeatureExecutionSignature(planned) ||
      renderFeaturePlanSignatureEvidenceMatches(planned.plan, planned.signature);
    if (metrics !== undefined) {
      if (signatureCacheHit) metrics.signatureValidationCacheHits += 1;
      else metrics.signatureValidationCacheMisses += 1;
    }
    const recomputedSignature = signatureCacheHit
      ? planned.signature
      : renderFeaturePlanSignature(planned.plan, signatureMetrics);
    if (metrics !== undefined) {
      const now = typeof performance === 'undefined' ? Date.now() : performance.now();
      metrics.signatureValidationCalls += signatureMetrics?.calls ?? 0;
      metrics.signatureValidationBytes += signatureMetrics?.typedArrayBytes ?? 0;
      metrics.signatureValidationChars += signatureMetrics?.outputChars ?? 0;
      metrics.signatureValidationCpuMs += now - started;
    }
    if (
      identities.has(planned.featureIdentity) ||
      planned.signature !== recomputedSignature ||
      execution === undefined ||
      execution.featureIdentity !== planned.featureIdentity ||
      execution.order <= previousOrder
    ) {
      return err(
        new RenderFeatureStageFailedError(planned.featureIdentity, order, 'plan', 'next-frame'),
      );
    }
    identities.add(planned.featureIdentity);
    previousOrder = execution.order;
    projected.push(execution);
  }
  return ok(Object.freeze(projected));
}

function commitFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate,
): void {
  // Publish renderer-owned declarations only after their device resources have
  // been admitted.  If the acceptance hook throws, the previously accepted
  // graph/state pair remains visible to the caller.
  recordRenderFeatureCandidateEvent(internals, candidate, 'accepted');
  const state = getRenderFeatureGraphState(internals);
  state.plans = candidate.plans;
  state.fullscreenEffects = candidate.fullscreenEffects;
  state.postProcessIdentities = candidate.postProcessIdentities ?? [];
}

function directionalTopologyOf(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
  shadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
): Result<RenderPipelineTopology['shadow']['directional'], RhiError> {
  const cascadeCount = Math.max(1, Math.min(4, Math.round(lights.cascadeCount ?? 1))) as
    | 1
    | 2
    | 3
    | 4;
  return terrainShadowTopology(
    shadowMapSize === undefined || lights.cascadeCount === undefined
      ? 'disabled'
      : { mapSize: shadowMapSize, cascadeCount },
    lights.directionalShadowQuality?.kind === 'pcss' ? [] : terrainReceivers,
    internals.device.limits.maxTextureArrayLayers,
  );
}

function topologyOf(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  clearOnly: boolean,
  lights: ExtractedLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  gpuDriven: PreparedGpuDrivenFrame | undefined,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  featurePlanRevision: number | string,
  cubeCaptureState: CubeCaptureGraphState | undefined,
  transmissionDemand: TransmissionDemand | undefined,
  volumetricFog: ExtractedVolumetricFog | undefined,
  standardLighting: StandardTopologyInputValue | undefined,
  ssr: SsrSpatialAdmission | undefined,
  renderExtent: RenderExtent | undefined,
  surfaceMediumActive: boolean | undefined,
  analyticFog: boolean,
  transparency: RenderPipelineTopology['transparency'],
  terrainReceivers: readonly TerrainShadowReceiver[] = [],
  subsurface?: RenderPipelineTopology['subsurface'],
  stockRecording = false,
): Result<RenderPipelineTopology, RhiError> {
  const directional = directionalTopologyOf(internals, lights, shadowMapSize, terrainReceivers);
  if (!directional.ok) return directional;
  const surfaceFormats = resolveSurfaceFormatPair(
    internals.device.caps.backendKind,
    pipelineState.format as GPUTextureFormat,
    pipelineState.colorAttachmentFormat as GPUTextureFormat,
  );
  const internal = internals.device as unknown as { readonly surfaceViewFormats?: boolean };
  const surfaceProfile = resolveSurfaceProfile(surfaceFormats.storage, surfaceFormats.view, {
    surfaceViewFormats:
      internal.surfaceViewFormats ?? internals.device.caps.backendKind !== 'wgpu-webgl2',
    rawAttachment:
      surfaceFormats.storage === 'rgba8unorm' || surfaceFormats.storage === 'bgra8unorm',
    floatRenderAttachment: internals.device.caps.rgba16floatRenderable,
  });
  if (!surfaceProfile.ok) return surfaceProfile;
  const featurePostEffects = (
    featureGraphCandidate?.postProcessIdentities ??
    getRenderFeatureGraphState(internals).postProcessIdentities
  ).filter((identity) => !isOutlinePostProcess(identity));
  const featurePostEffectDeclarations = [
    ...(featureGraphCandidate?.fullscreenEffects ??
      getRenderFeatureGraphState(internals).fullscreenEffects),
  ].map(([id, entry]) => [id, postProcessShaderEntrySignature(entry)] as const);
  const config =
    featurePostEffects.length === 0
      ? frameState.installedPipelineConfig
      : {
          ...(frameState.installedPipelineConfig ?? {}),
          postEffects: [
            ...new Set([
              ...(frameState.installedPipelineConfig?.postEffects ?? []),
              ...featurePostEffects,
            ]),
          ],
        };
  const volumeCapability = hasVolumetricFogCapability(
    internals.device.caps,
    internals.volumetricFogShaders,
  );
  const selectedVolumeLight =
    volumetricFog?.lightKind === 'spot'
      ? lights.spot.find((light) => light.entity === volumetricFog.lightEntity)
      : volumetricFog?.lightKind === 'point'
        ? lights.point.find((light) => light.entity === volumetricFog.lightEntity)
        : volumetricFog?.lightKind === 'directional' &&
            lights.directional?.entity === volumetricFog.lightEntity
          ? lights.directional
          : volumetricFog?.lightKind === undefined
            ? lights.directional
            : undefined;
  const preparedLut =
    frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
  const depthOfField = depthOfFieldTopology(camera.depthOfField);
  return ok({
    pipelineId: STANDARD_PIPELINE_ID,
    ...(subsurface === undefined ? {} : { subsurface }),
    projectedDecals: projectedDecalTopology(clearOnly ? [] : (camera.projectedDecals ?? [])),
    standardProfile: frameState.cameraStandardProfile ?? internals.standardProfile,
    config,
    preTemporalEffects: (config?.postEffects ?? []).filter(
      (identity) =>
        (
          featureGraphCandidate?.fullscreenEffects ??
          getRenderFeatureGraphState(internals).fullscreenEffects
        ).get(identity)?.stage === 'before-temporal',
    ),
    clearOnly,
    reflectionFallback: { enabled: frameState.reflectionFallbackDemand === true },
    ssr,
    ...(renderExtent === undefined ? {} : { extent: renderExtent }),
    analyticFog: !clearOnly && analyticFog,
    surface: {
      width,
      height,
      storageFormat: surfaceFormats.storage as TextureFormat,
      viewFormat: surfaceProfile.value.viewFormat as TextureFormat,
      profile: surfaceProfile.value,
    },
    camera: {
      tonemap: camera.tonemap,
      antialias: camera.antialias,
      // Bloom intensity is a frame parameter, not a graph identity. Fold
      // only its zero/non-zero admission into the closed topology switch so
      // positive intensity changes update the recorder UBO in place.
      bloom: standardBloomAdmitted(camera) ? 'on' : 'off',
      bloomIntensity: camera.bloomIntensity,
      outline: !clearOnly && camera.outline !== undefined,
      lensEffects: !clearOnly && camera.lensEffects !== undefined,
      lensFlare: !clearOnly && camera.lensFlare !== undefined,
      barrelDistortion: !clearOnly && (camera.barrelDistortion?.strength ?? 0) > 0,
      ...(depthOfField === undefined ? {} : { depthOfField }),
    },
    atmosphere: !clearOnly && frameState.environmentFrame?.source.kind === 'atmosphere',
    output: {
      autoExposure:
        !clearOnly &&
        camera.output?.exposure.kind === 'auto' &&
        (frameState.pendingAutoExposureGpuResources ?? frameState.autoExposureGpuResources) !==
          undefined,
      whiteBalance:
        !clearOnly &&
        camera.output !== undefined &&
        (camera.output.temperature !== 6504 || camera.output.tint !== 0),
      temperature: camera.output?.temperature ?? 6504,
      tint: camera.output?.tint ?? 0,
      colorLut:
        !clearOnly &&
        (camera.output?.colorLutStrength ?? 0) > 0 &&
        (frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources) !==
          undefined,
      colorLutStrength: camera.output?.colorLutStrength ?? 0,
      ...(preparedLut === undefined ? {} : { lutSourceKey: preparedLut.sourceKey }),
    },
    temporal: {
      taa: camera.antialias === 'taa',
      motionBlur: isMotionBlurTemporalDemand(camera.motionBlur),
    },
    shadow: {
      directional: directional.value,
      spotMapSize: shadowMapSize ?? 1024,
      pointCount: Math.min(SHADOW_ATLAS_DEFAULT_LAYERS, lights.pointShadow.length),
      pointFaceSize: lights.pointShadow[0]?.mapSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE,
      spotCount: Math.min(
        4,
        lights.spot.filter(
          (light) => light.shadowAtlasTile >= 0 && light.lightViewProj !== undefined,
        ).length,
      ),
    },
    volumetricFog:
      volumetricFog?.status === 'available' &&
      volumetricFog.densityAsset?.shape.viewDimension === '3d' &&
      selectedVolumeLight !== undefined &&
      volumeCapability
        ? (() => {
            const volumeProfile = resolveVolumetricFogProfile(internals.standardProfile ?? {});
            return {
              enabled: true,
              format: volumetricFog.densityAsset.format,
              additional: (volumetricFog.additional ?? []).flatMap((member) =>
                member.densityAsset?.shape.viewDimension === '3d'
                  ? [
                      {
                        format: member.densityAsset.format,
                        extent: member.densityAsset.shape.extent,
                      },
                    ]
                  : [],
              ),
              extent: {
                width: volumetricFog.densityAsset.shape.extent.width,
                height: volumetricFog.densityAsset.shape.extent.height,
                depth: volumetricFog.densityAsset.shape.extent.depth,
              },
              froxelExtent: deriveVolumetricFogExtent(
                { width, height },
                volumeProfile.depth * (1 + (volumetricFog.additional?.length ?? 0)),
                volumeProfile.tileSize,
              ),
              resolvedExtent: deriveVolumetricFogResolvedExtent(
                { width, height },
                volumeProfile.tileSize,
              ),
              lightKind: volumetricFog.lightKind,
              lightEntity: volumetricFog.lightEntity,
              pointLightEntity: volumetricFog.pointLightEntity,
              spotLightEntity: volumetricFog.spotLightEntity,
              ...(volumetricFog.projector === undefined
                ? {}
                : {
                    projector: {
                      guid: volumetricFog.projector.guid,
                      generation: volumetricFog.projector.generation,
                      revision: volumetricFog.projector.revision,
                    },
                  }),
            };
          })()
        : { enabled: false },
    lane: {
      compute: internals.device.caps.compute,
      storageBuffer: internals.device.caps.storageBuffer,
      multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
      maxColorAttachments: internals.device.caps.maxColorAttachments,
      primitiveIndex: internals.device.features.has('primitive-index'),
      maxColorAttachmentBytesPerSample: internals.device.limits.maxColorAttachmentBytesPerSample,
    },
    featureTopologySignature: JSON.stringify({
      planRevision: featurePlanRevision,
      fullscreenEffects: featurePostEffectDeclarations,
      preparedResourceKey:
        featureGraphCandidate?.preparedResourceKey ??
        frameState.compiledFrameGraph?.preparedResourceKey ??
        '',
      cubeCaptureSlots: cubeCaptureState?.work.length ?? 0,
    }),
    gpuDrivenTopologySignature: stockRecording
      ? (gpuDriven?._recordingTopologySignature ?? gpuDriven?.topologySignature ?? '')
      : (gpuDriven?.topologySignature ?? ''),
    standardLightingTopologySignature: standardLightingTopologySignature(standardLighting),
    transmissionDemand: transmissionDemand ?? {
      activeCount: 0,
      needsRoughMips: false,
    },
    ...((surfaceMediumActive ?? gpuDriven?.surfaceSubmission !== undefined)
      ? { singleLayerMedium: true }
      : {}),
    ...(transparency === undefined ? {} : { transparency }),
  });
}

function targetResolver(
  targets: readonly RenderPipelineFeatureTarget[],
  semanticTargets: readonly import('../render-pipeline').RenderPipelineTarget[] = [],
  namedTargets: Readonly<Record<string, import('../render-pipeline').RenderPipelineTarget>> = {},
): RenderFeatureGraphTargetResolver {
  return (resource) => {
    const namedKey =
      typeof resource === 'string'
        ? resource
        : isRenderFeatureTargetHandle(resource)
          ? resource.name
          : undefined;
    if (namedKey !== undefined) {
      const named = namedTargets[namedKey];
      if (named !== undefined) {
        return {
          texture: named.texture,
          view: named.view,
          ...(named.resolveTarget === undefined ? {} : { resolveTarget: named.resolveTarget }),
        };
      }
      if (typeof resource === 'string') {
        const target = targets.find((candidate) => candidate.name === resource);
        if (target !== undefined) {
          return {
            texture: target.texture,
            view: target.view,
            ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
          };
        }
        // Standard lanes expose the depth attachment as a semantic target
        // without duplicating the public `depth` name on every concrete graph
        // projection. Keep the string alias stable for feature-authored
        // fullscreen bindings while preserving the typed target identity.
        if (resource === 'depth') {
          const depth = targets.find((candidate) => candidate.kind === 'scene-depth');
          if (depth !== undefined) {
            return {
              texture: depth.texture,
              view: depth.view,
              ...(depth.resolveTarget === undefined ? {} : { resolveTarget: depth.resolveTarget }),
            };
          }
        }
      }
    }
    if (isSceneDataTarget(resource)) {
      const semantic = semanticTargets.find(
        (candidate) =>
          candidate.format === resource.format && candidate.sampleCount === resource.sampleCount,
      );
      return semantic === undefined
        ? undefined
        : { texture: semantic.texture, view: semantic.view };
    }
    if (!isRenderFeatureTargetHandle(resource)) return undefined;
    // A typed feature handle is an identity, not a format request. Falling
    // back to another same-format target can silently bind scene color in
    // place of a missing cloud history/shadow resource and turn a producer
    // failure into plausible but incorrect pixels.
    // Standard lanes expose scene depth as a semantic target without a
    // duplicated public name, while feature plans use the stable `depth`
    // handle name. Preserve that one semantic alias here as well as above for
    // string-authored fullscreen bindings.
    const target = targets.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        candidate.format === resource.format &&
        candidate.sampleCount === resource.sampleCount &&
        (resource.name === undefined ||
          candidate.name === resource.name ||
          (resource.kind === 'scene-color' &&
            resource.name === 'color' &&
            candidate.kind === 'scene-color') ||
          (resource.kind === 'scene-depth' &&
            resource.name === 'depth' &&
            candidate.kind === 'scene-depth')),
    );
    return target === undefined
      ? undefined
      : {
          texture: target.texture,
          view: target.view,
          ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        };
  };
}

export function resolveTargetBindings(
  input: {
    readonly frame: RenderPipelineFrame;
    readonly binding: import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource & {
      readonly kind: 'bindings';
    };
    readonly resources: GraphResourceResolver;
    readonly resolveTarget: RenderFeatureGraphTargetResolver;
    readonly resolveGpuResource?: (
      name: string,
    ) => import('../features/prepared-gpu-work').RenderFeatureResolvedGpuBuffer | undefined;
  },
  featurePostProcessEntries?: ReadonlyMap<string, PostProcessShaderEntry>,
  atmosphere?: GraphAtmosphere,
): RenderFeatureGraphBindingsResolution | undefined {
  const frame = input.frame as import('./render-context')._InternalRenderPipelineContext;
  const atmosphereViews: AtmosphereViews | undefined =
    atmosphere === undefined
      ? undefined
      : {
          transmittance: input.resources.textureView(atmosphere.transmittance).unwrap(),
          distantSkyLight: input.resources.textureView(atmosphere.distantSkyLight).unwrap(),
          multipleScattering: input.resources.textureView(atmosphere.multipleScattering).unwrap(),
          aerialPerspective: input.resources.textureView(atmosphere.aerialPerspective).unwrap(),
          aerialTransmittance: input.resources.textureView(atmosphere.aerialTransmittance).unwrap(),
        };
  const cloudShadow =
    atmosphere?.visibility.cloud === undefined
      ? undefined
      : input.resources.textureView(atmosphere.visibility.cloud).unwrap();
  const directionalShadow =
    atmosphere?.visibility.directional === undefined
      ? (frame.frameState.frameOutputs.directionalShadowView ?? undefined)
      : input.resources.textureView(atmosphere.visibility.directional).unwrap();
  const descriptor = input.binding.descriptor;
  const pipeline = input.binding.pipeline as
    | (RenderPipeline & { getBindGroupLayout?: (index: number) => BindGroupLayout })
    | undefined;
  const sceneDepth = descriptor?.values.sceneDepth;
  const sceneDepthBinding = descriptor?.values.sceneDepthBinding;
  if (pipeline === undefined) return undefined;
  // Blended feature draws (particles) read the View copy for their blend so
  // they fog themselves at their own depth over the already-fogged scene.
  const viewOffset =
    input.binding.fogComposition === undefined
      ? 0
      : translucentViewOffset(input.binding.fogComposition);
  if (descriptor?.values.view === true) {
    const viewBindGroup = buildPerFrameBindGroups(
      frame.runtime as RenderSystemInternals,
      frame.frameState,
      frame.pipelineState,
      true,
      frame.bindGroupCounts,
      {
        atmosphere: atmosphereViews,
        directionalShadow,
        cloudShadow,
        spotShadow: frame.frameState.frameOutputs.spotShadowView ?? undefined,
      },
      true,
      frame.standardLighting,
    ).viewBindGroup;
    return viewBindGroup === null
      ? undefined
      : { handle: viewBindGroup, dynamicOffsets: [viewOffset, 0] };
  }
  // Generic fullscreen producers (for example the CloudLayer scene pass)
  // share the renderer-owned post-process bind-group contract without opting
  // into the temporal two-input path below. Their input/depth aliases are
  // resolved from the active typed graph, so they cannot accidentally sample
  // a stale surface view or manufacture a second resource owner.
  if (descriptor?.values.fullscreen === true && !isTemporalFullscreenBinding(descriptor.values)) {
    const shader = descriptor.values.shader;
    if (typeof shader !== 'string') return undefined;
    const entry =
      featurePostProcessEntries?.get(shader) ?? frame.runtime.lookupPostProcess?.(shader);
    if (entry === undefined) return undefined;
    const depthFallback = descriptor.values.depthFallback === true;
    const depthValue = descriptor.values.depth;
    const depthTarget =
      depthFallback || depthValue === undefined
        ? undefined
        : input.resolveTarget(depthValue as never);
    const fullscreen = buildFullscreenPostProcessPass(
      { device: frame.runtime.device, errorRegistry: frame.runtime.errorRegistry },
      entry,
      depthTarget?.resolveTarget !== undefined,
    );
    if (fullscreen === null || fullscreen.sampler === null) return undefined;
    const inputDisabled = descriptor.values.input === false;
    const inputTarget = inputDisabled
      ? undefined
      : input.resolveTarget(descriptor.values.input as never);
    const inputView =
      inputTarget === undefined
        ? { ok: true as const, value: frame.pipelineState.defaultWhiteTextureView }
        : input.resources.textureView(inputTarget.view);
    if (!inputView.ok) return undefined;
    const depthView = depthFallback
      ? frame.pipelineState.shadowFallbackTextureView
      : depthTarget === undefined
        ? undefined
        : (() => {
            const depthTexture = input.resources.texture(depthTarget.texture);
            if (!depthTexture.ok) return undefined;
            const created = frame.runtime.device.createTextureView(depthTexture.value as Texture, {
              aspect: 'depth-only',
              dimension: '2d',
            });
            return created.ok ? created.value : undefined;
          })();
    if (
      depthTarget !== undefined &&
      (depthView === undefined || fullscreen.depthSampler === null)
    ) {
      return undefined;
    }
    const additionalViews: { readonly binding: number; readonly view: TextureView }[] = [];
    const additionalNames = descriptor.values.additionalTextures;
    if (Array.isArray(additionalNames)) {
      for (const [index, value] of additionalNames.entries()) {
        if (typeof value !== 'string') return undefined;
        const target = input.resolveTarget(value);
        if (target === undefined) return undefined;
        const view = input.resources.textureView(target.view);
        if (!view.ok) return undefined;
        const binding = fullscreen.extraColorBindings[index];
        if (binding === undefined) return undefined;
        additionalViews.push({ binding, view: view.value });
      }
    }
    const layout = pipeline.getBindGroupLayout?.(1);
    if (layout === undefined) return undefined;
    const paramsBuffer = frame.runtime.getPostProcessParamsBuffer?.(shader);
    if (entry.params !== undefined && paramsBuffer === undefined) return undefined;
    if (entry.params !== undefined && paramsBuffer !== undefined) {
      const data = frame.postProcessParams.get(shader) ?? entry.params.defaultValue;
      if (data.byteLength !== entry.params.byteSize) return undefined;
      const written = frame.runtime.device.queue.writeBuffer(paramsBuffer, 0, data);
      if (!written.ok) return undefined;
    }
    const createdBindGroup = createFullscreenBindGroup(
      frame.runtime.device,
      layout,
      inputView.value,
      fullscreen.sampler,
      paramsBuffer,
      depthView ?? null,
      fullscreen.depthSampler,
      additionalViews,
      fullscreen.extraStorageBindings.map((binding, index) => {
        const names = descriptor.values.storageBuffers;
        const name = Array.isArray(names) ? names[index] : undefined;
        if (typeof name !== 'string') throw new Error('fullscreen storage buffer name missing');
        const buffer = input.resolveGpuResource?.(name);
        if (buffer === undefined) throw new Error(`fullscreen storage buffer unavailable: ${name}`);
        return { binding, buffer: buffer.buffer };
      }),
    );
    if (createdBindGroup !== null) {
      // Cloud history is a producer of the shared temporal ping-pong state even
      // when TAA is disabled. Stage the write at encode time; execute's finish
      // guard and submit transaction then give it the same abort/commit/fence
      // semantics as the TAA resolve.
      if (shader === 'cloud-layer-resolve') {
        const state = getTemporalGpuState(
          frame.frameState,
          frame.runtime.device,
          frame.runtime.deviceScope,
          frame.targetW,
          frame.targetH,
          true,
        );
        stageTemporalGpuWrite(frame.frameState, state);
      }
      return createdBindGroup;
    }
    return undefined;
  }
  if (descriptor?.values.fullscreen === true && isTemporalFullscreenBinding(descriptor.values)) {
    const shader = descriptor.values.shader;
    if (typeof shader !== 'string') return undefined;
    const entry =
      featurePostProcessEntries?.get(shader) ?? frame.runtime.lookupPostProcess?.(shader);
    if (entry === undefined) return undefined;
    const fullscreen = buildFullscreenPostProcessPass(
      { device: frame.runtime.device, errorRegistry: frame.runtime.errorRegistry },
      entry,
      isRenderFeatureTargetHandle(descriptor.values.depth) &&
        descriptor.values.depth.sampleCount === 4,
    );
    if (fullscreen === null || fullscreen.sampler === null) return undefined;
    const inputTarget = input.resolveTarget(descriptor.values.input as never);
    if (inputTarget === undefined) return undefined;
    const inputView = input.resources.textureView(inputTarget.view);
    if (!inputView.ok) return undefined;
    const layout = pipeline.getBindGroupLayout?.(1);
    if (layout === undefined) return undefined;
    const depth = input.resolveTarget(descriptor.values.depth as never);
    const depthView =
      depth === undefined
        ? undefined
        : (() => {
            const depthTexture = input.resources.texture(depth.texture);
            if (!depthTexture.ok) return undefined;
            const created = frame.runtime.device.createTextureView(depthTexture.value as Texture, {
              aspect: 'depth-only',
              dimension: '2d',
            });
            return created.ok ? created.value : undefined;
          })();
    if (depth !== undefined && (depthView === undefined || fullscreen.depthSampler === null)) {
      return undefined;
    }

    const paramsBuffer = frame.runtime.getPostProcessParamsBuffer?.(shader);
    if (entry.params !== undefined && paramsBuffer === undefined) return undefined;
    if (entry.params !== undefined && paramsBuffer !== undefined) {
      const data = frame.postProcessParams.get(shader) ?? entry.params.defaultValue;
      if (data.byteLength !== entry.params.byteSize) return undefined;
      const written = frame.runtime.device.queue.writeBuffer(paramsBuffer, 0, data);
      if (!written.ok) return undefined;
    }

    if (!isTemporalFullscreenBinding(descriptor.values)) {
      return (
        createFullscreenBindGroup(
          frame.runtime.device,
          layout,
          inputView.value,
          fullscreen.sampler,
          paramsBuffer,
          depthView ?? null,
          fullscreen.depthSampler,
        ) ?? undefined
      );
    }

    const temporalTarget = input.resolveTarget(descriptor.values.temporal as never);
    if (temporalTarget === undefined) return undefined;
    const temporalView = input.resources.textureView(temporalTarget.view);
    if (!temporalView.ok) return undefined;
    return (
      createFullscreenBindGroup(
        frame.runtime.device,
        layout,
        inputView.value,
        fullscreen.sampler,
        paramsBuffer,
        depthView ?? null,
        fullscreen.depthSampler,
        [{ binding: fullscreen.extraColorBindings[0] ?? 5, view: temporalView.value }],
      ) ?? undefined
    );
  }
  if (sceneDepthBinding === 1) {
    const target = sceneDepth === undefined ? undefined : input.resolveTarget(sceneDepth);
    const texture = target === undefined ? undefined : input.resources.texture(target.texture);
    if (texture !== undefined && !texture.ok) throw texture.error;
    const depth = texture?.value ?? frame.pipelineState.shadowFallbackTextureView;
    const getLayout = pipeline.getBindGroupLayout;
    const layout = getLayout?.call(pipeline, 0);
    if (layout === undefined) {
      // Preserve depth-view failure reporting even for a pipeline that cannot
      // supply this layout; this branch never publishes a cached binding.
      if (texture !== undefined) {
        const view = frame.runtime.device.createTextureView(texture.value as Texture, {
          aspect: 'depth-only',
          dimension: '2d',
        });
        if (!view.ok) throw view.error;
      }
      return undefined;
    }
    const extraEntries = [
      ...atmosphereBindings(frame.pipelineState, atmosphereViews),
      ...atmosphereMaterialVisibilityBindings(frame.pipelineState, directionalShadow, cloudShadow),
    ];
    const extraLayout = extraEntries
      .map((entry) => {
        const resource = entry.resource;
        return `${entry.binding}:${resource.kind}${
          resource.kind === 'buffer' ? `:${resource.value.offset}:${resource.value.size}` : ''
        }`;
      })
      .join(',');
    // Auto layouts are exclusive to their immutable pipeline even when each
    // getBindGroupLayout call returns a new wrapper. Keep that actual pipeline
    // and every current physical input in the existing device-local View cache.
    // Texture contents and View uploads do not replace either binding resource.
    const created = getOrCreateFromChainResult(
      frame.frameState.viewBindGroupCache,
      [
        frame.runtime.device,
        frame.runtime.deviceScope ?? frame.runtime.device,
        pipeline,
        getLayout as object,
        frame.pipelineState.viewUniformBuffer,
        depth,
        ...extraEntries.map(extractEntryResourceHandle),
      ],
      `feature-depth-view:${texture === undefined ? 'fallback' : 'texture'}:${viewOffset}:${extraLayout}`,
      () => {
        const depthView =
          texture === undefined
            ? ok(frame.pipelineState.shadowFallbackTextureView)
            : frame.runtime.device.createTextureView(texture.value as Texture, {
                aspect: 'depth-only',
                dimension: '2d',
              });
        if (!depthView.ok) return depthView;
        return frame.runtime.device.createBindGroup({
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: frame.pipelineState.viewUniformBuffer,
                  offset: viewOffset,
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            },
            { binding: 1, resource: { kind: 'textureView', value: depthView.value } },
            ...extraEntries,
          ],
        });
      },
      frame.bindGroupCounts,
    );
    if (!created.ok) throw created.error;
    return created.value;
  }
  if (sceneDepth === undefined) {
    const viewBindGroup = buildPerFrameBindGroups(
      frame.runtime as RenderSystemInternals,
      frame.frameState,
      frame.pipelineState,
      // This callback is reached only for an actual feature draw. A scene
      // containing only particles still needs the pipeline's View/light ABI.
      true,
      frame.bindGroupCounts,
      {
        atmosphere: atmosphereViews,
        directionalShadow,
        cloudShadow,
        spotShadow: frame.frameState.frameOutputs.spotShadowView ?? undefined,
      },
      true,
      frame.standardLighting,
    ).viewBindGroup;
    return viewBindGroup === null
      ? undefined
      : { handle: viewBindGroup, dynamicOffsets: [viewOffset, 0] };
  }
  const target = input.resolveTarget(sceneDepth);
  if (target === undefined) return undefined;
  const texture = input.resources.texture(target.texture);
  if (!texture.ok) throw texture.error;
  const depthView = frame.runtime.device.createTextureView(texture.value as Texture, {
    aspect: 'depth-only',
    dimension: '2d',
  });
  if (!depthView.ok) throw depthView.error;
  const group = descriptor?.values.group === 1 ? 1 : 0;
  const layout = pipeline.getBindGroupLayout?.(group);
  if (layout === undefined) return undefined;
  const created = frame.runtime.device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { kind: 'textureView', value: depthView.value } }],
  });
  if (!created.ok) throw created.error;
  return created.value;
}

export function retire(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  if (frameState.retiredCompiledFrameGraphs.has(graph)) return;
  frameState.retiredCompiledFrameGraphs.add(graph);
  setGraphGenerationRetiring(frameState, graph);
  const failures = graphRetirementFailureSet(frameState);
  const retirement = graph.retire();
  // retire() synchronously moves graph-owned resources to pending before its
  // queue-fence await. Capture that overlap at the lifecycle event, rather
  // than waiting for a later inspection call.
  observeGraphGenerationAllocation(frameState);
  retirement
    .then((result) => {
      if (result.ok) {
        failures?.delete(graph);
        setGraphGenerationRetirementResult(frameState, graph, true);
      } else {
        failures?.add(graph);
        setGraphGenerationRetirementResult(frameState, graph, false);
      }
      frameState.retiredCompiledFrameGraphs.delete(graph);
    })
    .catch(() => {
      failures?.add(graph);
      setGraphGenerationRetirementResult(frameState, graph, false);
      frameState.retiredCompiledFrameGraphs.delete(graph);
    });
}

/** Settle the one compiled graph transaction after encode/finish/submit. */
export function settleCompiledFrameGraphCandidate(
  frameState: RenderFrameState,
  submitted: boolean,
): void {
  const candidate = frameState.compiledFrameGraphCandidate;
  if (candidate === undefined) return;
  const previous = candidate.previous;
  frameState.compiledFrameGraphCandidate = undefined;
  if (submitted) {
    const previousGraph = previous.installed?.graph;
    if (previousGraph !== undefined && previousGraph !== candidate.graph)
      retire(frameState, previousGraph);
    return;
  }
  if (candidate.graph !== previous.installed?.graph) retire(frameState, candidate.graph);
  frameState.compiledFrameGraph = previous.installed;
  frameState.graphGeneration = previous.graphGeneration;
  frameState.compiledFrameGraphGeneration = previous.compiledGeneration;
  frameState.standardLightingGraphSignature = previous.lightingSignature;
  frameState.barrelDistortionGraphResolution =
    previous.installed === null ? 'accepted' : 'retained';
}

/**
 * Drop every compiled graph this frame state owns at a renderer generation cut
 * (dispose or device recovery): roll back an unsubmitted candidate, retire the
 * installed graph, and forget graphs whose retirement is already in flight.
 */
export function discardCompiledFrameGraphs(frameState: RenderFrameState): void {
  settleCompiledFrameGraphCandidate(frameState, false);
  const installed = frameState.compiledFrameGraph;
  frameState.compiledFrameGraph = null;
  if (installed !== null) retire(frameState, installed.graph);
  frameState.retiredCompiledFrameGraphs.clear();
}

export function ensureCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  gpuDriven?: PreparedGpuDrivenFrame,
  featureGraphCandidate?: RenderFeatureGraphCandidate,
  cubeCaptureState?: CubeCaptureGraphState,
  clearOnly = false,
  transmissionDemand?: TransmissionDemand,
  volumetricFog?: ExtractedVolumetricFog,
  volumeTopologyCandidate = false,
  standardLighting?: StandardTopologyInputValue,
  onRecoveryError?: (error: unknown) => void,
  ssr?: SsrSpatialAdmission,
  renderExtent?: RenderExtent,
  surfaceMediumActive?: boolean,
  analyticFog = false,
  cloudShadowResolution?: number,
  transparency?: RenderPipelineTopology['transparency'],
  terrainReceivers: readonly TerrainShadowReceiver[] = [],
  subsurface?: RenderPipelineTopology['subsurface'],
  rendererRecording = false,
): CompiledRenderGraph<RenderPipelineFrame> | null {
  frameState.barrelDistortionGraphResolution = 'retained';
  const featureMetrics = mutableFeatureGraphInspection(internals);
  featureMetrics.ensureCalls += 1;
  const requestedStandardLightingSignature = standardLightingTopologySignature(standardLighting);
  const frameDepthOfField = resolveDepthOfFieldFrameParams(
    camera.depthOfField,
    camera.depthOfFieldError,
    frameState.depthOfFieldAccepted?.params,
  );
  // A rejected authoring request remains visible on the source camera, while
  // an accepted graph continues to receive its own params until a valid
  // replacement or explicit component removal is submitted.
  const graphCamera: CameraSnapshot =
    frameDepthOfField === undefined || frameDepthOfField === camera.depthOfField
      ? camera
      : { ...camera, depthOfField: frameDepthOfField };
  const lastKnownGood = (): CompiledRenderGraph<RenderPipelineFrame> | null => {
    const installed = frameState.compiledFrameGraph;
    const directional = directionalTopologyOf(internals, lights, shadowMapSize, terrainReceivers);
    return installed !== null &&
      directional.ok &&
      terrainShadowLayoutMatches(installed.topologyKey, directional.value) &&
      !hasSubmissionSensitiveFeatures(getRenderFeatureGraphState(internals).plans) &&
      cubeCaptureState?.planar?.current() === undefined &&
      !installed.graph
        .inspect()
        .resources.some((resource) => resource.label.startsWith('planar-reflection.')) &&
      frameState.standardLightingGraphSignature === requestedStandardLightingSignature
      ? installed.graph
      : null;
  };
  const retainLastKnownGood = (): CompiledRenderGraph<RenderPipelineFrame> | null => {
    const graph = lastKnownGood();
    if (graph !== null) frameState.barrelDistortionGraphResolution = 'retained';
    return graph;
  };
  const surfaceWidth = Math.max(1, width);
  const surfaceHeight = Math.max(1, height);
  const featurePlans = featureGraphCandidate?.plans ?? getRenderFeatureGraphState(internals).plans;
  const projectedFeaturePlans = validateRenderFeaturePlans(featurePlans, featureMetrics);
  if (!projectedFeaturePlans.ok) {
    featureMetrics.validationFailures += 1;
    onRecoveryError?.(projectedFeaturePlans.error);
    reportRenderFeatureGraphError(internals, projectedFeaturePlans.error);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return volumeTopologyCandidate ? null : retainLastKnownGood();
  }
  const cloudHistoryDemand = projectedFeaturePlans.value.some(
    (execution) =>
      execution.featureIdentity === CLOUD_LAYER_FEATURE_IDENTITY &&
      execution.passes.some(
        (pass) => pass.name === 'cloud-layer-transport' || pass.name === 'cloud-layer-resolve',
      ),
  );
  const nextPlanRevision = updateRenderFeaturePlanRevision(
    featureMetrics.planRevisionState,
    featurePlans,
    projectedFeaturePlans.value,
  );
  if (nextPlanRevision !== featureMetrics.planRevisionState) {
    featureMetrics.lastPlanSignature = nextPlanRevision.entries
      .map((entry) => `${entry.featureIdentity}:${entry.signature}`)
      .join('|');
    featureMetrics.planRevisionState = nextPlanRevision;
  }
  const transientViews = selectTransientViewPlans(
    internals,
    featurePlans,
    projectedFeaturePlans.value,
    rendererRecording &&
      frameState.activePipeline === standardPipeline &&
      frameState.graphTargetCapture === undefined,
    frameState,
  );
  const topologyCandidate = transientViews.ownsPhysicalChanges
    ? {
        ...featureGraphCandidate,
        plans: featurePlans,
        fullscreenEffects:
          featureGraphCandidate?.fullscreenEffects ??
          getRenderFeatureGraphState(internals).fullscreenEffects,
        preparedResourceKey: '',
      }
    : featureGraphCandidate;
  const topologyResult = topologyOf(
    internals,
    frameState,
    pipelineState,
    graphCamera,
    clearOnly,
    lights,
    surfaceWidth,
    surfaceHeight,
    shadowMapSize,
    gpuDriven,
    topologyCandidate,
    transientViews.topologySignature ?? featureMetrics.planRevisionState.revision,
    cubeCaptureState,
    transmissionDemand,
    volumetricFog,
    standardLighting,
    ssr,
    renderExtent,
    surfaceMediumActive,
    analyticFog,
    transparency,
    terrainReceivers,
    subsurface,
    rendererRecording && frameState.activePipeline === standardPipeline,
  );
  if (!topologyResult.ok) {
    featureMetrics.buildFailures += 1;
    onRecoveryError?.(topologyResult.error);
    internals.errorRegistry.fire(topologyResult.error);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return volumeTopologyCandidate ? null : retainLastKnownGood();
  }
  const requestedPostEffects = topologyResult.value.config?.postEffects ?? [];
  const featurePostProcessEntries =
    featureGraphCandidate?.fullscreenEffects ??
    getRenderFeatureGraphState(internals).fullscreenEffects;
  // Motion Blur's compute plan intentionally has no raster fullscreen shader
  // declaration, but it is still a post chain consumer: Standard Post owns
  // the named `motion-input`/`motion-output` targets and must project it after
  // TAA. Keep the identity in this deferred set alongside declared fullscreen
  // effects so an early forward/deferred contribution cannot resolve its
  // scene-data target against an incomplete target map.
  const fullscreenFeatureIds = new Set([
    ...featurePostProcessEntries.keys(),
    'forgeax.motion-blur',
  ]);
  const postProcessAdmission = resolvePostProcessChainAdmission(
    requestedPostEffects,
    (identity) => {
      const entry =
        featurePostProcessEntries.get(identity) ?? internals.lookupPostProcess?.(identity);
      // Preserve the existing missing-entry failure contract. The graph will
      // report post-process-not-found during record instead of silently
      // removing an authored id from the topology.
      if (entry === undefined) return true;
      const buildPipeline = internals.buildPostProcessPipeline;
      const getPipeline = internals.getPostProcessPipeline;
      if (buildPipeline === undefined || getPipeline === undefined) return true;
      const built = buildFullscreenPostProcessPass(
        { device: internals.device, errorRegistry: internals.errorRegistry },
        entry,
        camera.antialias === 'msaa' && topologyResult.value.lane.multisample,
      );
      if (built === null) return false;
      return (
        getPipeline(
          identity,
          built.bindGroupLayout,
          [
            entry.stage === 'before-temporal'
              ? 'rgba16float'
              : (topologyResult.value.surface.storageFormat as GPUTextureFormat),
          ],
          entry,
        ) !== null
      );
    },
  );
  const acceptedLkg = postProcessAdmission.pending ? lastKnownGood() : null;
  if (postProcessAdmission.pending && acceptedLkg !== null) {
    // Do not publish a candidate whose fullscreen chain is only partially
    // ready. Keep the accepted graph (including its prior post-effect chain)
    // and retry the same feature candidate on the next frame.
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    frameState.barrelDistortionGraphResolution = 'retained';
    return acceptedLkg;
  }
  const topology = postProcessAdmission.pending
    ? {
        ...topologyResult.value,
        preTemporalEffects: [],
        config: {
          ...(topologyResult.value.config ?? {}),
          postEffects: [],
        },
      }
    : topologyResult.value;
  // Keep Bloom's positive parameter values out of the compiled identity. A
  // crossing of zero has already changed topology.camera.bloom above; the
  // remaining values are uploaded by the active recorder without rebuilding
  // targets or pipelines.
  const topologyIdentity = frameGraphTopologyIdentity(
    topology,
    rendererRecording && frameState.activePipeline === standardPipeline,
  );
  const rayDiffuse = frameState.rayDiffuse?.ready;
  // Screen Probes consume the shared field; only the field lane gathers it per pixel.
  const irradianceField =
    internals.standardProfile?.diffuseGi?.gather === 'irradiance-field'
      ? frameState.irradianceField?.ready
      : undefined;
  const screenProbe = frameState.screenProbe?.ready;
  const bakedField =
    internals.standardProfile?.diffuseGi?.gather === 'baked'
      ? frameState.bakedField?.ready
      : undefined;
  const probePlacement = frameState.probePlacementFrame;
  const shadowCameraCull = shadowCameraCullAdmitted({
    rayDiffuse: rayDiffuse !== undefined,
    volumetricFog: topology.volumetricFog?.enabled === true,
    atmosphere: topology.atmosphere === true,
    cubeCaptures: cubeCaptureState?.work.length ?? 0,
    reflectionProbes: cubeCaptureState?.reflectionProbes?.work.length ?? 0,
    planarReflection: cubeCaptureState?.planar?.current() !== undefined,
    featureSceneInputs: internals.featureSceneInputs?.work.length ?? 0,
  });
  const key = JSON.stringify({
    topology: topologyIdentity,
    // Observation domains are an explicit per-frame graph demand.  They are
    // part of the cache identity so a request made after the ordinary graph
    // was compiled can admit the matching tone/output capture boundaries on
    // that receipt without forcing every unobserved frame onto the split
    // output path.
    observationCaptureDomains: [...(internals.observationCaptureDomains ?? [])].sort(),
    // GPU-driven residency can become available after the first record pass
    // (custom mesh handles are resolved into the per-frame projection).  The
    // topology signature alone is intentionally stable across that lifecycle,
    // so include the prepared projection's presence to invalidate a cached
    // CPU-only graph when the GPU owner becomes ready, and vice versa.
    gpuDrivenProjectionActive: gpuDriven !== undefined,
    rayDiffuseGeneration: rayDiffuse?.generation,
    irradianceField:
      irradianceField === undefined ? undefined : irradianceFieldGraphShape(irradianceField),
    screenProbe: screenProbe === undefined ? undefined : screenProbeGraphShape(screenProbe),
    bakedField: bakedField === undefined ? undefined : bakedFieldGraphShape(bakedField),
    probePlacement:
      probePlacement === undefined
        ? undefined
        : [
            probePlacement.generation,
            probePlacement.count,
            probePlacement.recordBytes,
            probeGlobalGraphShape(probePlacement),
          ],
    featureSceneInputs: internals.featureSceneInputs?.topologyKey,
    // Cloud shadow targets are quality-derived graph resources. Include the
    // resolved texel grid in the cache key so a quality/resize change cannot
    // reuse a graph compiled for the previous allocation.
    cloudShadowResolution: cloudShadowResolution ?? 0,
    cloudHistory: cloudHistoryDemand,
    cubeCaptureSlots: cubeCaptureState?.work.map((work) => ({
      descriptor: work.physical.descriptor,
      planar: work.faceCamera.planarReflection !== undefined,
      // A volume slice is a render-pass attachment fact, not a resolved view.
      depthSlice: work.physical.descriptor.shape === '3d' ? work.layer : undefined,
    })),
    planarRetained: cubeCaptureState?.planar?.current()?.physical.descriptor,
    reflectionProbeSlots: cubeCaptureState?.reflectionProbes?.work.map((work) => [
      work.probeIndex,
      work.rawCaptureFace ?? -1,
      work.step?.faceIndex ?? -1,
      work.step?.mipLevel ?? -1,
    ]),
  });
  const installed = frameState.compiledFrameGraph;
  if (installed !== null && installed.topologyKey === key) {
    frameState.barrelDistortionGraphResolution = 'accepted';
    featureMetrics.reuseHits += 1;
    featureMetrics.lastTopologyKey = key;
    frameState.standardLightingGraphSignature = requestedStandardLightingSignature;
    frameState.pendingCloudHistoryActive = cloudHistoryDemand;
    if (featureGraphCandidate !== undefined && !postProcessAdmission.pending) {
      commitFeatureCandidate(internals, featureGraphCandidate);
    } else if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'abandoned');
    }
    // A candidate flag only describes a possible topology replacement. When
    // the derived key is unchanged there is no replacement to stage: reuse the
    // accepted graph so dynamic volume history/imported views can advance and
    // a queue-submit failure can still publish the LKG diagnostic.
    return installed.graph;
  }

  featureMetrics.rebuildAttempts += 1;
  featureMetrics.lastTopologyKey = key;
  const buildStarted = typeof performance === 'undefined' ? Date.now() : performance.now();
  const builder = new RenderGraphBuilder<RenderPipelineFrame>();
  const sceneInputs = internals.featureSceneInputs?.import(builder);
  const autoExposureResources =
    topology.output?.autoExposure === true ? importAutoExposureGraphResources(builder) : undefined;
  if (autoExposureResources !== undefined && !autoExposureResources.ok) {
    internals.errorRegistry.fire(autoExposureResources.error);
    retirePendingStandardOutputGpu(frameState);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return retainLastKnownGood();
  }
  const lutResources =
    topology.output?.colorLut === true
      ? (() => {
          const prepared =
            frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
          if (prepared === undefined) return undefined;
          const texture = builder.importTexture(
            'standard-color-lut-source',
            {
              format: 'rgba16float',
              size: {
                width: prepared.size,
                height: prepared.size,
                depthOrArrayLayers: prepared.size,
              },
              dimension: '3d',
              usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            },
            (frame) =>
              (
                (frame as _InternalRenderPipelineContext).frameState
                  .pendingStandardLutGpuResources ??
                (frame as _InternalRenderPipelineContext).frameState.standardLutGpuResources
              )?.texture ?? prepared.texture,
          );
          if (!texture.ok) return texture;
          const view = builder.importView(
            texture.value,
            { label: 'standard-color-lut-source.view', dimension: '3d' },
            (frame) =>
              (
                (frame as _InternalRenderPipelineContext).frameState
                  .pendingStandardLutGpuResources ??
                (frame as _InternalRenderPipelineContext).frameState.standardLutGpuResources
              )?.view ?? prepared.view,
          );
          if (!view.ok) return view;
          return ok({ texture: texture.value, view: view.value, prepared });
        })()
      : undefined;
  if (lutResources !== undefined && !lutResources.ok) {
    internals.errorRegistry.fire(lutResources.error);
    retirePendingStandardOutputGpu(frameState);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return retainLastKnownGood();
  }
  const taaHistory = camera.antialias === 'taa' ? importTemporalHistoryTargets(builder) : undefined;
  const cloudHistory = cloudHistoryDemand ? importCloudHistoryTargets(builder) : undefined;
  const targetCoverage =
    camera.dynamicResolution === undefined || topology.extent === undefined
      ? undefined
      : createTargetCoverageAttachment(builder, topology.extent);
  if (targetCoverage !== undefined && !targetCoverage.ok) {
    internals.errorRegistry.fire(targetCoverage.error);
    retirePendingStandardOutputGpu(frameState);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return retainLastKnownGood();
  }
  const ssrHistory =
    ssr?.status === 'admitted' ? importSsrHistoryTargets(builder, topology.extent) : undefined;
  const featureProjection = createRenderFeatureProjectionState();
  const transientSlots = new Map<string, { complete: boolean; names: Set<string> }>();
  let featureShadows:
    | ReturnType<typeof projectRenderFeatureShadows<RenderPipelineFrame>>
    | undefined;
  let projectedGpuDriven = false;
  let prepareGpuDrivenPipelines: import('./frame-snapshot').InstalledFrameGraph['prepareGpuDrivenPipelines'];
  const activePipeline = frameState.activePipeline;
  let directionalShadowViewCount: number | undefined;
  // Direct and custom graph builds cannot admit callback or accessor elision.
  const build =
    rendererRecording && activePipeline === standardPipeline
      ? (context: Parameters<typeof activePipeline.build>[0], topology: RenderPipelineTopology) =>
          buildStandard(context, topology, true)
      : activePipeline.build;
  const built = Reflect.apply(build, activePipeline, [
    {
      graph: builder,
      ...(probePlacement === undefined
        ? {}
        : {
            contributeProbePlacement: (targets) => {
              const placed = addProbePlacementPass(builder, probePlacement, targets);
              if (!placed.ok) return placed;
              return probePlacement.global === undefined
                ? ok(undefined)
                : addProbeGlobalPasses(builder, probePlacement, placed.value);
            },
          }),
      ...(rayDiffuse === undefined
        ? irradianceField === undefined
          ? screenProbe === undefined
            ? bakedField === undefined
              ? {}
              : {
                  contributeDiffuseGi: (targets) =>
                    addBakedFieldPasses(builder, bakedField, targets),
                }
            : {
                contributeDiffuseGi: (targets) =>
                  addScreenProbePasses(builder, screenProbe, targets),
              }
          : {
              contributeDiffuseGi: (targets) =>
                addIrradianceFieldPasses(builder, irradianceField, targets),
            }
        : {
            contributeDiffuseGi: (targets) => addRayDiffusePasses(builder, rayDiffuse, targets),
          }),
      camera: { depthOfField: graphCamera.depthOfField },
      observationCaptureDomains: internals.observationCaptureDomains,
      ...(autoExposureResources?.ok === true
        ? { standardOutput: { autoExposure: autoExposureResources.value } }
        : {}),
      ...(lutResources?.ok === true
        ? {
            standardOutput: {
              ...(autoExposureResources?.ok === true
                ? { autoExposure: autoExposureResources.value }
                : {}),
              colorLut: {
                view: lutResources.value.view,
                sampler: lutResources.value.prepared.sampler,
                strength: lutResources.value.prepared.strength,
                bindGroupLayout: lutResources.value.prepared.bindGroupLayout,
                bindGroup: lutResources.value.prepared.bindGroup,
              },
            },
          }
        : {}),
      ...(standardLighting === undefined ? {} : { standardLighting }),
      capabilities: { rgba16floatRenderable: internals.device.caps.rgba16floatRenderable },
      ...(cloudShadowResolution === undefined ? {} : { cloudShadowResolution }),
      ...(taaHistory === undefined ? {} : { taaHistory }),
      ...(cloudHistory === undefined ? {} : { cloudHistory }),
      ...(targetCoverage?.ok === true ? { targetCoverage: targetCoverage.value } : {}),
      ...(ssrHistory === undefined ? {} : { ssrHistory }),
      encodeTransmissionMip: ({ pass, resources, source, format }) => {
        const sourceView = resources.textureView(source);
        if (!sourceView.ok) throw sourceView.error;
        const encoded = encodeMipmapLevel(internals.device, pass, sourceView.value, format);
        if (!encoded.ok) throw encoded.error;
      },
      projectGpuDriven: (target) => {
        if (projectedGpuDriven || gpuDriven === undefined) return ok(undefined);
        projectedGpuDriven = true;
        const projected = gpuDriven.project(
          builder,
          target.format,
          target.sampleCount,
          () => frameState.surfaceSubmissionObservation,
          target.additionalColorFormats,
          target.lateOcclusion === true,
          rendererRecording && activePipeline === standardPipeline,
        );
        if (projected.ok) prepareGpuDrivenPipelines = projected.value.preparePipelines;
        return projected;
      },
      ...(gpuDriven?.projectShadow === undefined
        ? {}
        : {
            projectGpuDrivenShadow: (identity, cameraPyramid) => {
              // Capture demand from the stock builder's actual projection calls,
              // rather than re-reading a possibly retained request/topology key.
              if (activePipeline === standardPipeline && identity.kind === 'directional') {
                directionalShadowViewCount = Math.max(
                  directionalShadowViewCount ?? 0,
                  identity.index + 1,
                );
              }
              // A newly compiled graph still owns every shadow compute pass.
              return (
                gpuDriven.projectShadow?.(
                  builder,
                  identity,
                  true,
                  shadowCameraCull ? cameraPyramid : undefined,
                ) ?? ok(undefined)
              );
            },
            ...(gpuDriven.shadowViewPool === undefined
              ? {}
              : { gpuDrivenStaticShadowLayers: gpuDriven.shadowViewPool.staticLayers }),
          }),
      contributeShadowFeatures: () =>
        (featureShadows ??= projectRenderFeatureShadows(
          builder,
          projectedFeaturePlans.value,
          featureProjection,
        )),
      contributeFeatures: (
        targets,
        semanticTargets = [],
        namedTargets = {},
        standardSurfaceAccesses = [],
        featureSelectionOrPlacement,
        passNames = [],
        atmosphere,
      ) => {
        const selection =
          featureSelectionOrPlacement !== undefined &&
          typeof featureSelectionOrPlacement !== 'string'
            ? featureSelectionOrPlacement
            : undefined;
        const placement =
          typeof featureSelectionOrPlacement === 'string' ? featureSelectionOrPlacement : 'post';
        const include = selection?.include === undefined ? undefined : new Set(selection.include);
        const exclude = selection?.exclude === undefined ? undefined : new Set(selection.exclude);
        // Forward/deferred scene lanes contribute scene plans before the
        // Standard post chain has created its named input/output targets.
        // Fullscreen effects (Motion Blur included) must wait for that later
        // call so their temporal input is resolved after TAA. The shared
        // projection state below deduplicates only the execution/pass that
        // actually reached the graph; an empty early projection therefore
        // cannot reserve the later fullscreen pass.
        const plans = (
          Object.keys(namedTargets).length === 0
            ? projectedFeaturePlans.value.filter(
                (execution) => !fullscreenFeatureIds.has(execution.featureIdentity),
              )
            : projectedFeaturePlans.value
        )
          .filter((execution) => (execution.placement ?? 'post') === placement)
          .filter((execution) => include === undefined || include.has(execution.featureIdentity))
          .filter((execution) => exclude === undefined || !exclude.has(execution.featureIdentity));
        if (plans.length === 0) return ok(undefined);
        const resolveDisplayTarget = targetResolver(targets, semanticTargets, namedTargets);
        const resolveTarget: ReturnType<typeof targetResolver> = (target) =>
          (typeof target === 'object'
            ? sceneInputs?.get(target as import('../features/targets').RenderFeatureTargetHandle)
            : undefined) ?? resolveDisplayTarget(target);
        const viewAccesses =
          atmosphere === undefined
            ? []
            : atmosphereTextures(atmosphere).map((resource) => ({
                resource,
                usage: 'sampled-read' as const,
              }));
        const projected = projectTransientViewPlans(
          builder,
          plans,
          transientViews.identities,
          {
            state: featureProjection,
            resolveTarget,
            placement,
            ...(passNames.length === 0 ? {} : { passNames: new Set(passNames) }),
            standardSurfaceAccesses,
            viewAccesses,
            resolveBindings: (input) =>
              resolveTargetBindings(input, featurePostProcessEntries, atmosphere),
            resolveStandardLighting: (frame, pipeline) => {
              const context = frame as import('./render-context')._InternalRenderPipelineContext;
              if (context.standardLighting?.kind !== 'clustered') return undefined;
              const layout = (
                pipeline as RenderPipeline & {
                  getBindGroupLayout?: (index: number) => BindGroupLayout;
                }
              ).getBindGroupLayout?.(2);
              if (layout === undefined) return undefined;
              return (
                createStandardSurfaceLightingBindGroup(
                  context.runtime,
                  layout,
                  context.standardLighting.prepared.layout.grid,
                  context.hdrpSsaoBlurredView === undefined
                    ? { enabled: false }
                    : { enabled: true, ssaoBlurredView: context.hdrpSsaoBlurredView },
                ) ?? undefined
              );
            },
            reportError: (error) => reportRenderFeatureGraphError(internals, error),
          },
          {
            owner: internals,
            device: internals.device,
            surfaceSize: { width: surfaceWidth, height: surfaceHeight },
            slots: transientSlots,
            ports: [
              ...standardSurfaceAccesses,
              ...viewAccesses,
              ...targets.flatMap((target) => [
                {
                  resource: target.view,
                  usage:
                    target.kind === 'scene-depth'
                      ? ('depth-stencil-write' as const)
                      : ('color-attachment' as const),
                },
                ...(target.kind === 'scene-depth'
                  ? [{ resource: target.view, usage: 'sampled-read' as const }]
                  : []),
                ...(target.resolveTarget === undefined
                  ? []
                  : [{ resource: target.resolveTarget, usage: 'color-attachment' as const }]),
              ]),
            ],
          },
        );
        if (!projected.ok) return projected;
        return ok(undefined);
      },
      contributeCubeCaptures: (environmentCube) => {
        const reflectionProbes = addReflectionProbeGraphPasses(
          builder,
          {
            work: (cubeCaptureState?.reflectionProbes?.work ?? []).map((work) => ({
              ...work,
              rawCaptureFace: undefined,
            })),
          },
          environmentCube,
        );
        if (!reflectionProbes.ok) return reflectionProbes;
        return cubeCaptureState === undefined
          ? ok(undefined)
          : addTargetCaptureGraphPasses(builder, { ...cubeCaptureState, work: [] });
      },
      hasFeature: (identity) =>
        projectedFeaturePlans.value.some((execution) => execution.featureIdentity === identity),
      hasFeatureWork: (identity, placement) =>
        projectedFeaturePlans.value.some(
          (execution) =>
            execution.featureIdentity === identity &&
            execution.passes.length > 0 &&
            (placement === undefined || (execution.placement ?? 'post') === placement),
        ),
      hasFeatureRasterWork: (identity, placement) =>
        projectedFeaturePlans.value.some(
          (execution) =>
            execution.featureIdentity === identity &&
            execution.passes.some((pass) => pass.graphics !== undefined) &&
            (placement === undefined || (execution.placement ?? 'post') === placement),
        ),
    },
    topology,
  ]);
  if (!built.ok) {
    featureMetrics.buildFailures += 1;
    onRecoveryError?.(built.error);
    internals.errorRegistry.fire(built.error);
    retirePendingStandardOutputGpu(frameState);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return volumeTopologyCandidate ? null : retainLastKnownGood();
  }
  featureMetrics.compileAttempts += 1;
  featureMetrics.buildCpuMs +=
    (typeof performance === 'undefined' ? Date.now() : performance.now()) - buildStarted;
  const changedDependencies = frameGraphChangedDependencies(installed?.topologyKey, key);
  const primaryCause = changedDependencies[0] ?? 'cold';
  featureMetrics.compilePrimaryCauses[primaryCause] =
    (featureMetrics.compilePrimaryCauses[primaryCause] ?? 0) + 1;
  for (const dependency of changedDependencies) {
    featureMetrics.compileChangedDependencies[dependency] =
      (featureMetrics.compileChangedDependencies[dependency] ?? 0) + 1;
  }
  const compileStarted = typeof performance === 'undefined' ? Date.now() : performance.now();
  const compiled = builder.compile({
    device: internals.device,
    surfaceSize: { width: surfaceWidth, height: surfaceHeight },
    reuseResourcesFrom: installed?.graph,
  });
  featureMetrics.compileCpuMs +=
    (typeof performance === 'undefined' ? Date.now() : performance.now()) - compileStarted;
  if (!compiled.ok) {
    featureMetrics.compileFailures += 1;
    onRecoveryError?.(compiled.error);
    internals.errorRegistry.fire(compiled.error);
    retirePendingStandardOutputGpu(frameState);
    if (featureGraphCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'rejected');
    }
    return retainLastKnownGood();
  }
  // Register the generation before publishing it. The owner observes the
  // overlap while the previous graph is still live, even if a queue fence
  // retires that graph before the next public inspect() call.
  trackGraphGeneration(frameState, compiled.value);
  // A second build in the same transaction supersedes only the unsubmitted
  // candidate; rollback must still reach the last accepted projection.
  const superseded = frameState.compiledFrameGraphCandidate;
  frameState.compiledFrameGraphCandidate = {
    graph: compiled.value,
    previous: superseded?.previous ?? {
      installed,
      graphGeneration: frameState.graphGeneration ?? 0,
      compiledGeneration: frameState.compiledFrameGraphGeneration ?? 0,
      lightingSignature: frameState.standardLightingGraphSignature ?? '',
    },
  };
  if (superseded !== undefined) retire(frameState, superseded.graph);
  frameState.barrelDistortionGraphResolution = 'accepted';
  frameState.standardLightingGraphSignature = requestedStandardLightingSignature;
  frameState.compiledFrameGraphGeneration += 1;
  const compiledTargets = compiled.value as CompiledGraphTargetAccess;
  frameState.graphGeneration += 1;
  featureMetrics.compileSuccesses += 1;
  // No new lease means the installed imports remain current, not a second
  // resource transition back to an empty key on the following frame.
  const preparedResourceKey =
    topologyCandidate?.preparedResourceKey ?? installed?.preparedResourceKey;
  const requiresShadowPipelinePreparation =
    rendererRecording && activePipeline === standardPipeline
      ? shadowPipelinePreparationDemand(builder)
      : undefined;
  frameState.compiledFrameGraph = {
    ...(requiresShadowPipelinePreparation === undefined
      ? {}
      : { requiresShadowPipelinePreparation }),
    ...(prepareGpuDrivenPipelines === undefined ? {} : { prepareGpuDrivenPipelines }),
    scenePipelinePreparations: scenePipelinePreparations(builder),
    ...(directionalShadowViewCount === undefined ? {} : { directionalShadowViewCount }),
    graph: compiled.value,
    topologyKey: key,
    ...(preparedResourceKey === undefined ? {} : { preparedResourceKey }),
    targets: {
      getColorTargetDescriptor: (name) => compiledTargets.getColorTargetDescriptor(name),
      getColorTargetView: (name) => compiledTargets.getColorTargetView(name),
      getColorTargetTexture: (name) => compiledTargets.getColorTargetTexture(name),
      graphGeneration: frameState.graphGeneration,
    },
  };
  // View buffer replacement is safe to retire once the compiled graph owns
  // the new imports. Shadow cache publication remains submit-transactional
  // and is committed only by executeCompiledFrameGraph's onSubmitted hook.
  if (gpuDriven?._commitGpuResourceReplacement !== undefined) {
    gpuDriven._commitGpuResourceReplacement();
  } else {
    // Synthetic/internal prepared projections predating the split own no
    // shadow cache; retain their original graph-promotion callback.
    gpuDriven?._commitResourceReplacement();
  }
  const deviceGeneration = internals.deviceScope?.generation;
  if (deviceGeneration !== undefined) {
    graphDeviceGenerations.set(compiled.value, deviceGeneration);
  }
  if (featureGraphCandidate !== undefined && !postProcessAdmission.pending) {
    commitFeatureCandidate(internals, featureGraphCandidate);
  } else if (featureGraphCandidate !== undefined) {
    recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'abandoned');
  }
  frameState.pendingCloudHistoryActive = cloudHistoryDemand;
  // The selected candidate owner retires the previous graph only after submit.
  return compiled.value;
}

/** Shared target captures use the same lighting prelude and scene raster owner as display views. */
export function compileTargetCaptureFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  shadowMapSize: number | undefined,
  state: CubeCaptureGraphState,
  lighting: StandardTopologyInputValue,
  probe?: ReflectionProbeGraphWork,
  terrainReceivers: readonly TerrainShadowReceiver[] = [],
): CompiledRenderGraph<RenderPipelineFrame> {
  const topology = topologyOf(
    internals,
    frameState,
    pipelineState,
    camera,
    false,
    lights,
    internals.canvas.width,
    internals.canvas.height,
    shadowMapSize,
    undefined,
    undefined,
    0,
    state,
    undefined,
    undefined,
    lighting,
    undefined,
    undefined,
    undefined,
    false,
    // Target captures (cube faces, planar mirrors) keep the sorted
    // transparent composition; OIT belongs to the display view camera.
    undefined,
    terrainReceivers,
  );
  if (!topology.ok) throw topology.error;
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const buffers = importStandardClusterBuffers(graph, lighting);
  if (!buffers.ok) throw buffers.error;
  if (buffers.value !== null) {
    const membership = addStandardClusterMembershipPass(graph, lighting, buffers.value);
    if (!membership.ok) throw membership.error;
  }
  const shadows = addTypedShadowPasses(graph, topology.value);
  if (!shadows.ok) throw shadows.error;
  const targets =
    probe === undefined
      ? addTargetCaptureGraphPasses(graph, state, {
          shadows: shadows.value,
          accesses: buffers.value === null ? [] : standardClusterReadAccesses(buffers.value),
        })
      : addReflectionProbeGraphPasses(graph, { work: [probe] }, undefined, shadows.value);
  if (!targets.ok) throw targets.error;
  const compiled = graph.compile({
    device: internals.device,
    surfaceSize: {
      width: internals.canvas.width,
      height: internals.canvas.height,
    },
  });
  if (!compiled.ok) throw compiled.error;
  return compiled.value;
}

export function executeCompiledFrameGraph(
  ...args: Parameters<typeof recordCompiledFrameGraph>
): boolean {
  return submitFrameRecordings([recordCompiledFrameGraph(...args)]);
}

export function* recordCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  frame: RenderPipelineFrame,
  encoder: RhiCommandEncoder,
  runPass?: import('@forgeax/engine-render-graph').RenderGraphPassRunner,
  frameHooks?:
    | {
        readonly afterGraphExecute?: () => Result<void, RhiError>;
        readonly generationFence?: import('../assembly/renderer-frame-transaction').RendererGenerationFence;
        readonly onSubmitted?: () => void;
        readonly onSubmittedWork?: (completed: Promise<void>) => void;
        readonly onAborted?: () => void;
      }
    // Keep the pre-submit-hook shape accepted for internal callers that have
    // not yet migrated to the typed frame hooks object.
    | (() => void),
  readbackLayers?: readonly import('../assembly/render-target-host').RenderTargetLayerWrite[],
  onSubmitted?: (completed: Promise<unknown>) => void,
  timingCapture?: GpuTimingCapture,
): FrameRecording {
  let submittedCompletion: Promise<void> | undefined;
  const legacySubmitCommit = typeof frameHooks === 'function' ? frameHooks : undefined;
  const resolvedFrameHooks = typeof frameHooks === 'function' ? undefined : frameHooks;
  const graph = frameState.compiledFrameGraph?.graph ?? null;
  const rejectTemporalFrame = (): void => {
    if (!frameState.temporalFrameTransaction.inspect().staged) return;
    frameState.temporalFrameTransaction.commit({ accepted: false });
  };
  if (graph === null) {
    timingCapture?.discard();
    discardStandardOutputStates(frameState);
    settleCompiledFrameGraphCandidate(frameState, false);
    rejectTemporalFrame();
    return false;
  }
  const acceptedFeaturePlans = getRenderFeatureGraphState(internals).plans;
  const executionFrame = {
    ...frame,
    featureExecutions: acceptedFeaturePlans
      .map(getRenderFeaturePlanExecutionProjection)
      .filter((execution): execution is RenderFeaturePlanExecution => execution !== undefined),
  };
  const motionBlurExecution = deriveMotionBlurExecutionReceipt(
    internals,
    frameState,
    acceptedFeaturePlans,
  );
  const legacyTimingInstrumentation =
    timingCapture === undefined ? undefined : createTimingInstrumentation(timingCapture);
  internals.observationGraphGeneration = frameState.compiledFrameGraphGeneration;
  const passTimingCapture = internals.gpuPassTimingCapture;
  const graphInstrumentation =
    passTimingCapture === undefined
      ? legacyTimingInstrumentation
      : createPassTimingInstrumentation<RenderPipelineFrame>(
          passTimingCapture,
          internals.gpuPassTimingViewId,
        );
  const deviceScope = internals.deviceScope;
  const graphDeviceGeneration = graphDeviceGenerations.get(graph);
  if (
    graphDeviceGeneration !== undefined &&
    deviceScope !== undefined &&
    graphDeviceGeneration !== deviceScope.generation
  ) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the compiled frame graph belongs to the active device generation',
        hint: 'discard the stale graph and rebuild it from the retained logical frame plan',
        detail: {
          error: {
            code: 'stale-frame-graph-generation',
            message: `graph=${graphDeviceGeneration}; current=${deviceScope.generation}`,
          },
        },
      }),
    );
    settleCompiledFrameGraphCandidate(frameState, false);
    return false;
  }
  const capturedGeneration = deviceScope?.generation;
  const steps: Omit<RendererFrameTransactionSteps<void>, 'submit'> = {
    build: () => ({ ok: true, value: undefined }),
    execute: () => {
      const graphCapture = frameState.graphTargetCapture;
      const replayPassNames = graphCapture?.replayPassNames;
      const unsupportedCaptureKind =
        graphCapture !== undefined &&
        graphCapture.kind !== undefined &&
        graphCapture.kind !== 'target-copy' &&
        graphCapture.kind !== 'pass-replay';
      if (unsupportedCaptureKind || replayPassNames !== undefined) {
        if (graphCapture === undefined) {
          return { ok: false, stage: 'execute' };
        }
        const passNames = graph.inspect().passes.map((pass) => pass.name);
        const passNameCounts = new Map<string, number>();
        for (const passName of passNames) {
          passNameCounts.set(passName, (passNameCounts.get(passName) ?? 0) + 1);
        }
        const passNameSet = new Set(passNames);
        const selectedReplayPassNames = replayPassNames ?? [];
        const requestedPassNames = new Set(selectedReplayPassNames);
        const passReplayCapture = graphCapture.kind === 'pass-replay' ? graphCapture : undefined;
        const onPassEncoded = passReplayCapture?.onPassEncoded;
        const onPrefixEncoded = passReplayCapture?.onPrefixEncoded;
        const depthAttachmentPassName = passReplayCapture?.depthAttachmentPassName;
        const observeAfterPassName = passReplayCapture?.observeAfterPassName;
        let replayValidationFailed = false;
        const duplicatePassName = selectedReplayPassNames.find(
          (passName, index) => selectedReplayPassNames.indexOf(passName) !== index,
        );
        const invalidPassName = selectedReplayPassNames.find(
          (passName) => !passNameSet.has(passName),
        );
        const nonUniquePassName = selectedReplayPassNames.find(
          (passName) => passNameCounts.get(passName) !== 1,
        );
        const replayFailure = (reason: string): void => {
          replayValidationFailed = true;
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected:
                'the requested graph target replay pass selection is valid and executes once',
              hint: 'inspect replayPassNames against the compiled graph pass roster',
              detail: {
                error: {
                  code: 'graph-target-capture-failed',
                  message: JSON.stringify({
                    target: graphCapture.kind === 'pass-replay' ? undefined : graphCapture.name,
                    replayPassNames,
                    availablePassNames: passNames,
                    reason,
                  }),
                },
              },
            }),
          );
        };
        if (unsupportedCaptureKind) {
          replayFailure('capture-kind-unknown');
          return { ok: false, stage: 'execute' };
        }
        if (replayPassNames === undefined) {
          replayFailure('replay-pass-selection-missing');
          return { ok: false, stage: 'execute' };
        }
        if (replayPassNames.length === 0) {
          replayFailure('replay-pass-selection-empty');
          return { ok: false, stage: 'execute' };
        }
        if (duplicatePassName !== undefined) {
          replayFailure(`replay-pass-selection-duplicate:${duplicatePassName}`);
          return { ok: false, stage: 'execute' };
        }
        if (invalidPassName !== undefined) {
          replayFailure(`replay-pass-selection-unknown:${invalidPassName}`);
          return { ok: false, stage: 'execute' };
        }
        if (nonUniquePassName !== undefined) {
          replayFailure(`replay-pass-selection-non-unique:${nonUniquePassName}`);
          return { ok: false, stage: 'execute' };
        }

        if (onPrefixEncoded !== undefined) {
          if (onPassEncoded !== undefined) {
            replayFailure('pass-replay-prefix-callback-conflict');
            return { ok: false, stage: 'execute' };
          }
          if (depthAttachmentPassName === undefined) {
            replayFailure('pass-replay-depth-attachment-name-missing');
            return { ok: false, stage: 'execute' };
          }
          if (observeAfterPassName === undefined) {
            replayFailure('pass-replay-observe-boundary-name-missing');
            return { ok: false, stage: 'execute' };
          }
          const firstNonPrefixPass = selectedReplayPassNames.find(
            (passName, index) => passName !== passNames[index],
          );
          if (
            firstNonPrefixPass !== undefined ||
            selectedReplayPassNames.length > passNames.length
          ) {
            replayFailure('pass-replay-selection-not-prefix');
            return { ok: false, stage: 'execute' };
          }
          if (selectedReplayPassNames.at(-1) !== observeAfterPassName) {
            replayFailure('pass-replay-observe-boundary-not-last');
            return { ok: false, stage: 'execute' };
          }
          const anchorIndex = selectedReplayPassNames.indexOf(depthAttachmentPassName);
          if (anchorIndex < 0 || anchorIndex > selectedReplayPassNames.length - 1) {
            replayFailure('pass-replay-depth-attachment-not-in-prefix');
            return { ok: false, stage: 'execute' };
          }
        }

        let replayTarget:
          | {
              readonly name: string;
              readonly view: TextureView;
              readonly texture: Texture;
              readonly textureIdentity: number;
              readonly graphGeneration: number;
            }
          | undefined;
        if (onPassEncoded !== undefined || onPrefixEncoded !== undefined) {
          const targetName = passReplayCapture?.targetName;
          const graphAccess = frameState.compiledFrameGraph?.targets;
          const targetView =
            targetName === undefined ? undefined : graphAccess?.getColorTargetView(targetName);
          const targetTexture =
            targetName === undefined ? undefined : graphAccess?.getColorTargetTexture(targetName);
          const targetDescriptor =
            targetName === undefined
              ? undefined
              : graphAccess?.getColorTargetDescriptor(targetName);
          if (targetName === undefined) {
            replayFailure('pass-replay-target-name-missing');
            return { ok: false, stage: 'execute' };
          }
          if (graphAccess === undefined || graphAccess === null) {
            replayFailure(`pass-replay-target-missing:${targetName}`);
            return { ok: false, stage: 'execute' };
          }
          if (targetView === undefined || targetTexture === undefined) {
            replayFailure(`pass-replay-target-missing:${targetName}`);
            return { ok: false, stage: 'execute' };
          }
          if (targetDescriptor !== undefined && targetDescriptor.texture !== targetTexture) {
            replayFailure(`pass-replay-target-identity-mismatch:${targetName}`);
            return { ok: false, stage: 'execute' };
          }
          replayTarget = {
            name: targetName,
            view: targetView,
            texture: targetTexture,
            textureIdentity: getTextureIdentity(targetTexture),
            graphGeneration: graphAccess.graphGeneration,
          };
        }

        const executed = graph.execute(executionFrame, runPass, graphInstrumentation);
        if (!executed.ok) {
          passTimingCapture?.abort({ code: executed.error.code });
          internals.errorRegistry.fire(executed.error);
          return { ok: false, stage: 'execute' };
        }
        const replayedPassNames = new Set<string>();
        let prefixCallbackCount = 0;
        let depthAnchorReceipt:
          | {
              readonly pass: { name: string; executionIndex: number };
              readonly view: TextureView;
            }
          | undefined;
        const replayRunPass: import('@forgeax/engine-render-graph').RenderGraphPassRunner = (
          pass,
          encode,
        ) => {
          if (!requestedPassNames.has(pass.name)) return;
          if (replayedPassNames.has(pass.name)) {
            replayFailure(`replay-pass-selection-multiple-hit:${pass.name}`);
            return;
          }
          replayedPassNames.add(pass.name);
          const depthView = (pass as ResolvedDepthPassExecution).resolvedDepthStencilAttachmentView;
          if (onPrefixEncoded !== undefined) {
            if (pass.name === depthAttachmentPassName) {
              if (depthView === undefined) {
                replayFailure(`pass-replay-depth-attachment-missing:${pass.name}`);
                return;
              }
              const target = replayTarget;
              if (target === undefined || depthView !== target.view) {
                replayFailure(`pass-replay-attachment-target-mismatch:${pass.name}`);
                return;
              }
              if (depthAnchorReceipt !== undefined) {
                replayFailure(`pass-replay-depth-attachment-multiple-hit:${pass.name}`);
                return;
              }
              depthAnchorReceipt = {
                pass: { name: pass.name, executionIndex: pass.executionIndex },
                view: depthView,
              };
            }
            let encoded = false;
            const encodePrefix = () => {
              if (encoded) {
                replayFailure(`pass-replay-encode-multiple-hit:${pass.name}`);
                return;
              }
              encode();
              encoded = true;
              if (replayValidationFailed || pass.name !== observeAfterPassName) return;
              const target = replayTarget;
              const anchor = depthAnchorReceipt;
              if (target === undefined || anchor === undefined) {
                replayFailure('pass-replay-depth-attachment-anchor-missing-at-boundary');
                return;
              }
              const receipt: GraphTargetPassReplayPrefixReceipt = {
                passName: pass.name,
                executionIndex: pass.executionIndex,
                resolvedDepthStencilAttachmentView: anchor.view,
                graphGeneration: target.graphGeneration,
                targetName: target.name,
                targetView: target.view,
                targetTexture: target.texture,
                targetTextureIdentity: target.textureIdentity,
                replayPassNames: [...selectedReplayPassNames],
                depthAttachmentPassName: anchor.pass.name,
                observeAfterPassName: pass.name,
                depthAttachmentExecutionIndex: anchor.pass.executionIndex,
              };
              try {
                onPrefixEncoded(receipt);
                prefixCallbackCount += 1;
              } catch (cause) {
                replayFailure(
                  `pass-replay-prefix-callback-threw:${pass.name}:${cause instanceof Error ? cause.message : String(cause)}`,
                );
              }
            };
            if (runPass === undefined) encodePrefix();
            else runPass(pass, encodePrefix);
            if (!encoded && !replayValidationFailed) {
              replayFailure(`pass-replay-encode-not-called:${pass.name}`);
            }
            return;
          }
          if (onPassEncoded === undefined) {
            if (runPass === undefined) encode();
            else runPass(pass, encode);
            return;
          }
          const target = replayTarget;
          if (target === undefined || depthView === undefined) {
            replayFailure(`pass-replay-depth-attachment-missing:${pass.name}`);
            return;
          }
          if (depthView !== target.view) {
            replayFailure(`pass-replay-attachment-target-mismatch:${pass.name}`);
            return;
          }
          let encoded = false;
          const encodeAndObserve = () => {
            if (encoded) {
              replayFailure(`pass-replay-encode-multiple-hit:${pass.name}`);
              return;
            }
            encode();
            encoded = true;
            if (replayValidationFailed) return;
            const receipt: GraphTargetPassReplayReceipt = {
              passName: pass.name,
              executionIndex: pass.executionIndex,
              resolvedDepthStencilAttachmentView: depthView,
              graphGeneration: target.graphGeneration,
              targetName: target.name,
              targetView: target.view,
              targetTexture: target.texture,
              targetTextureIdentity: target.textureIdentity,
            };
            try {
              onPassEncoded(receipt);
            } catch (cause) {
              replayFailure(
                `pass-replay-callback-threw:${pass.name}:${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          };
          if (runPass === undefined) encodeAndObserve();
          else runPass(pass, encodeAndObserve);
          if (!encoded && !replayValidationFailed) {
            replayFailure(`pass-replay-encode-not-called:${pass.name}`);
          }
        };
        const replayed = graph.execute(executionFrame, replayRunPass);
        if (!replayed.ok) {
          internals.errorRegistry.fire(replayed.error);
          return { ok: false, stage: 'execute' };
        }
        if (replayValidationFailed) return { ok: false, stage: 'execute' };
        if (replayedPassNames.size !== requestedPassNames.size) {
          replayFailure('replay-pass-selection-zero-hit');
          return { ok: false, stage: 'execute' };
        }
        if (onPrefixEncoded !== undefined && prefixCallbackCount !== 1) {
          replayFailure('pass-replay-prefix-callback-count-invalid');
          return { ok: false, stage: 'execute' };
        }
      } else {
        const executed = graph.execute(executionFrame, runPass, graphInstrumentation);
        if (!executed.ok) {
          passTimingCapture?.abort({ code: executed.error.code });
          internals.errorRegistry.fire(executed.error);
          return { ok: false, stage: 'execute' };
        }
      }
      const afterGraphExecute = resolvedFrameHooks?.afterGraphExecute;
      internals.framePassNames?.push(...graph.inspect().passes.map((pass) => pass.name));
      if (afterGraphExecute !== undefined) {
        const recorded = afterGraphExecute();
        if (!recorded.ok) {
          internals.errorRegistry.fire(recorded.error);
          return { ok: false, stage: 'execute' };
        }
      }
      return { ok: true, value: undefined };
    },
    finish: () => {
      const graphCapture = frameState.graphTargetCapture;
      frameState.graphTargetCapture = undefined;
      if (graphCapture !== undefined && graphCapture.kind !== 'pass-replay') {
        const graphAccess = frameState.compiledFrameGraph?.targets;
        const graphTexture = graphAccess?.getColorTargetTexture(graphCapture.name);
        const descriptor = graphAccess?.getColorTargetDescriptor(graphCapture.name);
        const frameId = frameState.frameNumber;
        const captureFailure = (message: string): void => {
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected:
                'the requested graph target is present in the current graph with a matching copy-readable descriptor',
              hint: 'inspect the target name, graph generation/frame, texture identity, format, extent, and COPY_SRC usage',
              detail: {
                error: {
                  code: 'graph-target-capture-failed',
                  message,
                },
              },
            }),
          );
        };
        if (
          graphAccess === undefined ||
          graphAccess === null ||
          graphTexture === undefined ||
          descriptor === undefined
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess?.graphGeneration,
              frameId,
              textureIdentity:
                graphTexture === undefined ? undefined : getTextureIdentity(graphTexture),
              reason: 'target-not-present-in-current-graph',
            }),
          );
        } else if (
          descriptor.size.width !== graphCapture.width ||
          descriptor.size.height !== graphCapture.height
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              expectedFormat: graphCapture.expected.format,
              actualFormat: descriptor.format,
              expectedExtent: { width: graphCapture.width, height: graphCapture.height },
              actualExtent: descriptor.size,
              reason: 'extent-mismatch',
            }),
          );
        } else if ((descriptor.usage & GPU_TEXTURE_USAGE_COPY_SRC) === 0) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              format: descriptor.format,
              extent: descriptor.size,
              usage: descriptor.usage,
              reason: 'copy-src-usage-missing',
            }),
          );
        } else if (
          descriptor.format !== graphCapture.expected.format ||
          descriptor.size.width !== graphCapture.expected.width ||
          descriptor.size.height !== graphCapture.expected.height ||
          (descriptor.usage & graphCapture.expected.usage) !== graphCapture.expected.usage
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              expected: graphCapture.expected,
              actual: {
                format: descriptor.format,
                width: descriptor.size.width,
                height: descriptor.size.height,
                usage: descriptor.usage,
              },
              reason: 'descriptor-mismatch',
            }),
          );
        } else if (
          graphCapture.expected.identity !== undefined &&
          (graphAccess.graphGeneration !== graphCapture.expected.identity.graphGeneration ||
            graphCapture.expected.identity.frameId !== frameId ||
            graphCapture.expected.identity.textureIdentity !== getTextureIdentity(graphTexture))
        ) {
          captureFailure(
            JSON.stringify({
              target: graphCapture.name,
              graphGeneration: graphAccess.graphGeneration,
              frameId,
              textureIdentity: getTextureIdentity(graphTexture),
              expectedIdentity: graphCapture.expected.identity,
              reason: 'identity-mismatch',
            }),
          );
        } else {
          encoder.copyTextureToBuffer(
            { texture: graphTexture as never },
            {
              buffer: graphCapture.buffer as never,
              bytesPerRow: graphCapture.bytesPerRow,
              rowsPerImage: graphCapture.height,
            },
            {
              width: graphCapture.width,
              height: graphCapture.height,
              depthOrArrayLayers: 1,
            },
          );
        }
      }
      const fallbackReadback = frameState.reflectionFallbackReadback;
      frameState.reflectionFallbackReadback = undefined;
      if (fallbackReadback !== undefined) {
        const graphAccess = frameState.compiledFrameGraph?.targets;
        const graphTexture = graphAccess?.getColorTargetTexture(fallbackReadback.name);
        const descriptor = graphAccess?.getColorTargetDescriptor(fallbackReadback.name);
        const matches =
          graphAccess !== undefined &&
          graphAccess !== null &&
          graphTexture !== undefined &&
          descriptor !== undefined &&
          descriptor.format === fallbackReadback.expected.format &&
          descriptor.size.width === fallbackReadback.expected.width &&
          descriptor.size.height === fallbackReadback.expected.height &&
          descriptor.sample === 1 &&
          (descriptor.usage & fallbackReadback.expected.usage) ===
            fallbackReadback.expected.usage &&
          graphAccess.graphGeneration === fallbackReadback.expected.graphGeneration &&
          frameState.frameNumber === fallbackReadback.expected.frameId &&
          getTextureIdentity(graphTexture) === fallbackReadback.expected.textureIdentity;
        if (matches && graphTexture !== undefined) {
          encoder.copyTextureToBuffer(
            { texture: graphTexture },
            {
              buffer: fallbackReadback.buffer,
              bytesPerRow: fallbackReadback.bytesPerRow,
              rowsPerImage: fallbackReadback.height,
            },
            {
              width: fallbackReadback.width,
              height: fallbackReadback.height,
              depthOrArrayLayers: 1,
            },
          );
          fallbackReadback.encoded = true;
        }
      }
      internals.encodeRenderTargetReadbacks?.(encoder, readbackLayers);
      const stagedGpuState = frameState.temporalGpuState;
      if (stagedGpuState !== undefined && !hasPendingTemporalGpuSubmit(stagedGpuState)) {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'an admitted temporal producer stages a history write before submit',
            hint: 'retry the frame after the TAA or CloudLayer history pass has encoded successfully',
          }),
        );
        return { ok: false, stage: 'finish' };
      }
      const resolved = timingCapture?.resolve(encoder);
      if (resolved !== undefined && !resolved.ok) {
        timingCapture?.discard();
        return { ok: false, stage: 'finish' };
      }
      return { ok: true, value: undefined };
    },
    ...(capturedGeneration === undefined && resolvedFrameHooks?.generationFence === undefined
      ? {}
      : {
          generationFence: {
            capturedGeneration: 0,
            // Read the owner at submit time. Recovery publishes a replacement
            // scope synchronously between finish and submit; retaining the
            // entry scope here would make that race invisible to the fence.
            currentGeneration: () => {
              const content = resolvedFrameHooks?.generationFence;
              return (capturedGeneration === undefined ||
                internals.deviceScope?.generation === capturedGeneration) &&
                (content === undefined ||
                  content.currentGeneration() === content.capturedGeneration)
                ? 0
                : -1;
            },
          },
        }),
    commit: () => {
      timingCapture?.markSubmitted();
      resolvedFrameHooks?.onSubmitted?.();
      legacySubmitCommit?.();
      if (motionBlurExecution === undefined) {
        delete frameState.motionBlurExecution;
      } else {
        frameState.motionBlurExecution = motionBlurExecution;
      }
      if (frameState.temporalFrameTransaction.inspect().staged) {
        const temporal = frameState.temporalFrameTransaction.commit({ accepted: true });
        if (temporal.ok) {
          frameState.temporalFrame = temporal.value;
        } else {
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'the staged temporal frame to commit after queue submission',
              hint: 'discard the temporal candidate and retry the next frame',
              detail: { error: temporal.error },
            }),
          );
        }
      }
      if (frameState.bloomFrameReceipts !== undefined) {
        internals
          .getPipelineState()
          ?.perPassResources.commitBloomFrameReceipts?.(frameState.bloomFrameReceipts);
        frameState.bloomFrameReceipts = undefined;
      }
      commitStandardOutputSubmission(frameState, internals.device.queue);
      const onTemporalRetireFailure = (cause: unknown): void => {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'submitted temporal resources remain valid until queue completion',
            hint: `temporal resource retirement failed: ${String(cause)}`,
          }),
        );
      };
      commitStagedTemporalGpuState(frameState, internals.device.queue, {
        onReplaced: () => internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve'),
        onRetireFailure: onTemporalRetireFailure,
      });
      const stagedTemporalCommit = frameState.pendingTemporalCommit ?? { kind: 'none' as const };
      const stagedCloudHistoryActive = frameState.pendingCloudHistoryActive;
      if (stagedCloudHistoryActive !== undefined) {
        frameState.cloudHistoryActive = stagedCloudHistoryActive;
        delete frameState.pendingCloudHistoryActive;
      }
      if (stagedTemporalCommit.kind !== 'none') {
        frameState.lastSuccessfulTemporalView = stagedTemporalCommit.view;
      }
      if (stagedTemporalCommit.kind === 'taa') {
        frameState.successfulTemporalFrameIndex = stagedTemporalCommit.view.temporalFrameIndex + 1;
      } else if (stagedTemporalCommit.kind === 'off') {
        frameState.successfulTemporalFrameIndex = 0;
      }
      if (stagedTemporalCommit.kind === 'off' && frameState.cloudHistoryActive !== true) {
        internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
        // Retire frame-sized resources, not the device-owned prewarmed
        // shader. The next TAA frame must not start an async cold compile.
        retireActiveTemporalGpuState(frameState, internals.device.queue, onTemporalRetireFailure);
      }
      frameState.pendingTemporalCommit = { kind: 'none' };
      if (frameState.environmentGeneration !== undefined) {
        frameState.environmentLifecycle?.publish(frameState.environmentGeneration);
        frameState.environmentGeneration = undefined;
      }
      settleAtmospherePublish(frameState, true);
      if (submittedCompletion !== undefined) onSubmitted?.(submittedCompletion);
      settleCompiledFrameGraphCandidate(frameState, true);
    },
    abort: (failure) => {
      settleAtmospherePublish(frameState, false);
      resolvedFrameHooks?.onAborted?.();
      passTimingCapture?.abort({ code: failure.stage });
      timingCapture?.discard();
      frameState.bloomFrameReceipts = undefined;
      discardStandardOutputStates(frameState);
      retirePendingStandardOutputGpu(frameState);
      if (frameState.environmentGeneration !== undefined) {
        frameState.environmentLifecycle?.recordStageFailure(
          failure.stage,
          frameState.environmentGeneration,
        );
      }
      abortStagedTemporalGpuState(frameState);
      delete frameState.pendingCloudHistoryActive;
      frameState.pendingTemporalCommit = { kind: 'none' };
      if (frameState.environmentGeneration !== undefined) {
        frameState.environmentLifecycle?.discard(frameState.environmentGeneration);
        frameState.environmentGeneration = undefined;
      }
      settleCompiledFrameGraphCandidate(frameState, false);
    },
  };
  const transaction = yield* recordFrameTransaction(steps, {
    encoder,
    device: internals.device,
    beforeSubmit: internals.beforeSubmit,
    ...(onSubmitted === undefined && resolvedFrameHooks?.onSubmittedWork === undefined
      ? {}
      : {
          onSubmittedWork: (done: Promise<void>) => {
            submittedCompletion = done;
            resolvedFrameHooks?.onSubmittedWork?.(done);
          },
        }),
    reportError: (error) => internals.errorRegistry.fire(error),
  });
  // The callbacks above settle the normal transaction path. Keep this guard
  // for synthetic callers and any future early transaction result that does
  // not enter a callback.
  settleCompiledFrameGraphCandidate(frameState, transaction.ok);
  if (!transaction.ok) rejectTemporalFrame();
  return transaction.ok;
}

function createTimingInstrumentation(
  capture: GpuTimingCapture,
): RenderGraphPassInstrumentation<RenderPipelineFrame> {
  return {
    begin: (pass): RenderGraphPassInstrumentationScope | undefined => {
      // WebGPU has no portable timestamp boundary for a copy pass. Do not
      // pretend a command-encoder marker exists; frame timing remains valid
      // when at least one raster/compute pass is present.
      if (pass.kind === 'copy' || pass.kind === 'subgraph') return undefined;
      const writes = capture.beginPass(pass.name, pass.kind, pass.executionIndex);
      if (writes === undefined) return undefined;
      if (pass.kind === 'raster') {
        return {
          renderPassDescriptor: (descriptor) => {
            if (descriptor.timestampWrites !== undefined) {
              capture.markOwnerConflict(pass.name);
              return descriptor;
            }
            return { ...descriptor, timestampWrites: writes };
          },
        };
      }
      return {
        computePassDescriptor: (descriptor) => {
          if (descriptor.timestampWrites !== undefined) {
            capture.markOwnerConflict(pass.name);
            return descriptor;
          }
          return { ...descriptor, timestampWrites: writes };
        },
      };
    },
  };
}
