import {
  type FrameRecording,
  recordFrameTransaction,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import type { RendererFrameTransactionSteps } from '../assembly/renderer-frame-transaction';
import { projectedDecalTopology } from '../decals/graph';
import { addAtmosphereBackground } from '../environment/background';
import { recordAtmosphereCaptureBackground } from '../environment/capture';
import { atmosphereTextures } from '../environment/luts';
import { settleAtmospherePublish } from '../environment/storage';
import { isOutlinePostProcess } from '../features/outline/shaders';
import { pmremExtent } from '../ibl/pmrem';
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
import { ShadowDepthLayers } from '../shadow-depth-layers';
import {
  type TerrainShadowReceiver,
  terrainShadowLayoutMatches,
  terrainShadowTopology,
} from '../terrain/shadow-family';
import { addTypedShadowPasses, shadowPipelinePreparationDemand } from '../typed-shadow-passes';
import { resolveSpotShadowMapSize } from './frame-targets';
import { flushMeshDrawUploads } from './mesh-ssbo';
import { addReflectionProbePmremPasses } from './reflection-probe-pmrem';
import { scenePipelinePreparations } from './scene-pipeline-preparation';
import { addTargetCaptureGraphPasses, type CubeCaptureGraphState } from './target-capture-graph';
import { resolveTargetBindings, targetResolver } from './typed-frame-graph-bindings';

export type { CubeCaptureGraphState, CubeCaptureGraphWork } from './target-capture-graph';

import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import {
  type CompiledRenderGraph,
  RenderGraphBuilder,
  type RenderGraphError,
  type RenderGraphGenerationAllocationEntry,
  type RenderGraphGenerationAllocationInspection,
  type RenderGraphPassInstrumentation,
  type RenderGraphPassInstrumentationScope,
  type RenderGraphResourceAllocationInspection,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
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
import {
  inspectTransientViewGraphs,
  projectTransientViewPlans,
  selectTransientViewPlans,
} from '../features/transient-view-graph';
import {
  buildFullscreenPostProcessPass,
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
import type { StandardLutGraphProjection } from '../pipeline/standard-output/lut-gpu';
import {
  commitStandardOutputSubmission,
  discardStandardOutputStates,
  retirePendingStandardOutputGpu,
} from '../pipeline/standard-output/resources';
import { buildStandard, standardPipeline } from '../pipeline/standard-pipeline';
import { resolveVolumetricFogProfile, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import { type ProbeBackgroundResources, recordProbeBackground } from '../reflection/background';
import type { CameraSnapshot, RendererError } from '../render-contract';
import type {
  RenderPipelineBuildContext,
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
  TEMPORAL_HISTORY_FORMATS,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import { createTargetCoverageAttachment } from '../temporal/target-coverage-attachment';
import type { TransmissionDemand } from '../transmission/projection';
import { hasVolumetricFogCapability } from '../volume/capability';
import { deriveVolumetricFogExtent, deriveVolumetricFogResolvedExtent } from '../volume/resources';
import {
  frameGraphChangedDependencies,
  frameGraphChangedValues,
  frameGraphTopologyIdentity,
} from './frame-graph-identity';
import { buildPerFrameBindGroups } from './frame-lighting';
import {
  type GraphTargetPassReplayPrefixReceipt,
  type GraphTargetPassReplayReceipt,
  getTextureIdentity,
  type InstalledFrameGraph,
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
import { resolveSurfaceProfile } from './render-context';
import { installScenePasses, registerScenePass, scenePassContext } from './scene-pass-work';

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
  const resolveSurface = (frame: RenderPipelineFrame) => {
    const internal = frame as import('./render-context')._InternalRenderPipelineContext;
    const state = getTemporalGpuState(
      internal.frameState,
      internal.runtime.device,
      internal.runtime.deviceScope,
      frame.targetW,
      frame.targetH,
    );
    const index = role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state);
    return state[kind][index];
  };
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
    (frame) => resolveSurface(frame).texture,
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => resolveSurface(frame).view,
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
  const resolveSurface = (frame: RenderPipelineFrame) => {
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
    return cloudHistorySurface(state, kind, index);
  };
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
    (frame) => resolveSurface(frame).texture,
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => resolveSurface(frame).view,
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
  const resolveSurface = (frame: RenderPipelineFrame) => {
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
    return owner.resources.slots[slot];
  };
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
    (frame) => (surface ? resolveSurface(frame).surfaceTexture : resolveSurface(frame).texture),
  );
  if (!texture.ok) throw texture.error;
  const view = graph.importView(
    texture.value,
    { label: `${label}.view`, dimension: '2d' },
    (frame) => (surface ? resolveSurface(frame).surfaceView : resolveSurface(frame).view),
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
  readonly filteredView: TextureView;
  readonly filterScratchTexture: Texture;
  readonly filterScratchView: TextureView;
  readonly outputFormat: TextureFormat;
  readonly sampler: Sampler;
  readonly filterPipeline: RenderPipeline;
  readonly filterGroup0: readonly BindGroup[] | undefined;
  readonly filterGroup1: BindGroup;
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
        ['prefilter', 336, 256, 1, 1, 0x17],
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
        size: pmremExtent(work.filteredSize),
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        usage: 0x10 | 0x04 | 0x01,
      },
      () => work.filteredTexture,
    );
    if (!filtered.ok) return filtered;
    const filteredAtlas = builder.importView(
      filtered.value,
      {
        label: `reflection-probe.${work.probeIndex}.filtered-atlas`,
        dimension: '2d',
      },
      () => work.filteredView,
    );
    if (!filteredAtlas.ok) return filteredAtlas;
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
      const request = registerScenePass(builder, {
        selector: undefined,
        excludeSelector: undefined,
        recordMode: undefined,
        passKind: 'forward',
        gpu: false,
        gpuFilter: undefined,
        late: false,
        capture: true,
        camera: () => work.faceCamera,
      });
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
          const internal = scenePassContext(frame as _InternalRenderPipelineContext, request);
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
          delete captureContext.gpuDrivenSelection;
          delete captureContext.gpuDrivenStandardPbrFrameResources;
          encodeMainPass(
            {
              ...captureContext,
              dispatch: internal.dispatch,
              foldDispatchPlan: null,
              camera: work.faceCamera,
              viewBindGroupDynamicOffset: work.viewBindGroupDynamicOffset,
              transparentColorFormat: work.outputFormat as GPUTextureFormat,
              msaaActive: false,
              splitLdrSprite: false,
            },
            pass,
            undefined,
            {
              colorFormats: [work.outputFormat as GPUTextureFormat],
              passKind: 'forward',
            },
          );
        },
      });
      if (!added.ok) return added;
    }
    const filteredStep = addReflectionProbePmremPasses(
      builder,
      work,
      rawCube.value,
      filtered.value,
      filteredAtlas.value,
    );
    if (!filteredStep.ok) return filteredStep;
    accesses.push({ resource: filteredAtlas.value, usage: 'sampled-read' });
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
  unsubmittedGraphReuses: number;
  recentCompileChanges: {
    readonly frame: number;
    readonly changes: ReturnType<typeof frameGraphChangedValues>;
  }[];
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
    recentCompileChanges: [],
    unsubmittedGraphReuses: 0,
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
    recentCompileChanges: Object.freeze([...metrics.recentCompileChanges]),
    unsubmittedGraphReuses: metrics.unsubmittedGraphReuses,
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
      : {
          mapSize: shadowMapSize,
          cascadeCount,
          ...(lights.directionalCsmConfig?.staticShadowCache === false
            ? { staticLayer: false as const }
            : {}),
        },
    lights.directionalShadowQuality?.kind === 'pcss' ? [] : terrainReceivers,
    internals.device.limits.maxTextureArrayLayers,
  );
}

