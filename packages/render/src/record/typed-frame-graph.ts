import { nowMs } from '@forgeax/engine-platform';
import {
  type BoundRenderGraphRecording,
  boundRenderGraphResources,
  compiledRenderGraphHasPass,
  compiledRenderGraphPassCountByPrefix,
  compiledRenderGraphResourceDeclarations,
} from '@forgeax/engine-render-graph';
import {
  type SharedFeatureGraphPublication,
  sharedFeatureGraphPublication,
} from '../assembly/feature-frame-graph';
import { isCaptureViewPipeline } from '../capture/capture-view';
import type { CloudShadowSpatialLayout } from '../cloud/lighting/shadow-spatial-layout';
import { cloudMode0DepthFormat } from '../cloud/reconstruction/history';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import { projectedDecalTopology } from '../decals/graph';
import { hasDepthPyramidPrograms } from '../depth-pyramid/programs';
import { atmosphereTransportOf } from '../environment/inspection';
import { captureEditorAssistanceView } from '../features/editor-assistance/feature';
import { scopedGraphTextureTarget } from '../features/graph-texture-targets';
import { chromaticAberrationActive, outputLensEffectsActive } from '../features/lens-effects';
import { distanceOutlineFirstStep } from '../features/outline/distance-graph';
import { isOutlinePostProcess } from '../features/outline/shaders';
import { importSharedGraphTextures } from '../features/shared-graph-textures';
import { renderFeatureViewIdentity } from '../features/view';
import {
  EMPTY_ADMITTED_VIEW_FEATURES,
  EMPTY_VIEW_FEATURE_WORK,
  type ViewFeatureWork,
  viewFeaturesOf,
} from '../features/view-feature-work';
import { withForwardShadowAdmission } from '../pipeline/forward-shadow-admission';
import { buildDeferredDisplay } from '../pipeline/standard-deferred-lane';
import { forwardClusterTextureExtent } from '../pipeline/standard-forward-lane';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from '../pipeline/standard-lighting/graph';
import { standardAutoExposureMode, usesNativeGrade } from '../pipeline/standard-output/layout';
import { addBakedFieldPasses } from '../raytracing/baked-field-graph';
import { addRayDiffusePasses } from '../raytracing/diffuse-graph';
import {
  addIrradianceFieldPasses,
  irradianceFieldGraphShape,
} from '../raytracing/irradiance-field-graph';
import { addProbeGlobalPasses, probeGlobalGraphShape } from '../raytracing/probe-global-graph';
import { addProbePlacementPass } from '../raytracing/probe-placement-graph';
import { addScreenProbePasses, screenProbeGraphShape } from '../raytracing/screen-probe-graph';
import { ShadowDepthLayers } from '../shadow-depth-layers';
import { isWaterSsrAdmitted } from '../ssr/water-profile';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../temporal/scene-data';
import {
  sceneDataTopologyFields,
  standardSceneGBufferWriters,
} from '../temporal/standard-scene-data-admission';
import { type TerrainShadowReceiver, terrainShadowTopology } from '../terrain/shadow-family';
import {
  addPlanarReflectionPass,
  addTypedShadowPasses,
  currentShadowViews,
  importSharedShadowTargets,
  type SharedShadowSource,
  shadowPipelinePreparationDemand,
} from '../typed-shadow-passes';
import {
  matchesWaterFluidMaterialTopology,
  type WaterFluidMaterialPublication,
  waterFluidBodyDescriptorReader,
  waterFluidMaterialTopology,
} from '../water/fluid-graph';
import { EMPTY_VIEW_FEATURE_PLAN, type ViewFeaturePlan } from '../world/feature-plan-systems';
import { EMPTY_VIEW_PASS_PLAN, planOpaque, type ViewPassPlan } from '../world/pass-plan-systems';
import { viewReflectionProbesOf } from '../world/reflection-systems';
import type { ViewLights } from '../world/render-lights';
import { renderWorldFor } from '../world/render-world';
import { reflectionFallbackDemandOf } from '../world/ssr-admission-systems';
import { recordContext } from '../world/view-record-context';
import { currentGpuRaster } from './current-gpu-raster';
import { leanLightingFrame } from './directional-shadow-simple';
import {
  admitOrderedDisplay,
  cloudDisplayPorts,
  type DisplayOutput,
  DisplayPorts,
  displayCoverageExtent,
  matchesCloudDisplayPorts,
  shadowProjectionLightBytes,
  type WaterDisplayPorts,
} from './display-ports';
import { buildForwardDisplay } from './forward-display';
import {
  retainedFrameGraphPolicy,
  retainedFrameGraphPolicyMatches,
  serializeFrameGraphKey,
} from './frame-graph-key';
import { resolveSpotShadowMapSize } from './frame-targets';
import {
  setGraphGenerationRetirementResult,
  setGraphGenerationRetiring,
} from './graph-allocation-owner';
import {
  clearStaleGtaoCandidatePreparationFault,
  consumeGtaoCandidatePreparationFault,
} from './gtao-candidate-preparation-fault';
import { captureNativeGraphInputs } from './native-graph-inputs';
import {
  type CaptureRecording,
  nativeProbeCapture,
  nativeTargetCapture,
} from './native-target-capture';
import { hasReferencedReadyProbe } from './reflection-probe-material';
import { addCurrentReflectionProbeFilters } from './reflection-probe-pmrem';
import { scenePipelinePreparations } from './scene-pipeline-preparation';
import { admitStandardAoConfig, standardAoUnavailableForGraph } from './standard-ao-admission';
import {
  standardAfterTonemapOutput,
  standardFeatureContribution,
} from './standard-feature-contribution';
import {
  addTargetCaptureGraphPasses,
  type CubeCaptureGraphState,
  importPlanarCaptureView,
} from './target-capture-graph';
import {
  traceCompiledFeatureGraph,
  traceFeaturePlans,
  traceGraphDecision,
} from './typed-frame-graph-trace';
import {
  admitsOrderedViewportStages,
  graphCameraWithViewportOutput,
  resolveViewportOutputState,
} from './viewport-output-topology';

export type { CubeCaptureGraphState, CubeCaptureGraphWork } from './target-capture-graph';

import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';

import type { RecorderSession } from '@forgeax/engine-profiler';

import {
  type CompiledRenderGraph,
  type GraphTextureView,
  RenderGraphBuilder,
  type RenderGraphError,
} from '@forgeax/engine-render-graph';

import type { TextureFormat } from '@forgeax/engine-rhi';

import { multisampleRenderCapability, RhiError } from '@forgeax/engine-rhi';

import { err, ok, type Result } from '@forgeax/engine-types';

import { standardBloomAdmitted } from '../bloom-admission';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { selectCloudShadowFormat } from '../cloud/lighting/shadow-format';
import type { CloudTransportFormat } from '../cloud/reconstruction/history';
import {
  type RenderError,
  RendererContractFailureError,
  RendererOperationError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { depthOfFieldTopology } from '../features/depth-of-field/depth-of-field-feature';
import { inspectDepthOfFieldGraph } from '../features/depth-of-field/depth-of-field-inspection';
import { resolveDepthOfFieldFrameParams } from '../features/depth-of-field/depth-of-field-params';
import { featureScopeKey } from '../features/frame-plan';
import {
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
  hasSubmissionSensitiveFeatures,
  isStandardCloudPlan,
  isStandardWaterPlan,
  type RenderFeaturePlanExecution,
  renderFeaturePlanRequiresPreparedResourceKey,
} from '../features/host';
import { MOTION_BLUR_FEATURE_IDENTITY } from '../features/motion-blur/motion-blur-feature';
import {
  type RenderFeaturePlannedFrame,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureEvidenceMatches,
} from '../features/plan';
import {
  createRenderFeatureProjectionState,
  projectRenderFeatureShadows,
} from '../features/render-graph-contribution';
import { importRenderFeatureGraphBuffer } from '../features/render-graph-resources';
import {
  inspectTransientViewGraphs,
  selectTransientViewPlans,
} from '../features/transient-view-graph';
import {
  buildFullscreenPostProcessPass,
  postProcessShaderEntrySignature,
} from '../fullscreen-post-process-pass';
import type {
  GpuDrivenGraphProjection,
  PreparedGpuDrivenFrame,
} from '../gpu-driven/production-raster';
import { GPU_TEXTURE_USAGE_TEXTURE_BINDING } from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_INDIRECT } from '../gpu-usage';
import type { RenderFeatureGraphInspection } from '../inspection-types';
import { type RenderExtent, renderInternalCopySize } from '../pipeline/render-extent';
import {
  buildStandardViewRecording,
  ownsStandardForwardRaster,
  premultipliedForwardOutput,
  standardForwardTargetKey,
  standardViewRecording,
} from '../pipeline/standard-forward-output';
import { bindAmbientOcclusionViewFacts } from '../pipeline/standard-lighting/inspection';
import {
  deriveStandardTopologyInput,
  matchesStandardLightingDeclaration,
  type StandardTopologyInputValue,
  standardLightingDeclaration,
  standardLightingTopologySignature,
} from '../pipeline/standard-lighting/topology';
import { importAutoExposureGraphResources } from '../pipeline/standard-output/auto-exposure/gpu';
import type { StandardLutGraphProjection } from '../pipeline/standard-output/lut-gpu';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { isStandardNamedPostProcess } from '../pipeline/standard-post';
import {
  DEFAULT_STANDARD_PROFILE,
  isStandardLightCount,
  resolveVolumetricFogProfile,
  STANDARD_PIPELINE_ID,
} from '../pipeline/standard-profile';
import type { CameraSnapshot } from '../render-contract';
import type {
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import type { ExtractedVolumetricFog } from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_FACE_SIZE } from '../shadow-atlas';
import { admitsInlineSsr, type SsrSpatialAdmission } from '../ssr/admission';
import { createTargetCoverageAttachment } from '../temporal/target-coverage-attachment';
import { estimateTransmissionBackdropBytes } from '../transmission/inspection';
import { usesTsrCompute } from '../tsr/capabilities';
import { hasSelectedVolumeLight, hasVolumetricFogCapability } from '../volume/capability';
import {
  bindVolumetricFogTextures,
  deriveVolumetricFogExtent,
  deriveVolumetricFogResolvedExtent,
} from '../volume/resources';
import { WATER_GPU_MESH_FEATURE } from '../water/gpu-mesh-source';
import {
  displayGraphIdentity,
  type FrameGraphCompileAttribution,
  type FrameGraphIdentity,
  frameGraphKeyText,
  frameGraphTopologyIdentity,
} from './frame-graph-identity';
import {
  type GraphCaptureLayout,
  getOpaqueResourceIdentity,
  type InstalledFrameGraph,
  type RenderFrameState,
  viewGraphDeviceIsCurrent,
} from './frame-snapshot';
import type {
  FeatureGraphMetricsDelta,
  GraphEffectError,
  GraphEffects,
  GraphRejectCode,
  ViewGraphCompileOutcome,
} from './graph-adoption';
import { activeRenderProfileSession } from './profile-session';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RenderSystemInternals,
} from './render-context';
import { resolveSurfaceProfile, runProfiledRenderPhase } from './render-context';
import { type CaptureScenePasses, installScenePasses, scenePassRequests } from './scene-pass-work';
import { staticShadowAdmission } from './static-shadow-budget';

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

export {
  projectRenderTargetGraph,
  type RenderTargetGraphInput,
  type RenderTargetGraphProjection,
  type RenderTargetGraphSubresource,
} from '../targets/graph-projection';

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
  readonly featureTextureReadbacks?: readonly import('../render-contract').FeatureTextureReadbackDeclaration[];
  readonly sceneDataAdmission?: import('../temporal/scene-data').StandardSceneSurfaceAdmission;
  readonly sceneDataBindings?: readonly import('../temporal/scene-data').SceneDataSurfaceBinding[];
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
  /** Discard candidate-only resources when a base graph is kept as fallback. */
  readonly onAbandoned?: () => void;
}

export interface MutableRenderFeatureGraphInspection {
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
    readonly changes: FrameGraphCompileAttribution['changes'];
  }[];
  candidatesWithPreparedBatches: number;
  preparedKeyChanges: number;
  accepted: number;
  rejected: number;
  abandoned: number;
  lastPlanSignature: string;
  lastTopologyKey: FrameGraphIdentity | undefined;
  lastPreparedResourceKey: string | undefined;
  preparedKeyObserved: boolean;
}

const featureGraphInspections = new WeakMap<
  RenderSystemInternals,
  MutableRenderFeatureGraphInspection
>();

