import { nowMs } from '@forgeax/engine-platform';
import {
  compiledRenderGraphAllocation,
  compiledRenderGraphGeneration,
} from '@forgeax/engine-render-graph';
import {
  type SharedFeatureGraphPublication,
  sharedFeatureGraphPublication,
} from '../assembly/feature-frame-graph';
import { isCaptureViewPipeline } from '../capture/capture-view';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import { projectedDecalTopology } from '../decals/graph';
import { atmosphereTransportOf } from '../environment/inspection';
import { captureEditorAssistanceView } from '../features/editor-assistance/feature';
import { scopedGraphTextureTarget } from '../features/graph-texture-targets';
import { chromaticAberrationActive, outputLensEffectsActive } from '../features/lens-effects';
import { distanceOutlineFirstStep } from '../features/outline/distance-graph';
import { isOutlinePostProcess } from '../features/outline/shaders';
import { importSharedGraphTextures } from '../features/shared-graph-textures';
import { renderFeatureViewIdentity } from '../features/view';
import { referencedDeferredProbes } from '../pipeline/deferred-reflection-coverage';
import { withForwardShadowAdmission } from '../pipeline/forward-shadow-admission';
import { buildDeferredDisplay } from '../pipeline/standard-deferred-lane';
import { forwardClusterTextureExtent } from '../pipeline/standard-forward-lane';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from '../pipeline/standard-lighting/graph';
import { usesNativeGrade } from '../pipeline/standard-output/layout';
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
import {
  getRenderFeatureGraphState,
  recordedGraphDeviceGeneration,
} from './compiled-frame-recording';
import { currentGpuRaster } from './current-gpu-raster';
import { leanLightingFrame } from './directional-shadow-simple';
import { admitsOrderedDisplay, DisplayPorts, shadowProjectionLightBytes } from './display-ports';
import { buildForwardDisplay } from './forward-display';
import {
  retainedFrameGraphPolicy,
  retainedFrameGraphPolicyMatches,
  serializeFrameGraphKey,
} from './frame-graph-key';
import { resolveSpotShadowMapSize } from './frame-targets';
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
import { addCurrentReflectionProbeFilters } from './reflection-probe-pmrem';
import { scenePipelinePreparations } from './scene-pipeline-preparation';
import { admitStandardAoConfig, standardAoUnavailableForGraph } from './standard-ao-admission';

import {
  standardAfterTonemapOutput,
  standardFeatureContribution,
} from './standard-feature-contribution';
import { addTargetCaptureGraphPasses, type CubeCaptureGraphState } from './target-capture-graph';

export type { CubeCaptureGraphState, CubeCaptureGraphWork } from './target-capture-graph';

import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';

import type { RecorderSession } from '@forgeax/engine-profiler';

import {
  type CompiledRenderGraph,
  type GraphTextureView,
  RenderGraphBuilder,
  type RenderGraphError,
  type RenderGraphGenerationAllocationEntry,
  type RenderGraphGenerationAllocationInspection,
} from '@forgeax/engine-render-graph';

import type { Texture, TextureFormat, TextureView } from '@forgeax/engine-rhi';

import { multisampleRenderCapability, RhiError } from '@forgeax/engine-rhi';

import { err, ok, type Result } from '@forgeax/engine-types';