function featureFullscreenEffects(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate | undefined,
): RenderFeatureGraphCandidate['fullscreenEffects'] {
  return candidate?.fullscreenEffects ?? getRenderFeatureGraphState(internals).fullscreenEffects;
}

function surfaceProfileOf(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
): ReturnType<typeof resolveSurfaceProfile> {
  const storage = pipelineState.format;
  const internal = internals.device as unknown as { readonly surfaceViewFormats?: boolean };
  return resolveSurfaceProfile(storage, pipelineState.colorAttachmentFormat, {
    surfaceViewFormats:
      internal.surfaceViewFormats ?? internals.device.caps.backendKind !== 'wgpu-webgl2',
    rawAttachment: storage === 'rgba8unorm' || storage === 'bgra8unorm',
    floatRenderAttachment: internals.device.caps.rgba16floatRenderable,
  });
}

/** Installed pipeline config with the feature-declared post effects (outline excluded) appended. */
function featurePostEffectConfig(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
): RenderPipelineTopology['config'] {
  const featurePostEffects = (
    featureGraphCandidate?.postProcessIdentities ??
    getRenderFeatureGraphState(internals).postProcessIdentities
  ).filter((identity) => !isOutlinePostProcess(identity));
  const installed = frameState.installedPipelineConfig;
  if (featurePostEffects.length === 0) return installed;
  return {
    ...(installed ?? {}),
    postEffects: [...new Set([...(installed?.postEffects ?? []), ...featurePostEffects])],
  };
}

function preTemporalEffectsOf(
  config: RenderPipelineTopology['config'],
  fullscreenEffects: RenderFeatureGraphCandidate['fullscreenEffects'],
): readonly string[] {
  return (config?.postEffects ?? []).filter(
    (identity) => fullscreenEffects.get(identity)?.stage === 'before-temporal',
  );
}

/** Whether the light the volumetric fog selected is still present in this frame. */
function hasSelectedVolumeLight(
  lights: ExtractedLights,
  volumetricFog: ExtractedVolumetricFog | undefined,
): boolean {
  switch (volumetricFog?.lightKind) {
    case undefined:
      return lights.directional !== undefined;
    case 'spot':
      return lights.spot.some((light) => light.entity === volumetricFog.lightEntity);
    case 'point':
      return lights.point.some((light) => light.entity === volumetricFog.lightEntity);
    case 'directional':
      return (
        lights.directional !== undefined && lights.directional.entity === volumetricFog.lightEntity
      );
    default:
      return false;
  }
}

function cameraTopologyOf(
  camera: CameraSnapshot,
  clearOnly: boolean,
): RenderPipelineTopology['camera'] {
  const depthOfField = depthOfFieldTopology(camera.depthOfField);
  return {
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
  };
}

function outputTopologyOf(
  camera: CameraSnapshot,
  frameState: RenderFrameState,
  clearOnly: boolean,
): NonNullable<RenderPipelineTopology['output']> {
  const output = camera.output;
  const preparedLut =
    frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
  const autoExposureResources =
    frameState.pendingAutoExposureGpuResources ?? frameState.autoExposureGpuResources;
  return {
    autoExposure:
      !clearOnly && output?.exposure.kind === 'auto' && autoExposureResources !== undefined,
    whiteBalance:
      !clearOnly && output !== undefined && (output.temperature !== 6504 || output.tint !== 0),
    temperature: output?.temperature ?? 6504,
    tint: output?.tint ?? 0,
    colorLut: !clearOnly && (output?.colorLutStrength ?? 0) > 0 && preparedLut !== undefined,
    colorLutStrength: output?.colorLutStrength ?? 0,
    ...(preparedLut === undefined
      ? {}
      : { lutSourceKey: preparedLut.sourceKey, lutSize: preparedLut.size }),
  };
}

function isVarianceSpotShadow(light: ExtractedLights['spot'][number]): boolean {
  return light.shadowFilter === 8 && light.shadowAtlasTile >= 0;
}

function shadowTopologyOf(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
  directional: RenderPipelineTopology['shadow']['directional'],
): RenderPipelineTopology['shadow'] {
  const directionalVariance = lights.directionalCsmConfig?.shadowFilter === 8;
  return {
    directional,
    ...(directionalVariance || lights.spot.some(isVarianceSpotShadow)
      ? {
          variance: {
            directional: directionalVariance,
            spots: lights.spot.filter(isVarianceSpotShadow).map((light) => light.shadowAtlasTile),
          },
        }
      : {}),
    spotMapSize: resolveSpotShadowMapSize(internals, lights) ?? 1024,
    pointCount: Math.min(SHADOW_ATLAS_DEFAULT_LAYERS, lights.pointShadow.length),
    pointFaceSize: lights.pointShadow[0]?.mapSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE,
    spotCount: Math.min(
      4,
      lights.spot.filter((light) => light.shadowAtlasTile >= 0 && light.lightViewProj !== undefined)
        .length,
    ),
  };
}