export function mutableFeatureGraphInspection(
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
  const lastKey = metrics.lastTopologyKey;
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
      get topologyKey() {
        return lastKey === undefined ? undefined : frameGraphKeyText(lastKey);
      },
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

export function recordRenderFeatureCandidateEvent(
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

export function reportRenderFeatureGraphError(
  internals: RenderSystemInternals,
  error: RenderError,
): void {
  const host = recordContext(internals).featureHost;
  if (host !== undefined && 'detail' in error) {
    const detail = error.detail;
    if (detail !== undefined && 'featureIdentity' in detail && 'order' in detail) {
      const owned = host.recordError(detail.featureIdentity, error);
      internals.errorRegistry.fire(owned);
      return;
    }
  }
  internals.errorRegistry.fire(error);
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

const NO_FEATURE_WORK = ok(EMPTY_VIEW_FEATURE_WORK);

type SignatureValidationMetrics = Pick<
  MutableRenderFeatureGraphInspection,
  | 'signatureValidationCalls'
  | 'signatureValidationBytes'
  | 'signatureValidationChars'
  | 'signatureValidationCpuMs'
  | 'signatureValidationCacheHits'
  | 'signatureValidationCacheMisses'
>;

function measurePlanSignature(
  planned: RenderFeaturePlannedFrame,
  metrics: SignatureValidationMetrics | undefined,
): string {
  const signatureMetrics =
    metrics === undefined ? undefined : { calls: 0, typedArrayBytes: 0, outputChars: 0 };
  const started = metrics === undefined ? 0 : nowMs();
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
    const now = nowMs();
    metrics.signatureValidationCalls += signatureMetrics?.calls ?? 0;
    metrics.signatureValidationBytes += signatureMetrics?.typedArrayBytes ?? 0;
    metrics.signatureValidationChars += signatureMetrics?.outputChars ?? 0;
    metrics.signatureValidationCpuMs += now - started;
  }
  return recomputedSignature;
}

/** @internal Shared typed-graph admission gate for renderer-produced Feature plans. */
export function validateRenderFeaturePlans(
  plans: readonly RenderFeaturePlannedFrame[],
  metrics?: SignatureValidationMetrics,
): Result<ViewFeatureWork, RenderError> {
  if (plans.length === 0) return NO_FEATURE_WORK;
  const identities = new Set<string>();
  const projected: RenderFeaturePlanExecution[] = [];
  let atomic: number[] | undefined;
  let previousOrder = -1;
  for (let order = 0; order < plans.length; order++) {
    const planned = plans[order] as RenderFeaturePlannedFrame;
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    const recomputedSignature = measurePlanSignature(planned, metrics);
    const duplicateIdentity = identities.has(planned.featureIdentity);
    const signatureMismatch = planned.signature !== recomputedSignature;
    const executionMissing = execution === undefined;
    const executionIdentityMismatch =
      execution !== undefined && execution.featureIdentity !== planned.featureIdentity;
    const executionOrderNotIncreasing = execution !== undefined && execution.order <= previousOrder;
    if (
      duplicateIdentity ||
      signatureMismatch ||
      executionMissing ||
      executionIdentityMismatch ||
      executionOrderNotIncreasing
    ) {
      return err(
        new RenderFeatureStageFailedError(planned.featureIdentity, order, 'plan', 'next-frame', {
          kind: 'typed-render-feature-plan-admission',
          failedPredicates: {
            duplicateIdentity,
            signatureMismatch,
            executionMissing,
            executionIdentityMismatch,
            executionOrderNotIncreasing,
          },
          previousOrder,
          planned: {
            featureIdentity: planned.featureIdentity,
            scope: planned.scope,
            signaturePrefix: planned.signature.slice(0, 96),
            signatureLength: planned.signature.length,
          },
          ...(execution === undefined
            ? {}
            : {
                execution: {
                  featureIdentity: execution.featureIdentity,
                  scope: execution.scope,
                  order: execution.order,
                },
              }),
          ...(signatureMismatch
            ? {
                recomputedSignaturePrefix: recomputedSignature.slice(0, 96),
                recomputedSignatureLength: recomputedSignature.length,
              }
            : {}),
        }),
      );
    }
    identities.add(planned.featureIdentity);
    previousOrder = execution.order;
    projected.push(execution);
    if (planned.plan.submission === 'atomic' && planned.plan.passes.length !== 0) {
      atomic ??= [];
      atomic.push(order);
    }
  }
  return ok({ plans, executions: Object.freeze(projected), atomic });
}

export function commitFeatureCandidate(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate,
  work: ViewFeatureWork,
): void {
  // Publish renderer-owned declarations only after their device resources have
  // been admitted.  If the acceptance hook throws, the previously accepted
  // graph/state pair remains visible to the caller.
  recordRenderFeatureCandidateEvent(internals, candidate, 'accepted');
  frameState.previousViewFeatures ??= viewFeaturesOf(frameState);
  frameState.viewFeatures = {
    work,
    fullscreenEffects: candidate.fullscreenEffects,
    postProcessIdentities:
      candidate.postProcessIdentities ?? EMPTY_ADMITTED_VIEW_FEATURES.postProcessIdentities,
  };
}

function directionalTopologyOf(
  internals: RenderSystemInternals,
  lights: ViewLights,
  shadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
  staticLayer: boolean,
): Result<RenderPipelineTopology['shadow']['directional'], RhiError> {
  const cascadeCount = Math.max(1, Math.min(4, Math.round(lights.cascades?.cascadeCount ?? 1))) as
    | 1
    | 2
    | 3
    | 4;
  return terrainShadowTopology(
    shadowMapSize === undefined || lights.cascades?.cascadeCount === undefined
      ? 'disabled'
      : {
          mapSize: shadowMapSize,
          cascadeCount,
          ...(!staticLayer ? { staticLayer: false as const } : {}),
        },
    lights.cascades?.directionalShadowQuality?.kind === 'pcss' ? [] : terrainReceivers,
    internals.device.limits.maxTextureArrayLayers,
  );
}

function featureFullscreenEffects(
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
): RenderFeatureGraphCandidate['fullscreenEffects'] {
  return candidate?.fullscreenEffects ?? viewFeaturesOf(frameState).fullscreenEffects;
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
  frameState: RenderFrameState,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
): RenderPipelineTopology['config'] {
  const identities =
    featureGraphCandidate?.postProcessIdentities ??
    viewFeaturesOf(frameState).postProcessIdentities;
  const installed = frameState.installedPipelineConfig;
  let effects: Set<string> | undefined;
  for (const identity of identities) {
    if (isOutlinePostProcess(identity)) continue;
    effects ??= new Set(installed?.postEffects);
    effects.add(identity);
  }
  return effects === undefined ? installed : { ...installed, postEffects: [...effects] };
}

function preTemporalEffectsOf(
  config: RenderPipelineTopology['config'],
  fullscreenEffects: RenderFeatureGraphCandidate['fullscreenEffects'],
): readonly string[] {
  return (config?.postEffects ?? []).filter(
    (identity) => fullscreenEffects.get(identity)?.stage === 'before-temporal',
  );
}

function cameraTopologyOf(
  camera: CameraSnapshot,
  clearOnly: boolean,
  outline: CameraSnapshot['outline'],
  height: number,
): RenderPipelineTopology['camera'] {
  const depthOfField = depthOfFieldTopology(camera.depthOfField);
  return {
    ...(camera.dynamicResolution === undefined
      ? {}
      : { dynamicResolution: camera.dynamicResolution }),
    postProcessing: camera.postProcessing !== false,
    tonemap: camera.tonemap,
    antialias: camera.antialias,
    // Bloom intensity is a frame parameter, not a graph identity. Fold
    // only its zero/non-zero admission into the closed topology switch so
    // positive intensity changes update the recorder UBO in place.
    bloom: standardBloomAdmitted(camera) ? 'on' : 'off',
    ...(standardBloomAdmitted(camera) && camera.bloomQuality !== undefined
      ? { bloomQuality: camera.bloomQuality }
      : {}),
    ...(standardBloomAdmitted(camera) && camera.bloomThreshold >= 0
      ? { bloomPrefilter: true as const }
      : {}),
    bloomIntensity: camera.bloomIntensity,
    outline:
      !clearOnly &&
      camera.postProcessing !== false &&
      outline !== undefined &&
      (outline.distanceStyle === undefined
        ? true
        : {
            kind: 'distance-field',
            firstStep: distanceOutlineFirstStep(outline.width, outline.distanceStyle, height),
          }),
    lensEffects: !clearOnly && outputLensEffectsActive(camera.lensEffects),
    chromaticAberration: !clearOnly && chromaticAberrationActive(camera.lensEffects),
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
  const postProcessing = !clearOnly && camera.postProcessing !== false;
  const preparedLut =
    frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
  const autoExposureResources =
    frameState.pendingAutoExposureGpuResources ?? frameState.autoExposureGpuResources;
  return {
    autoExposure:
      postProcessing && output?.exposure.kind === 'auto' && autoExposureResources !== undefined,
    autoExposureHalfRes:
      postProcessing &&
      autoExposureResources !== undefined &&
      output?.exposure.kind === 'auto' &&
      output.exposure.adaptation === 'ue-eye-adaptation',
    whiteBalance:
      postProcessing && output !== undefined && (output.temperature !== 6504 || output.tint !== 0),
    temperature: output?.temperature ?? 6504,
    tint: output?.tint ?? 0,
    colorLut: postProcessing && (output?.colorLutStrength ?? 0) > 0 && preparedLut !== undefined,
    colorLutStrength: output?.colorLutStrength ?? 0,
    ...(preparedLut === undefined
      ? {}
      : { lutSourceKey: preparedLut.sourceKey, lutSize: preparedLut.size }),
  };
}

function layerSpan<T>(lights: readonly T[], layerOf: (light: T) => number): number {
  let span = 0;
  for (const light of lights) span = Math.max(span, layerOf(light) + 1);
  return span;
}

function shadowTopologyOf(
  spotMapSize: number,
  lights: ViewLights,
  directional: RenderPipelineTopology['shadow']['directional'],
  layers: ReturnType<typeof staticShadowAdmission>,
): RenderPipelineTopology['shadow'] {
  const { pointMask: pointStaticMask, spotMask: spotStaticMask } = layers;
  return {
    directional,
    ...(pointStaticMask === 0 ? {} : { pointStaticMask }),
    ...(spotStaticMask === 0 ? {} : { spotStaticMask }),
    spotMapSize,
    // Layers are stable per light, so the graph spans the highest held layer;
    // a free layer below it records an empty pass.
    pointCount: layerSpan(lights.pointShadow, (light) => light.shadowAtlasLayer),
    pointFaceSize: lights.pointShadow[0]?.mapSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE,
    spotCount: layerSpan(lights.spot, (light) =>
      light.lightViewProj === undefined ? -1 : light.shadowAtlasTile,
    ),
  };
}

/** Display and capture writers consume the shadow layout of their own fitted lights. */
function fittedShadowTopology(
  internals: RenderSystemInternals,
  lights: ViewLights,
  shadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
  layersOwner?: ShadowDepthLayers,
): Result<RenderPipelineTopology['shadow'], RhiError> {
  const spotMapSize = resolveSpotShadowMapSize(internals, lights) ?? 1024;
  const layers =
    layersOwner?.staticPlan?.layout ??
    staticShadowAdmission(
      lights,
      shadowMapSize,
      spotMapSize,
      internals.options?.staticShadowBudgetBytes,
      layersOwner,
    );
  const directional = directionalTopologyOf(
    internals,
    lights,
    shadowMapSize,
    terrainReceivers,
    layers.directional,
  );
  if (!directional.ok) return directional;
  return ok(shadowTopologyOf(spotMapSize, lights, directional.value, layers));
}

/** Graph import shape of a fog owner's density: its 3D asset, or the unit volume for `uniform`. */
function volumeDensityShapeOf(fog: ExtractedVolumetricFog):
  | {
      readonly format: GPUTextureFormat;
      readonly extent: { readonly width: number; readonly height: number; readonly depth: number };
    }
  | undefined {
  if (fog.fog?.sampling === 'uniform')
    return { format: 'rgba8unorm', extent: { width: 1, height: 1, depth: 1 } };
  const asset = fog.densityAsset;
  if (asset?.shape.viewDimension !== '3d') return undefined;
  return {
    format: asset.format,
    extent: {
      width: asset.shape.extent.width,
      height: asset.shape.extent.height,
      depth: asset.shape.extent.depth,
    },
  };
}

function volumetricFogTopologyOf(
  internals: RenderSystemInternals,
  lights: ViewLights,
  volumetricFog: ExtractedVolumetricFog | undefined,
  surface: { readonly width: number; readonly height: number },
): NonNullable<RenderPipelineTopology['volumetricFog']> {
  const density = volumetricFog === undefined ? undefined : volumeDensityShapeOf(volumetricFog);
  if (
    volumetricFog?.status !== 'available' ||
    density === undefined ||
    !hasSelectedVolumeLight(lights, volumetricFog) ||
    !hasVolumetricFogCapability(internals.device.caps, internals.volumetricFogShaders)
  ) {
    return { enabled: false };
  }
  const volumeProfile = resolveVolumetricFogProfile(internals.standardProfile ?? {});
  const additional = volumetricFog.additional ?? [];
  return {
    enabled: true,
    format: density.format,
    additional: additional.flatMap((member) => {
      const shape = volumeDensityShapeOf(member);
      return shape === undefined ? [] : [shape];
    }),
    extent: density.extent,
    froxelExtent: deriveVolumetricFogExtent(
      surface,
      volumeProfile.depth * (1 + additional.length),
      volumeProfile.tileSize,
    ),
    resolvedExtent: deriveVolumetricFogResolvedExtent(surface, volumeProfile.tileSize),
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
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  featurePlanRevision: number | string,
  preparedResourceKey: string | undefined,
  fullscreenEffects: RenderFeatureGraphCandidate['fullscreenEffects'],
  cubeCaptureState: CubeCaptureGraphState | undefined,
  stockRecording: boolean,
): string {
  const sceneData = stockRecording
    ? undefined
    : sceneDataTopologyFields(
        featureGraphCandidate?.sceneDataAdmission,
        featureGraphCandidate?.sceneDataBindings,
      );
  return JSON.stringify({
    planRevision: featurePlanRevision,
    fullscreenEffects: Array.from(
      fullscreenEffects,
      ([id, entry]) => [id, postProcessShaderEntrySignature(entry)] as const,
    ),
    preparedResourceKey: preparedResourceKey ?? '',
    cubeCaptureSlots: stockRecording ? undefined : (cubeCaptureState?.work.length ?? 0),
    sceneDataAdmission: sceneData?.sceneDataAdmission?.identity,
    sceneDataBindings: sceneData?.sceneDataBindings,
  });
}

function gpuDrivenTopologySignatureOf(
  gpuDriven: GpuDrivenGraphProjection | undefined,
  ownedGpuRaster: boolean,
): string {
  if (gpuDriven === undefined) return '';
  return ownedGpuRaster
    ? (gpuDriven._recordingTopologySignature?.() ?? gpuDriven.topologySignature())
    : gpuDriven.topologySignature();
}

function forwardContactDemand(
  clearOnly: boolean,
  lighting: StandardTopologyInputValue | undefined,
): boolean {
  return !clearOnly && (lighting?.prepared.directional?.contactShadowLength ?? 0) > 0;
}

/** Fail closed before a requested MSAA graph can retain single-sample attachments. */
function admitMultisampleTopology(
  internals: RenderSystemInternals,
  camera: CameraSnapshot,
): Result<boolean, RhiError> {
  if (internals.device.caps.backendKind !== 'wgpu-webgl2') return ok(true);
  const multisample = multisampleRenderCapability(internals.device);
  if (!isMultisampleAntialias(camera.antialias) || multisample?.ok === true)
    return ok(multisample?.ok === true);
  return err(
    multisample?.ok === false
      ? multisample.error
      : new RhiError({
          code: 'rhi-texture-format-capability-unavailable',
          expected: 'a completed Standard MSAA4 HDR/depth resolve probe',
          hint: 'Wait for renderer readiness or recover the device before requesting MSAA.',
        }),
  );
}

/** Project both atmosphere modes from the same prepared environment source. */
function atmosphereTopologyOf(
  frame: RenderFrameState,
  clearOnly: boolean,
  perPixel: boolean | undefined,
) {
  const source = frame.environmentFrame?.source;
  const atmosphere = source?.kind === 'atmosphere';
  return {
    atmosphere: !clearOnly && atmosphere,
    atmosphereBackgroundOnly: atmosphere && source.atmosphere.backgroundOnly,
    perPixelAtmosphereTransmittance:
      !clearOnly && atmosphere && !source.atmosphere.backgroundOnly && perPixel !== false,
  };
}

function editorAssistanceTopology(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  clearOnly: boolean,
) {
  return clearOnly
    ? undefined
    : captureEditorAssistanceView(
        recordContext(internals).featureHost,
        internals.rendererFrameNumber ?? frameState.frameNumber,
        renderFeatureViewIdentity(camera),
        camera.outline,
      );
}

function compactGbufferRejection(
  internals: RenderSystemInternals,
  camera: CameraSnapshot,
  clearOnly: boolean,
  writers: ReturnType<typeof standardSceneGBufferWriters>,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  ssr: SsrSpatialAdmission | undefined,
): string | undefined {
  const incompatibleSceneData = featureGraphCandidate?.sceneDataBindings?.find(
    ({ schema, owners }) =>
      schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA ||
      owners.some((owner) => owner.featureIdentity !== MOTION_BLUR_FEATURE_IDENTITY),
  );
  let rejection: string | undefined;
  if (internals.standardSceneShaders?.compactGbuffer !== 'standard-gbuffer/4')
    rejection = 'Install a Default GBuffer lighting shader built for this device.';
  else if (!clearOnly && writers === undefined)
    rejection = 'Prepare the current view surface producer catalog before rendering.';
  else if (!clearOnly && writers?.incompatibleWriter !== undefined)
    rejection = `Use a Default GBuffer material for ${writers.incompatibleWriter}.`;
  else if (incompatibleSceneData !== undefined)
    rejection = `Use a feature that supports the Default GBuffer for ${incompatibleSceneData.schema}.`;
  else if (
    (camera.projectedDecals?.length ?? 0) !== 0 &&
    internals.standardSceneShaders?.compactDecals !== true
  )
    rejection = 'Install the Default GBuffer decal programs.';
  else if (
    ssr?.status === 'admitted' &&
    internals.ssrShaders?.compactGbuffer !== 'standard-gbuffer/4'
  )
    rejection = 'Install the Default GBuffer SSR programs.';
  return rejection;
}

function compactGbufferTopology(
  internals: RenderSystemInternals,
  format: 'default' | undefined,
  clearOnly: boolean,
  camera: CameraSnapshot,
  lights: ViewLights,
  hasTerrainReceivers: boolean,
  hasLocalProbes: boolean,
  surfaceAdmission: Parameters<typeof standardSceneGBufferWriters>[0],
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  ssr: SsrSpatialAdmission | undefined,
): Result<Pick<RenderPipelineTopology, 'compactGbuffer' | 'compactReceiver'>, RhiError> {
  if (format !== 'default') return ok({});
  const writers = standardSceneGBufferWriters(surfaceAdmission);
  const rejection = compactGbufferRejection(
    internals,
    camera,
    clearOnly,
    writers,
    featureGraphCandidate,
    ssr,
  );
  if (rejection !== undefined)
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'a view supported by the Default GBuffer format',
        hint: rejection,
      }),
    );
  const shadowConfig = lights.directionalCsmConfig;
  const projectedShadows =
    shadowConfig === undefined ||
    (shadowConfig.shadowViewProjection === undefined &&
      (shadowConfig.shadowBiasMode ?? 0) === 0 &&
      (lights.normalBias ?? 0) === 0 &&
      lights.cascades?.directionalShadowQuality?.kind === 'pcf-vogel');
  const compactGbuffer = 'standard-gbuffer/4';
  if (!projectedShadows || hasTerrainReceivers)
    return ok({ compactGbuffer, compactReceiver: 'geometry' });
  if (hasLocalProbes || writers?.receiverContext)
    return ok({ compactGbuffer, compactReceiver: 'context' });
  if (writers?.lightingChannels) return ok({ compactGbuffer, compactReceiver: 'channels' });
  return ok({ compactGbuffer });
}

function canUseDeferredPcf(
  internals: RenderSystemInternals,
  profile: RenderPipelineTopology['standardProfile'],
  lights: ViewLights,
): boolean {
  return (
    profile?.renderPath === 'deferred' &&
    internals.standardSceneShaders?.specializedDeferredLighting !== undefined &&
    leanLightingFrame(lights, undefined, undefined)
  );
}

function topologyOf(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  clearOnly: boolean,
  lights: ViewLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  passPlan: ViewPassPlan,
  volumetricFog: ExtractedVolumetricFog | undefined,
  standardLighting: StandardTopologyInputValue | undefined,
  ssr: SsrSpatialAdmission | undefined,
  renderExtent: RenderExtent | undefined,
  analyticFog: boolean,
  terrainReceivers: readonly TerrainShadowReceiver[] = [],
  subsurface?: RenderPipelineTopology['subsurface'],
  unfoggedOpaque = false,
  capsuleShadows = false,
  layersOwner?: ShadowDepthLayers,
): Result<RenderPipelineTopology, RhiError> {
  const shadow = fittedShadowTopology(
    internals,
    lights,
    shadowMapSize,
    terrainReceivers,
    layersOwner,
  );
  if (!shadow.ok) return shadow;
  const surfaceProfile = surfaceProfileOf(internals, pipelineState);
  if (!surfaceProfile.ok) return surfaceProfile;
  const fullscreenEffects = featureFullscreenEffects(frameState, featureGraphCandidate);
  const config = admitStandardAoConfig(
    internals,
    pipelineState,
    featurePostEffectConfig(frameState, featureGraphCandidate),
  );
  const standardProfile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const { vpBucket, effectiveCamera } = resolveViewportOutputState(frameState, camera);
  const editor = editorAssistanceTopology(internals, frameState, effectiveCamera, clearOnly);
  const multisample = admitMultisampleTopology(internals, effectiveCamera);
  if (!multisample.ok) return multisample;
  const waterView = featurePlansOf(frameState, featureGraphCandidate).find(
    (plan) =>
      plan.scope !== 'frame' &&
      plan.scope.view === renderFeatureViewIdentity(camera) &&
      plan.plan.waterView !== undefined,
  )?.plan.waterView;
  const surfaceAdmission =
    frameState.standardSceneSurfaceAdmission ?? featureGraphCandidate?.sceneDataAdmission;
  const inlineSsr = admitsInlineSsr(internals.device, pipelineState.extendedLightingAvailable, ssr);
  const reflectionFallback = reflectionFallbackDemandOf(internals);
  const probes = viewReflectionProbesOf(renderWorldFor(internals), internals.viewEntity);
  const hasLocalProbes =
    standardProfile?.renderPath === 'deferred' &&
    probes?.ok === true &&
    hasReferencedReadyProbe(probes.value.probes);
  const deferredLightProbes = !clearOnly && frameState.deferredLightProbes === true;
  const probeTopology = deferredLightProbes ? { deferredLightProbes: true as const } : {};
  const compact = compactGbufferTopology(
    internals,
    standardProfile?.gbufferFormat,
    clearOnly,
    camera,
    lights,
    terrainReceivers.length !== 0,
    hasLocalProbes || deferredLightProbes,
    surfaceAdmission,
    featureGraphCandidate,
    ssr,
  );
  if (!compact.ok) return compact;
  const projectedDecals = projectedDecalTopology(clearOnly ? [] : (camera.projectedDecals ?? []));
  const deferredPcf = canUseDeferredPcf(internals, standardProfile, lights)
    ? { deferredPcfLighting: true as const }
    : {};
  const capsuleTopology =
    standardProfile?.renderPath === 'deferred'
      ? { deferredCapsuleShadows: !clearOnly && capsuleShadows }
      : { forwardCapsuleShadows: !clearOnly && capsuleShadows };
  const publishViewTopology = (
    checkedShadow: Extract<typeof shadow, { ok: true }>,
    checkedSurfaceProfile: Extract<typeof surfaceProfile, { ok: true }>,
    checkedMultisample: Extract<typeof multisample, { ok: true }>,
  ): Result<RenderPipelineTopology, RhiError> => {
    const shadow = checkedShadow;
    const surfaceProfile = checkedSurfaceProfile;
    const multisample = checkedMultisample;
    const topology: RenderPipelineTopology = {
      pipelineId: STANDARD_PIPELINE_ID,
      ...(vpBucket === undefined ? {} : { viewportOutput: vpBucket }),
      ...sceneDataTopologyFields(surfaceAdmission, featureGraphCandidate?.sceneDataBindings),
      ...(subsurface === undefined ? {} : { subsurface: { quality: subsurface.quality } }),
      ...compact.value,
      forwardContactShadows: forwardContactDemand(clearOnly, standardLighting),
      ...capsuleTopology,
      projectedDecals,
      standardProfile,
      config,
      preTemporalEffects: preTemporalEffectsOf(config, fullscreenEffects),
      hdrOutputEffects: (config?.postEffects ?? []).filter(
        (identity) => fullscreenEffects.get(identity)?.stage === 'before-output',
      ),
      clearOnly,
      ...probeTopology,
      reflectionFallback: {
        enabled: reflectionFallback,
        ...(hasLocalProbes ? { localProbes: true } : {}),
      },
      ssr,
      ...(inlineSsr ? { inlineSsr: true } : {}),
      ...(renderExtent === undefined ? {} : { extent: renderExtent }),
      analyticFog: !clearOnly && analyticFog,
      surface: {
        width,
        height,
        storageFormat: pipelineState.format as TextureFormat,
        viewFormat: surfaceProfile.value.viewFormat as TextureFormat,
        profile: surfaceProfile.value,
      },
      camera: {
        ...cameraTopologyOf(
          effectiveCamera,
          clearOnly,
          editor === undefined ? effectiveCamera.outline : editor.authoredOutline,
          height,
        ),
        ...(editor === undefined
          ? {}
          : {
              editorAssistance: true,
              editorOutline: editor.source.outline !== undefined,
            }),
      },
      ...atmosphereTopologyOf(
        frameState,
        clearOnly,
        lights.directional?.perPixelAtmosphereTransmittance,
      ),
      output: outputTopologyOf(effectiveCamera, frameState, clearOnly),
      temporal: {
        taa: isTemporalAntialias(effectiveCamera.antialias),
        motionBlur: isMotionBlurTemporalDemand(effectiveCamera.motionBlur),
      },
      shadow: shadow.value,
      volumetricFog: volumetricFogTopologyOf(
        internals,
        lights,
        volumetricFog,
        renderInternalCopySize({ extent: renderExtent, surface: { width, height } }),
      ),
      lane: {
        compute: internals.device.caps.compute,
        storageTexture: internals.device.caps.storageTexture,
        storageBuffer: internals.device.caps.storageBuffer,
        multisample: multisample.value,
        maxColorAttachments: internals.device.caps.maxColorAttachments,
        primitiveIndex: internals.device.features.has('primitive-index'),
        maxColorAttachmentBytesPerSample: internals.device.limits.maxColorAttachmentBytesPerSample,
      },
      // Only the generic graph route compares Feature topology.
      featureTopologySignature: '',
      // Borrowed graph imports resolve their signature only after recording ownership is known.
      gpuDrivenTopologySignature: '',
      ...deferredPcf,
      // The view's RenderQueue pass plan is the only transmission, medium and
      // transparent-composition authority of the graph.
      transmissionDemand: passPlan.transmission.demand,
      ...(passPlan.transmission.singleLayerMedium ? { singleLayerMedium: true } : {}),
      ...(passPlan.transmission.water ? { water: true } : {}),
      ...(waterView === undefined
        ? {}
        : {
            waterView:
              waterView.kind === 'available'
                ? { kind: 'available' as const, underwater: waterView.state.immersionDepthM > 0 }
                : { kind: 'unavailable' as const },
          }),
      ...(passPlan.transparent.topology === undefined
        ? {}
        : { transparency: passPlan.transparent.topology }),
      opaque:
        passPlan.opaque ??
        planOpaque({
          renderPath: (standardProfile ?? DEFAULT_STANDARD_PROFILE).renderPath,
          gpuOcclusion: config?.gpuOcclusion,
          clearOnly,
        }),
      ...(!clearOnly && analyticFog && unfoggedOpaque ? { unfoggedOpaque: true } : {}),
    };
    return ok(
      withForwardShadowAdmission(
        topology,
        internals,
        frameState,
        passPlan,
        camera,
        standardLighting,
        lights.directionalCsmConfig,
      ),
    );
  };
  return publishViewTopology(shadow, surfaceProfile, multisample);
}

export function retire(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  if (frameState.retiredCompiledFrameGraphs.has(graph)) return;
  frameState.retiredCompiledFrameGraphs.add(graph);
  frameState.materialBgAssemblyCache.retirePassResources(boundRenderGraphResources(graph));
  setGraphGenerationRetiring(frameState, graph);
  const settle = (succeeded: boolean): void => {
    setGraphGenerationRetirementResult(frameState, graph, succeeded);
    frameState.retiredCompiledFrameGraphs.delete(graph);
  };
  void graph.retire().then(
    (result) => settle(result.ok),
    () => settle(false),
  );
}

/** What settling a view's adopted graph candidate did; `none` when it adopted no new graph. */
export type GraphCandidateSettlement = 'none' | 'promoted' | 'stashed' | 'rolled-back';

/**
 * An accepted view keeps its adopted graph: the graph it replaced, and a
 * stashed graph that may alias its resources, retire.
 */
export function promoteGraphCandidate(frameState: RenderFrameState): GraphCandidateSettlement {
  const candidate = frameState.compiledFrameGraphCandidate;
  if (candidate === undefined) return 'none';
  frameState.compiledFrameGraphCandidate = undefined;
  const previousGraph = candidate.previous.installed?.graph;
  if (previousGraph !== undefined && previousGraph !== candidate.installed.graph)
    retire(frameState, previousGraph);
  // A stashed graph may alias resources of the graph it was compiled
  // against; once another graph is accepted it can never be promoted.
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  frameState.unsubmittedCompiledFrameGraph = undefined;
  if (stashed !== undefined && stashed.graph !== candidate.installed.graph)
    retire(frameState, stashed.graph);
  frameState.shadowDepthLayers?.acceptSubmittedTextures(candidate.installed.graph);
  return 'promoted';
}

/**
 * A view that was not accepted reinstalls the graph its candidate replaced.
 * A candidate that only waited for pipeline preparation is stashed for its
 * topology key; any other fresh candidate retires.
 */
export function rollbackGraphCandidate(
  frameState: RenderFrameState,
  awaitingPreparation: boolean,
): GraphCandidateSettlement {
  const candidate = frameState.compiledFrameGraphCandidate;
  if (candidate === undefined) return 'none';
  const previous = candidate.previous;
  frameState.compiledFrameGraphCandidate = undefined;
  const candidateInstalled = frameState.compiledFrameGraph;
  let settlement: GraphCandidateSettlement = 'rolled-back';
  if (candidate.installed.graph !== previous.installed?.graph) {
    // Keep one compiled-but-unsubmitted graph for its topology key. A frame
    // that only waited for pipeline preparation must not recompile the same
    // graph on every following frame.
    const stashed = frameState.unsubmittedCompiledFrameGraph;
    if (stashed !== undefined && stashed.graph !== candidate.installed.graph)
      retire(frameState, stashed.graph);
    frameState.unsubmittedCompiledFrameGraph =
      awaitingPreparation && candidateInstalled === candidate.installed
        ? candidateInstalled
        : undefined;
    if (frameState.unsubmittedCompiledFrameGraph === undefined)
      retire(frameState, candidate.installed.graph);
    else settlement = 'stashed';
  }
  frameState.compiledFrameGraph = previous.installed;
  frameState.graphGeneration = previous.graphGeneration;
  frameState.barrelDistortionGraphResolution =
    previous.installed === null ? 'accepted' : 'retained';
  return settlement;
}

/**
 * Drop every compiled graph this frame state owns at a renderer generation cut
 * (dispose or device recovery): roll back an unsubmitted candidate, retire the
 * installed graph, and forget graphs whose retirement is already in flight.
 */
export function discardCompiledFrameGraphs(frameState: RenderFrameState): void {
  rollbackGraphCandidate(frameState, false);
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  frameState.unsubmittedCompiledFrameGraph = undefined;
  if (stashed !== undefined) retire(frameState, stashed.graph);
  const installed = frameState.compiledFrameGraph;
  frameState.compiledFrameGraph = null;
  if (installed !== null) retire(frameState, installed.graph);
  frameState.retiredCompiledFrameGraphs.clear();
}

function featurePlansOf(
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
): readonly RenderFeaturePlannedFrame[] {
  return candidate?.plans ?? viewFeaturesOf(frameState).work.plans;
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
  return graphCameraWithViewportOutput(camera, frameDepthOfField, frameState);
}

function ownsDeclaredViewWork(entry: RenderFeaturePlannedFrame): boolean {
  const plan = entry.plan;
  return plan.passes.length !== 0 || plan.resources.length !== 0 || plan.waterView !== undefined;
}

/** A shared graph owns whole plans. Borrow the validated roster unless it needs partitioning. */
function viewFeaturePlans(
  work: ViewFeatureWork,
  shared: SharedFeatureGraphPublication | undefined,
) {
  if (shared === undefined) return work;
  const { plans, executions } = work;
  let selected:
    | { plans: RenderFeaturePlannedFrame[]; executions: RenderFeaturePlanExecution[] }
    | undefined;
  for (let i = 0; i < executions.length; i++) {
    const execution = executions[i] as RenderFeaturePlanExecution;
    const passes = execution.passes;
    if (passes.length !== 0 && passes.every((pass) => shared.passes.has(pass))) {
      selected ??= { plans: plans.slice(0, i), executions: executions.slice(0, i) };
    } else if (selected !== undefined) {
      selected.plans.push(plans[i] as RenderFeaturePlannedFrame);
      selected.executions.push(execution);
    }
  }
  return selected ?? work;
}

function cloudHistoryFormatOf(
  plans: readonly RenderFeaturePlanExecution[],
): CloudTransportFormat | undefined {
  for (const execution of plans) {
    if (execution.featureIdentity !== CLOUD_LAYER_FEATURE_IDENTITY) continue;
    const transport = execution.passes.find((pass) => pass.name === 'cloud-layer-transport');
    if (transport !== undefined)
      return transport.graphics?.attachments.colors[0]?.format === 'rgba32float'
        ? 'rgba32float'
        : 'rgba16float';
    if (execution.passes.some((pass) => pass.name === 'cloud-layer-resolve')) return 'rgba16float';
  }
  return undefined;
}

/** Ordered Standard views admit renderer-owned Water and Cloud plans. */
function orderedCloudHistoryFormat(
  plans: readonly RenderFeaturePlannedFrame[],
  executions: readonly RenderFeaturePlanExecution[],
  output: DisplayOutput | undefined,
  topology: RenderPipelineTopology,
  shared: SharedFeatureGraphPublication | undefined,
): CloudTransportFormat | undefined | false {
  if (shared !== undefined && (topology.water !== true || shared.hasAdditionalFrameWork))
    return false;
  let active = false;
  for (const entry of plans) {
    if (!ownsDeclaredViewWork(entry) || (topology.water === true && isStandardWaterPlan(entry)))
      continue;
    if (!isStandardCloudPlan(entry)) return false;
    active = true;
  }
  if (!active) return undefined;
  if (
    (output !== 'standard' && output !== 'deferred') ||
    (topology.lane.multisample && isMultisampleAntialias(topology.camera.antialias))
  )
    return false;
  return cloudHistoryFormatOf(executions) ?? false;
}

function viewFeatureResourceBindings(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  featureProjection: ReturnType<typeof createRenderFeatureProjectionState>,
  featureExecutions: readonly RenderFeaturePlanExecution[],
  currentView: string,
): Pick<
  RenderPipelineBuildContext<RenderPipelineFrame>,
  | 'getFeatureGraphTextureView'
  | 'getFeatureGraphTextureFormat'
  | 'getFeatureGraphTextureBinding'
  | 'getFeatureGraphTextureBindings'
  | 'getWaterMeshGraphAccesses'
> {
  let waterMeshAccesses: ReturnType<typeof collectWaterMeshAccesses> | undefined;
  function collectWaterMeshAccesses() {
    const scope = featureScopeKey({ view: currentView });
    const accesses: import('@forgeax/engine-render-graph').GraphAccess[] = [];
    const visited = new Set<import('@forgeax/engine-rhi').Buffer>();
    for (const execution of featureExecutions) {
      if (execution.featureIdentity !== WATER_GPU_MESH_FEATURE || execution.scope !== scope)
        continue;
      for (const pass of execution.passes)
        for (const buffer of pass.gpuCompute?.dispatches.some(
          (dispatch) => dispatch.entryPoint === 'scatter',
        )
          ? (pass.resolvedGpuCompute?.buffers ?? [])
          : []) {
          if (
            visited.has(buffer.buffer) ||
            (buffer.access !== 'storage-write' && buffer.access !== 'storage-read-write')
          )
            continue;
          visited.add(buffer.buffer);
          const imported = importRenderFeatureGraphBuffer(
            builder,
            featureProjection.buffers,
            buffer.name,
            buffer,
          );
          if (!imported.ok) throw imported.error;
          accesses.push({
            resource: imported.value,
            usage:
              (buffer.physicalUsage & GPU_BUFFER_USAGE_INDIRECT) !== 0
                ? 'indirect-read'
                : 'storage-read',
          });
        }
    }
    return accesses;
  }
  return {
    getFeatureGraphTextureView: (name, viewIdentity) =>
      scopedGraphTextureTarget(featureProjection.graphTextures, name, viewIdentity)?.[1].view,
    getFeatureGraphTextureFormat: (name, viewIdentity) => {
      const match = scopedGraphTextureTarget(featureProjection.graphTextures, name, viewIdentity);
      return match === undefined ? undefined : (match[0].view?.format ?? match[0].format);
    },
    getFeatureGraphTextureBinding: (name, viewIdentity) => {
      const match = scopedGraphTextureTarget(featureProjection.graphTextures, name, viewIdentity);
      if (match === undefined) return undefined;
      const [target, resolved] = match;
      const format = target.view?.format ?? target.format;
      return format === undefined ? undefined : { view: resolved.view, format };
    },
    getFeatureGraphTextureBindings: (prefix, viewIdentity, materialSourcesOnly = false) => {
      const scope = featureScopeKey({ view: viewIdentity });
      const result = new Map<
        string,
        Readonly<{
          view: GraphTextureView;
          format: import('@forgeax/engine-rhi').TextureFormat;
        }>
      >();
      for (const [target, resolved] of featureProjection.graphTextures.targets) {
        const name = target.name;
        if (
          resolved.scope !== scope ||
          !name?.startsWith(prefix) ||
          (materialSourcesOnly && target.materialSource !== true)
        )
          continue;
        const format = target.view?.format ?? target.format;
        if (format !== undefined) result.set(name, { view: resolved.view, format });
      }
      return result;
    },
    getWaterMeshGraphAccesses: () => (waterMeshAccesses ??= collectWaterMeshAccesses()),
  };
}

function waterImmersion(topology: RenderPipelineTopology): WaterDisplayPorts['immersion'] {
  const water = topology.waterView;
  if (water?.kind !== 'available') return 'unavailable';
  return water.underwater ? 'underwater' : 'surface';
}

function orderedWaterViewIdentity(
  topology: RenderPipelineTopology,
  camera: CameraSnapshot,
): string {
  return topology.water === true ? renderFeatureViewIdentity(camera) : '';
}

function waterDisplayPorts(
  topology: RenderPipelineTopology,
  viewIdentity: string,
  planRevision: number,
  preparedResourceKey: string | undefined,
  shared: SharedFeatureGraphPublication | undefined,
): WaterDisplayPorts | undefined {
  if (topology.water !== true) return undefined;
  return {
    viewIdentity,
    immersion: waterImmersion(topology),
    planRevision,
    preparedResourceKey,
    sharedTextures: shared?.topologyKey,
    fluid: waterFluidMaterialTopology(shared?.waterFluid.get(viewIdentity)),
  };
}

function matchesWaterDisplayPorts(
  current: WaterDisplayPorts | undefined,
  topology: RenderPipelineTopology,
  viewIdentity: string,
  planRevision: number,
  preparedResourceKey: string | undefined,
  shared: SharedFeatureGraphPublication | undefined,
) {
  if (topology.water !== true) return current === undefined && shared === undefined;
  return (
    current !== undefined &&
    current.viewIdentity === viewIdentity &&
    current.immersion === waterImmersion(topology) &&
    current.planRevision === planRevision &&
    current.preparedResourceKey === preparedResourceKey &&
    current.sharedTextures === shared?.topologyKey &&
    matchesWaterFluidMaterialTopology(current.fluid, shared?.waterFluid.get(viewIdentity))
  );
}

function orderedFeatureContribution(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  topology: RenderPipelineTopology,
  ports: DisplayPorts,
  executions: readonly RenderFeaturePlanExecution[],
  sharedPublication: SharedFeatureGraphPublication | undefined,
): Omit<Partial<RenderPipelineBuildContext<RenderPipelineFrame>>, 'graph'> {
  if (ports.cloud === undefined && ports.water === undefined)
    return { hasFeatureWork: () => false };
  const featureProjection = createRenderFeatureProjectionState();
  const sharedTextures = importSharedGraphTextures(
    builder,
    sharedPublication,
    featureProjection.graphTextures,
    readSharedFeatureGraph,
  );
  // These executions are issued by the frame owner before the first view.
  for (const pass of sharedPublication?.passes ?? []) featureProjection.projected.add(pass);
  const viewIdentity = ports.water?.viewIdentity;
  const fluid =
    viewIdentity === undefined ? undefined : sharedPublication?.waterFluid.get(viewIdentity);
  const featurePostProcessEntries = new Map();
  const fullscreenFeatureIds = new Set<string>();
  const contribute = standardFeatureContribution({
    internals,
    frameState,
    builder,
    projectedFeaturePlans: executions,
    featurePostProcessEntries,
    fullscreenFeatureIds,
    featureProjection,
    sceneDataDepthViews: new Map(),
    transientViews: new Set(),
    transientSlots: new Map(),
    sceneInputs: undefined,
    surfaceSize: topology.surface,
    reportError: (error) => reportRenderFeatureGraphError(internals, error),
  });
  const cloud = ports.cloud;
  return {
    ...(cloud === undefined
      ? {}
      : {
          cloudHistory: importCloudHistoryTargets(builder, cloud.format, cloud.depthFormat),
          cloudShadowFormat: cloud.shadowFormat,
          ...(cloud.shadowLayout === undefined ? {} : { cloudShadowLayout: cloud.shadowLayout }),
          capabilities: internals.device.caps,
        }),
    ...(viewIdentity === undefined
      ? {}
      : {
          viewIdentity,
          ...viewFeatureResourceBindings(builder, featureProjection, executions, viewIdentity),
          getSharedGraphTextureBinding: (name) => sharedTextures.get(`frame:${name}`),
          ...(fluid === undefined
            ? {}
            : { waterFluid: { publication: fluid, read: waterFluidForRecording(viewIdentity) } }),
          afterTonemapOutput: standardAfterTonemapOutput(
            executions,
            fullscreenFeatureIds,
            topology.surface.storageFormat,
          ),
        }),
    contributeFeatures: contribute,
    hasFeatureWork: (identity, placement) =>
      executions.some(
        (execution) =>
          (identity === undefined || execution.featureIdentity === identity) &&
          execution.passes.length > 0 &&
          (placement === undefined || (execution.placement ?? 'post') === placement),
      ),
    hasFeatureRasterWork: (identity, placement, passName, sampledTarget) =>
      executions.some(
        (execution) =>
          execution.featureIdentity === identity &&
          (placement === undefined || execution.placement === placement) &&
          execution.passes.some(
            (pass) =>
              pass.graphics !== undefined &&
              (passName === undefined || pass.name === passName) &&
              (sampledTarget === undefined ||
                pass.graphics.sampledTargets?.some(
                  (target) =>
                    typeof target === 'object' && 'name' in target && target.name === sampledTarget,
                ) === true),
          ),
      ),
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
          entry.stage === 'before-temporal' || entry.stage === 'before-output'
            ? 'rgba16float'
            : (topology.surface.storageFormat as GPUTextureFormat),
        ],
        entry,
      ) !== null
    );
  });
}