import { standardBloomAdmitted } from '../bloom-admission';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
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
import {
  type FeatureGraphConformanceEvent,
  recordFeatureGraphConformanceEvent,
} from '../features/feature-graph-conformance-trace';
import { featureScopeKey } from '../features/frame-plan';
import {
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
  hasSubmissionSensitiveFeatures,
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
import {
  deriveStandardTopologyInput,
  type StandardTopologyInputValue,
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
import { usesTsrCompute } from '../tsr/capabilities';
import { hasVolumetricFogCapability } from '../volume/capability';
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
import { type CaptureScenePasses, installScenePasses } from './scene-pass-work';
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

export interface RenderFeatureGraphRuntimeState {
  plans: readonly RenderFeaturePlannedFrame[];
  fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
  postProcessIdentities: readonly string[];
  /**
   * The accepted state a candidate committed this frame replaced; restored by
   * `settleFeatureGraphState` when the view's submission is not accepted.
   */
  rollback?: Pick<
    RenderFeatureGraphRuntimeState,
    'plans' | 'fullscreenEffects' | 'postProcessIdentities'
  >;
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

const graphRetirementFailures = new WeakMap<
  RenderFrameState,
  Set<CompiledRenderGraph<RenderPipelineFrame>>
>();

type GraphGenerationRole = 'active' | 'candidate' | 'retiring';

type GraphGenerationStatus = 'active' | 'retiring' | 'failed' | 'retired';

interface GraphGenerationAllocationRecord {
  readonly graph: CompiledRenderGraph<RenderPipelineFrame>;
  status: GraphGenerationStatus;
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

function graphGenerationAllocationTotals(records: Iterable<GraphGenerationAllocationRecord>): {
  liveBytes: number;
  pendingRetirementBytes: number;
} {
  const physical = new Map<string, { bytes: number; live: boolean }>();
  let liveBytes = 0;
  let pendingRetirementBytes = 0;
  const add = (key: string | undefined, bytes: number, state: 'live' | 'pending-retirement') => {
    const live = state === 'live';
    if (key === undefined) {
      if (live) liveBytes += bytes;
      else pendingRetirementBytes += bytes;
    } else {
      const prior = physical.get(key);
      if (prior === undefined) physical.set(key, { bytes, live });
      else {
        prior.bytes = bytes;
        prior.live ||= live;
      }
    }
  };
  for (const record of records)
    if (record.status !== 'retired') compiledRenderGraphAllocation(record.graph, add);
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

export function trackGraphGeneration(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  const owner = graphGenerationAllocationOwner(frameState);
  const record = owner.records.get(graph);
  if (record === undefined) {
    owner.records.set(graph, { graph, status: 'active' });
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
    owner.records.set(graph, { graph, status: 'retiring' });
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
    const allocation = compiledRenderGraphAllocation(graph);
    if (allocation === undefined) {
      unavailableGenerationCount += 1;
      continue;
    }
    const retirement =
      record.status === 'failed' ? 'failed' : roles.has('retiring') ? 'pending' : 'active';
    entries.push({
      generation: compiledRenderGraphGeneration(graph),
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

type CompiledGraphTargetAccess = CompiledRenderGraph<RenderPipelineFrame> & {
  readonly getColorTargetDescriptor: (
    name: string,
  ) => import('@forgeax/engine-render-graph').ResolvedColorTargetDescriptor | undefined;
  readonly getColorTargetView: (name: string) => TextureView | undefined;
  readonly getColorTargetTexture: (name: string) => Texture | undefined;
};

export function resetRenderFeatureGraphState(internals: RenderSystemInternals): void {
  const state = getRenderFeatureGraphState(internals);
  state.plans = [];
  state.fullscreenEffects = new Map();
  state.postProcessIdentities = [];
  delete state.rollback;
}

/**
 * Keep the Feature state a candidate committed this frame when the view's
 * submission was accepted, otherwise restore the state it replaced. Accepted
 * post-process parameter buffers are not restored: each frame prepares a
 * fresh candidate against the restored plans.
 */
export function settleFeatureGraphState(internals: RenderSystemInternals, accepted: boolean): void {
  const state = getRenderFeatureGraphState(internals);
  const previous = state.rollback;
  if (previous === undefined) return;
  delete state.rollback;
  if (accepted) return;
  state.plans = previous.plans;
  state.fullscreenEffects = previous.fullscreenEffects;
  state.postProcessIdentities = previous.postProcessIdentities;
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
): Result<readonly RenderFeaturePlanExecution[], RenderError> {
  const identities = new Set<string>();
  const projected: RenderFeaturePlanExecution[] = [];
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
  }
  return ok(Object.freeze(projected));
}

export function commitFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate,
): void {
  // Publish renderer-owned declarations only after their device resources have
  // been admitted.  If the acceptance hook throws, the previously accepted
  // graph/state pair remains visible to the caller.
  recordRenderFeatureCandidateEvent(internals, candidate, 'accepted');
  const state = getRenderFeatureGraphState(internals);
  state.rollback ??= {
    plans: state.plans,
    fullscreenEffects: state.fullscreenEffects,
    postProcessIdentities: state.postProcessIdentities,
  };
  state.plans = candidate.plans;
  state.fullscreenEffects = candidate.fullscreenEffects;
  state.postProcessIdentities = candidate.postProcessIdentities ?? [];
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
  lights: ViewLights,
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
  frameState: RenderFrameState,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
  featurePlanRevision: number | string,
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
    preparedResourceKey:
      featureGraphCandidate?.preparedResourceKey ??
      frameState.compiledFrameGraph?.preparedResourceKey ??
      '',
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
  featurePlanRevision: number | string,
  cubeCaptureState: CubeCaptureGraphState | undefined,
  passPlan: ViewPassPlan,
  volumetricFog: ExtractedVolumetricFog | undefined,
  standardLighting: StandardTopologyInputValue | undefined,
  lightingSignature: string,
  ssr: SsrSpatialAdmission | undefined,
  renderExtent: RenderExtent | undefined,
  analyticFog: boolean,
  terrainReceivers: readonly TerrainShadowReceiver[] = [],
  subsurface?: RenderPipelineTopology['subsurface'],
  unfoggedOpaque = false,
  capsuleShadows = false,
  stockRecording = false,
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
  const fullscreenEffects = featureFullscreenEffects(internals, featureGraphCandidate);
  const config = admitStandardAoConfig(
    internals,
    pipelineState,
    featurePostEffectConfig(internals, frameState, featureGraphCandidate),
  );
  const standardProfile = frameState.cameraStandardProfile ?? internals.standardProfile;
  const editor = editorAssistanceTopology(internals, frameState, camera, clearOnly);
  const multisample = admitMultisampleTopology(internals, camera);
  if (!multisample.ok) return multisample;
  const waterView = featurePlansOf(internals, featureGraphCandidate).find(
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
    referencedDeferredProbes(probes.value.probes).length > 0;
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
          camera,
          clearOnly,
          editor === undefined ? camera.outline : editor.authoredOutline,
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
      output: outputTopologyOf(camera, frameState, clearOnly),
      temporal: {
        taa: isTemporalAntialias(camera.antialias),
        motionBlur: isMotionBlurTemporalDemand(camera.motionBlur),
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
      featureTopologySignature: featureTopologySignatureOf(
        frameState,
        featureGraphCandidate,
        featurePlanRevision,
        fullscreenEffects,
        cubeCaptureState,
        stockRecording,
      ),
      // Borrowed graph imports resolve their signature only after recording ownership is known.
      gpuDrivenTopologySignature: '',
      standardLightingTopologySignature: lightingSignature,
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
  frameState.materialBgAssemblyCache.retireGraph(graph);
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
  if (previousGraph !== undefined && previousGraph !== candidate.graph)
    retire(frameState, previousGraph);
  // A stashed graph may alias resources of the graph it was compiled
  // against; once another graph is accepted it can never be promoted.
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  frameState.unsubmittedCompiledFrameGraph = undefined;
  if (stashed !== undefined && stashed.installed.graph !== candidate.graph)
    retire(frameState, stashed.installed.graph);
  frameState.shadowDepthLayers?.acceptSubmittedTextures(candidate.graph);
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
            deviceGeneration: recordedGraphDeviceGeneration(candidate.graph),
          }
        : undefined;
    if (frameState.unsubmittedCompiledFrameGraph === undefined) retire(frameState, candidate.graph);
    else settlement = 'stashed';
  }
  frameState.compiledFrameGraph = previous.installed;
  frameState.graphGeneration = previous.graphGeneration;
  frameState.compiledFrameGraphGeneration = previous.compiledGeneration;
  frameState.standardLightingGraphSignature = previous.lightingSignature;
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

function ownsDeclaredViewWork(entry: RenderFeaturePlannedFrame): boolean {
  const plan = entry.plan;
  return plan.passes.length !== 0 || plan.resources.length !== 0 || plan.waterView !== undefined;
}

/** A shared graph owns whole plans. Borrow the validated roster unless it needs partitioning. */
function viewFeaturePlans(
  plans: readonly RenderFeaturePlannedFrame[],
  executions: readonly RenderFeaturePlanExecution[],
  shared: SharedFeatureGraphPublication | undefined,
) {
  let selectedPlans: RenderFeaturePlannedFrame[] | undefined;
  let selectedExecutions: RenderFeaturePlanExecution[] | undefined;
  if (shared !== undefined) {
    for (let i = 0; i < executions.length; i++) {
      const execution = executions[i] as RenderFeaturePlanExecution;
      const passes = execution.passes;
      if (passes.length !== 0 && passes.every((pass) => shared.passes.has(pass))) {
        selectedPlans ??= plans.slice(0, i);
        selectedExecutions ??= executions.slice(0, i);
      } else if (selectedPlans !== undefined) {
        selectedPlans.push(plans[i] as RenderFeaturePlannedFrame);
        selectedExecutions?.push(execution);
      }
    }
  }
  return { plans: selectedPlans ?? plans, executions: selectedExecutions ?? executions };
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
          entry.stage === 'before-temporal' || entry.stage === 'before-output'
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
  cloudShadowResolution: number | undefined,
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
    cloudShadowResolution: cloudShadowResolution ?? 0,
    cloudHistory: cloudHistoryFormat,
    ssrSceneColorReference:
      frameState.activeTemporalGpuState === undefined
        ? undefined
        : [frameState.activeTemporalGpuState.width, frameState.activeTemporalGpuState.height],
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
      ? importAutoExposureGraphResources(
          builder,
          topology.lane.compute && topology.lane.storageBuffer ? 'compute' : 'fragment',
        )
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

/** Renderer-owned output resources and histories imported into a new graph, in import order. */
function importStandardGraphInputs(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  topology: RenderPipelineTopology,
  cloudHistoryFormat: CloudTransportFormat | undefined,
  ssr: SsrSpatialAdmission | undefined,
): Result<StandardGraphInputs, RenderGraphError> {
  const standardOutput = importStandardOutputInputs(builder, frameState, topology);
  if (!standardOutput.ok) return standardOutput;
  const taaHistory = isTemporalAntialias(camera.antialias)
    ? importTemporalHistoryTargets(
        builder,
        camera.antialias === 'tsr' ? 'tsr' : 'taa',
        usesTsrCompute(topology.lane),
      )
    : undefined;
  const cloudHistory =
    cloudHistoryFormat === undefined
      ? undefined
      : importCloudHistoryTargets(builder, cloudHistoryFormat);
  const targetCoverage =
    camera.dynamicResolution === undefined || topology.extent === undefined
      ? undefined
      : createTargetCoverageAttachment(builder, topology.extent);
  if (targetCoverage !== undefined && !targetCoverage.ok) return targetCoverage;
  const waterSsr = topology.water === true && isWaterSsrAdmitted(ssr) ? ssr : undefined;
  const temporalAA = isTemporalAntialias(camera.antialias);
  const hitColorHistory =
    topology.inlineSsr ||
    (temporalAA &&
      (waterSsr !== undefined || (ssr?.status === 'admitted' && ssr.lane === 'deferred')))
      ? importSsrSceneColorHistoryTarget(
          builder,
          frameState,
          topology.surface.width,
          topology.surface.height,
          !temporalAA,
        )
      : undefined;
  if (hitColorHistory !== undefined && !hitColorHistory.ok) return hitColorHistory;
  const collectStandardGraphInputs = () => {
    return ok({
      ...standardOutput.value,
      ...(taaHistory === undefined ? {} : { taaHistory }),
      ...(cloudHistory === undefined ? {} : { cloudHistory }),
      ...(targetCoverage === undefined ? {} : { targetCoverage: targetCoverage.value }),
      ...(waterSsr === undefined
        ? {}
        : { waterSsr: { inputParams: importWaterSsrInputParams(builder) } }),
      ...(hitColorHistory === undefined ? {} : { ssrSceneColorHistory: hitColorHistory.value }),
      ...(!topology.inlineSsr || temporalAA
        ? {}
        : {
            ssrSceneColorOutput: importSsrSceneColorOutput(
              builder,
              topology.surface.width,
              topology.surface.height,
            ),
          }),
    });
  };
  return collectStandardGraphInputs();
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

function installedFrameGraphOf(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  topologyKey: FrameGraphIdentity,
  topology: RenderPipelineTopology,
  captureLayout: GraphCaptureLayout | undefined,
  graphGeneration: number,
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
): InstalledFrameGraph {
  const requiresShadowPipelinePreparation = stockRecording
    ? shadowPipelinePreparationDemand(builder)
    : undefined;
  const compiledTargets = graph as CompiledGraphTargetAccess;
  const waterFluidBodyDescriptor = waterFluidBodyDescriptorReader(builder);
  const resolveTargetName = (name: string): string => {
    const alias = featureTextureAliases.get(name);
    return alias !== undefined && compiledTargets.getColorTargetTexture(name) === undefined
      ? alias
      : name;
  };
  return {
    ...(captureLayout === undefined ? {} : { captureLayout }),
    ...(waterFluidBodyDescriptor === undefined ? {} : { waterFluidBodyDescriptor }),
    ...(requiresShadowPipelinePreparation === undefined
      ? {}
      : { requiresShadowPipelinePreparation }),
    ...(prepareGpuDrivenPipelines === undefined ? {} : { prepareGpuDrivenPipelines }),
    ...(prepareGpuDrivenSource === undefined ? {} : { prepareGpuDrivenSource }),
    scenePipelinePreparations: scenePipelinePreparations(builder),
    ...(topology.camera.depthOfField === undefined
      ? {}
      : { depthOfField: inspectDepthOfFieldGraph(graph, topology.camera.depthOfField) }),
    ...(topology.volumetricFog?.enabled === true
      ? { volumetricFogTextures: bindVolumetricFogTextures(graph) }
      : {}),
    ...(directionalShadowViewCount === undefined ? {} : { directionalShadowViewCount }),
    graph,
    configurationRevision,
    ...receiverTransport,
    topologyKey,
    retainedPolicy: retainedFrameGraphPolicy(topology),
    ...(preparedResourceKey === undefined ? {} : { preparedResourceKey }),
    targets: {
      getColorTargetDescriptor: (name) =>
        compiledTargets.getColorTargetDescriptor(resolveTargetName(name)),
      getColorTargetView: (name) => compiledTargets.getColorTargetView(resolveTargetName(name)),
      getColorTargetTexture: (name) =>
        compiledTargets.getColorTargetTexture(resolveTargetName(name)),
      graphGeneration,
    },
  };
}

/** @internal Stock graph adapter exposed to backend conformance fixtures. */
export function pipelineBuildOf(
  activePipeline: RenderFrameState['activePipeline'],
  stockRecording: boolean,
  gtaoExecutionOverride?: RenderFrameState['gtaoExecutionOverride'],
): RenderFrameState['activePipeline']['build'] {
  // Direct and custom graph builds cannot admit callback or accessor elision.
  return stockRecording
    ? (context, topology) =>
        buildStandardViewRecording(
          activePipeline,
          {
            ...context,
            ...(gtaoExecutionOverride === undefined ? {} : { gtaoExecutionOverride }),
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
  readonly cloudShadowResolution?: number | undefined;
  readonly terrainReceivers?: readonly TerrainShadowReceiver[] | undefined;
  readonly subsurface?: RenderPipelineTopology['subsurface'] | undefined;
  readonly rendererRecording?: boolean | undefined;
  readonly unfoggedOpaque?: boolean | undefined;
  readonly capsuleShadows?: boolean | undefined;
  /** Renderer-owned shadow layers; the caller ensures them before compile. */
  readonly shadowDepthLayers: ShadowDepthLayers;
}

/**
 * The graph this view already owns for `key`. A candidate flag only describes
 * a possible topology replacement: an unchanged key reuses the accepted graph
 * so dynamic volume history/imported views can advance and a queue-submit
 * failure can still publish the LKG diagnostic. Otherwise a stashed
 * compiled-but-unsubmitted graph is promoted when its key and device
 * generation match; any other stash is retired by the rebuild.
 */
function existingFrameGraphFor(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  key: string,
): ExistingFrameGraph {
  const installed = frameState.compiledFrameGraph;
  if (installed !== null && installed.topologyKey === key)
    return { kind: 'reused', graph: installed };
  const stashed = frameState.unsubmittedCompiledFrameGraph;
  if (stashed === undefined) return REBUILD_WITHOUT_STASH;
  return stashed.installed.topologyKey === key &&
    stashed.deviceGeneration === recordContext(internals).deviceScope?.generation
    ? { kind: 'promoted', graph: stashed.installed }
    : { kind: 'rebuild', retireStash: stashed.installed };
}

type ExistingFrameGraph =
  | { readonly kind: 'reused' | 'promoted'; readonly graph: InstalledFrameGraph }
  | { readonly kind: 'rebuild'; readonly retireStash: InstalledFrameGraph | undefined };

const EMPTY_FEATURE_ALIASES: ReadonlyMap<string, string> = new Map();

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
  accepted: Pick<
    GraphEffects,
    'postPending' | 'cloudHistoryActive' | 'cloudHistoryFormat' | 'gpuReplacement'
  >,
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
    cloudHistoryActive: cloudHistoryFormat !== undefined,
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
    cloudShadowResolution,
    terrainReceivers = [],
    subsurface,
    rendererRecording = false,
    unfoggedOpaque = false,
    capsuleShadows = false,
    shadowDepthLayers,
  } = input;
  // `render-feature-plan` planned the Feature candidate compile reads (fullscreen
  // effects, post identities, plans, prepared-resource key) in RenderQueue.
  const featureGraphCandidate = featurePlan.candidate;
  clearStaleGtaoCandidatePreparationFault(
    frameState,
    recordContext(internals).deviceScope.generation,
  );
  const metrics = emptyFeatureGraphMetricsDelta();
  const requestedStandardLightingSignature = standardLightingTopologySignature(
    standardLighting,
    frameState.standardClusterMembership?.graphLayout,
  );
  const graphCamera = graphCameraOf(camera, frameState);
  const compactProfile =
    (frameState.cameraStandardProfile ?? internals.standardProfile)?.gbufferFormat === 'default';
  const lastKnownGood = (): CompiledRenderGraph<RenderPipelineFrame> | null => {
    const installed = frameState.compiledFrameGraph;
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
    return installed !== null &&
      directional.ok &&
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
      !hasSubmissionSensitiveFeatures(getRenderFeatureGraphState(internals).plans) &&
      cubeCaptureState?.planar?.current() === undefined &&
      !installed.graph
        .inspect()
        .resources.some((resource) => resource.label.startsWith('planar-reflection.')) &&
      frameState.standardLightingGraphSignature === requestedStandardLightingSignature
      ? installed.graph
      : null;
  };
  let retireStash: InstalledFrameGraph | undefined;
  const effects = (overrides: Partial<GraphEffects> = {}): GraphEffects => ({
    metrics,
    configurationRevision: internals.standardProfile?.configurationRevision,
    lightingSignature: requestedStandardLightingSignature,
    cloudHistoryActive: false,
    featureCandidate: featureGraphCandidate,
    postPending: false,
    retireStash,
    gpuReplacement: undefined,
    error: undefined,
    ...overrides,
  });
  // A rejected volume-topology candidate has no fallback; any other keeps the accepted graph.
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
  const featurePlans = featurePlansOf(internals, featureGraphCandidate);
  traceFeaturePlanInput(internals, frameState, featureGraphCandidate, featurePlans);
  const projectedFeaturePlans = validateRenderFeaturePlans(featurePlans, metrics);
  if (!projectedFeaturePlans.ok) {
    metrics.validationFailures += 1;
    return reject(
      'feature-validation-failed',
      { route: 'feature', error: projectedFeaturePlans.error },
      'topology',
    );
  }
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
        metrics.validationFailures += 1;
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
  traceFeatureGraphEvent(
    internals,
    frameState.frameNumber,
    'typed-plan-validated',
    featurePlanTraceDetails(internals, featurePlans),
  );
  const cloudHistoryFormat = cloudHistoryFormatOf(projectedFeaturePlans.value);
  const sharedPublication = sharedFeatureGraphPublication(internals.featureHost);
  const { plans: viewPlans, executions: viewExecutions } = viewFeaturePlans(
    featurePlans,
    projectedFeaturePlans.value,
    sharedPublication,
  );
  const planRevisionState = mutableFeatureGraphInspection(internals).planRevisionState;
  const nextPlanRevision = updateRenderFeaturePlanRevision(
    planRevisionState,
    viewPlans,
    viewExecutions,
  );
  if (nextPlanRevision !== planRevisionState) metrics.planRevision = nextPlanRevision;
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
  const topologyCandidate = topologyCandidateOf(
    internals,
    featureGraphCandidate,
    featurePlans,
    transientViews.ownsPhysicalChanges ||
      (sharedPublication !== undefined &&
        !viewPlans.some(renderFeaturePlanRequiresPreparedResourceKey)),
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
    topologyCandidate,
    transientViews.topologySignature ?? nextPlanRevision.revision,
    cubeCaptureState,
    passPlan,
    volumetricFog,
    standardLighting,
    requestedStandardLightingSignature,
    ssr,
    renderExtent,
    analyticFog,
    terrainReceivers,
    subsurface,
    unfoggedOpaque,
    capsuleShadows,
    stockRecording,
    gpuDriven?.shadowViewPool?.staticLayers,
  );
  const completeViewGraphCompileCandidate = (): ViewGraphCompileOutcome => {
    const topologyAdmission = admitStandardGraphTopology(
      { internals, frameState, camera, stockRecording },
      topologyResult,
    );
    if (!topologyAdmission.ok) {
      metrics.buildFailures += 1;
      const failure = topologyAdmission.error;
      return reject(failure.code, { route: 'registry', error: failure.error }, failure.fallback);
    }
    const featurePostProcessEntries = featureFullscreenEffects(internals, featureGraphCandidate);
    const postProcessAdmission = admitFeaturePostProcessChain(
      internals,
      topologyAdmission.value,
      featurePostProcessEntries,
      isMultisampleAntialias(camera.antialias) && topologyAdmission.value.lane.multisample,
    );
    const acceptedLkg = postProcessAdmission.pending ? lastKnownGood() : null;
    if (acceptedLkg !== null) {
      // Do not publish a candidate whose fullscreen chain is only partially
      // ready. Keep the accepted graph (including its prior post-effect chain)
      // and retry the same feature candidate on the next frame.
      return {
        frame,
        kind: 'retained',
        graph: acceptedLkg,
        reason: 'post-chain-pending',
        effects: effects(),
      };
    }
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
      (!currentCameraLateOcclusion ||
        (internals.depthPyramidShaders?.seed !== undefined &&
          internals.depthPyramidShaders.reduce !== undefined));
    const directSource =
      input.currentGpuCamera === false &&
      gpuReplacement === undefined &&
      gpuDriven?.projectCamera !== undefined &&
      supportsCameraSelection;
    const displayOutput =
      stockRecording &&
      captureLayout === undefined &&
      (currentGpuCamera || gpuDriven === undefined || directSource)
        ? frameState.activePipeline === standardPipeline
          ? topology.opaque.lane === 'deferred'
            ? 'deferred'
            : 'standard'
          : premultipliedForwardOutput(frameState.activePipeline)
        : undefined;
    const observations = recordContext(internals).observationCaptureDomains;
    if (
      displayOutput !== undefined &&
      !postProcessAdmission.pending &&
      admitsOrderedDisplay(topology, displayOutput, internals.device.caps.rgba16floatRenderable) &&
      isStandardLightCount((topology.standardProfile ?? DEFAULT_STANDARD_PROFILE).lightCount) &&
      standardLighting !== undefined &&
      deriveStandardTopologyInput(standardLighting).ok &&
      !viewPlans.some(ownsDeclaredViewWork) &&
      sharedPublication === undefined &&
      (featureGraphCandidate?.featureTextureReadbacks?.length ?? 0) === 0 &&
      !observations?.some(
        (domain) =>
          domain !== 'final-display' &&
          !(
            typeof displayOutput === 'string' &&
            (domain === 'linear-hdr' || (domain === 'linear-ldr' && usesNativeGrade(topology)))
          ),
      ) &&
      !recordContext(internals).featureSceneInputs?.work.length &&
      cubeCaptureState?.planar?.current() === undefined &&
      frameState.probePlacementFrame === undefined &&
      frameState.rayDiffuse?.ready === undefined &&
      frameState.screenProbe?.ready === undefined &&
      internals.standardProfile?.diffuseGi?.gather !== 'baked' &&
      irradianceFieldInput(internals, frameState) === undefined &&
      frameState.gtaoExecutionOverride === undefined &&
      frameState.gtaoCandidatePreparationFailureGeneration === undefined
    ) {
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
      const textureLighting =
        displayOutput !== 'deferred' &&
        standardLighting.kind === 'clustered' &&
        standardLighting.transport.kind === 'cpu-texture'
          ? requestedStandardLightingSignature
          : undefined;
      const shadowLightBytes = shadowProjectionLightBytes(topology, standardLighting);
      const weighted = passPlan.transparent.inspection.resolved === 'weighted-blended';
      const revision = internals.standardProfile?.configurationRevision;
      const installed = frameState.compiledFrameGraph;
      const stashed = frameState.unsubmittedCompiledFrameGraph;
      const accepted = {
        ...acceptedGraphFeatures(false, undefined),
        forwardDisplayReceiver: topology.forwardDirectionalShadow,
      };
      if (
        installed?.displayPorts?.accepts(
          topology,
          displayOutput,
          weighted,
          geometry,
          cullShadowReceivers,
          shadowDepthLayers,
          observeDisplay,
          observeLinear,
          textureLighting,
          shadowLightBytes,
        )
      )
        return existingFrameGraphOutcome(
          { kind: 'reused', graph: installed },
          frame,
          installed.topologyKey,
          metrics,
          effects,
          { ...accepted, gpuReplacement },
        );
      if (
        stashed?.installed.displayPorts?.accepts(
          topology,
          displayOutput,
          weighted,
          geometry,
          cullShadowReceivers,
          shadowDepthLayers,
          observeDisplay,
          observeLinear,
          textureLighting,
          shadowLightBytes,
        ) &&
        stashed.deviceGeneration === recordContext(internals).deviceScope.generation
      )
        return existingFrameGraphOutcome(
          { kind: 'promoted', graph: stashed.installed },
          frame,
          stashed.installed.topologyKey,
          metrics,
          effects,
          { ...accepted, gpuReplacement },
        );
      retireStash = stashed?.installed;
      const ports = new DisplayPorts(
        topology,
        displayOutput,
        weighted,
        geometry,
        cullShadowReceivers,
        shadowDepthLayers,
        observeDisplay,
        observeLinear,
        textureLighting,
        displayOutput === 'deferred'
          ? undefined
          : forwardClusterTextureExtent(topology, standardLighting),
        shadowLightBytes,
      );
      const key = displayGraphIdentity(ports, topology);
      metrics.lastTopologyKey = key;
      metrics.rebuildAttempts++;
      const started = nowMs();
      const procedure = RenderGraphBuilder.procedure<RenderPipelineFrame>({
        device: internals.device,
        surfaceSize: { width: surfaceWidth, height: surfaceHeight },
        reuseResourcesFrom: installed?.graph,
      });
      const builder = procedure.passes;
      const retainBundles = internals.options?.retainIndirectBundles === true;
      const built =
        displayOutput === 'deferred'
          ? buildDeferredDisplay(
              builder,
              topology,
              standardLighting,
              ports,
              frameState,
              shadowDepthLayers,
              retainBundles,
              internals.device.caps,
            )
          : buildForwardDisplay(
              builder,
              topology,
              displayOutput,
              standardLighting,
              ports,
              frameState,
              shadowDepthLayers,
              retainBundles,
              internals.device.caps,
            );
      metrics.buildCpuMs += nowMs() - started;
      if (!built.ok) {
        metrics.buildFailures++;
        return reject('graph-build-failed', { route: 'registry', error: built.error }, 'topology');
      }
      metrics.compileAttempts++;
      metrics.compileCause = { installedTopologyKey: installed?.topologyKey, key };
      const physicalStarted = nowMs();
      const physical =
        profileSession === undefined
          ? procedure.bindResources()
          : runProfiledRenderPhase(
              profileSession,
              'graph/bind-ordered-resources',
              procedure.bindResources,
            );
      metrics.compileCpuMs += nowMs() - physicalStarted;
      if (!physical.ok) {
        metrics.compileFailures++;
        return reject(
          'graph-compile-failed',
          { route: 'registry', error: physical.error },
          'last-known-good',
        );
      }
      traceCompiledFeatureGraph(
        internals,
        frameState,
        featureGraphCandidate,
        featurePlans,
        physical.value,
      );
      installScenePasses(builder, physical.value);
      metrics.compileSuccesses++;
      const binding = installedFrameGraphOf(
        builder,
        physical.value,
        key,
        topology,
        undefined,
        frameState.graphGeneration + 1,
        topologyCandidate?.preparedResourceKey ?? installed?.preparedResourceKey,
        true,
        built.value?.preparePipelines,
        built.value?.prepareSource,
        ports.directional ? 'current' : 0,
        EMPTY_FEATURE_ALIASES,
        revision,
        {
          atmosphereTransport: atmosphereTransportOf(topology),
          forwardDirectionalShadow: topology.forwardDirectionalShadow,
          forwardShadowCoverage: passPlan.forwardShadowCoverage,
        },
      );
      return {
        frame,
        kind: 'compiled',
        graph: physical.value,
        installed: { ...binding, displayPorts: ports },
        effects: effects({ ...accepted, gpuReplacement }),
      };
    }
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
    const graphTopology: RenderPipelineTopology = {
      ...topology,
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
          cloudShadowResolution,
          cloudHistoryFormat,
          cubeCaptureState,
          sharedPublication,
          fluid,
          stockRecording,
          receiverPolicy,
        );
        existing = existingFrameGraphFor(internals, frameState, key);
      } else {
        const match = runProfiledRenderPhase(profileSession, 'graph/key-match', () => {
          const candidateKey = frameGraphCacheKey(
            internals,
            frameState,
            topologyIdentity,
            captureLayout,
            currentGpuCamera || gpuDriven !== undefined,
            cloudShadowResolution,
            cloudHistoryFormat,
            cubeCaptureState,
            sharedPublication,
            fluid,
            stockRecording,
            receiverPolicy,
          );
          return {
            key: candidateKey,
            existing: existingFrameGraphFor(internals, frameState, candidateKey),
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
        getRenderFeatureGraphState(internals).postProcessIdentities),
      ...[...featurePostProcessEntries.keys()].filter(isStandardNamedPostProcess),
      MOTION_BLUR_FEATURE_IDENTITY,
    ]);
    const procedure = RenderGraphBuilder.procedure<RenderPipelineFrame>(
      {
        device: internals.device,
        surfaceSize: { width: surfaceWidth, height: surfaceHeight },
        reuseResourcesFrom: frameState.compiledFrameGraph?.graph,
        retainPassLocalTargets: captureLayout !== undefined,
      },
      stockRecording ? 'ordered' : 'deferred',
    );
    const builder = procedure.passes;
    const sceneInputs = recordContext(internals).featureSceneInputs?.import(builder);
    const graphInputs = importStandardGraphInputs(
      builder,
      frameState,
      camera,
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
    const build = pipelineBuildOf(activePipeline, stockRecording, frameState.gtaoExecutionOverride);
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
          ...(cloudShadowResolution === undefined ? {} : { cloudShadowResolution }),
          encodeTransmissionMip: ({ pass, resources, source, format }) => {
            const sourceView = resources.textureView(source);
            if (!sourceView.ok) throw sourceView.error;
            const encoded = encodeMipmapLevel(internals.device, pass, sourceView.value, format);
            if (!encoded.ok) throw encoded.error;
          },
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
          getFeatureGraphTextureView: (name, viewIdentity) =>
            scopedGraphTextureTarget(featureProjection.graphTextures, name, viewIdentity)?.[1].view,
          getFeatureGraphTextureFormat: (name, viewIdentity) => {
            const match = scopedGraphTextureTarget(
              featureProjection.graphTextures,
              name,
              viewIdentity,
            );
            return match === undefined ? undefined : (match[0].view?.format ?? match[0].format);
          },
          getFeatureGraphTextureBinding: (name, viewIdentity) => {
            const match = scopedGraphTextureTarget(
              featureProjection.graphTextures,
              name,
              viewIdentity,
            );
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
          getWaterMeshGraphAccesses: () => {
            const accesses: import('@forgeax/engine-render-graph').GraphAccess[] = [];
            const visited = new Set<import('@forgeax/engine-rhi').Buffer>();
            for (const execution of projectedFeaturePlans.value) {
              if (
                execution.featureIdentity !== WATER_GPU_MESH_FEATURE ||
                execution.scope !==
                  featureScopeKey({ view: renderFeatureViewIdentity(graphCamera) })
              )
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
          },
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
            projectedFeaturePlans.value.some((execution) => execution.featureIdentity === identity),
          afterTonemapOutput: standardAfterTonemapOutput(
            viewExecutions,
            fullscreenFeatureIds,
            graphTopology.surface.storageFormat,
          ),
          hasFeatureWork: (identity, placement) =>
            projectedFeaturePlans.value.some(
              (execution) =>
                (identity === undefined || execution.featureIdentity === identity) &&
                execution.passes.length > 0 &&
                (placement === undefined || (execution.placement ?? 'post') === placement),
            ),
          hasFeatureRasterWork: (identity, placement, passName) =>
            projectedFeaturePlans.value.some(
              (execution) =>
                execution.featureIdentity === identity &&
                execution.passes.some(
                  (pass) =>
                    pass.graphics !== undefined &&
                    (passName === undefined || pass.name === passName),
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
      let compiled: ReturnType<typeof builder.compile>;
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
    // Decorate the new graph object; adoption publishes it.
    installScenePasses(builder, compiled.value);
    metrics.compileSuccesses += 1;
    // No new lease means the installed imports remain current, not a second
    // resource transition back to an empty key on the following frame.
    return {
      frame,
      kind: 'compiled',
      graph: compiled.value,
      installed: installedFrameGraphOf(
        builder,
        compiled.value,
        key,
        topology,
        captureLayout,
        frameState.graphGeneration + 1,
        topologyCandidate?.preparedResourceKey ??
          frameState.compiledFrameGraph?.preparedResourceKey,
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

function featurePlanTraceDetails(
  internals: RenderSystemInternals,
  plans: readonly RenderFeaturePlannedFrame[],
): FeatureGraphConformanceEvent['details'] {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return {};
  const plan = plans.find((candidate) => candidate.featureIdentity === trace.featureIdentity);
  const execution = plan === undefined ? undefined : getRenderFeaturePlanExecutionProjection(plan);
  const passes = execution?.passes ?? [];
  return {
    targetPlanPresent: plan !== undefined,
    planCount: plans.length,
    scope: plan === undefined ? null : featureScopeKey(plan.scope),
    generation: plan?.generation ?? null,
    placement: plan?.placement ?? 'post',
    signature: plan?.signature ?? null,
    passNames: passes.map((pass) => pass.name),
    resolvedDispatchCount: passes.reduce(
      (count, pass) => count + (pass.resolvedGpuCompute?.dispatches.length ?? 0),
      0,
    ),
  };
}

function traceFeatureGraphEvent(
  internals: RenderSystemInternals,
  recordFrameNumber: number,
  stage: FeatureGraphConformanceEvent['stage'],
  details: FeatureGraphConformanceEvent['details'],
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber,
    featureIdentity: trace.featureIdentity,
    stage,
    details,
  });
}

function traceGraphPasses(
  internals: RenderSystemInternals,
  recordFrameNumber: number,
  path: string,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  targetFeaturePlanPresent: boolean,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const inspection = graph.inspect();
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'graph-passes',
    details: {
      path,
      passNames: inspection.passes.map((pass) => pass.name),
      graphGeneration: inspection.generation,
      targetFeaturePlanPresent,
    },
  });
}

function traceCandidateLifecycle(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
  disposition: string,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const plan = candidate?.plans.find((row) => row.featureIdentity === trace.featureIdentity);
  const execution = plan === undefined ? undefined : getRenderFeaturePlanExecutionProjection(plan);
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber: frameState.frameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'candidate-lifecycle',
    details: {
      disposition,
      candidatePresent: candidate !== undefined,
      targetPlanPresent: plan !== undefined,
      scope: plan === undefined ? null : featureScopeKey(plan.scope),
      passNames: execution?.passes.map((pass) => pass.name) ?? [],
    },
  });
}

function traceGraphDecision(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  path: string,
  candidate: RenderFeatureGraphCandidate | undefined,
  graph?: CompiledRenderGraph<RenderPipelineFrame> | null,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const plans = featurePlansOf(internals, candidate);
  const targetPlanPresent = plans.some((plan) => plan.featureIdentity === trace.featureIdentity);
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber: frameState.frameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'graph-decision',
    details: {
      path,
      candidatePresent: candidate !== undefined,
      targetPlanPresent,
      graphGeneration: graph?.inspect().generation ?? null,
      passNames: graph?.inspect().passes.map((pass) => pass.name) ?? [],
    },
  });
}

function traceFeaturePlanInput(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
  plans: readonly RenderFeaturePlannedFrame[],
): void {
  traceFeatureGraphEvent(internals, frameState.frameNumber, 'typed-plan-input', {
    source: candidate === undefined ? 'accepted-feature-host-state' : 'frame-candidate',
    candidatePresent: candidate !== undefined,
    ...featurePlanTraceDetails(internals, plans),
  });
}

function traceCompiledFeatureGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
  plans: readonly RenderFeaturePlannedFrame[],
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  traceCandidateLifecycle(internals, frameState, candidate, 'compiled-pending-adoption');
  traceGraphDecision(internals, frameState, 'render-graph-compiled', candidate, graph);
  traceGraphPasses(
    internals,
    frameState.frameNumber,
    'compiled',
    graph,
    plans.some(
      (plan) =>
        plan.featureIdentity ===
        recordContext(internals).featureGraphConformanceTrace?.featureIdentity,
    ),
  );
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
  importSsrSceneColorHistoryTarget,
  importSsrSceneColorOutput,
  importTemporalHistoryTargets,
  importWaterSsrInputParams,
  isMotionBlurTemporalDemand,
  type ReflectionProbeGraphWork,
} from './frame-graph-history';

export {
  type CompiledFrameHooks,
  type EncodedFrameGraph,
  type FrameGraphEncodeOutcome,
  getRenderFeatureGraphState,
  recordCompiledFrameGraph,
  recordGraphDeviceGeneration,
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