function volumetricFogTopologyOf(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
  volumetricFog: ExtractedVolumetricFog | undefined,
  width: number,
  height: number,
): NonNullable<RenderPipelineTopology['volumetricFog']> {
  const densityAsset = volumetricFog?.densityAsset;
  if (
    volumetricFog?.status !== 'available' ||
    densityAsset?.shape.viewDimension !== '3d' ||
    !hasSelectedVolumeLight(lights, volumetricFog) ||
    !hasVolumetricFogCapability(internals.device.caps, internals.volumetricFogShaders)
  ) {
    return { enabled: false };
  }
  const volumeProfile = resolveVolumetricFogProfile(internals.standardProfile ?? {});
  const additional = volumetricFog.additional ?? [];
  return {
    enabled: true,
    format: densityAsset.format,
    additional: additional.flatMap((member) =>
      member.densityAsset?.shape.viewDimension === '3d'
        ? [{ format: member.densityAsset.format, extent: member.densityAsset.shape.extent }]
        : [],
    ),
    extent: {
      width: densityAsset.shape.extent.width,
      height: densityAsset.shape.extent.height,
      depth: densityAsset.shape.extent.depth,
    },
    froxelExtent: deriveVolumetricFogExtent(
      { width, height },
      volumeProfile.depth * (1 + additional.length),
      volumeProfile.tileSize,
    ),
    resolvedExtent: deriveVolumetricFogResolvedExtent({ width, height }, volumeProfile.tileSize),
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
}

function featureTopologySignatureOf(
  frameState: RenderFrameState,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  featurePlanRevision: number | string,
  fullscreenEffects: RenderFeatureGraphCandidate['fullscreenEffects'],
  cubeCaptureState: CubeCaptureGraphState | undefined,
): string {
  return JSON.stringify({
    planRevision: featurePlanRevision,
    fullscreenEffects: [...fullscreenEffects].map(
      ([id, entry]) => [id, postProcessShaderEntrySignature(entry)] as const,
    ),
    preparedResourceKey:
      featureGraphCandidate?.preparedResourceKey ??
      frameState.compiledFrameGraph?.preparedResourceKey ??
      '',
    cubeCaptureSlots: cubeCaptureState?.work.length ?? 0,
  });
}

function gpuDrivenTopologySignatureOf(
  gpuDriven: PreparedGpuDrivenFrame | undefined,
  stockRecording: boolean,
): string {
  if (gpuDriven === undefined) return '';
  return stockRecording
    ? (gpuDriven._recordingTopologySignature ?? gpuDriven.topologySignature)
    : gpuDriven.topologySignature;
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
  const surfaceProfile = surfaceProfileOf(internals, pipelineState);
  if (!surfaceProfile.ok) return surfaceProfile;
  const fullscreenEffects = featureFullscreenEffects(internals, featureGraphCandidate);
  const config = featurePostEffectConfig(internals, frameState, featureGraphCandidate);
  return ok({
    pipelineId: STANDARD_PIPELINE_ID,
    ...(subsurface === undefined ? {} : { subsurface }),
    projectedDecals: projectedDecalTopology(clearOnly ? [] : (camera.projectedDecals ?? [])),
    standardProfile: frameState.cameraStandardProfile ?? internals.standardProfile,
    config,
    preTemporalEffects: preTemporalEffectsOf(config, fullscreenEffects),
    clearOnly,
    reflectionFallback: { enabled: frameState.reflectionFallbackDemand === true },
    ssr,
    ...(renderExtent === undefined ? {} : { extent: renderExtent }),
    analyticFog: !clearOnly && analyticFog,
    surface: {
      width,
      height,
      storageFormat: pipelineState.format as TextureFormat,
      viewFormat: surfaceProfile.value.viewFormat as TextureFormat,
      profile: surfaceProfile.value,
    },
    camera: cameraTopologyOf(camera, clearOnly),
    atmosphere: !clearOnly && frameState.environmentFrame?.source.kind === 'atmosphere',
    output: outputTopologyOf(camera, frameState, clearOnly),
    temporal: {
      taa: camera.antialias === 'taa',
      motionBlur: isMotionBlurTemporalDemand(camera.motionBlur),
    },
    shadow: shadowTopologyOf(internals, lights, directional.value),
    volumetricFog: volumetricFogTopologyOf(internals, lights, volumetricFog, width, height),
    lane: {
      compute: internals.device.caps.compute,
      storageBuffer: internals.device.caps.storageBuffer,
      multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
      maxColorAttachments: internals.device.caps.maxColorAttachments,
      primitiveIndex: internals.device.features.has('primitive-index'),
      maxColorAttachmentBytesPerSample: internals.device.limits.maxColorAttachmentBytesPerSample,
    },
    featureTopologySignature: featureTopologySignatureOf(
      frameState,
      featureGraphCandidate,
      featurePlanRevision,
      fullscreenEffects,
      cubeCaptureState,
    ),
    gpuDrivenTopologySignature: gpuDrivenTopologySignatureOf(gpuDriven, stockRecording),
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
  /** The frame stopped only because pipeline preparation was still pending. */
  awaitingPreparation = false,
): void {
  const candidate = frameState.compiledFrameGraphCandidate;
  if (candidate === undefined) return;
  const previous = candidate.previous;
  frameState.compiledFrameGraphCandidate = undefined;
  if (submitted) {
    const previousGraph = previous.installed?.graph;
    if (previousGraph !== undefined && previousGraph !== candidate.graph)
      retire(frameState, previousGraph);
    // A stashed graph may alias resources of the graph it was compiled
    // against; once another graph is accepted it can never be promoted.
    const stashed = frameState.unsubmittedCompiledFrameGraph;
    frameState.unsubmittedCompiledFrameGraph = undefined;
    if (stashed !== undefined && stashed.installed.graph !== candidate.graph)
      retire(frameState, stashed.installed.graph);
    return;
  }
  const candidateInstalled = frameState.compiledFrameGraph;
  if (candidate.graph !== previous.installed?.graph) {
    // Keep one compiled-but-unsubmitted graph for its topology key. A frame
    // that only waited for pipeline preparation must not recompile the same
    // graph on every following frame.
    const stashed = frameState.unsubmittedCompiledFrameGraph;
    if (stashed !== undefined && stashed.installed.graph !== candidate.graph)
      retire(frameState, stashed.installed.graph);
    frameState.unsubmittedCompiledFrameGraph =
      awaitingPreparation &&
      candidateInstalled !== null &&
      candidateInstalled.graph === candidate.graph
        ? {
            installed: candidateInstalled,
            deviceGeneration: graphDeviceGenerations.get(candidate.graph),
          }
        : undefined;
    if (frameState.unsubmittedCompiledFrameGraph === undefined) retire(frameState, candidate.graph);
  }
  frameState.compiledFrameGraph = previous.installed;
  frameState.graphGeneration = previous.graphGeneration;
  frameState.compiledFrameGraphGeneration = previous.compiledGeneration;
  frameState.standardLightingGraphSignature = previous.lightingSignature;
  frameState.barrelDistortionGraphResolution =
    previous.installed === null ? 'accepted' : 'retained';
}

/**
 * A candidate flag only describes a possible topology replacement. When the
 * derived key is unchanged there is no replacement to stage: reuse the
 * accepted graph so dynamic volume history/imported views can advance and a
 * queue-submit failure can still publish the LKG diagnostic.
 */
function reuseInstalledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  key: string,
  lightingSignature: string,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  postProcessPending: boolean,
  cloudHistoryDemand: boolean,
): CompiledRenderGraph<RenderPipelineFrame> | undefined {
  const installed = frameState.compiledFrameGraph;
  if (installed === null || installed.topologyKey !== key) return undefined;
  const featureMetrics = mutableFeatureGraphInspection(internals);
  frameState.barrelDistortionGraphResolution = 'accepted';
  featureMetrics.reuseHits += 1;
  featureMetrics.lastTopologyKey = key;
  frameState.standardLightingGraphSignature = lightingSignature;
  frameState.pendingCloudHistoryActive = cloudHistoryDemand;
  settleFeatureCandidate(internals, featureGraphCandidate, postProcessPending);
  return installed.graph;
}

/**
 * Claim the stashed compiled-but-unsubmitted graph when it matches this
 * frame's topology key and device generation; any other stash is retired.
 */
function takeUnsubmittedFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  key: string,
): InstalledFrameGraph | undefined {
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  if (stashed === undefined) return undefined;
  frameState.unsubmittedCompiledFrameGraph = undefined;
  if (
    stashed.installed.topologyKey === key &&
    stashed.deviceGeneration === internals.deviceScope?.generation
  )
    return stashed.installed;
  retire(frameState, stashed.installed.graph);
  return undefined;
}

/**
 * Stage an already compiled graph for this frame as the transactional
 * candidate, exactly as a fresh compile with the same topology key would.
 */
function promoteCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  compiled: InstalledFrameGraph,
  installed: InstalledFrameGraph | null,
  lightingSignature: string,
  gpuDriven: PreparedGpuDrivenFrame | undefined,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  postProcessPending: boolean,
  cloudHistoryDemand: boolean,
  key: string,
): CompiledRenderGraph<RenderPipelineFrame> {
  const featureMetrics = mutableFeatureGraphInspection(internals);
  featureMetrics.unsubmittedGraphReuses += 1;
  featureMetrics.lastTopologyKey = key;
  trackGraphGeneration(frameState, graph);
  const superseded = frameState.compiledFrameGraphCandidate;
  frameState.compiledFrameGraphCandidate = {
    graph,
    previous: superseded?.previous ?? {
      installed,
      graphGeneration: frameState.graphGeneration ?? 0,
      compiledGeneration: frameState.compiledFrameGraphGeneration ?? 0,
      lightingSignature: frameState.standardLightingGraphSignature ?? '',
    },
  };
  if (superseded !== undefined && superseded.graph !== graph) retire(frameState, superseded.graph);
  frameState.barrelDistortionGraphResolution = 'accepted';
  frameState.standardLightingGraphSignature = lightingSignature;
  frameState.compiledFrameGraphGeneration += 1;
  frameState.graphGeneration += 1;
  frameState.compiledFrameGraph = {
    ...compiled,
    targets: { ...compiled.targets, graphGeneration: frameState.graphGeneration },
  };
  if (gpuDriven?._commitGpuResourceReplacement !== undefined) {
    gpuDriven._commitGpuResourceReplacement();
  } else {
    gpuDriven?._commitResourceReplacement();
  }
  if (featureGraphCandidate !== undefined && !postProcessPending) {
    commitFeatureCandidate(internals, featureGraphCandidate);
  } else if (featureGraphCandidate !== undefined) {
    recordRenderFeatureCandidateEvent(internals, featureGraphCandidate, 'abandoned');
  }
  frameState.pendingCloudHistoryActive = cloudHistoryDemand;
  return graph;
}