function pendingPostChainOutcome(
  frame: number,
  installed: InstalledFrameGraph | null,
  recover: () => CompiledRenderGraph<RenderPipelineFrame> | null,
  effects: () => GraphEffects,
): ViewGraphCompileOutcome | undefined {
  if (installed?.displayPorts !== undefined)
    return { frame, kind: 'rejected', code: 'post-chain-pending', effects: effects() };
  const graph = recover();
  return graph === null
    ? undefined
    : { frame, kind: 'retained', graph, reason: 'post-chain-pending', effects: effects() };
}

function withoutPostEffects(topology: RenderPipelineTopology): RenderPipelineTopology {
  return {
    ...topology,
    preTemporalEffects: [],
    hdrOutputEffects: [],
    config: {
      ...(topology.config ?? {}),
      postEffects: [],
    },
  };
}

function topologyForPostProcessAdmission(
  topology: RenderPipelineTopology,
  pending: boolean,
): RenderPipelineTopology {
  return pending ? withoutPostEffects(topology) : topology;
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
    // An atlas filter or array copy reads probe-owned textures and never samples shadow maps.
    reflectionProbes: cubeCaptureState?.reflectionProbes?.work.some(
      (work) => work.rawCaptureFace !== undefined,
    )
      ? 1
      : 0,
    planarReflection: cubeCaptureState?.planar?.current() !== undefined,
    featureSceneInputs: recordContext(internals).featureSceneInputs?.work.length ?? 0,
  });
}