/**
 * Drop every compiled graph this frame state owns at a renderer generation cut
 * (dispose or device recovery): roll back an unsubmitted candidate, retire the
 * installed graph, and forget graphs whose retirement is already in flight.
 */
export function discardCompiledFrameGraphs(frameState: RenderFrameState): void {
  settleCompiledFrameGraphCandidate(frameState, false);
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  frameState.unsubmittedCompiledFrameGraph = undefined;
  if (stashed !== undefined) retire(frameState, stashed.installed.graph);
  const installed = frameState.compiledFrameGraph;
  frameState.compiledFrameGraph = null;
  if (installed !== null) retire(frameState, installed.graph);
  frameState.retiredCompiledFrameGraphs.clear();
}

function featurePlansOf(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate | undefined,
): readonly RenderFeaturePlannedFrame[] {
  return candidate?.plans ?? getRenderFeatureGraphState(internals).plans;
}

function rejectFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate | undefined,
): void {
  if (candidate !== undefined) recordRenderFeatureCandidateEvent(internals, candidate, 'rejected');
}

/** Publish a candidate whose post chain is complete; abandon one still waiting on post pipelines. */
function settleFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate | undefined,
  postProcessPending: boolean,
): void {
  if (candidate === undefined) return;
  if (postProcessPending) recordRenderFeatureCandidateEvent(internals, candidate, 'abandoned');
  else commitFeatureCandidate(internals, candidate);
}

/** Report a graph build failure and drop the Standard output GPU state staged for it. */
function failGraphBuild(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
  error: RendererError,
): void {
  internals.errorRegistry.fire(error);
  retirePendingStandardOutputGpu(frameState);
  rejectFeatureCandidate(internals, candidate);
}

/** A rejected volume-topology candidate has no fallback; any other keeps the accepted graph. */
function rejectedTopologyFallback(
  volumeTopologyCandidate: boolean,
  retainLastKnownGood: () => CompiledRenderGraph<RenderPipelineFrame> | null,
): CompiledRenderGraph<RenderPipelineFrame> | null {
  return volumeTopologyCandidate ? null : retainLastKnownGood();
}

// A rejected authoring request remains visible on the source camera, while
// an accepted graph continues to receive its own params until a valid
// replacement or explicit component removal is submitted.
function graphCameraOf(camera: CameraSnapshot, frameState: RenderFrameState): CameraSnapshot {
  const frameDepthOfField = resolveDepthOfFieldFrameParams(
    camera.depthOfField,
    camera.depthOfFieldError,
    frameState.depthOfFieldAccepted?.params,
  );
  return frameDepthOfField === undefined || frameDepthOfField === camera.depthOfField
    ? camera
    : { ...camera, depthOfField: frameDepthOfField };
}

function hasCloudHistoryDemand(plans: readonly RenderFeaturePlanExecution[]): boolean {
  return plans.some(
    (execution) =>
      execution.featureIdentity === CLOUD_LAYER_FEATURE_IDENTITY &&
      execution.passes.some(
        (pass) => pass.name === 'cloud-layer-transport' || pass.name === 'cloud-layer-resolve',
      ),
  );
}

function recordFeaturePlanRevision(
  featureMetrics: MutableRenderFeatureGraphInspection,
  featurePlans: readonly RenderFeaturePlannedFrame[],
  projectedPlans: readonly RenderFeaturePlanExecution[],
): void {
  const nextPlanRevision = updateRenderFeaturePlanRevision(
    featureMetrics.planRevisionState,
    featurePlans,
    projectedPlans,
  );
  if (nextPlanRevision === featureMetrics.planRevisionState) return;
  featureMetrics.lastPlanSignature = nextPlanRevision.entries
    .map((entry) => `${entry.featureIdentity}:${entry.signature}`)
    .join('|');
  featureMetrics.planRevisionState = nextPlanRevision;
}

/** Transient views that own physical changes publish no prepared-resource lease of their own. */
function topologyCandidateOf(
  internals: RenderSystemInternals,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  featurePlans: readonly RenderFeaturePlannedFrame[],
  ownsPhysicalChanges: boolean,
): RenderFeatureGraphCandidate | undefined {
  if (!ownsPhysicalChanges) return featureGraphCandidate;
  return {
    ...featureGraphCandidate,
    plans: featurePlans,
    fullscreenEffects: featureFullscreenEffects(internals, featureGraphCandidate),
    preparedResourceKey: '',
  };
}

function admitFeaturePostProcessChain(
  internals: RenderSystemInternals,
  topology: RenderPipelineTopology,
  featurePostProcessEntries: RenderFeatureGraphCandidate['fullscreenEffects'],
  multisample: boolean,
): ReturnType<typeof resolvePostProcessChainAdmission> {
  return resolvePostProcessChainAdmission(topology.config?.postEffects ?? [], (identity) => {
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
      multisample,
    );
    if (built === null) return false;
    return (
      getPipeline(
        identity,
        built.bindGroupLayout,
        [
          entry.stage === 'before-temporal'
            ? 'rgba16float'
            : (topology.surface.storageFormat as GPUTextureFormat),
        ],
        entry,
      ) !== null
    );
  });
}

function withoutPostEffects(topology: RenderPipelineTopology): RenderPipelineTopology {
  return {
    ...topology,
    preTemporalEffects: [],
    config: {
      ...(topology.config ?? {}),
      postEffects: [],
    },
  };
}

function irradianceFieldInput(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): NonNullable<RenderFrameState['irradianceField']>['ready'] | undefined {
  // Screen Probes consume the shared field; only the field lane gathers it per pixel.
  return internals.standardProfile?.diffuseGi?.gather === 'irradiance-field'
    ? frameState.irradianceField?.ready
    : undefined;
}

function bakedFieldInput(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): NonNullable<RenderFrameState['bakedField']>['ready'] | undefined {
  return internals.standardProfile?.diffuseGi?.gather === 'baked'
    ? frameState.bakedField?.ready
    : undefined;
}

function shadowCameraCullOf(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  topology: RenderPipelineTopology,
  cubeCaptureState: CubeCaptureGraphState | undefined,
): boolean {
  return shadowCameraCullAdmitted({
    rayDiffuse: frameState.rayDiffuse?.ready !== undefined,
    volumetricFog: topology.volumetricFog?.enabled === true,
    atmosphere: topology.atmosphere === true,
    cubeCaptures: cubeCaptureState?.work.length ?? 0,
    reflectionProbes: cubeCaptureState?.reflectionProbes?.work.length ?? 0,
    planarReflection: cubeCaptureState?.planar?.current() !== undefined,
    featureSceneInputs: internals.featureSceneInputs?.work.length ?? 0,
  });
}

function frameGraphCacheKey(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  topologyIdentity: ReturnType<typeof frameGraphTopologyIdentity>,
  gpuDrivenProjectionActive: boolean,
  cloudShadowResolution: number | undefined,
  cloudHistoryDemand: boolean,
  cubeCaptureState: CubeCaptureGraphState | undefined,
): string {
  const irradianceField = irradianceFieldInput(internals, frameState);
  const screenProbe = frameState.screenProbe?.ready;
  const bakedField = bakedFieldInput(internals, frameState);
  const probePlacement = frameState.probePlacementFrame;
  return JSON.stringify({
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
    gpuDrivenProjectionActive,
    rayDiffuseGeneration: frameState.rayDiffuse?.ready?.generation,
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
}

function graphClockMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

type StandardGraphInputs = Pick<
  RenderPipelineBuildContext<RenderPipelineFrame>,
  'standardOutput' | 'taaHistory' | 'cloudHistory' | 'targetCoverage' | 'ssrHistory'
>;

function importColorLutSource(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
): Result<StandardLutGraphProjection, RenderGraphError> | undefined {
  const prepared = frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
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
        (frame as _InternalRenderPipelineContext).frameState.pendingStandardLutGpuResources ??
        (frame as _InternalRenderPipelineContext).frameState.standardLutGpuResources
      )?.texture ?? prepared.texture,
  );
  if (!texture.ok) return texture;
  const view = builder.importView(
    texture.value,
    { label: 'standard-color-lut-source.view', dimension: '3d' },
    (frame) =>
      (
        (frame as _InternalRenderPipelineContext).frameState.pendingStandardLutGpuResources ??
        (frame as _InternalRenderPipelineContext).frameState.standardLutGpuResources
      )?.view ?? prepared.view,
  );
  if (!view.ok) return view;
  return ok({
    view: view.value,
    strength: prepared.strength,
    bind: (frame) => {
      const state = (frame as _InternalRenderPipelineContext).frameState;
      const current = state.pendingStandardLutGpuResources ?? state.standardLutGpuResources;
      if (current === undefined)
        throw new Error('Standard LUT binding unavailable for accepted frame');
      return current;
    },
  });
}