/** An identity-bound copy observes a specific installed allocation. It cannot
 * request a new graph generation or change a transient target's lifetime. */
function captureLayoutFor(frameState: RenderFrameState): GraphCaptureLayout | undefined {
  const capture = frameState.graphTargetCapture;
  if (capture === undefined) return undefined;
  if (capture.kind === 'pass-replay') return ['pass-replay', capture.targetName];
  return capture.expected.identity === undefined
    ? capture.name
    : frameState.compiledFrameGraph?.captureLayout;
}

function frameGraphCacheKey(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  topologyIdentity: ReturnType<typeof frameGraphTopologyIdentity>,
  captureLayout: GraphCaptureLayout | undefined,
  gpuDrivenProjectionActive: boolean,
  cloudShadowLayout: CloudShadowSpatialLayout | undefined,
  cloudHistoryFormat: CloudTransportFormat | undefined,
  cubeCaptureState: CubeCaptureGraphState | undefined,
  sharedPublication: SharedFeatureGraphPublication | undefined,
  fluid: WaterFluidMaterialPublication | undefined,
  display: boolean,
  cullShadowReceivers: boolean | undefined,
): string {
  const irradianceField = irradianceFieldInput(internals, frameState);
  const screenProbe = frameState.screenProbe?.ready;
  const probePlacement = frameState.probePlacementFrame;
  const declaredProbes =
    display && captureLayout === undefined ? undefined : cubeCaptureState?.reflectionProbes;
  const input = {
    captureTarget: captureLayout,
    forwardTarget: standardForwardTargetKey(frameState.activePipeline),
    // Custom builders may inspect arbitrary profile fields when declaring work.
    configurationRevision: display ? undefined : internals.standardProfile?.configurationRevision,
    quality: internals.standardProfile?.quality,
    topology: topologyIdentity,
    // Internal conformance stage changes the raw GTAO graph node and its storage usage.
    gtaoExecutionOverride: frameState.gtaoExecutionOverride,
    // Observation domains are an explicit per-frame graph demand.  They are
    // part of the cache identity so a request made after the ordinary graph
    // was compiled can admit the matching tone/output capture boundaries on
    // that receipt without forcing every unobserved frame onto the split
    // output path.
    observationCaptureDomains: [
      ...(recordContext(internals).observationCaptureDomains ?? []),
    ].sort(),
    // GPU-driven residency can become available after the first record pass
    // (custom mesh handles are resolved into the per-frame projection).  The
    // topology signature alone is intentionally stable across that lifecycle,
    // so include the prepared projection's presence to invalidate a cached
    // CPU-only graph when the GPU owner becomes ready, and vice versa.
    gpuDrivenProjectionActive,
    retainIndirectBundles: internals.options?.retainIndirectBundles === true || undefined,
    rayDiffuseGeneration: frameState.rayDiffuse?.ready?.generation,
    irradianceField:
      irradianceField === undefined ? undefined : irradianceFieldGraphShape(irradianceField),
    screenProbe: screenProbe === undefined ? undefined : screenProbeGraphShape(screenProbe),
    // Authored builders may admit the contribution only once the source is available.
    bakedField:
      (!display &&
        captureLayout === undefined &&
        bakedFieldInput(internals, frameState) !== undefined) ||
      undefined,
    probePlacement:
      probePlacement === undefined
        ? undefined
        : [probePlacement.count, probePlacement.recordBytes, probeGlobalGraphShape(probePlacement)],
    featureSceneInputs: recordContext(internals).featureSceneInputs?.topologyKey,
    sharedGraphTextures: sharedPublication?.topologyKey,
    waterFluid: waterFluidMaterialTopology(fluid),
    // Cloud shadow targets are quality-derived graph resources. Include the
    // resolved texel grid in the cache key so a quality/resize change cannot
    // reuse a graph compiled for the previous allocation.
    cloudShadowLayout,
    cloudShadowFormat:
      cloudShadowLayout === undefined ? undefined : selectCloudShadowFormat(internals.device.caps),
    cloudHistory: cloudHistoryFormat,
    // Each capture view declares its own faces and attachment shape. The stock display
    // only consumes the resulting receiver-culling policy and retained planar input.
    cullShadowReceivers,
    cubeCaptureSlots: display
      ? undefined
      : cubeCaptureState?.work.map((work) => ({
          descriptor: work.physical.descriptor,
          mipLevel: work.mipLevel ?? 0,
          explicitWrite: work.write,
          planar: work.faceCamera.planarReflection !== undefined,
          // A volume slice is a render-pass attachment fact, not a resolved view.
          depthSlice: work.physical.descriptor.shape === '3d' ? work.layer : undefined,
        })),
    planarRetained: cubeCaptureState?.planar?.current()?.physical.descriptor,
    reflectionPmremMigrations: declaredProbes?.migrations?.map((ticket) => [
      ticket.key,
      ticket.target.generation,
      ticket.source.capacity,
      ticket.target.capacity,
    ]),
    reflectionProbeSlots: declaredProbes?.work.map((work) => [
      work.probeIndex,
      work.captureGeneration ?? 0,
      work.filteredLayer ?? 0,
      work.filteredArrayLayers ?? 1,
      work.filteredGeneration ?? 0,
      display ? -1 : (work.rawCaptureFace ?? -1),
      work.step?.faceIndex ?? -1,
      work.step?.mipLevel ?? -1,
    ]),
  };
  return serializeFrameGraphKey(input);
}

function waterFluidForRecording(viewIdentity: string) {
  return (frame: RenderPipelineFrame): WaterFluidMaterialPublication | undefined => {
    const internal = frame as _InternalRenderPipelineContext;
    const current = internal.sharedFeatureGraph?.waterFluid.get(viewIdentity);
    return current !== undefined &&
      current.render.frameNumber ===
        (internal.runtime.rendererFrameNumber ?? internal.frameState.frameNumber) &&
      current.render.deviceGeneration === recordContext(internal.runtime).deviceScope.generation
      ? current
      : undefined;
  };
}

type StandardGraphInputs = Pick<
  RenderPipelineBuildContext<RenderPipelineFrame>,
  | 'standardOutput'
  | 'taaHistory'
  | 'cloudHistory'
  | 'targetCoverage'
  | 'waterSsr'
  | 'ssrSceneColorHistory'
  | 'ssrSceneColorOutput'
>;

function importColorLutSource(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
): Result<StandardLutGraphProjection, RenderGraphError> | undefined {
  const prepared = frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
  if (prepared === undefined) return undefined;
  function binding(frame: RenderPipelineFrame) {
    const state = (frame as _InternalRenderPipelineContext).frameState;
    const current = state.pendingStandardLutGpuResources ?? state.standardLutGpuResources;
    if (current === undefined)
      throw new Error('Standard LUT binding unavailable for accepted frame');
    return current;
  }
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
    (frame) => binding(frame).texture,
  );
  if (!texture.ok) return texture;
  const view = builder.importView(
    texture.value,
    { label: 'standard-color-lut-source.view', dimension: '3d' },
    (frame) => binding(frame).view,
  );
  if (!view.ok) return view;
  return ok({
    view: view.value,
    strength: prepared.strength,
    bind: binding,
  });
}