function importStandardOutputInputs(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  topology: RenderPipelineTopology,
): Result<Pick<StandardGraphInputs, 'standardOutput'>, RenderGraphError> {
  const autoExposure =
    topology.output?.autoExposure === true ? importAutoExposureGraphResources(builder) : undefined;
  if (autoExposure !== undefined && !autoExposure.ok) return autoExposure;
  const colorLut =
    topology.output?.colorLut === true ? importColorLutSource(builder, frameState) : undefined;
  if (colorLut !== undefined && !colorLut.ok) return colorLut;
  if (autoExposure === undefined && colorLut === undefined) return ok({});
  return ok({
    standardOutput: {
      ...(autoExposure === undefined ? {} : { autoExposure: autoExposure.value }),
      ...(colorLut === undefined ? {} : { colorLut: colorLut.value }),
    },
  });
}

/** Renderer-owned output resources and histories imported into a new graph, in import order. */
function importStandardGraphInputs(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  topology: RenderPipelineTopology,
  cloudHistoryDemand: boolean,
  ssr: SsrSpatialAdmission | undefined,
): Result<StandardGraphInputs, RenderGraphError> {
  const standardOutput = importStandardOutputInputs(builder, frameState, topology);
  if (!standardOutput.ok) return standardOutput;
  const taaHistory = camera.antialias === 'taa' ? importTemporalHistoryTargets(builder) : undefined;
  const cloudHistory = cloudHistoryDemand ? importCloudHistoryTargets(builder) : undefined;
  const targetCoverage =
    camera.dynamicResolution === undefined || topology.extent === undefined
      ? undefined
      : createTargetCoverageAttachment(builder, topology.extent);
  if (targetCoverage !== undefined && !targetCoverage.ok) return targetCoverage;
  const ssrHistory =
    ssr?.status === 'admitted' ? importSsrHistoryTargets(builder, topology.extent) : undefined;
  return ok({
    ...standardOutput.value,
    ...(taaHistory === undefined ? {} : { taaHistory }),
    ...(cloudHistory === undefined ? {} : { cloudHistory }),
    ...(targetCoverage === undefined ? {} : { targetCoverage: targetCoverage.value }),
    ...(ssrHistory === undefined ? {} : { ssrHistory }),
  });
}

function probePlacementContribution(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  probePlacement: RenderFrameState['probePlacementFrame'],
): Pick<RenderPipelineBuildContext<RenderPipelineFrame>, 'contributeProbePlacement'> {
  if (probePlacement === undefined) return {};
  return {
    contributeProbePlacement: (targets) => {
      const placed = addProbePlacementPass(builder, probePlacement, targets);
      if (!placed.ok) return placed;
      return probePlacement.global === undefined
        ? ok(undefined)
        : addProbeGlobalPasses(builder, probePlacement, placed.value);
    },
  };
}

/** The one diffuse GI producer this frame gathers, in precedence order. */
function diffuseGiContribution(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): Pick<RenderPipelineBuildContext<RenderPipelineFrame>, 'contributeDiffuseGi'> {
  const rayDiffuse = frameState.rayDiffuse?.ready;
  if (rayDiffuse !== undefined) {
    return {
      contributeDiffuseGi: (targets) => addRayDiffusePasses(builder, rayDiffuse, targets),
    };
  }
  const irradianceField = irradianceFieldInput(internals, frameState);
  if (irradianceField !== undefined) {
    return {
      contributeDiffuseGi: (targets) => addIrradianceFieldPasses(builder, irradianceField, targets),
    };
  }
  const screenProbe = frameState.screenProbe?.ready;
  if (screenProbe !== undefined) {
    return {
      contributeDiffuseGi: (targets) => addScreenProbePasses(builder, screenProbe, targets),
    };
  }
  const bakedField = bakedFieldInput(internals, frameState);
  if (bakedField !== undefined) {
    return {
      contributeDiffuseGi: (targets) => addBakedFieldPasses(builder, bakedField, targets),
    };
  }
  return {};
}

function recordCompileCauses(
  featureMetrics: MutableRenderFeatureGraphInspection,
  frame: number,
  installedTopologyKey: string | undefined,
  key: string,
): void {
  const changedDependencies = frameGraphChangedDependencies(installedTopologyKey, key);
  const primaryCause = changedDependencies[0] ?? 'cold';
  featureMetrics.compilePrimaryCauses[primaryCause] =
    (featureMetrics.compilePrimaryCauses[primaryCause] ?? 0) + 1;
  for (const dependency of changedDependencies) {
    featureMetrics.compileChangedDependencies[dependency] =
      (featureMetrics.compileChangedDependencies[dependency] ?? 0) + 1;
  }
  // Bounded detached evidence of what changed; compiles are already rare and costly.
  featureMetrics.recentCompileChanges.push({
    frame,
    changes: frameGraphChangedValues(installedTopologyKey, key, changedDependencies),
  });
  if (featureMetrics.recentCompileChanges.length > 32) featureMetrics.recentCompileChanges.shift();
}

/**
 * A second build in the same transaction supersedes only the unsubmitted
 * candidate; rollback must still reach the last accepted projection.
 */
function stageCompiledFrameGraphCandidate(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  installed: RenderFrameState['compiledFrameGraph'],
): void {
  const superseded = frameState.compiledFrameGraphCandidate;
  frameState.compiledFrameGraphCandidate = {
    graph,
    previous: superseded?.previous ?? {
      installed,
      graphGeneration: frameState.graphGeneration ?? 0,
      compiledGeneration: frameState.compiledFrameGraphGeneration ?? 0,
      lightingSignature: frameState.standardLightingGraphSignature ?? '',
    },
  };
  if (superseded !== undefined) retire(frameState, superseded.graph);
}

function installedFrameGraphOf(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  topologyKey: string,
  graphGeneration: number,
  preparedResourceKey: string | undefined,
  stockRecording: boolean,
  prepareGpuDrivenPipelines: InstalledFrameGraph['prepareGpuDrivenPipelines'],
  directionalShadowViewCount: number | undefined,
): InstalledFrameGraph {
  const requiresShadowPipelinePreparation = stockRecording
    ? shadowPipelinePreparationDemand(builder)
    : undefined;
  const compiledTargets = graph as CompiledGraphTargetAccess;
  return {
    ...(requiresShadowPipelinePreparation === undefined
      ? {}
      : { requiresShadowPipelinePreparation }),
    ...(prepareGpuDrivenPipelines === undefined ? {} : { prepareGpuDrivenPipelines }),
    scenePipelinePreparations: scenePipelinePreparations(builder),
    ...(directionalShadowViewCount === undefined ? {} : { directionalShadowViewCount }),
    graph,
    topologyKey,
    ...(preparedResourceKey === undefined ? {} : { preparedResourceKey }),
    targets: {
      getColorTargetDescriptor: (name) => compiledTargets.getColorTargetDescriptor(name),
      getColorTargetView: (name) => compiledTargets.getColorTargetView(name),
      getColorTargetTexture: (name) => compiledTargets.getColorTargetTexture(name),
      graphGeneration,
    },
  };
}

// View buffer replacement is safe to retire once the compiled graph owns
// the new imports. Shadow cache publication remains submit-transactional
// and is committed only by executeCompiledFrameGraph's onSubmitted hook.
function commitGpuDrivenResourceReplacement(gpuDriven: PreparedGpuDrivenFrame | undefined): void {
  if (gpuDriven?._commitGpuResourceReplacement !== undefined) {
    gpuDriven._commitGpuResourceReplacement();
  } else {
    // Synthetic/internal prepared projections predating the split own no
    // shadow cache; retain their original graph-promotion callback.
    gpuDriven?._commitResourceReplacement();
  }
}

function recordGraphDeviceGeneration(
  internals: RenderSystemInternals,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  const deviceGeneration = internals.deviceScope?.generation;
  if (deviceGeneration !== undefined) graphDeviceGenerations.set(graph, deviceGeneration);
}

function pipelineBuildOf(
  activePipeline: RenderFrameState['activePipeline'],
  stockRecording: boolean,
): RenderFrameState['activePipeline']['build'] {
  // Direct and custom graph builds cannot admit callback or accessor elision.
  return stockRecording
    ? (context, topology) => buildStandard(context, topology, true)
    : activePipeline.build;
}