function importStandardOutputInputs(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  topology: RenderPipelineTopology,
): Result<Pick<StandardGraphInputs, 'standardOutput'>, RenderGraphError> {
  const autoExposure =
    topology.output?.autoExposure === true
      ? importAutoExposureGraphResources(builder, standardAutoExposureMode(topology.lane))
      : undefined;
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

function importStandardTemporalHistory(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Pick<StandardGraphInputs, 'taaHistory'> {
  const { antialias } = topology.camera;
  if (!isTemporalAntialias(antialias)) return {};
  const tsr = antialias === 'tsr';
  return {
    taaHistory: importTemporalHistoryTargets(
      builder,
      tsr ? 'tsr' : 'taa',
      tsr && usesTsrCompute(topology.lane),
    ),
  };
}

function declareStandardCoverage(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<Pick<StandardGraphInputs, 'targetCoverage'>, RenderGraphError> {
  const extent = displayCoverageExtent(topology);
  if (extent === undefined) return ok({});
  const coverage = createTargetCoverageAttachment(builder, extent);
  return coverage.ok ? ok({ targetCoverage: coverage.value }) : coverage;
}

function importOrderedPlanar(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  descriptor: DisplayPorts['planar'],
) {
  if (descriptor === undefined) return ok(undefined);
  return importPlanarCaptureView(builder, descriptor, (frame) => {
    const physical = (frame as _InternalRenderPipelineContext).planarReflectionPhysical;
    if (physical === undefined) throw new Error('The selected planar capture is unavailable');
    return physical;
  });
}

function encodeStandardTransmissionMip(
  internals: RenderSystemInternals,
): NonNullable<RenderPipelineBuildContext<RenderPipelineFrame>['encodeTransmissionMip']> {
  return ({ pass, resources, source, format }) => {
    const view = resources.textureView(source).unwrap();
    encodeMipmapLevel(internals.device, pass, view, format).unwrap();
  };
}

function buildOrderedDisplay(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  output: DisplayOutput,
  lighting: StandardTopologyInputValue,
  ports: DisplayPorts,
  frameState: RenderFrameState,
  shadowDepthLayers: ShadowDepthLayers,
  internals: RenderSystemInternals,
  outputStages: number,
  pipelineState: Parameters<typeof captureNativeGraphInputs>[1],
  executions: readonly RenderFeaturePlanExecution[],
  sharedPublication: SharedFeatureGraphPublication | undefined,
): ReturnType<typeof buildForwardDisplay> {
  const inputs = importStandardOutputInputs(builder, frameState, topology);
  if (!inputs.ok) return inputs;
  const coverage = declareStandardCoverage(builder, topology);
  if (!coverage.ok) return coverage;
  const waterSsr = ports.water !== undefined && isWaterSsrAdmitted(topology.ssr);
  const history = importStandardViewHistories(builder, topology, waterSsr);
  if (!history.ok) return history;
  const planar = importOrderedPlanar(builder, ports.planar);
  if (!planar.ok) return planar;
  const post = {
    ...(ports.medium === 0 && ports.water === undefined
      ? {}
      : { encodeTransmissionMip: encodeStandardTransmissionMip(internals) }),
    ...inputs.value,
    ...(planar.value === undefined ? {} : { planarReflection: planar.value }),
    ...history.value,
    ...coverage.value,
    ...(ports.water === undefined
      ? {}
      : { nativeInputs: captureNativeGraphInputs(internals, pipelineState) }),
    ...orderedFeatureContribution(
      builder,
      internals,
      frameState,
      topology,
      ports,
      executions,
      sharedPublication,
    ),
    ...(waterSsr ? { waterSsr: { inputParams: importWaterSsrInputParams(builder) } } : {}),
    outputStages,
  };
  const retainBundles = internals.options?.retainIndirectBundles === true;
  const { caps } = internals.device;
  return output === 'deferred'
    ? buildDeferredDisplay(
        builder,
        topology,
        lighting,
        ports,
        frameState,
        shadowDepthLayers,
        retainBundles,
        caps,
        post,
      )
    : buildForwardDisplay(
        builder,
        topology,
        output,
        lighting,
        ports,
        frameState,
        shadowDepthLayers,
        retainBundles,
        caps,
        post,
      );
}

/** Renderer-owned output resources and histories imported into a new graph, in import order. */
function importStandardGraphInputs(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  topology: RenderPipelineTopology,
  cloudHistoryFormat: CloudTransportFormat | undefined,
  ssr: SsrSpatialAdmission | undefined,
): Result<StandardGraphInputs, RenderGraphError> {
  const standardOutput = importStandardOutputInputs(builder, frameState, topology);
  if (!standardOutput.ok) return standardOutput;
  const cloudHistory =
    cloudHistoryFormat === undefined
      ? undefined
      : importCloudHistoryTargets(
          builder,
          cloudHistoryFormat,
          cloudMode0DepthFormat(topology.standardProfile),
        );
  const coverage = declareStandardCoverage(builder, topology);
  if (!coverage.ok) return coverage;
  const waterSsr = topology.water === true && isWaterSsrAdmitted(ssr) ? ssr : undefined;
  const history = importStandardViewHistories(builder, topology, waterSsr !== undefined);
  if (!history.ok) return history;
  return ok({
    ...standardOutput.value,
    ...history.value,
    ...(cloudHistory === undefined ? {} : { cloudHistory }),
    ...coverage.value,
    ...(waterSsr === undefined
      ? {}
      : { waterSsr: { inputParams: importWaterSsrInputParams(builder) } }),
  });
}

/** SSR and temporal AA share a graph port when they sample the same accepted color. */
function importStandardViewHistories(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  waterNeedsHistory: boolean,
): Result<
  Pick<StandardGraphInputs, 'taaHistory' | 'ssrSceneColorHistory' | 'ssrSceneColorOutput'>,
  RenderGraphError
> {
  const history = importStandardTemporalHistory(builder, topology);
  if (history.taaHistory !== undefined) {
    const deferred = topology.ssr?.status === 'admitted' && topology.ssr.lane === 'deferred';
    return topology.inlineSsr || deferred || waterNeedsHistory
      ? ok({ ...history, ssrSceneColorHistory: history.taaHistory.previousColor })
      : ok(history);
  }
  const { width, height } = topology.surface;
  return topology.inlineSsr ? importSsrSceneColorTargets(builder, width, height) : ok(history);
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
  baked: boolean,
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
  if (baked) {
    return { contributeDiffuseGi: (targets) => addBakedFieldPasses(builder, targets) };
  }
  return {};
}

/** Retained import readers must not capture a view compilation's previous graph. */
function readSharedFeatureGraph(frame: RenderPipelineFrame) {
  return (frame as _InternalRenderPipelineContext).sharedFeatureGraph;
}

function declaredViewPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  preparesStockShadows: boolean,
): Pick<
  InstalledFrameGraph,
  'scenePasses' | 'scenePipelinePreparations' | 'requiresShadowPipelinePreparation'
> {
  const prepareShadow = preparesStockShadows ? shadowPipelinePreparationDemand(builder) : undefined;
  return {
    scenePasses: scenePassRequests(builder),
    scenePipelinePreparations: scenePipelinePreparations(builder),
    ...(prepareShadow === undefined ? {} : { requiresShadowPipelinePreparation: prepareShadow }),
  };
}

/** The ordered procedure yields the native target owner without a generated lookup layer. */
function orderedDisplayBinding(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  graph: BoundRenderGraphRecording<RenderPipelineFrame>,
  input: Pick<
    InstalledFrameGraph,
    | 'deviceScope'
    | 'topologyKey'
    | 'standardLighting'
    | 'configurationRevision'
    | 'forwardDirectionalShadow'
    | 'forwardShadowCoverage'
    | 'atmosphereTransport'
  > & { readonly displayPorts: DisplayPorts },
  shadowDepthLayers: ShadowDepthLayers,
  topology: RenderPipelineTopology,
  preparedResourceKey: string | undefined,
  gpu: import('../render-pipeline').RenderPipelineGpuDrivenProjection | undefined,
): InstalledFrameGraph {
  const waterFluidBodyDescriptor =
    input.displayPorts.water === undefined ? undefined : waterFluidBodyDescriptorReader(builder);
  return {
    ...(waterFluidBodyDescriptor === undefined ? {} : { waterFluidBodyDescriptor }),
    ...input,
    ...declaredViewPasses(builder, true),
    graph,
    nativeResources: graph.nativeResources,
    targets: graph,
    ...boundViewInspection(graph, topology),
    ...(input.displayPorts.volume === undefined
      ? {}
      : { volumetricFogTextures: bindVolumetricFogTextures(graph) }),
    ...(input.displayPorts.directional || input.displayPorts.spotMapSize > 0
      ? { displayShadowDepthLayers: shadowDepthLayers }
      : {}),
    directionalShadowViewCount: input.displayPorts.directional ? 'current' : 0,
    hasBarrelDistortionPass: compiledRenderGraphHasPass(graph, 'barrel-distortion'),
    ...(preparedResourceKey === undefined ? {} : { preparedResourceKey }),
    ...(gpu?.preparePipelines === undefined
      ? {}
      : { prepareGpuDrivenPipelines: gpu.preparePipelines }),
    ...(gpu?.prepareSource === undefined ? {} : { prepareGpuDrivenSource: gpu.prepareSource }),
  };
}

const TRANSMISSION_BACKDROP_DECLARATION = ['transmission-backdrop'] as const;

function boundViewInspection(
  graph: BoundRenderGraphRecording<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Pick<InstalledFrameGraph, 'depthOfField' | 'ambientOcclusion' | 'transmissionBackdrop'> {
  const shape = topology.camera.depthOfField;
  const backdrop =
    (topology.transmissionDemand?.activeCount ?? 0) > 0
      ? compiledRenderGraphResourceDeclarations(graph, TRANSMISSION_BACKDROP_DECLARATION)[0]
      : undefined;
  const descriptor = backdrop?.descriptor;
  return {
    ...(shape === undefined ? {} : { depthOfField: inspectDepthOfFieldGraph(graph, shape) }),
    ...(topology.config?.ambientOcclusion?.enabled === true
      ? { ambientOcclusion: bindAmbientOcclusionViewFacts(graph) }
      : {}),
    ...(descriptor?.kind === 'texture'
      ? {
          transmissionBackdrop: {
            extent: { width: descriptor.width, height: descriptor.height },
            format: descriptor.format,
            mipCount: descriptor.mipLevelCount,
            bytes:
              backdrop?.byteSize ??
              estimateTransmissionBackdropBytes(
                descriptor,
                descriptor.mipLevelCount,
                descriptor.format,
              ),
          },
        }
      : {}),
  };
}

function featureTargetAccess(
  graph: BoundRenderGraphRecording<RenderPipelineFrame>,
  aliases: ReadonlyMap<string, string>,
): InstalledFrameGraph['targets'] {
  if (aliases.size === 0) return graph;
  const resolve = (name: string): string => {
    const alias = aliases.get(name);
    return alias !== undefined && graph.getColorTargetTexture(name) === undefined ? alias : name;
  };
  return {
    getColorTargetDescriptor: (name) => graph.getColorTargetDescriptor(resolve(name)),
    getColorTargetView: (name) => graph.getColorTargetView(resolve(name)),
    getColorTargetTexture: (name) => graph.getColorTargetTexture(resolve(name)),
    graphGeneration: graph.graphGeneration,
  };
}

function installedFrameGraphOf(
  deviceScope: InstalledFrameGraph['deviceScope'],
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  graph: BoundRenderGraphRecording<RenderPipelineFrame>,
  topologyKey: FrameGraphIdentity,
  topology: RenderPipelineTopology,
  captureLayout: GraphCaptureLayout | undefined,
  preparedResourceKey: string | undefined,
  stockRecording: boolean,
  prepareGpuDrivenPipelines: InstalledFrameGraph['prepareGpuDrivenPipelines'],
  prepareGpuDrivenSource: InstalledFrameGraph['prepareGpuDrivenSource'],
  directionalShadowViewCount: InstalledFrameGraph['directionalShadowViewCount'],
  featureTextureAliases: ReadonlyMap<string, string>,
  configurationRevision: number | undefined,
  receiverTransport: Pick<
    InstalledFrameGraph,
    'atmosphereTransport' | 'forwardDirectionalShadow' | 'forwardShadowCoverage'
  >,
  standardLighting: InstalledFrameGraph['standardLighting'],
): InstalledFrameGraph {
  const waterFluidBodyDescriptor = waterFluidBodyDescriptorReader(builder);
  return {
    ...(captureLayout === undefined ? {} : { captureLayout }),
    ...(waterFluidBodyDescriptor === undefined ? {} : { waterFluidBodyDescriptor }),
    ...(prepareGpuDrivenPipelines === undefined ? {} : { prepareGpuDrivenPipelines }),
    ...(prepareGpuDrivenSource === undefined ? {} : { prepareGpuDrivenSource }),
    hasBarrelDistortionPass: compiledRenderGraphHasPass(graph, 'barrel-distortion'),
    ...declaredViewPasses(builder, stockRecording),
    ...boundViewInspection(graph, topology),
    ...(topology.volumetricFog?.enabled === true
      ? { volumetricFogTextures: bindVolumetricFogTextures(graph) }
      : {}),
    ...(directionalShadowViewCount === undefined ? {} : { directionalShadowViewCount }),
    directionalShadowWriterPasses: compiledRenderGraphPassCountByPrefix(graph, 'shadowCascade'),
    graph,
    nativeResources: graph.nativeResources,
    deviceScope,
    standardLighting,
    configurationRevision,
    ...receiverTransport,
    topologyKey,
    retainedPolicy: retainedFrameGraphPolicy(topology),
    ...(preparedResourceKey === undefined ? {} : { preparedResourceKey }),
    targets: featureTargetAccess(graph, featureTextureAliases),
  };
}

/** @internal Stock graph adapter exposed to backend conformance fixtures. */
export function pipelineBuildOf(
  activePipeline: RenderFrameState['activePipeline'],
  stockRecording: boolean,
  gtaoExecutionOverride?: RenderFrameState['gtaoExecutionOverride'],
  viewportOutput?: import('../viewport-output-contract').ViewportOutputExtension,
): RenderFrameState['activePipeline']['build'] {
  // Direct and custom graph builds cannot admit callback or accessor elision.
  return stockRecording
    ? (context, topology) =>
        buildStandardViewRecording(
          activePipeline,
          {
            ...context,
            ...(gtaoExecutionOverride === undefined ? {} : { gtaoExecutionOverride }),
            ...(viewportOutput === undefined ? {} : { viewportOutput }),
          },
          topology,
        )
    : activePipeline.build;
}

/** Renderer-owned shadow layers outlive any one compiled graph. */
export function ensureShadowDepthLayers(
  frameState: RenderFrameState,
  device: RenderSystemInternals['device'],
): ShadowDepthLayers {
  frameState.shadowDepthLayers ??= new ShadowDepthLayers(device);
  return frameState.shadowDepthLayers;
}

/**
 * Everything one view graph compile reads besides the owner bags. A record
 * replaces positional arguments so the staged compile input has one shape.
 */
export interface GraphCompileInput {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly pipelineState: PipelineState;
  readonly camera: CameraSnapshot;
  readonly lights: ViewLights;
  /** Canvas extent; compile clamps each side to at least one texel. */
  readonly surface: { readonly width: number; readonly height: number };
  readonly shadowMapSize?: number | undefined;
  readonly currentGpuCamera?: boolean;
  readonly gpuDriven?: PreparedGpuDrivenFrame | undefined;
  readonly featurePlan?: ViewFeaturePlan | undefined;
  readonly cubeCaptureState?: CubeCaptureGraphState | undefined;
  readonly clearOnly?: boolean | undefined;
  readonly passPlan?: ViewPassPlan | undefined;
  readonly volumetricFog?: ExtractedVolumetricFog | undefined;
  /** A rejected volume-topology candidate has no last-known-good fallback. */
  readonly volumeTopologyCandidate?: boolean | undefined;
  readonly standardLighting?: StandardTopologyInputValue | undefined;
  readonly ssr?: SsrSpatialAdmission | undefined;
  readonly renderExtent?: RenderExtent | undefined;
  readonly analyticFog?: boolean | undefined;
  readonly cloudShadowLayout?: CloudShadowSpatialLayout | undefined;
  readonly terrainReceivers?: readonly TerrainShadowReceiver[] | undefined;
  readonly subsurface?: RenderPipelineTopology['subsurface'] | undefined;
  readonly rendererRecording?: boolean | undefined;
  readonly unfoggedOpaque?: boolean | undefined;
  readonly capsuleShadows?: boolean | undefined;
  /** Renderer-owned shadow layers; the caller ensures them before compile. */
  readonly shadowDepthLayers: ShadowDepthLayers;
}

function currentDeviceViewGraph(
  installed: InstalledFrameGraph | null | undefined,
  deviceScope: InstalledFrameGraph['deviceScope'],
): InstalledFrameGraph | undefined {
  if (installed == null || !viewGraphDeviceIsCurrent(installed, deviceScope)) return undefined;
  return installed;
}

/** The view keeps its current binding or promotes a compatible unsubmitted one. */
function existingFrameGraphFor(
  deviceScope: InstalledFrameGraph['deviceScope'],
  frameState: RenderFrameState,
  key: string,
): ExistingFrameGraph {
  const installed = currentDeviceViewGraph(frameState.compiledFrameGraph, deviceScope);
  if (installed?.topologyKey === key) return { kind: 'reused', graph: installed };
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  if (stashed === undefined) return REBUILD_WITHOUT_STASH;
  return stashed.topologyKey === key && viewGraphDeviceIsCurrent(stashed, deviceScope)
    ? { kind: 'promoted', graph: stashed }
    : { kind: 'rebuild', retireStash: stashed };
}

type ExistingFrameGraph =
  | { readonly kind: 'reused' | 'promoted'; readonly graph: InstalledFrameGraph }
  | { readonly kind: 'rebuild'; readonly retireStash: InstalledFrameGraph | undefined };

const REBUILD_WITHOUT_STASH: ExistingFrameGraph = Object.freeze({
  kind: 'rebuild',
  retireStash: undefined,
});

/** Reuse the installed graph, or promote the matching stash, without a rebuild. */
function existingFrameGraphOutcome(
  existing: Extract<ExistingFrameGraph, { readonly graph: InstalledFrameGraph }>,
  frame: number,
  key: FrameGraphIdentity,
  metrics: FeatureGraphMetricsDelta,
  effects: (overrides: Partial<GraphEffects>) => GraphEffects,
  accepted: Pick<GraphEffects, 'postPending' | 'cloudHistoryFormat' | 'gpuReplacement'>,
): ViewGraphCompileOutcome {
  metrics.lastTopologyKey = key;
  if (existing.kind === 'reused') {
    metrics.reuseHits += 1;
    // The installed graph already owns its imports; no GPU-driven replacement to commit.
    return {
      frame,
      kind: 'reused',
      graph: existing.graph.graph,
      effects: effects({ ...accepted, gpuReplacement: undefined }),
    };
  }
  metrics.unsubmittedGraphReuses += 1;
  return {
    frame,
    kind: 'promoted',
    graph: existing.graph.graph,
    stash: existing.graph,
    effects: effects(accepted),
  };
}

function emptyFeatureGraphMetricsDelta(): FeatureGraphMetricsDelta {
  return {
    signatureValidationCalls: 0,
    signatureValidationBytes: 0,
    signatureValidationChars: 0,
    signatureValidationCpuMs: 0,
    signatureValidationCacheHits: 0,
    signatureValidationCacheMisses: 0,
    reuseHits: 0,
    rebuildAttempts: 0,
    compileAttempts: 0,
    compileSuccesses: 0,
    compileFailures: 0,
    validationFailures: 0,
    buildFailures: 0,
    unsubmittedGraphReuses: 0,
    compileCpuMs: 0,
    buildCpuMs: 0,
    planRevision: undefined,
    lastTopologyKey: undefined,
    compileCause: undefined,
  };
}

/**
 * Compile one view graph without writing `frameState` or any owner: every
 * side effect is returned as data on the outcome, and `adoptViewGraph`
 * applies it. A throw becomes the `failed` kind.
 */
export function compileViewGraph(input: GraphCompileInput): ViewGraphCompileOutcome {
  const frame = input.frameState.frameNumber;
  try {
    return compileViewGraphStages(input, frame, input.gpuDriven);
  } catch (cause) {
    return { frame, kind: 'failed', cause };
  }
}

export type SourceGraphCompileInput = Omit<GraphCompileInput, 'gpuDriven'> & {
  readonly gpuDriven: GpuDrivenGraphProjection;
};

/** Same builder and native graph owner, without issuing a recording or frame replacement. */
export function compileSourceViewGraph(input: SourceGraphCompileInput): ViewGraphCompileOutcome {
  const frame = input.frameState.frameNumber;
  try {
    return compileViewGraphStages(input, frame, undefined);
  } catch (cause) {
    return { frame, kind: 'failed', cause };
  }
}

/** Count actual stock shadow projection calls while building this graph. */
function shadowGraphProjection(input: {
  readonly gpuDriven: GpuDrivenGraphProjection | undefined;
  readonly builder: RenderGraphBuilder<RenderPipelineFrame>;
  readonly stockRecording: boolean;
  readonly activePipeline: RenderFrameState['activePipeline'];
  readonly shadowCameraCull: boolean;
}) {
  const { gpuDriven, builder, stockRecording, activePipeline, shadowCameraCull } = input;
  let count: number | undefined = stockRecording ? 0 : undefined;
  return {
    get count() {
      return count;
    },
    project: (
      identity: import('../gpu-driven/shadow-views').ShadowViewIdentity,
      cameraPyramid?: import('@forgeax/engine-render-graph').GraphTextureView,
    ) => {
      if (
        (activePipeline === standardPipeline || isCaptureViewPipeline(activePipeline)) &&
        identity.kind === 'directional'
      )
        count = Math.max(count ?? 0, identity.index + 1);
      return (
        gpuDriven?.projectShadow?.(
          builder,
          identity,
          true,
          shadowCameraCull ? cameraPyramid : undefined,
        ) ?? ok(undefined)
      );
    },
  };
}

function acceptedGraphFeatures(
  postPending: boolean,
  cloudHistoryFormat: ReturnType<typeof cloudHistoryFormatOf>,
) {
  return {
    postPending: postPending,
    ...(cloudHistoryFormat === undefined ? {} : { cloudHistoryFormat }),
  };
}

function compileViewGraphStages(
  input: ViewGraphCompileInput,
  frame: number,
  gpuReplacement: PreparedGpuDrivenFrame | undefined,
): ViewGraphCompileOutcome {
  const profileSession = activeRenderProfileSession(input.internals);
  return compileViewGraphStagesOwned(input, frame, profileSession, gpuReplacement);
}

type ViewGraphCompileInput = Omit<GraphCompileInput, 'gpuDriven'> & {
  readonly gpuDriven?: GpuDrivenGraphProjection | undefined;
};

/** Named lighting products outside the ordered display's local attachments. */
function needsLightingGraph(internals: RenderSystemInternals, frame: RenderFrameState): boolean {
  return (
    frame.probePlacementFrame !== undefined ||
    frame.rayDiffuse?.ready !== undefined ||
    frame.screenProbe?.ready !== undefined ||
    internals.standardProfile?.diffuseGi?.gather === 'baked' ||
    irradianceFieldInput(internals, frame) !== undefined ||
    frame.gtaoExecutionOverride !== undefined ||
    frame.gtaoCandidatePreparationFailureGeneration !== undefined
  );
}

function orderedDisplayOutput(
  pipeline: RenderFrameState['activePipeline'],
  topology: RenderPipelineTopology,
): DisplayOutput | undefined {
  if (pipeline !== standardPipeline) return premultipliedForwardOutput(pipeline);
  return topology.opaque.lane === 'deferred' ? 'deferred' : 'standard';
}

function admitsOrderedDisplayObservation(
  topology: RenderPipelineTopology,
  output: DisplayOutput,
  observations: readonly import('../render-contract').FrameObservationDomain[] | undefined,
): boolean {
  return !observations?.some(
    (domain) =>
      domain !== 'final-display' &&
      !(
        typeof output === 'string' &&
        (domain === 'linear-hdr' || (domain === 'linear-ldr' && usesNativeGrade(topology)))
      ),
  );
}

function orderedDisplayLightingMode(
  output: DisplayOutput,
  lighting: StandardTopologyInputValue,
  topology: RenderPipelineTopology,
): 'texture' | 'storage' | 'current' {
  if (output === 'deferred') return 'storage';
  if (lighting.kind === 'clustered' && lighting.transport.kind === 'cpu-texture') return 'texture';
  return topology.volumetricFog?.enabled === true ? 'storage' : 'current';
}

function matchesDisplayLighting(
  installed: InstalledFrameGraph,
  lighting: StandardTopologyInputValue,
  fixed: boolean,
  shadowDepthLayers: ShadowDepthLayers,
): boolean {
  const { standardLighting, displayShadowDepthLayers } = installed;
  if (displayShadowDepthLayers !== undefined && displayShadowDepthLayers !== shadowDepthLayers)
    return false;
  return fixed
    ? standardLighting !== 'current' &&
        matchesStandardLightingDeclaration(standardLighting, lighting)
    : standardLighting === 'current';
}

function compileViewGraphStagesOwned(
  input: ViewGraphCompileInput,
  frame: number,
  profileSession: RecorderSession | undefined,
  gpuReplacement: PreparedGpuDrivenFrame | undefined,
): ViewGraphCompileOutcome {
  const {
    internals,
    frameState,
    pipelineState,
    camera,
    lights,
    shadowMapSize,
    gpuDriven,
    featurePlan = EMPTY_VIEW_FEATURE_PLAN,
    cubeCaptureState,
    clearOnly = false,
    passPlan = EMPTY_VIEW_PASS_PLAN,
    volumetricFog,
    volumeTopologyCandidate = false,
    standardLighting,
    ssr,
    renderExtent,
    analyticFog = false,
    cloudShadowLayout,
    terrainReceivers = [],
    subsurface,
    rendererRecording = false,
    unfoggedOpaque = false,
    capsuleShadows = false,
    shadowDepthLayers,
  } = input;
  const cloudShadowResolution = cloudShadowLayout?.filteredResolution;
  // `render-feature-plan` planned the Feature candidate compile reads (fullscreen
  // effects, post identities, plans, prepared-resource key) in RenderQueue.
  const featureGraphCandidate = featurePlan.candidate;
  const { deviceScope } = recordContext(internals);
  clearStaleGtaoCandidatePreparationFault(frameState, deviceScope.generation);
  let metricDelta: FeatureGraphMetricsDelta | undefined;
  const graphMetrics = () => (metricDelta ??= emptyFeatureGraphMetricsDelta());
  const graphCamera = graphCameraOf(camera, frameState);
  const compactProfile =
    (frameState.cameraStandardProfile ?? internals.standardProfile)?.gbufferFormat === 'default';
  const lastKnownGood = (): CompiledRenderGraph<RenderPipelineFrame> | null => {
    const installed = frameState.compiledFrameGraph;
    if (
      installed === null ||
      installed.displayPorts !== undefined ||
      !viewGraphDeviceIsCurrent(installed, deviceScope)
    )
      return null;
    const layers =
      gpuDriven?.shadowViewPool?.staticLayers.staticPlan?.layout ??
      staticShadowAdmission(
        lights,
        shadowMapSize,
        resolveSpotShadowMapSize(internals, lights) ?? 1024,
        internals.options?.staticShadowBudgetBytes,
      );
    const directional = directionalTopologyOf(
      internals,
      lights,
      shadowMapSize,
      terrainReceivers,
      layers.directional,
    );
    return directional.ok &&
      retainedFrameGraphPolicyMatches(
        installed.retainedPolicy,
        directional.value,
        capsuleShadows,
        compactProfile ? 'standard-gbuffer/4' : undefined,
        canUseDeferredPcf(
          internals,
          frameState.cameraStandardProfile ?? internals.standardProfile,
          lights,
        ),
        layers,
      ) &&
      !hasSubmissionSensitiveFeatures(viewFeaturesOf(frameState).work.plans) &&
      cubeCaptureState?.planar?.current() === undefined &&
      compiledRenderGraphResourceDeclarations(installed.graph, 'planar-reflection.').length === 0 &&
      installed.standardLighting !== 'current' &&
      matchesStandardLightingDeclaration(installed.standardLighting, standardLighting)
      ? installed.graph
      : null;
  };
  let retireStash: InstalledFrameGraph | undefined;
  let featureWork = EMPTY_VIEW_FEATURE_WORK;
  const effects = (overrides: Partial<GraphEffects> = {}): GraphEffects => ({
    metrics: graphMetrics(),
    configurationRevision: internals.standardProfile?.configurationRevision,
    featureCandidate: featureGraphCandidate,
    featureWork,
    postPending: false,
    retireStash,
    gpuReplacement: undefined,
    error: undefined,
    ...overrides,
  });
  // Authored graphs can retain a compatible previous topology. Ordered display
  // failure leaves the last submitted picture in place and retries current inputs.
  const reject = (
    code: GraphRejectCode,
    error: GraphEffectError | undefined,
    fallback: 'last-known-good' | 'topology' | 'none',
  ): Extract<ViewGraphCompileOutcome, { kind: 'retained' | 'rejected' }> => {
    const graph =
      fallback === 'none' ||
      (fallback === 'topology' && (volumeTopologyCandidate || compactProfile))
        ? null
        : lastKnownGood();
    const rejected = effects({ error });
    return graph === null
      ? { frame, kind: 'rejected', code, effects: rejected }
      : { frame, kind: 'retained', graph, reason: code, effects: rejected };
  };
  const surfaceWidth = Math.max(1, input.surface.width);
  const surfaceHeight = Math.max(1, input.surface.height);
  const featurePlans = featurePlansOf(frameState, featureGraphCandidate);
  traceFeaturePlans(internals, frame, 'typed-plan-input', featurePlans, featureGraphCandidate);
  const projectedFeaturePlans = validateRenderFeaturePlans(
    featurePlans,
    featurePlans.length === 0 ? undefined : graphMetrics(),
  );
  if (!projectedFeaturePlans.ok) {
    graphMetrics().validationFailures += 1;
    return reject(
      'feature-validation-failed',
      { route: 'feature', error: projectedFeaturePlans.error },
      'topology',
    );
  }
  featureWork = projectedFeaturePlans.value;
  const featureExecutions = featureWork.executions;
  const preflightFeatureTextureReadbacks = () => {
    if (
      internals.options?.featureTextureReadbackBudgetBytes !== undefined ||
      (featureGraphCandidate?.featureTextureReadbacks?.length ?? 0) > 0
    ) {
      const readbackOwner = recordContext(internals).observationCaptureOwner;
      const preflight = readbackOwner?.preflightFeatureTextureReadbacks?.(
        recordContext(internals).observationFrameId ?? frame,
        featureGraphCandidate?.featureTextureReadbacks ?? [],
      );
      if (preflight === undefined || !preflight.ok) {
        graphMetrics().validationFailures += 1;
        const error =
          preflight === undefined
            ? new RendererContractFailureError(
                'draw',
                'an explicit feature-texture readback profile requires the Renderer observation owner',
              )
            : preflight.error;
        return reject('feature-validation-failed', { route: 'feature', error }, 'topology');
      }
    }
    return undefined;
  };
  const readbackPreflightFailure = preflightFeatureTextureReadbacks();
  if (readbackPreflightFailure !== undefined) return readbackPreflightFailure;
  traceFeaturePlans(internals, frameState.frameNumber, 'typed-plan-validated', featurePlans);
  const sharedPublication = sharedFeatureGraphPublication(internals.featureHost);
  const { plans: viewPlans, executions: viewExecutions } = viewFeaturePlans(
    featureWork,
    sharedPublication,
  );
  const planRevisionState = mutableFeatureGraphInspection(internals).planRevisionState;
  const nextPlanRevision = updateRenderFeaturePlanRevision(
    planRevisionState,
    viewPlans,
    viewExecutions,
  );
  if (nextPlanRevision !== planRevisionState) graphMetrics().planRevision = nextPlanRevision;
  const stockRecording = rendererRecording && standardViewRecording(frameState.activePipeline);
  const ownedGpuRaster =
    stockRecording || (rendererRecording && ownsStandardForwardRaster(frameState.activePipeline));
  const captureLayout = captureLayoutFor(frameState);
  const transientViews = selectTransientViewPlans(
    internals,
    viewPlans,
    viewExecutions,
    stockRecording && captureLayout === undefined,
    frameState,
  );
  // Transient views and shared work own their own imports.
  const preparedResourceKey =
    transientViews.ownsPhysicalChanges ||
    (sharedPublication !== undefined &&
      !viewPlans.some(renderFeaturePlanRequiresPreparedResourceKey))
      ? ''
      : (featureGraphCandidate?.preparedResourceKey ??
        frameState.compiledFrameGraph?.preparedResourceKey);
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
    featureGraphCandidate,
    passPlan,
    volumetricFog,
    standardLighting,
    ssr,
    renderExtent,
    analyticFog,
    terrainReceivers,
    subsurface,
    unfoggedOpaque,
    capsuleShadows,
    gpuDriven?.shadowViewPool?.staticLayers,
  );
  const completeViewGraphCompileCandidate = (): ViewGraphCompileOutcome => {
    const topologyAdmission = admitStandardGraphTopology(
      { internals, frameState, camera, stockRecording },
      topologyResult,
    );
    if (!topologyAdmission.ok) {
      graphMetrics().buildFailures += 1;
      const failure = topologyAdmission.error;
      return reject(failure.code, { route: 'registry', error: failure.error }, failure.fallback);
    }
    const featurePostProcessEntries = featureFullscreenEffects(frameState, featureGraphCandidate);
    const postProcessAdmission = admitFeaturePostProcessChain(
      internals,
      topologyAdmission.value,
      featurePostProcessEntries,
      isMultisampleAntialias(graphCamera.antialias) && topologyAdmission.value.lane.multisample,
    );
    const pending = postProcessAdmission.pending
      ? pendingPostChainOutcome(frame, frameState.compiledFrameGraph, lastKnownGood, effects)
      : undefined;
    if (pending !== undefined) return pending;
    const topology: RenderPipelineTopology = {
      ...topologyForPostProcessAdmission(topologyAdmission.value, postProcessAdmission.pending),
      materialSceneDepth: passPlan.materialSceneDepth === true,
    };
    // Keep Bloom's positive parameter values out of the compiled identity. A
    // crossing of zero has already changed topology.camera.bloom above; the
    // remaining values are uploaded by the active recorder without rebuilding
    // targets or pipelines.
    const currentCameraLateOcclusion =
      passPlan.requestedLateOcclusion ?? topology.opaque.lateOcclusion;
    const supportsCameraSelection = topology.lane.compute && topology.lane.storageBuffer;
    const currentGpuCamera =
      input.currentGpuCamera === true &&
      stockRecording &&
      captureLayout === undefined &&
      !topology.clearOnly &&
      supportsCameraSelection &&
      (!currentCameraLateOcclusion || hasDepthPyramidPrograms(internals.depthPyramidShaders));
    const directSource =
      input.currentGpuCamera === false &&
      gpuReplacement === undefined &&
      gpuDriven?.projectCamera !== undefined &&
      supportsCameraSelection;
    const displayOutput =
      stockRecording &&
      captureLayout === undefined &&
      (currentGpuCamera || gpuDriven === undefined || directSource)
        ? orderedDisplayOutput(frameState.activePipeline, topology)
        : undefined;
    const observations = recordContext(internals).observationCaptureDomains;
    const postStages = admitOrderedDisplay(
      topology,
      displayOutput,
      internals.device.caps.rgba16floatRenderable,
    );
    const orderedCloud = orderedCloudHistoryFormat(
      featurePlans,
      viewExecutions,
      displayOutput,
      topology,
      sharedPublication,
    );
    if (
      displayOutput !== undefined &&
      !postProcessAdmission.pending &&
      admitsOrderedViewportStages(topology, postStages) &&
      isStandardLightCount((topology.standardProfile ?? DEFAULT_STANDARD_PROFILE).lightCount) &&
      standardLighting !== undefined &&
      deriveStandardTopologyInput(standardLighting).ok &&
      orderedCloud !== false &&
      (featureGraphCandidate?.featureTextureReadbacks?.length ?? 0) === 0 &&
      admitsOrderedDisplayObservation(topology, displayOutput, observations) &&
      !recordContext(internals).featureSceneInputs?.work.length &&
      !needsLightingGraph(internals, frameState)
    ) {
      const orderedViewIdentity = orderedWaterViewIdentity(topology, graphCamera);
      const matchesFeatures = (ports: DisplayPorts) =>
        matchesCloudDisplayPorts(
          ports,
          orderedCloud,
          cloudShadowLayout,
          nextPlanRevision.revision,
          preparedResourceKey,
          cloudMode0DepthFormat(topology.standardProfile),
          selectCloudShadowFormat(internals.device.caps),
        ) &&
        matchesWaterDisplayPorts(
          ports.water,
          topology,
          orderedViewIdentity,
          nextPlanRevision.revision,
          preparedResourceKey,
          sharedPublication,
        );
      const observeDisplay = observations?.includes('final-display') === true;
      const observeLinear = observations?.includes('linear-ldr') === true;
      // Only an occlusion pyramid needs different backing. Selection issues work from
      // the current camera roster and shares every ordinary attachment with direct draws.
      const geometry =
        currentGpuCamera && currentCameraLateOcclusion
          ? 'occlusion'
          : supportsCameraSelection
            ? 'selection'
            : 'direct';
      const cullShadowReceivers =
        displayOutput === 'deferred' &&
        geometry === 'occlusion' &&
        (topology.shadow.directional !== 'disabled' || topology.shadow.spotCount > 0) &&
        shadowCameraCullOf(internals, frameState, topology, cubeCaptureState);
      const lightingMode = orderedDisplayLightingMode(displayOutput, standardLighting, topology);
      const textureLighting = lightingMode === 'texture';
      const fixedLighting = lightingMode !== 'current';
      const shadowLightBytes = shadowProjectionLightBytes(topology, standardLighting);
      const weighted = passPlan.transparent.inspection.resolved === 'weighted-blended';
      const revision = internals.standardProfile?.configurationRevision;
      const planar = cubeCaptureState?.planar?.current()?.physical.descriptor;
      const installed = currentDeviceViewGraph(frameState.compiledFrameGraph, deviceScope);
      const stashed = currentDeviceViewGraph(frameState.unsubmittedCompiledFrameGraph, deviceScope);
      const ordered = {
        frame,
        kind: 'ordered-display',
        configurationRevision: revision,
        forwardDisplayReceiver: topology.forwardDirectionalShadow,
        featureCandidate: featureGraphCandidate,
        featureWork,
        metrics: metricDelta,
      } as const;
      if (
        installed?.displayPorts !== undefined &&
        matchesFeatures(installed.displayPorts) &&
        matchesDisplayLighting(installed, standardLighting, fixedLighting, shadowDepthLayers) &&
        installed.displayPorts.accepts(
          topology,
          displayOutput,
          weighted,
          geometry,
          cullShadowReceivers,
          observeDisplay,
          observeLinear,
          textureLighting,
          shadowLightBytes,
          postStages,
          planar,
        )
      )
        return { ...ordered, operation: 'reuse', installed };
      if (
        stashed?.displayPorts !== undefined &&
        matchesFeatures(stashed.displayPorts) &&
        matchesDisplayLighting(stashed, standardLighting, fixedLighting, shadowDepthLayers) &&
        stashed.displayPorts.accepts(
          topology,
          displayOutput,
          weighted,
          geometry,
          cullShadowReceivers,
          observeDisplay,
          observeLinear,
          textureLighting,
          shadowLightBytes,
          postStages,
          planar,
        )
      )
        return { ...ordered, operation: 'promote', installed: stashed, gpuReplacement };
      retireStash = frameState.unsubmittedCompiledFrameGraph;
      const displayLighting = fixedLighting
        ? standardLightingDeclaration(standardLighting)
        : undefined;
      const ports = new DisplayPorts(
        topology,
        displayOutput,
        weighted,
        geometry,
        cullShadowReceivers,
        observeDisplay,
        observeLinear,
        textureLighting,
        displayOutput === 'deferred'
          ? undefined
          : forwardClusterTextureExtent(topology, standardLighting),
        shadowLightBytes,
        displayLighting,
        postStages,
        cloudDisplayPorts(
          orderedCloud,
          cloudShadowLayout,
          nextPlanRevision.revision,
          preparedResourceKey,
          cloudMode0DepthFormat(topology.standardProfile),
          selectCloudShadowFormat(internals.device.caps),
        ),
        planar,
        waterDisplayPorts(
          topology,
          orderedViewIdentity,
          nextPlanRevision.revision,
          preparedResourceKey,
          sharedPublication,
        ),
      );
      const key = displayGraphIdentity(ports, topology);
      const started = nowMs();
      const procedure = RenderGraphBuilder.orderedView<RenderPipelineFrame>({
        device: internals.device,
        surfaceSize: { width: surfaceWidth, height: surfaceHeight },
        reuseResourcesFrom: installed?.graph,
      });
      const builder = procedure.passes;
      const built = buildOrderedDisplay(
        builder,
        topology,
        displayOutput,
        standardLighting,
        ports,
        frameState,
        shadowDepthLayers,
        internals,
        postStages,
        pipelineState,
        viewExecutions,
        sharedPublication,
      );
      const buildCpuMs = nowMs() - started;
      if (!built.ok) {
        const metrics = graphMetrics();
        metrics.lastTopologyKey = key;
        metrics.rebuildAttempts++;
        metrics.buildCpuMs += buildCpuMs;
        metrics.buildFailures++;
        return reject('graph-build-failed', { route: 'registry', error: built.error }, 'none');
      }
      const physicalStarted = nowMs();
      const physical =
        profileSession === undefined
          ? procedure.bindResources()
          : runProfiledRenderPhase(
              profileSession,
              'graph/bind-ordered-resources',
              procedure.bindResources,
            );
      const bindingCpuMs = nowMs() - physicalStarted;
      if (!physical.ok) {
        const metrics = graphMetrics();
        metrics.lastTopologyKey = key;
        metrics.rebuildAttempts++;
        metrics.buildCpuMs += buildCpuMs;
        metrics.compileAttempts++;
        metrics.compileCause = { installedTopologyKey: installed?.topologyKey, key };
        metrics.compileCpuMs += bindingCpuMs;
        metrics.compileFailures++;
        return reject('graph-compile-failed', { route: 'registry', error: physical.error }, 'none');
      }
      traceCompiledFeatureGraph(
        internals,
        frameState,
        featureGraphCandidate,
        featurePlans,
        physical.value,
      );
      const binding = orderedDisplayBinding(
        builder,
        physical.value,
        {
          deviceScope,
          topologyKey: key,
          displayPorts: ports,
          configurationRevision: revision,
          standardLighting: displayLighting ?? 'current',
          forwardDirectionalShadow: topology.forwardDirectionalShadow,
          forwardShadowCoverage: passPlan.forwardShadowCoverage,
          atmosphereTransport: atmosphereTransportOf(topology),
        },
        shadowDepthLayers,
        topology,
        preparedResourceKey,
        built.value,
      );
      return {
        ...ordered,
        operation: 'bind',
        installed: binding,
        retireStash,
        gpuReplacement,
        buildCpuMs,
        bindingCpuMs,
      };
    }
    const metrics = graphMetrics();
    const shadow = topology.shadow;
    const nativeStaticLayers =
      currentGpuCamera &&
      ((shadow.directional !== 'disabled' && shadow.directional.staticLayer !== false) ||
        !!shadow.pointStaticMask ||
        !!shadow.spotStaticMask)
        ? gpuDriven?.shadowViewPool?.staticLayers
        : undefined;
    const shadowCameraCull = shadowCameraCullOf(internals, frameState, topology, cubeCaptureState);
    const receiverPolicy = currentGpuCamera
      ? topology.opaque.lane === 'deferred' &&
        currentCameraLateOcclusion &&
        (shadow.directional !== 'disabled' || shadow.spotCount > 0) &&
        shadowCameraCull
      : stockRecording && gpuDriven?.projectShadow !== undefined
        ? shadowCameraCull
        : undefined;
    const cloudHistoryFormat = cloudHistoryFormatOf(featureExecutions);
    const graphTopology: RenderPipelineTopology = {
      ...topology,
      featureTopologySignature: featureTopologySignatureOf(
        featureGraphCandidate,
        transientViews.topologySignature ?? nextPlanRevision.revision,
        preparedResourceKey,
        featurePostProcessEntries,
        cubeCaptureState,
        stockRecording,
      ),
      standardLightingTopologySignature: standardLightingTopologySignature(standardLighting),
      gpuDrivenTopologySignature: currentGpuCamera
        ? nativeStaticLayers === undefined
          ? 'current-camera'
          : `current-camera:static-depth:${getOpaqueResourceIdentity(nativeStaticLayers)}`
        : gpuDrivenTopologySignatureOf(gpuDriven, ownedGpuRaster),
    };
    const localShadows =
      stockRecording &&
      captureLayout === undefined &&
      (currentGpuCamera || gpuDriven?.projectShadow === undefined)
        ? currentShadowViews(
            topology.shadow,
            shadowDepthLayers !== undefined && nativeStaticLayers === undefined,
          )
        : undefined;
    const currentMaterialDepth =
      stockRecording &&
      captureLayout === undefined &&
      (!isMultisampleAntialias(camera.antialias) || !topology.lane.multisample);
    const currentTransmission =
      currentMaterialDepth && topology.singleLayerMedium !== true && topology.clearOnly !== true;
    const currentTransparency =
      currentMaterialDepth && passPlan.transparent.inspection.resolved === 'weighted-blended';
    const topologyIdentity = frameGraphTopologyIdentity(
      currentGpuCamera
        ? {
            ...graphTopology,
            opaque: {
              ...topology.opaque,
              lateOcclusion: currentCameraLateOcclusion,
            },
          }
        : graphTopology,
      stockRecording,
      localShadows,
      currentMaterialDepth,
      currentTransparency,
      currentTransmission,
      stockRecording &&
        frameState.activePipeline === standardPipeline &&
        internals.device.caps.rgba16floatRenderable &&
        usesNativeGrade(graphTopology),
      observations?.includes('linear-ldr') === true,
    );
    const probePlacement = frameState.probePlacementFrame;
    const viewIdentity = renderFeatureViewIdentity(graphCamera);
    const fluid = sharedPublication?.waterFluid.get(viewIdentity);
    // The prior graph is a transient resource-reuse input. Retained build
    // callbacks share this lexical scope, so never store that graph here.
    const matchViewFrameGraph = () => {
      let key: string;
      let existing: ExistingFrameGraph;
      if (profileSession === undefined) {
        key = frameGraphCacheKey(
          internals,
          frameState,
          topologyIdentity,
          captureLayout,
          currentGpuCamera || gpuDriven !== undefined,
          cloudShadowLayout,
          cloudHistoryFormat,
          cubeCaptureState,
          sharedPublication,
          fluid,
          stockRecording,
          receiverPolicy,
        );
        existing = existingFrameGraphFor(deviceScope, frameState, key);
      } else {
        const match = runProfiledRenderPhase(profileSession, 'graph/key-match', () => {
          const candidateKey = frameGraphCacheKey(
            internals,
            frameState,
            topologyIdentity,
            captureLayout,
            currentGpuCamera || gpuDriven !== undefined,
            cloudShadowLayout,
            cloudHistoryFormat,
            cubeCaptureState,
            sharedPublication,
            fluid,
            stockRecording,
            receiverPolicy,
          );
          return {
            key: candidateKey,
            existing: existingFrameGraphFor(deviceScope, frameState, candidateKey),
          };
        });
        key = match.key;
        existing = match.existing;
      }
      return { key, existing };
    };
    const { key, existing } = matchViewFrameGraph();
    const accepted = acceptedGraphFeatures(postProcessAdmission.pending, cloudHistoryFormat);
    if (existing.kind !== 'rebuild') {
      return existingFrameGraphOutcome(existing, frame, key, metrics, effects, {
        ...accepted,
        gpuReplacement,
      });
    }
    retireStash = existing.retireStash;
    metrics.rebuildAttempts += 1;
    metrics.lastTopologyKey = key;
    const buildStarted = nowMs();
    // Shader resources do not classify their owning plan. Only standalone effects
    // and Standard's named post stages defer ordinary scene contribution.
    const fullscreenFeatureIds = new Set([
      ...(featureGraphCandidate?.postProcessIdentities ??
        viewFeaturesOf(frameState).postProcessIdentities),
      ...[...featurePostProcessEntries.keys()].filter(isStandardNamedPostProcess),
      MOTION_BLUR_FEATURE_IDENTITY,
    ]);
    const procedure = RenderGraphBuilder.procedure<RenderPipelineFrame>(
      {
        device: internals.device,
        surfaceSize: { width: surfaceWidth, height: surfaceHeight },
        reuseResourcesFrom: currentDeviceViewGraph(frameState.compiledFrameGraph, deviceScope)
          ?.graph,
        retainPassLocalTargets: captureLayout !== undefined,
      },
      stockRecording ? 'ordered' : 'deferred',
    );
    const builder = procedure.passes;
    const sceneInputs = recordContext(internals).featureSceneInputs?.import(builder);
    const graphInputs = importStandardGraphInputs(
      builder,
      frameState,
      topology,
      cloudHistoryFormat,
      ssr,
    );
    if (!graphInputs.ok) {
      return reject(
        'graph-inputs-failed',
        { route: 'registry', error: graphInputs.error },
        'last-known-good',
      );
    }
    const featureProjection = createRenderFeatureProjectionState();
    const sharedTextures = importSharedGraphTextures(
      builder,
      sharedPublication,
      featureProjection.graphTextures,
      readSharedFeatureGraph,
    );
    for (const pass of sharedPublication?.passes ?? []) featureProjection.projected.add(pass);
    const transientSlots = new Map<string, { complete: boolean; names: Set<string> }>();
    let featureShadows:
      | ReturnType<typeof projectRenderFeatureShadows<RenderPipelineFrame>>
      | undefined;
    let projectedGpuDriven = false;
    let prepareGpuDrivenPipelines: InstalledFrameGraph['prepareGpuDrivenPipelines'];
    let prepareGpuDrivenSource: InstalledFrameGraph['prepareGpuDrivenSource'];
    const activePipeline = frameState.activePipeline;
    const shadowProjection = shadowGraphProjection({
      gpuDriven,
      builder,
      stockRecording,
      activePipeline,
      shadowCameraCull,
    });
    const build = pipelineBuildOf(
      activePipeline,
      stockRecording,
      frameState.gtaoExecutionOverride,
      internals.viewportOutput,
    );
    const prepareViewGraphBuildArguments = () => {
      const buildArgs = [
        {
          graph: builder,
          nativeInputs: captureNativeGraphInputs(internals, pipelineState),
          viewIdentity,
          ...(fluid === undefined
            ? {}
            : { waterFluid: { publication: fluid, read: waterFluidForRecording(viewIdentity) } }),
          getSharedGraphTextureBinding: (name) => sharedTextures.get(`frame:${name}`),
          ...probePlacementContribution(builder, probePlacement),
          ...diffuseGiContribution(
            builder,
            internals,
            frameState,
            captureLayout === undefined &&
              (stockRecording
                ? internals.standardProfile?.diffuseGi?.gather === 'baked'
                : bakedFieldInput(internals, frameState) !== undefined),
          ),
          camera: { depthOfField: graphCamera.depthOfField },
          observationCaptureDomains: recordContext(internals).observationCaptureDomains,
          ...graphInputs.value,
          ...(standardLighting === undefined ? {} : { standardLighting }),
          capabilities: internals.device.caps,
          ...(cloudShadowLayout === undefined
            ? {}
            : {
                cloudShadowLayout,
                cloudShadowFormat: selectCloudShadowFormat(internals.device.caps),
              }),
          ...(cloudShadowResolution === undefined ? {} : { cloudShadowResolution }),
          encodeTransmissionMip: encodeStandardTransmissionMip(internals),
          shadowDepthLayers,
          ...(localShadows === undefined ? {} : { currentShadowViews: localShadows }),
          ...(stockRecording && captureLayout === undefined
            ? { directFinalColor: true as const }
            : {}),
          ...(currentTransparency ? { currentTransparency: true as const } : {}),
          ...(currentTransmission ? { currentTransmission: true as const } : {}),
          ...(currentMaterialDepth ? { currentMaterialDepth: true as const } : {}),
          projectGpuDriven: (target) => {
            if (projectedGpuDriven || (!currentGpuCamera && gpuDriven === undefined))
              return ok(undefined);
            projectedGpuDriven = true;
            const projected = currentGpuCamera
              ? currentGpuRaster(
                  builder,
                  {
                    ...target,
                    lateOcclusion: currentCameraLateOcclusion,
                  },
                  frameState,
                  internals.options?.retainIndirectBundles === true,
                )
              : gpuDriven?.project(
                  builder,
                  target.format,
                  target.sampleCount,
                  () => frameState.surfaceSubmissionObservation,
                  target.additionalColorFormats,
                  target.lateOcclusion === true,
                  ownedGpuRaster,
                );
            if (projected === undefined) return ok(undefined);
            if (projected.ok) {
              prepareGpuDrivenPipelines = projected.value.preparePipelines;
              prepareGpuDrivenSource = projected.value.prepareSource;
              if (!currentGpuCamera && internals.options?.retainIndirectBundles === true)
                return ok({ ...projected.value, retainIndirectBundles: true });
            }
            return projected;
          },
          ...(currentGpuCamera
            ? {
                currentShadowReceiverDepth: receiverPolicy === true,
                ...(nativeStaticLayers === undefined
                  ? {}
                  : { gpuDrivenShadowDepthLayers: nativeStaticLayers }),
              }
            : gpuDriven?.projectShadow === undefined
              ? {}
              : {
                  projectGpuDrivenShadow: shadowProjection.project,
                  ...(gpuDriven.shadowViewPool === undefined
                    ? {}
                    : { gpuDrivenShadowDepthLayers: gpuDriven.shadowViewPool.staticLayers }),
                }),
          contributeShadowFeatures: () =>
            (featureShadows ??= projectRenderFeatureShadows(
              builder,
              viewExecutions,
              featureProjection,
            )),
          contributeFeatures: standardFeatureContribution({
            internals,
            frameState,
            builder,
            projectedFeaturePlans: viewExecutions,
            featurePostProcessEntries,
            fullscreenFeatureIds,
            featureProjection,
            sceneDataDepthViews: new Map(),
            transientViews: transientViews.identities,
            transientSlots,
            sceneInputs,
            surfaceSize: { width: surfaceWidth, height: surfaceHeight },
            reportError: (error) => reportRenderFeatureGraphError(internals, error),
          }),
          ...viewFeatureResourceBindings(
            builder,
            featureProjection,
            featureExecutions,
            viewIdentity,
          ),
          contributeCubeCaptures: (environmentCube, shadows) => {
            // Target capture and explicit graph inspection keep their declared resources.
            // Both stock display lanes borrow the current producer's physical batch.
            const reflectionProbes =
              stockRecording && captureLayout === undefined
                ? addCurrentReflectionProbeFilters(builder)
                : addReflectionProbeGraphPasses(
                    builder,
                    {
                      migrations: cubeCaptureState?.reflectionProbes?.migrations,
                      work: (cubeCaptureState?.reflectionProbes?.work ?? []).map((work) => ({
                        ...work,
                        rawCaptureFace: undefined,
                      })),
                    },
                    environmentCube,
                  );
            if (!reflectionProbes.ok) return reflectionProbes;
            if (cubeCaptureState === undefined) return ok(undefined);
            const planarView = addTargetCaptureGraphPasses(builder, {
              ...cubeCaptureState,
              work: [],
            });
            if (!planarView.ok || planarView.value === undefined) return planarView;
            const recorded = addPlanarReflectionPass(builder, shadows, planarView.value);
            return recorded.ok ? planarView : recorded;
          },
          hasFeature: (identity) =>
            featureExecutions.some((execution) => execution.featureIdentity === identity),
          afterTonemapOutput: standardAfterTonemapOutput(
            viewExecutions,
            fullscreenFeatureIds,
            graphTopology.surface.storageFormat,
          ),
          hasFeatureWork: (identity, placement) =>
            featureExecutions.some(
              (execution) =>
                (identity === undefined || execution.featureIdentity === identity) &&
                execution.passes.length > 0 &&
                (placement === undefined || (execution.placement ?? 'post') === placement),
            ),
          hasFeatureRasterWork: (identity, placement, passName, sampledTarget) =>
            featureExecutions.some(
              (execution) =>
                execution.featureIdentity === identity &&
                execution.passes.some(
                  (pass) =>
                    pass.graphics !== undefined &&
                    (passName === undefined || pass.name === passName) &&
                    (sampledTarget === undefined ||
                      pass.graphics.sampledTargets?.some(
                        (target) =>
                          typeof target === 'object' &&
                          'name' in target &&
                          target.name === sampledTarget,
                      ) === true),
                ) &&
                (placement === undefined || (execution.placement ?? 'post') === placement),
            ),
        } satisfies RenderPipelineBuildContext<RenderPipelineFrame>,
        graphTopology,
      ] as const;
      return buildArgs;
    };
    const buildArgs = prepareViewGraphBuildArguments();
    const built =
      profileSession === undefined
        ? Reflect.apply(build, activePipeline, buildArgs)
        : runProfiledRenderPhase(profileSession, 'graph/build', () =>
            Reflect.apply(build, activePipeline, buildArgs),
          );
    if (!built.ok) {
      metrics.buildFailures += 1;
      return reject('graph-build-failed', { route: 'registry', error: built.error }, 'topology');
    }
    const retainViewGraphCaptureTarget = () => {
      if (typeof captureLayout === 'string') {
        const captureScope = featureScopeKey({ view: renderFeatureViewIdentity(camera) });
        const captureTargets = [...featureProjection.graphTextures.targets].filter(
          ([target, resolved]) => target.name === captureLayout && resolved.scope === captureScope,
        );
        const uniqueCaptureTargets = new Map(
          captureTargets.map(([, resolved]) => [resolved.label, resolved] as const),
        );
        if (uniqueCaptureTargets.size === 1) {
          const captureTarget = uniqueCaptureTargets.values().next().value;
          if (captureTarget !== undefined) {
            const retained = builder.addCopyPass(
              `graph-target-capture-retain:${captureLayout}`,
              {
                accesses: [{ resource: captureTarget.view, usage: 'copy-src' }],
                encodeDirect: () => {},
              },
              'transfer',
            );
            if (!retained.ok) {
              metrics.buildFailures += 1;
              return reject(
                'graph-build-failed',
                { route: 'registry', error: retained.error },
                'topology',
              );
            }
          }
        }
      }
      return undefined;
    };
    const captureTargetFailure = retainViewGraphCaptureTarget();
    if (captureTargetFailure !== undefined) return captureTargetFailure;
    metrics.compileAttempts += 1;
    metrics.buildCpuMs += nowMs() - buildStarted;
    metrics.compileCause = {
      installedTopologyKey: frameState.compiledFrameGraph?.topologyKey,
      key,
    };
    const compileStarted = nowMs();
    const compileViewGraphCandidate = () => {
      let compiled: ReturnType<typeof procedure.bindResources>;
      try {
        compiled =
          profileSession === undefined
            ? procedure.bindResources()
            : runProfiledRenderPhase(
                profileSession,
                stockRecording ? 'graph/bind-ordered-resources' : 'graph/compile',
                procedure.bindResources,
              );
      } finally {
        metrics.compileCpuMs += nowMs() - compileStarted;
      }
      return compiled;
    };
    const compiled = compileViewGraphCandidate();
    if (!compiled.ok) {
      metrics.compileFailures += 1;
      return reject(
        'graph-compile-failed',
        { route: 'registry', error: compiled.error },
        'last-known-good',
      );
    }
    const rejectViewGraphPreparationFault = () => {
      if (frameState.gtaoCandidatePreparationFailureGeneration === undefined) return undefined;
      const candidateInfo = compiled.value.inspect();
      if (
        consumeGtaoCandidatePreparationFault(
          frameState,
          recordContext(internals).deviceScope.generation,
          candidateInfo.passes.map((pass) => pass.name),
        )
      ) {
        const error = new RendererOperationError('graph-build-failed', {
          operation: 'draw',
          cause: {
            code: 'gtao-candidate-preparation-fault-injected',
            expected: 'an AO graph candidate remains unpromoted after allocation',
            hint: 'retry candidate preparation after this one-shot conformance fault',
            detail: {
              phase: 'post-allocation-before-promotion',
              deviceGeneration: recordContext(internals).deviceScope.generation,
              candidateGeneration: candidateInfo.generation,
              passNames: Object.freeze(candidateInfo.passes.map((pass) => pass.name)),
              resourceAllocation: candidateInfo.resourceAllocation,
            },
          },
        });
        const rejected = reject(
          'graph-build-failed',
          { route: 'registry', error },
          'last-known-good',
        );
        return { ...rejected, effects: { ...rejected.effects, rejectedGraph: compiled.value } };
      }
      return undefined;
    };
    const candidatePreparationFailure = rejectViewGraphPreparationFault();
    if (candidatePreparationFailure !== undefined) return candidatePreparationFailure;
    traceCompiledFeatureGraph(
      internals,
      frameState,
      featureGraphCandidate,
      featurePlans,
      compiled.value,
    );
    metrics.compileSuccesses += 1;
    // No new lease means the installed imports remain current, not a second
    // resource transition back to an empty key on the following frame.
    return {
      frame,
      kind: 'compiled',
      graph: compiled.value,
      installed: installedFrameGraphOf(
        deviceScope,
        builder,
        compiled.value,
        key,
        topology,
        captureLayout,
        preparedResourceKey,
        stockRecording,
        prepareGpuDrivenPipelines,
        prepareGpuDrivenSource,
        localShadows?.directional === true
          ? 'current'
          : currentGpuCamera
            ? shadow.directional === 'disabled'
              ? 0
              : shadow.directional.cascadeCount
            : shadowProjection.count,
        new Map(
          [...featureProjection.graphTextures.targets].flatMap(([target, resolved]) => {
            const name = target.name;
            return name !== undefined &&
              resolved.scope === featureScopeKey({ view: renderFeatureViewIdentity(camera) })
              ? [[name, resolved.label] as const]
              : [];
          }),
        ),
        internals.standardProfile?.configurationRevision,
        {
          atmosphereTransport: stockRecording ? atmosphereTransportOf(topology) : undefined,
          forwardDirectionalShadow: stockRecording ? topology.forwardDirectionalShadow : undefined,
          forwardShadowCoverage: stockRecording ? passPlan.forwardShadowCoverage : undefined,
        },
        standardLightingDeclaration(standardLighting),
      ),
      effects: effects({ ...accepted, gpuReplacement }),
    };
  };
  return completeViewGraphCompileCandidate();
}

/** Shared target captures use the same lighting prelude and scene raster owner as display views. */
export function prepareTargetCaptureRecording(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  viewport: { readonly width: number; readonly height: number },
  lights: ViewLights,
  shadowMapSize: number | undefined,
  state: CubeCaptureGraphState,
  lighting: StandardTopologyInputValue,
  probe?: ReflectionProbeGraphWork,
  terrainReceivers: readonly TerrainShadowReceiver[] = [],
  sharedShadows?: SharedShadowSource,
  scenePasses?: CaptureScenePasses,
): CaptureRecording {
  const profileSession = activeRenderProfileSession(internals);
  if (profileSession === undefined)
    return prepareTargetCaptureRecordingOwned(
      internals,
      frameState,
      viewport,
      lights,
      shadowMapSize,
      state,
      lighting,
      probe,
      terrainReceivers,
      sharedShadows,
      undefined,
      scenePasses,
    );
  return runProfiledRenderPhase(profileSession, 'capture/prepare', () =>
    prepareTargetCaptureRecordingOwned(
      internals,
      frameState,
      viewport,
      lights,
      shadowMapSize,
      state,
      lighting,
      probe,
      terrainReceivers,
      sharedShadows,
      profileSession,
      scenePasses,
    ),
  );
}

function prepareTargetCaptureRecordingOwned(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  viewport: { readonly width: number; readonly height: number },
  lights: ViewLights,
  shadowMapSize: number | undefined,
  state: CubeCaptureGraphState,
  lighting: StandardTopologyInputValue,
  probe: ReflectionProbeGraphWork | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
  sharedShadows: SharedShadowSource | undefined,
  profileSession: RecorderSession | undefined,
  scenePasses: CaptureScenePasses | undefined,
): CaptureRecording {
  const shadow = fittedShadowTopology(internals, lights, shadowMapSize, terrainReceivers);
  if (!shadow.ok) throw shadow.error;
  const face = state.work[0];
  if (
    face !== undefined &&
    state.work.length === 1 &&
    probe === undefined &&
    state.atmosphere !== true &&
    scenePasses !== undefined
  ) {
    const native = nativeTargetCapture(face, scenePasses, lighting, shadow.value, sharedShadows);
    if (native !== undefined) return native;
  }
  if (
    probe !== undefined &&
    state.work.length === 0 &&
    state.atmosphere !== true &&
    sharedShadows === undefined &&
    scenePasses !== undefined
  ) {
    const native = nativeProbeCapture(probe, scenePasses, lighting, shadow.value);
    if (native !== undefined) return native;
  }
  const procedure = RenderGraphBuilder.procedure<RenderPipelineFrame>({
    device: internals.device,
    surfaceSize: viewport,
  });
  const graph = procedure.passes;
  const atmosphere = atmosphereTopologyOf(
    frameState,
    false,
    lights.directional?.perPixelAtmosphereTransmittance,
  );
  const buffers = importStandardClusterBuffers(
    graph,
    lighting,
    !internals.device.caps.storageBuffer &&
      atmosphere.atmosphere === true &&
      atmosphere.atmosphereBackgroundOnly !== true
      ? { atmosphere: true }
      : undefined,
  );
  if (!buffers.ok) throw buffers.error;
  if (buffers.value !== null) {
    const membership = addStandardClusterMembershipPass(graph, lighting, buffers.value);
    if (!membership.ok) throw membership.error;
  }
  // A planar mirror records with the display view's lights and samples the
  // shadows that view rastered this frame.
  const shadows =
    sharedShadows === undefined
      ? addTypedShadowPasses(graph, { shadow: shadow.value })
      : importSharedShadowTargets(graph, { shadow: shadow.value }, sharedShadows);
  if (!shadows.ok) throw shadows.error;
  const targets =
    probe === undefined
      ? addTargetCaptureGraphPasses(
          graph,
          state,
          {
            shadows: shadows.value,
            clusters: buffers.value,
            accesses: buffers.value === null ? [] : standardClusterReadAccesses(buffers.value),
          },
          undefined,
          ({ pass, resources, source, format }) => {
            const sourceView = resources.textureView(source);
            if (!sourceView.ok) throw sourceView.error;
            const encoded = encodeMipmapLevel(internals.device, pass, sourceView.value, format);
            if (!encoded.ok) throw encoded.error;
          },
          scenePasses,
        )
      : addReflectionProbeGraphPasses(
          graph,
          { work: [probe] },
          undefined,
          shadows.value,
          buffers.value,
          scenePasses,
        );
  if (!targets.ok) throw targets.error;
  const compiled =
    profileSession === undefined
      ? procedure.bindResources()
      : runProfiledRenderPhase(
          profileSession,
          'graph/bind-ordered-resources',
          procedure.bindResources,
        );
  if (!compiled.ok) throw compiled.error;
  installScenePasses(graph, compiled.value);
  return compiled.value;
}

function admitStandardGraphTopology(
  input: Pick<
    Parameters<typeof standardAoUnavailableForGraph>[0],
    'internals' | 'frameState' | 'camera' | 'stockRecording'
  >,
  result: Result<RenderPipelineTopology, RhiError>,
): Result<
  RenderPipelineTopology,
  {
    readonly code: GraphRejectCode;
    readonly error: Extract<GraphEffectError, { route: 'registry' }>['error'];
    readonly fallback: 'topology' | 'none';
  }
> {
  if (!result.ok)
    return err({
      code: 'topology-failed',
      error: result.error,
      fallback:
        result.error.code === 'rhi-texture-format-capability-unavailable' ? 'none' : 'topology',
    });
  const error = standardAoUnavailableForGraph({
    ...input,
    topology: result.value,
    deviceGeneration: recordContext(input.internals).deviceScope.generation,
  });
  if (error !== undefined) {
    traceGraphDecision(input.internals, input.frameState, 'ao-unavailable', undefined);
    return err({ code: 'ao-unavailable', error, fallback: 'none' });
  }
  return result;
}

import {
  addReflectionProbeGraphPasses,
  importCloudHistoryTargets,
  importSsrSceneColorTargets,
  importTemporalHistoryTargets,
  importWaterSsrInputParams,
  isMotionBlurTemporalDemand,
  type ReflectionProbeGraphWork,
} from './frame-graph-history';

export {
  type CompiledFrameHooks,
  type EncodedFrameGraph,
  type FrameGraphEncodeOutcome,
  recordCompiledFrameGraph,
  settleEncodedFrameGraph,
} from './compiled-frame-recording';
export {
  addReflectionProbeGraphPasses,
  boundedReflectionProbeFilterWork,
  isMotionBlurTemporalDemand,
  type ReflectionProbeFilterGraphState,
  type ReflectionProbeFilterGraphWork,
  type ReflectionProbeGraphState,
  type ReflectionProbeGraphWork,
  shouldUseTemporalFrameTransaction,
} from './frame-graph-history';