/** Renderer-owned shadow layers outlive any one compiled graph. */
function ensureShadowDepthLayers(
  frameState: RenderFrameState,
  device: RenderSystemInternals['device'],
): ShadowDepthLayers {
  frameState.shadowDepthLayers ??= new ShadowDepthLayers(device);
  return frameState.shadowDepthLayers;
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
  const graphCamera = graphCameraOf(camera, frameState);
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
  const featurePlans = featurePlansOf(internals, featureGraphCandidate);
  const projectedFeaturePlans = validateRenderFeaturePlans(featurePlans, featureMetrics);
  if (!projectedFeaturePlans.ok) {
    featureMetrics.validationFailures += 1;
    onRecoveryError?.(projectedFeaturePlans.error);
    reportRenderFeatureGraphError(internals, projectedFeaturePlans.error);
    rejectFeatureCandidate(internals, featureGraphCandidate);
    return rejectedTopologyFallback(volumeTopologyCandidate, retainLastKnownGood);
  }
  const cloudHistoryDemand = hasCloudHistoryDemand(projectedFeaturePlans.value);
  recordFeaturePlanRevision(featureMetrics, featurePlans, projectedFeaturePlans.value);
  const stockRecording = rendererRecording && frameState.activePipeline === standardPipeline;
  const transientViews = selectTransientViewPlans(
    internals,
    featurePlans,
    projectedFeaturePlans.value,
    stockRecording && frameState.graphTargetCapture === undefined,
    frameState,
  );
  const topologyCandidate = topologyCandidateOf(
    internals,
    featureGraphCandidate,
    featurePlans,
    transientViews.ownsPhysicalChanges,
  );
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
    stockRecording,
  );
  if (!topologyResult.ok) {
    featureMetrics.buildFailures += 1;
    onRecoveryError?.(topologyResult.error);
    internals.errorRegistry.fire(topologyResult.error);
    rejectFeatureCandidate(internals, featureGraphCandidate);
    return rejectedTopologyFallback(volumeTopologyCandidate, retainLastKnownGood);
  }
  const featurePostProcessEntries = featureFullscreenEffects(internals, featureGraphCandidate);
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
  const postProcessAdmission = admitFeaturePostProcessChain(
    internals,
    topologyResult.value,
    featurePostProcessEntries,
    camera.antialias === 'msaa' && topologyResult.value.lane.multisample,
  );
  const acceptedLkg = postProcessAdmission.pending ? lastKnownGood() : null;
  if (acceptedLkg !== null) {
    // Do not publish a candidate whose fullscreen chain is only partially
    // ready. Keep the accepted graph (including its prior post-effect chain)
    // and retry the same feature candidate on the next frame.
    rejectFeatureCandidate(internals, featureGraphCandidate);
    frameState.barrelDistortionGraphResolution = 'retained';
    return acceptedLkg;
  }
  const topology = postProcessAdmission.pending
    ? withoutPostEffects(topologyResult.value)
    : topologyResult.value;
  // Keep Bloom's positive parameter values out of the compiled identity. A
  // crossing of zero has already changed topology.camera.bloom above; the
  // remaining values are uploaded by the active recorder without rebuilding
  // targets or pipelines.
  const topologyIdentity = frameGraphTopologyIdentity(topology, stockRecording);
  const probePlacement = frameState.probePlacementFrame;
  const shadowCameraCull = shadowCameraCullOf(internals, frameState, topology, cubeCaptureState);
  const key = frameGraphCacheKey(
    internals,
    frameState,
    topologyIdentity,
    gpuDriven !== undefined,
    cloudShadowResolution,
    cloudHistoryDemand,
    cubeCaptureState,
  );
  const installed = frameState.compiledFrameGraph;
  const reused = reuseInstalledFrameGraph(
    internals,
    frameState,
    key,
    requestedStandardLightingSignature,
    featureGraphCandidate,
    postProcessAdmission.pending,
    cloudHistoryDemand,
  );
  if (reused !== undefined) return reused;

  const stashed = takeUnsubmittedFrameGraph(internals, frameState, key);
  if (stashed !== undefined)
    return promoteCompiledFrameGraph(
      internals,
      frameState,
      stashed.graph,
      stashed,
      installed,
      requestedStandardLightingSignature,
      gpuDriven,
      featureGraphCandidate,
      postProcessAdmission.pending,
      cloudHistoryDemand,
      key,
    );
  featureMetrics.rebuildAttempts += 1;
  featureMetrics.lastTopologyKey = key;
  const buildStarted = graphClockMs();
  const builder = new RenderGraphBuilder<RenderPipelineFrame>();
  const sceneInputs = internals.featureSceneInputs?.import(builder);
  const graphInputs = importStandardGraphInputs(
    builder,
    frameState,
    camera,
    topology,
    cloudHistoryDemand,
    ssr,
  );
  if (!graphInputs.ok) {
    failGraphBuild(internals, frameState, featureGraphCandidate, graphInputs.error);
    return retainLastKnownGood();
  }
  const featureProjection = createRenderFeatureProjectionState();
  const transientSlots = new Map<string, { complete: boolean; names: Set<string> }>();
  let featureShadows:
    | ReturnType<typeof projectRenderFeatureShadows<RenderPipelineFrame>>
    | undefined;
  let projectedGpuDriven = false;
  let prepareGpuDrivenPipelines: InstalledFrameGraph['prepareGpuDrivenPipelines'];
  const activePipeline = frameState.activePipeline;
  let directionalShadowViewCount: number | undefined;
  const build = pipelineBuildOf(activePipeline, stockRecording);
  const built = Reflect.apply(build, activePipeline, [
    {
      graph: builder,
      ...probePlacementContribution(builder, probePlacement),
      ...diffuseGiContribution(builder, internals, frameState),
      camera: { depthOfField: graphCamera.depthOfField },
      observationCaptureDomains: internals.observationCaptureDomains,
      ...graphInputs.value,
      ...(standardLighting === undefined ? {} : { standardLighting }),
      capabilities: { rgba16floatRenderable: internals.device.caps.rgba16floatRenderable },
      ...(cloudShadowResolution === undefined ? {} : { cloudShadowResolution }),
      encodeTransmissionMip: ({ pass, resources, source, format }) => {
        const sourceView = resources.textureView(source);
        if (!sourceView.ok) throw sourceView.error;
        const encoded = encodeMipmapLevel(internals.device, pass, sourceView.value, format);
        if (!encoded.ok) throw encoded.error;
      },
      shadowDepthLayers: ensureShadowDepthLayers(frameState, internals.device),
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
          stockRecording,
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
              : { gpuDrivenShadowDepthLayers: gpuDriven.shadowViewPool.staticLayers }),
          }),
      contributeShadowFeatures: () =>
        (featureShadows ??= projectRenderFeatureShadows(
          builder,
          projectedFeaturePlans.value,
          featureProjection,
        )),
      contributeFeatures: ({
        targets,
        semanticTargets = [],
        namedTargets = {},
        standardSurfaceAccesses = [],
        placement = 'post',
        include: includedIdentities,
        exclude: excludedIdentities,
        passNames = [],
        atmosphere,
      }) => {
        const include = includedIdentities === undefined ? undefined : new Set(includedIdentities);
        const exclude = excludedIdentities === undefined ? undefined : new Set(excludedIdentities);
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
    failGraphBuild(internals, frameState, featureGraphCandidate, built.error);
    return rejectedTopologyFallback(volumeTopologyCandidate, retainLastKnownGood);
  }
  featureMetrics.compileAttempts += 1;
  featureMetrics.buildCpuMs += graphClockMs() - buildStarted;
  recordCompileCauses(featureMetrics, frameState.frameNumber, installed?.topologyKey, key);
  const compileStarted = graphClockMs();
  const compiled = builder.compile({
    device: internals.device,
    surfaceSize: { width: surfaceWidth, height: surfaceHeight },
    reuseResourcesFrom: installed?.graph,
  });
  featureMetrics.compileCpuMs += graphClockMs() - compileStarted;
  if (!compiled.ok) {
    featureMetrics.compileFailures += 1;
    onRecoveryError?.(compiled.error);
    failGraphBuild(internals, frameState, featureGraphCandidate, compiled.error);
    return retainLastKnownGood();
  }
  // Register the generation before publishing it. The owner observes the
  // overlap while the previous graph is still live, even if a queue fence
  // retires that graph before the next public inspect() call.
  installScenePasses(builder, compiled.value);
  trackGraphGeneration(frameState, compiled.value);
  stageCompiledFrameGraphCandidate(frameState, compiled.value, installed);
  frameState.barrelDistortionGraphResolution = 'accepted';
  frameState.standardLightingGraphSignature = requestedStandardLightingSignature;
  frameState.compiledFrameGraphGeneration += 1;
  frameState.graphGeneration += 1;
  featureMetrics.compileSuccesses += 1;
  // No new lease means the installed imports remain current, not a second
  // resource transition back to an empty key on the following frame.
  frameState.compiledFrameGraph = installedFrameGraphOf(
    builder,
    compiled.value,
    key,
    frameState.graphGeneration,
    topologyCandidate?.preparedResourceKey ?? installed?.preparedResourceKey,
    stockRecording,
    prepareGpuDrivenPipelines,
    directionalShadowViewCount,
  );
  commitGpuDrivenResourceReplacement(gpuDriven);
  recordGraphDeviceGeneration(internals, compiled.value);
  settleFeatureCandidate(internals, featureGraphCandidate, postProcessAdmission.pending);
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
  installScenePasses(graph, compiled.value);
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
      const drawStorage = (frame as _InternalRenderPipelineContext).pipelineState.meshStorageBuffer;
      if (drawStorage !== undefined) flushMeshDrawUploads(internals.device.queue, drawStorage);
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
            { texture: graphTexture },
            {
              buffer: graphCapture.buffer,
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
