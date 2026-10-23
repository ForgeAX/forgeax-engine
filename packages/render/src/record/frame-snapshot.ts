import type { ShadowMeshReads } from '../device/mesh-changes';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { FramePresentationPendingReason } from '../render-contract';
import type { CpuLodSelection } from './cpu-lod';
import type { MaterialBgAssemblyCache } from './material-bg-assembly-cache';
// @forgeax/engine-runtime - RenderSystem record stage: frame-snapshot.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import type { RenderReadVersion } from '@forgeax/engine-ecs/projection';
import { vec3 } from '@forgeax/engine-math';
import type {
  CompiledRenderGraphInfo,
  ResolvedColorTargetDescriptor,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { BarrelDistortionMapping } from '../barrel-distortion';
import type { ClusterBinScratch } from '../cluster-binner';
import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import type { EnvironmentGeneration } from '../environment/generation';
import type { EnvironmentLifecycle } from '../environment/lifecycle';
import type { DepthOfFieldParams } from '../features/depth-of-field/depth-of-field-params';
import type { GpuBuffer } from '../gpu-resource';
import type { MotionBlurExecutionReceipt } from '../inspection-types';
import type { InstanceProjectionStore } from '../instances';
import type { IblBindingInspection } from '../mesh-material-bindings';
import type { StandardLightingInspection } from '../pipeline/standard-lighting/inspection';
import type { AutoExposureGpuResources } from '../pipeline/standard-output/auto-exposure/gpu';
import type { AutoExposureState } from '../pipeline/standard-output/auto-exposure/state';
import type { StandardLutGpuResources } from '../pipeline/standard-output/lut-gpu';
import type { StandardLutCandidate, StandardLutState } from '../pipeline/standard-output/lut-state';
import type { PointShadowInspection } from '../point-shadow-inspection';
import type { SsrSpatialAdmission } from '../ssr/admission';
import type { SsrHistoryOwner } from '../ssr/history';
import type { TemporalGpuState } from '../temporal/gpu';
import type { TemporalView } from '../temporal/view';

export type TemporalCommitOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'off'; readonly view: TemporalView }
  | { readonly kind: 'taa'; readonly view: TemporalView };

/** CPU transaction metadata staged beside the renderer-owned GPU candidate. */
export interface PendingAutoExposureState {
  readonly state: AutoExposureState;
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly frameId: number;
}

/** CPU POD staged beside the renderer-owned LUT resources until submit. */
export interface PendingStandardLutState {
  readonly state: StandardLutState;
  readonly candidate?: StandardLutCandidate;
  readonly remove: boolean;
  readonly targetGeneration: number;
  readonly deviceEpoch: number;
}

/**
 * feat-20260708-composited-multi-world-rendering M1 / D-1 / D-9:
 * worldId-entityKey composite key helper. Formula: `worldId * 2^32 + entityKey`.
 *
 * worldId is the index into `worlds[]` (the `draw` call argument). entityKey
 * is the packed Entity u32 (encodeEntity(indexSlot, generation)) surfaced
 * through `RenderableSnapshot.entityKey`.
 *
 * Key properties:
 *   - worldId=0 identity: `worldEntityKey(0, k) === k` — single-world path
 *     cache behavior is bit-for-bit unchanged (AC-03 regression guarantee).
 *   - JS safe integer: worldId < 2^21 keeps the composite key below
 *     Number.MAX_SAFE_INTEGER (2^53).
 *   - SSOT: all cache-key compositing consumers import this single helper;
 *     no inline `worldId * 2^32 + k` duplication (D-9).
 *
 * @internal — exported for unit test + glyph/tilemap/record consumers;
 * not part of the public @forgeax/engine-runtime API surface.
 */
export function worldEntityKey(worldId: number, entityKey: number): number {
  return worldId * 4294967296 + entityKey; // 2^32 = 4294967296
}

/**
 * Cache identity for a renderer-owned instance collection.
 *
 * A collection can be rebound from one entity to another while retaining the
 * same count, revision, and extraction archetype. The collection id is the
 * owner identity in that case; the entity cache key is only the compatibility
 * fallback for legacy snapshots that predate the collection field.
 */
export function instanceCollectionCacheKey(
  worldId: number,
  instance: { readonly cacheKey: number; readonly collectionId?: number },
): number {
  // Keep collection entries in a disjoint numeric namespace from the shared
  // legacy sprite/fold cache. Fold keys occupy -1..-(2^32), while ordinary
  // world/entity keys are non-negative; this range starts below both.
  return -(0x1_0000_0000 + worldEntityKey(worldId, instance.collectionId ?? instance.cacheKey));
}

/**
 * Cross-frame cache entry for a material bind group whose source material and
 * all resolved GPU resources are stable. Binding-source handles survive
 * Worker cloning and numeric material edits; the builder only stores entries
 * after all explicit resource handles resolve to resident GPU objects.
 */
export interface MaterialBgAssemblyCacheEntry {
  readonly uniformResources: object;
  readonly material: MaterialSnapshot;
  /** Exact asset versions and resident views used by this shared binding. */
  readonly materialResources: readonly {
    readonly handle: number;
    readonly kind: 'texture' | 'sampler';
    readonly revision: number | undefined;
    readonly view: TextureView | undefined;
  }[];
  readonly preparedTextures: readonly {
    readonly parameter: string;
    readonly textureView: TextureView | undefined;
    readonly sampler: import('@forgeax/engine-rhi').Sampler | undefined;
  }[];
  readonly materialBgl: BindGroupLayout;
  /** Buffer identity changes when the shared material capacity grows. */
  readonly materialBuffer: Buffer;
  readonly sceneMaterialBuffer?: Buffer;
  readonly skylightResources: SkylightBindGroupResources;
  readonly bindGroup: BindGroup;
}

import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import type { MaterialRenderState, RenderPipelineAsset } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import type { InstanceBufferCacheEntry, InstanceBufferChunks } from '../instance-buffer-cache';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../render-contract';
import type { RenderPipeline as RenderPipelineDef, RenderPipelineFrame } from '../render-pipeline';
import type {
  DispatchEntry,
  MaterialSnapshot,
  PointShadowSnapshot,
  RenderableSnapshot,
  SpotLightSnapshot,
} from '../render-system-extract';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import type { ShadowAtlas } from '../shadow-atlas';
import type { TemporalFrame, TemporalFrameTransaction } from '../temporal/frame';
import type { VolumetricFogInspection } from '../volume/inspection';
import type { VolumeTemporalSignature } from '../volume/temporal';
import type { DirectionalCascadeCadenceState } from './directional-cascade-cadence';
import type { ShadowRasterLedger } from './shadow-raster-ledger';

/** Renderer-owned GPU cache entry for one object's 160B probe record. */
export interface ProbeBlendBufferCacheEntry {
  readonly generation: number;
  readonly bytes: Uint8Array;
}

/**
 * feat-20260608-create-app-param-surface-trim / M1 / D-8 (q8 user lock):
 * fallback clear color when the world carries no Camera entity. Opaque
 * black `[0, 0, 0, 1]`, replacing the historical
 * `[0.06, 0.06, 0.08, 1.0]` dark-slate sentinel. Single SSOT consumed by
 * the synthetic CameraSnapshot built when `cameras.length === 0`
 * (Case B in `recordFrame`) and read directly by tests
 * (`zero-camera-clear-fallback.test.ts`). AC-05.
 */
export const ZERO_CAMERA_CLEAR_FALLBACK: readonly [number, number, number, number] = [0, 0, 0, 1];

export interface FrameObservationSource {
  readonly texture: Texture;
  readonly descriptor: ResolvedColorTargetDescriptor;
  readonly frameId: number;
  readonly pipelineId: 'forgeax::standard';
  readonly backendId: string;
}

/** Internal test/diagnostic view of one compiled graph color target. */
export interface CurrentGraphTarget {
  readonly name: string;
  readonly texture: Texture;
  /** Stable opaque identity for this RHI handle during the renderer lifetime. */
  readonly textureIdentity: number;
  readonly descriptor: ResolvedColorTargetDescriptor;
  readonly frameId: number;
  /** Monotonic identity of the compiled graph that owns this texture. */
  readonly graphGeneration: number;
}

const textureIdentities = new WeakMap<object, number>();
let nextTextureIdentity = 1;

const opaqueResourceIdentities = new WeakMap<object, number>();
let nextOpaqueResourceIdentity = 1;

/** Stable detached identity for a renderer-owned opaque resource handle. */
export function getOpaqueResourceIdentity(resource: object): number {
  const existing = opaqueResourceIdentities.get(resource);
  if (existing !== undefined) return existing;
  const identity = nextOpaqueResourceIdentity++;
  opaqueResourceIdentities.set(resource, identity);
  return identity;
}

/**
 * Project an opaque RHI texture handle to a stable diagnostic identity.
 * RHI handles intentionally expose no serializable fields; object identity is
 * the only valid comparison boundary for a copy-time capture.
 */
export function getTextureIdentity(texture: Texture): number {
  const object = texture as object;
  const existing = textureIdentities.get(object);
  if (existing !== undefined) return existing;
  const identity = nextTextureIdentity++;
  textureIdentities.set(object, identity);
  return identity;
}

export type GraphTargetCaptureReadbackValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'capture-readback-length'
        | 'capture-readback-untouched-sentinel'
        | 'capture-readback-empty'
        | 'capture-readback-non-finite';
    };

/** Validate a mapped rgba16float capture before a consumer decodes its values. */
export function validateGraphTargetCaptureReadback(input: {
  readonly bytes: Uint8Array;
  readonly expectedByteLength: number;
  readonly sentinel?: Uint8Array;
  readonly allowZero?: boolean;
}): GraphTargetCaptureReadbackValidation {
  const { bytes, expectedByteLength, sentinel, allowZero = false } = input;
  if (bytes.byteLength !== expectedByteLength)
    return { ok: false, code: 'capture-readback-length' };
  if (sentinel?.every((value, index) => bytes[index] === value)) {
    return { ok: false, code: 'capture-readback-untouched-sentinel' };
  }
  if (!allowZero && bytes.every((value) => value === 0)) {
    return { ok: false, code: 'capture-readback-empty' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let index = 0;
  // Inspect both half-float exponents per word. DataView also preserves
  // little-endian capture semantics for unaligned slices and host byte orders.
  for (; index + 3 < bytes.byteLength; index += 4) {
    const word = view.getUint32(index, true);
    if ((word & 0x7c00) === 0x7c00 || (word & 0x7c000000) === 0x7c000000)
      return { ok: false, code: 'capture-readback-non-finite' };
  }
  if (index + 1 < bytes.byteLength && (view.getUint16(index, true) & 0x7c00) === 0x7c00)
    return { ok: false, code: 'capture-readback-non-finite' };
  return { ok: true };
}

/**
 * Receipt delivered after a selected pass-replay raster pass has encoded.
 * The depth view and target handles are the frame-resolved objects used by
 * the graph; the numeric texture identity is derived by getTextureIdentity.
 */
export interface GraphTargetPassReplayReceipt {
  readonly passName: string;
  readonly executionIndex: number;
  readonly resolvedDepthStencilAttachmentView: TextureView;
  readonly graphGeneration: number;
  readonly targetName: string;
  readonly targetView: TextureView;
  readonly targetTexture: Texture;
  readonly targetTextureIdentity: number;
}

export type GraphTargetPassReplayCallback = (receipt: GraphTargetPassReplayReceipt) => void;

/** Receipt delivered once after a complete selected prefix reaches its boundary pass. */
export interface GraphTargetPassReplayPrefixReceipt extends GraphTargetPassReplayReceipt {
  /** The compiled-order prefix that was replayed. */
  readonly replayPassNames: readonly string[];
  /** The unique depth-bearing raster pass used as the observation anchor. */
  readonly depthAttachmentPassName: string;
  /** The final pass in the selected prefix. */
  readonly observeAfterPassName: string;
  readonly depthAttachmentExecutionIndex: number;
}

export type GraphTargetPassReplayPrefixCallback = (
  receipt: GraphTargetPassReplayPrefixReceipt,
) => void;

/** Internal readback request consumed by the record encoder in the same submit. */
export type GraphTargetCaptureRequest =
  | {
      /** The default preserves the original target-copy request shape. */
      readonly kind?: 'target-copy';
      readonly name: string;
      /** Optional one-shot pass selection for internal graph-target diagnostics. */
      readonly replayPassNames?: readonly string[];
      readonly buffer: Buffer;
      readonly bytesPerRow: number;
      readonly width: number;
      readonly height: number;
      /** Descriptor contract checked against the resolved target at copy time. */
      readonly expected: {
        readonly format: ResolvedColorTargetDescriptor['format'];
        readonly width: number;
        readonly height: number;
        readonly usage: number;
        /** Optional caller binding; when present it is checked at copy time. */
        readonly identity?: {
          readonly graphGeneration: number;
          readonly frameId: number;
          readonly textureIdentity: number;
        };
      };
    }
  | {
      /** Execute selected compiled passes without requesting a target copy. */
      readonly kind: 'pass-replay';
      readonly replayPassNames: readonly string[];
      /** Optional graph target used to validate the selected pass attachment. */
      readonly targetName?: string;
      /** Optional callback invoked after each selected pass encodes. */
      readonly onPassEncoded?: GraphTargetPassReplayCallback;
      /** Optional one-shot callback invoked after the selected prefix boundary encodes. */
      readonly depthAttachmentPassName?: string;
      readonly observeAfterPassName?: string;
      readonly onPrefixEncoded?: GraphTargetPassReplayPrefixCallback;
    };

/** Renderer-private readback request for the Standard fallback MRT. */
export interface ReflectionFallbackReadbackRequest {
  readonly name: string;
  readonly buffer: Buffer;
  readonly bytesPerRow: number;
  readonly width: number;
  readonly height: number;
  readonly expected: {
    readonly format: ResolvedColorTargetDescriptor['format'];
    readonly width: number;
    readonly height: number;
    readonly usage: number;
    readonly graphGeneration: number;
    readonly frameId: number;
    readonly textureIdentity: number;
  };
  encoded: boolean;
}
/** Stable internal parameters for clear/UI frames with no authored camera. */
export function makeZeroCameraFallbackSnapshot(): CameraSnapshot {
  // Identity world mat4 so `mat4.invert(world)` yields identity view.
  const identityWorld = new Float32Array(16);
  identityWorld[0] = 1;
  identityWorld[5] = 1;
  identityWorld[10] = 1;
  identityWorld[15] = 1;
  return {
    position: vec3.create(0, 0, 0),
    world: identityWorld,
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 100,
    // feat-20260613 M6 / w20: synthetic camera defaults to perspective so
    // the CSM extract path stays consistent with the previously-implicit
    // perspective shape (unchanged behavior; explicit field).
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1.0,
    whitePoint: 4.0,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1.0,
    bloomIntensity: 1.0,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: ZERO_CAMERA_CLEAR_FALLBACK,
  };
}

/** A written volume parameter slot and the CPU copy of its payload. */
export interface VolumetricFogParamsSlot {
  readonly slot: 0 | 1;
  readonly params: Float32Array;
}

/**
 * Two renderer-owned parameter buffers; only the pending slot is writable.
 * `pending` is promoted to `accepted` only after queue submission succeeds,
 * and `accepted` keeps the payload for degraded-frame restaging.
 */
export interface VolumetricFogParamsState {
  buffers: [Buffer | null, Buffer | null];
  pending: VolumetricFogParamsSlot | null;
  accepted: VolumetricFogParamsSlot | null;
}

/**
 * Facts produced while recording one frame. They are cleared before the next
 * recording starts and when device-bound frame state is dropped.
 */
export interface FrameRecordingOutputs {
  /** A display or capture scene graph reached the physical submit barrier. */
  sceneSubmitted: boolean;
  directionalShadowView: TextureView | null;
  spotShadowView: TextureView | null;
  /** Physical outputs projected by typed graph passes for downstream observers. */
  observationSource: FrameObservationSource | undefined;
}

export function emptyFrameRecordingOutputs(): FrameRecordingOutputs {
  return {
    sceneSubmitted: false,
    directionalShadowView: null,
    spotShadowView: null,
    observationSource: undefined,
  };
}

export function resetFrameRecordingOutputs(outputs: FrameRecordingOutputs): void {
  outputs.sceneSubmitted = false;
  outputs.directionalShadowView = null;
  outputs.spotShadowView = null;
  outputs.observationSource = undefined;
}

/**
 * Inspection projections published together when a frame is submitted (or a
 * recovery candidate is published) and dropped together with device-bound
 * frame state.
 */
export interface SubmittedFrameInspection {
  /** Prepared Standard transport facts. */
  readonly standardLighting: StandardLightingInspection;
  /** Point-shadow atlas budget. */
  readonly pointShadow: PointShadowInspection;
  /** Capsule-shadow admission. */
  readonly capsuleShadow:
    | import('../capsule-shadow/inspection').CapsuleShadowInspection
    | undefined;
  /** Display-view transparency resolution. */
  readonly transparency: import('../oit/view').TransparencyInspection | undefined;
}

/** Color-target lookup minted with an installed compiled graph. */
export interface FrameGraphTargets {
  readonly getColorTargetDescriptor: (key: string) => ResolvedColorTargetDescriptor | undefined;
  readonly getColorTargetView: (key: string) => TextureView | undefined;
  readonly getColorTargetTexture: (key: string) => Texture | undefined;
  readonly graphGeneration: number;
}

/** A compiled graph together with the topology key and target lookup installed with it. */
export interface InstalledFrameGraph {
  readonly scenePipelinePreparations?: readonly import('./scene-pipeline-preparation').ScenePipelinePreparation[];
  /** Pure demand from the same graph's retained shadow target/raster owner. */
  readonly requiresShadowPipelinePreparation?: (
    frame: import('../render-pipeline').RenderPipelineFrame,
    identity: import('../gpu-driven/shadow-views').ShadowViewIdentity,
  ) => boolean;
  /** Private graph-owned real GPU-driven PSO completion gate. */
  readonly prepareGpuDrivenPipelines?: (
    entries?: readonly ValidatedRenderable[],
    artifacts?: ReadonlyMap<string, import('@forgeax/engine-shader').MaterialShaderArtifact>,
    onPending?: (reason: import('../render-contract').FramePresentationPendingReason) => void,
    materials?: import('../scene/material-dispatch').MaterialFrame,
  ) => boolean;
  /** Stock pipeline directional views actually projected during this graph build.
   * Absent for custom/legacy graphs: their preparation retains the full capacity. */
  readonly directionalShadowViewCount?: number;
  readonly graph: CompiledRenderGraph<RenderPipelineFrame>;
  readonly topologyKey: string;
  /** Last prepared-resource replacement imported by this graph; rollback follows the graph. */
  readonly preparedResourceKey?: string;
  readonly targets: FrameGraphTargets;
}

/**
 * Per-RenderSystem mutable frame state.
 *
 * Owned by the `createRenderSystem` closure; advanced once per
 * `recordFrame` invocation. The `instanceBuffers` map holds the per-entity
 * GPU storage buffers for Instances-bearing entities (cache key = the
 * renderer-owned collection id, with the packed Entity u32 retained only for
 * legacy snapshots); entries are recreated when the `archVersion` bumps or
 * `byteLength` changes.
 *
 * feat-20260518-pbr-direct-lighting-mvp M3 / w14 (AC-17 a): the
 * `warnedZeroLightStandard` flag latches the first-frame warning that
 * fires when the world contains a StandardMaterial entity but zero
 * DirectionalLight entries — once latched the next 100 frames suppress
 * the warning so the AI user is not flooded with repeated noise (charter
 * P3 silent failure -> explicit warning at most once per RenderSystem
 * lifetime).
 */
export interface RenderFrameState {
  /** A required non-drawing pipeline request has not completed this record. */
  pipelinePreparationPending?: boolean;
  pipelinePreparationPendingReason?: FramePresentationPendingReason;
  candidatePipelinePreparations?: import('./candidate-pipeline-preparation').CandidatePipelinePreparationOwner;
  frameNumber: number;
  materialUboCounters?: {
    -readonly [K in keyof import('../inspection-types').MaterialUniformCacheInspection]: import('../inspection-types').MaterialUniformCacheInspection[K];
  };
  /** Renderer-lifetime render-bundle segment reuse tally across scene passes. */
  renderBundleCounters?: import('./render-bundle-cache').RenderBundleCounters;
  /** Physical scene commands survive unrelated feature-graph replacement. */
  renderBundleCaches?: import('./render-bundle-cache').SceneRenderBundleState['renderBundleCaches'];
  dynamicResolution?: import('../pipeline/dynamic-resolution').DynamicResolutionController;
  rayDiffuse?: import('../raytracing/renderer-diffuse').RendererRayDiffuse | undefined;
  irradianceField?:
    | import('../raytracing/renderer-irradiance-field').RendererIrradianceField
    | undefined;
  screenProbe?: import('../raytracing/renderer-screen-probe').RendererScreenProbe | undefined;
  bakedField?: import('../raytracing/renderer-baked-field').RendererBakedField | undefined;
  probePlacement?:
    | import('../raytracing/renderer-probe-placement').RendererProbePlacement
    | undefined;
  probePlacementFrame?:
    | import('../raytracing/renderer-probe-placement').PreparedProbePlacement
    | undefined;
  /** Actual Surface commands staged for the renderer-owned submission fence. */
  surfaceSubmissionObservation:
    | import('../surface/submission-observation').SurfaceSubmissionCandidate
    | undefined;
  /** Exact producer artifacts accepted by the last submitted GPU frame. */
  recoveryMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  /** Exact ShadowCaster artifacts accepted by the last submitted GPU frame. */
  recoveryShadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  /** Last successful Motion Blur compute execution; failed submits retain the prior receipt. */
  motionBlurExecution?: MotionBlurExecutionReceipt;
  /** Final-submit Standard IBL binding-chain receipt for this frame. */
  iblBindingInspection?: IblBindingInspection;
  /** Demand for the frame-local Standard fallback MRT. */
  reflectionFallbackDemand?: boolean;
  /** Whether the active camera explicitly requested SSR this frame. */
  ssrRequested?: boolean | undefined;
  /** Current renderer-owned SSR spatial admission projection. */
  ssrSpatialAdmission?: SsrSpatialAdmission | undefined;
  /** Persistent SSR history owner; its `candidate` is promoted only after submit. */
  ssrHistoryOwner?: SsrHistoryOwner | undefined;
  /** Reused CPU parameter payload for the SSR temporal resolve. */
  ssrTemporalParamsPayload?: Uint8Array | undefined;
  /** Last camera identity used by the SSR history reset seam. */
  ssrLastCameraEntity?: number | undefined;
  ssrLastHistoryVersion?: number | undefined;
  /** Monotonic compiled-graph identity used by diagnostic readbacks. */
  graphGeneration: number;
  /** Number of successfully submitted TAA frames; failed attempts do not advance it. */
  successfulTemporalFrameIndex?: number;
  /** The renderer-owned accepted-submit temporal fact consumed by consumers. */
  temporalFrame?: TemporalFrame | undefined;
  /** The sole transaction that advances temporal history after queue.submit. */
  readonly temporalFrameTransaction: TemporalFrameTransaction;
  graphTargetCapture?: GraphTargetCaptureRequest | undefined;
  /** One-frame producer-owned copy target for fallback MRT readback. */
  reflectionFallbackReadback?: ReflectionFallbackReadbackRequest | undefined;
  /** Last successfully rendered static directional shadow atlas token. */
  directionalShadowCache: DirectionalShadowCache | null;
  /** Latest actual Direct-shadow LOD query; independent of accepted depth. */
  directionalShadowLod?: CpuLodSelection | undefined;
  /** Last submitted projection; guard-band retention shares it with every shadow consumer. */
  directionalShadowProjection?: readonly Float32Array[] | undefined;
  /** Projection/stale evidence promoted only by the last submitted CPU frame. */
  directionalCascadeCadence?: DirectionalCascadeCadenceState | undefined;
  /** Last successfully submitted camera post-process mode. */
  lastSuccessfulBloom: 'off' | 'on';
  /** Bloom record receipts staged by this frame; cleared on abort. */
  bloomFrameReceipts?: BloomFrameReceipts | undefined;
  /** Set by a directional shadow pass when this frame refreshed the atlas. */
  directionalShadowCacheRecorded: boolean;
  /** Shadow view hit/miss decisions and draw counts of the staged and last submitted frame. */
  readonly shadowRaster: ShadowRasterLedger;
  shadowDepthLayers?: import('../shadow-depth-layers').ShadowDepthLayers | undefined;
  /** The sole compiled owner for compute, copy, feature, and raster work. */
  compiledFrameGraph: InstalledFrameGraph | null;
  /** Monotonic generation of successfully promoted compiled graphs. */
  compiledFrameGraphGeneration: number;
  /** One candidate owns all graph facts until the frame submits or rolls back. */
  compiledFrameGraphCandidate?:
    | {
        readonly graph: CompiledRenderGraph<RenderPipelineFrame>;
        readonly previous: {
          readonly installed: InstalledFrameGraph | null;
          readonly graphGeneration: number;
          readonly compiledGeneration: number;
          readonly lightingSignature: string;
        };
      }
    | undefined;
  /**
   * A compiled graph whose frame did not submit (for example, while its new
   * pipelines were still preparing). The next frame with the same topology key
   * promotes it again instead of compiling an identical graph.
   */
  unsubmittedCompiledFrameGraph?:
    | { readonly installed: InstalledFrameGraph; readonly deviceGeneration: number | undefined }
    | undefined;
  /** DoF graph/params detached at the same successful-submit boundary. */
  depthOfFieldAccepted?:
    | {
        readonly params: DepthOfFieldParams;
        readonly graph: CompiledRenderGraphInfo;
        readonly deviceGeneration: number;
      }
    | undefined;
  /** A DoF candidate was present when the frame failed to submit. */
  depthOfFieldLastSubmitFailed?: boolean | undefined;
  volumetricFogParams: VolumetricFogParamsState;
  /** Last candidate/accepted volume projection exposed through inspect(). */
  volumetricFogInspection: VolumetricFogInspection;
  /** Accepted volume POD/context retained while a later candidate degrades. */
  volumetricFogAccepted: import('../render-system-extract').ExtractedVolumetricFog | undefined;
  volumetricFogAcceptedContext: VolumetricFogFrameContext | undefined;
  /** Accepted graph identity and ping-pong slot for temporal volume history. */
  volumetricFogHistoryGraph: CompiledRenderGraph<RenderPipelineFrame> | null;
  volumetricFogHistorySlot: 0 | 1 | null;
  volumetricFogHistorySignature: VolumeTemporalSignature | null;
  readonly retiredCompiledFrameGraphs: Set<CompiledRenderGraph<RenderPipelineFrame>>;
  /** Views and observation outputs projected by the current frame's recording. */
  readonly frameOutputs: FrameRecordingOutputs;
  /** Completed-frame source for the producer-owned fallback MRT. */
  reflectionFallbackObservationSource?: FrameObservationSource | undefined;
  /** Completion fence for the producer-owned fallback row/readback promotion. */
  reflectionFallbackCompletion?: Promise<void> | undefined;
  /** Camera antialias mode for the last successfully submitted graph. */
  lastSuccessfulCameraAntialias: CameraSnapshot['antialias'] | undefined;
  /** Last accepted output-space barrel mapping, promoted with the picture. */
  lastSuccessfulBarrelDistortion: BarrelDistortionMapping | undefined;
  /** Whether the current frame graph was retained from an accepted LKG. */
  barrelDistortionGraphResolution?: 'accepted' | 'retained';
  /** Staged TAA GPU state is promoted only after queue.submit succeeds. */
  temporalGpuState: TemporalGpuState | undefined;
  /** Device-scoped auto-exposure buffers imported by the Standard graph. */
  autoExposureGpuResources?: AutoExposureGpuResources | undefined;
  /** Candidate auto-exposure buffers; promoted only after queue.submit succeeds. */
  pendingAutoExposureGpuResources?: AutoExposureGpuResources | undefined;
  /** Accepted auto-exposure inspection state; promoted only after submit. */
  autoExposureState?: AutoExposureState | undefined;
  /** Candidate auto-exposure inspection state; cleared on any failed frame. */
  pendingAutoExposureState?: PendingAutoExposureState | undefined;
  /** Prepared ordinary TextureAsset LUT candidate for the Standard graph. */
  standardLutGpuResources?: StandardLutGpuResources | undefined;
  /** Candidate LUT resources; promoted only after queue.submit succeeds. */
  pendingStandardLutGpuResources?: StandardLutGpuResources | undefined;
  /** Accepted LUT inspection state; promoted only after submit. */
  standardLutState: StandardLutState;
  /** Candidate LUT inspection state; cleared on any failed frame. */
  pendingStandardLutState?: PendingStandardLutState | undefined;
  /** Last successful TAA GPU state; candidate replacement stays staged until submit. */
  activeTemporalGpuState: TemporalGpuState | undefined;
  /** Submitted temporal generations retained until their queue fence resolves. */
  readonly retiringTemporalGpuStates: Set<TemporalGpuState>;
  /** The accepted graph currently owns CloudLayer ping-pong history. */
  cloudHistoryActive?: boolean;
  /** Candidate CloudLayer history ownership, promoted only after submit. */
  pendingCloudHistoryActive?: boolean;
  /** Last successful projection; candidate frames never overwrite it. */
  lastSuccessfulTemporalView: TemporalView | undefined;
  pendingTemporalCommit: TemporalCommitOutcome;
  /** Staged environment generation is promoted only after queue.submit succeeds. */
  environmentGeneration: EnvironmentGeneration | undefined;
  environmentFrame?: import('../environment/frame').SelectedEnvironmentFrame | undefined;
  pendingAtmospherePublish?: (() => void) | undefined;
  readonly environmentLifecycle: EnvironmentLifecycle | undefined;
  readonly instanceBuffers: Map<number, InstanceBufferCacheEntry>;
  /** Renderer-private World projection receiving record-stage residency facts. */
  readonly instanceCollections?: InstanceProjectionStore;
  /** Stable buffers for renderer-owned collections split by device cap. */
  readonly instanceBufferChunks?: InstanceBufferChunks;
  /** Per-object ProbeBlendRecord buffers; upload is one atomic 160B write. */
  readonly probeBlendBuffers: Map<number, ProbeBlendBufferCacheEntry>;
  /** One renderer-owned record array; each object selects its 256B-aligned lane. */
  probeBlendRecordBuffer?: GpuBuffer;
  probeBlendRecordBufferCapacity: number;
  /** Last producer revision fully uploaded to the current device buffer. */
  probeBlendRecordProjection?: {
    readonly projection: import('../scene/probe-blend').ProbeBlendBufferProjection;
    readonly device: RhiDevice;
    readonly buffer: GpuBuffer | undefined;
  };
  /** Per-entity vertex buffers for the Standard CPU morph lane. */
  readonly morphBuffers?: Map<number, MorphBufferCacheEntry>;
  readonly hdrpClusterBinScratch: ClusterBinScratch;
  /** Reusable HDRP cluster output buffers; sized once and grown only if the grid/cap changes. */
  hdrpClusterGridScratch: Uint32Array | null;
  hdrpLightIndexListScratch: Uint32Array | null;
  /** Device-owned membership binding; layout and device must match the active pipeline. */
  hdrpClusterMembership: {
    readonly device: RhiDevice;
    readonly layout: BindGroupLayout;
    readonly bindGroup: BindGroup;
    /** Cluster buffer identity keeps this group aligned with grown bundles. */
    readonly clusterGridBuffer: Buffer;
  } | null;
  /**
   * Signature of the Standard lighting declaration accepted by the compiled
   * graph. Payload uploads and membership bindings must match this signature;
   * a failed candidate never changes it.
   */
  standardLightingGraphSignature: string;
  /** Renderer.inspect() projections of the last submitted frame. */
  submittedInspection?: SubmittedFrameInspection | undefined;
  /** Capsule tile binning of the display view in the current frame. */
  capsuleShadowSubmission?:
    | import('../capsule-shadow/inspection').CapsuleShadowSubmission
    | undefined;
  transientInstanceBuffers: InstanceBufferCacheEntry[];
  warnedZeroLightStandard: boolean;
  /**
   * feat-20260608-multi-light-warn-once M3: once-warn latch for the
   * single-directional authoring constraint. Standard local lights use the
   * unified Cluster budget; there is no per-kind local-light cap.
   */
  warnedMultiLightDirectional: boolean;
  /**
   * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
   * once-warn latches for >1 Skylight / >1 SkyboxBackground entity. Fire at most
   * once per RenderSystem lifetime so the multi-entity warn (which names the
   * winning entity handle, F-8) does not flood the console every frame.
   */
  warnedMultiSkylight: boolean;
  warnedMultiSkybox: boolean;
  /** feat-20260531-skybox-env-background M3 / w20: once-warn when camera
   * tonemap is 'none' but a SkyboxBackground entity exists. Skybox needs
   * the HDR render target allocated by the tonemap path; without it the
   * skybox pass is skipped (plan-strategy D-2 NOTE). */
  warnedSkyboxTonemapNone: boolean;
  /**
   * Per-handle warn-once anchor for the missing baseColor-texture fallback,
   * shared by every textured material path (sprite / sprite-lit / standard-pbr
   * / pbr-skin / unlit — feat-20260520-2d-sprite-layer-mvp M-3 / w25 seeded it
   * for sprites; feat-future-pbr-missing-texture-fallback-explicit generalised
   * it to PBR/skin so GLB textures that fail to reach the GPU no longer render
   * silently flat). A `Set<number>` keyed by the raw Handle<TextureAsset> id -
   * the writer fires `console.warn` exactly once per missing texture handle per
   * RenderSystem lifetime so AI users see a single actionable message without
   * per-frame log flooding. The set lives across frames so the second frame on
   * the same missing handle stays silent (charter P3 explicit failure:
   * warn-once preserves signal / noise floor while structured RhiError below
   * stays per-frame fire).
   *
   * Note on the WeakSet/Set choice: plan-strategy mentions WeakSet but
   * Handle values are numeric brand u32s (not object references), so
   * WeakSet<object> is not applicable; Set<number> gives identical
   * warn-once-per-handle semantics at zero additional cost (charter F1
   * minimal surface; the per-RenderSystem lifetime cap is the upper
   * bound).
   */
  readonly warnedMissingBaseColorTextureHandles: Set<number>;
  /**
   * feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
   * renderable guard for the `nineslice.scale-too-small` metric increment.
   * Keyed by `renderableIndex` so the second frame on the same mis-scaled
   * entity does NOT keep bumping the counter — AI users see one counter
   * tick per offending entity per RenderSystem lifetime, matching the
   * single-event semantics of the structured fail-fast (charter P3:
   * machine-readable signal, not a per-frame inflation). M4 retired the
   * placeholder console.warn; the increment lands on the per-Renderer
   * EngineMetrics through `runtime.metrics.increment(...)`.
   */
  readonly warnedNineSliceScaleEntities: Set<number>;
  /**
   * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
   * per-handle fire-once anchor for the lazy equirect-to-cubemap projection
   * failure. A `Set<number>` keyed by the raw Handle<EquirectAsset> id - the
   * record arm fires the structured `EquirectProjectionFailedError` exactly
   * once per failed source per RenderSystem lifetime (the store records
   * `status:'failed'` permanently and never retries, R-2 / AC-09; without this
   * latch the record arm would re-fire the error every frame). The set lives
   * across frames so the second frame on the same failed handle stays silent
   * (charter P3: warn-once preserves signal / noise floor).
   */
  readonly firedEquirectProjectionFailedHandles: Set<number>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
   * bind group caches converted to nested WeakMap chain roots (D-3).
   * Each root is a WeakMap<object, WeakMap<...>> walked by
   * getOrCreateFromChain; the chain depth varies by variant
   * (view-main = 7, mesh = 1, hdrp-unified = 5, skin = 2).
   * Roots are stable between device recoveries and replaced when the renderer
   * swaps to a fresh device. Chain keys are always inner buffer handles, never
   * wrappers (D-3).
   */
  viewBindGroupCache: WeakMap<object, unknown>;
  meshBindGroupCache: WeakMap<object, unknown>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
   * bind group caches scoped by entityKey (packed u32 as number).
   * Outer Map<number, WeakMap<handle, ...>> lets GC collect entries for
   * destroyed entities whose handles are unreachable; per-entity material
   * and instances share the same two-level shape (D-1). The inner WeakMap
   * value is opaque (`unknown`) because `getOrCreateFromChain` walks a
   * variable-depth chain — intermediate handles map to nested WeakMaps and
   * only the final handle maps to the variant->BindGroup leaf Map. Direct
   * readers (HDRP shadow-instances read end) assert the leaf shape locally.
   */
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1a #2: outer Map
   * keyed by `worldEntityKey(worldId, entityKey)`. Inner WeakMap unchanged.
   */
  readonly materialBgPerEntity: Map<number, WeakMap<object, unknown>>;
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1a #3: outer Map
   * keyed by `worldEntityKey(worldId, entityKey)`. Inner WeakMap unchanged.
   */
  readonly instancesBgPerEntity: Map<number, WeakMap<object, unknown>>;
  /** Identity-keyed instances BGs shared across entities using the same buffer. */
  readonly instancesBgShared: WeakMap<object, unknown>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w2: cross-entity
   * shared material bind group cache (OQ-1 option A). Outer key is the
   * material shaderId string; inner chain is a WeakMap keyed by the same
   * handle objects used in per-entity chains. Reuses the generic
   * `getOrCreatePerEntity` helper with outerKey string|number (D-1).
   */
  readonly materialBgShared: Map<string, WeakMap<object, unknown>>;
  /** Cross-frame fast path for fully-resident, immutable material snapshots. */
  readonly materialBgAssemblyCache: MaterialBgAssemblyCache;
  /** Opaque shadow fallback bindings follow physical resources across scene replacement. */
  shadowMaterialBindGroups: WeakMap<object, unknown>;
  /**
   * Post-process bind group cache: nested WeakMap chain root shared by the
   * built-in bloom (bright / blur-H / blur-V / composite), FXAA, and HDRP SSAO
   * (calc / blur) fullscreen passes. Each of these passes samples graph-owned
   * transient render targets (hdrColor / ldrColor / bloom* / ssaoRaw /
   * gbuf0 / hdrDepth); on canvas resize the graph retires the old physical
   * textures and allocates new ones, so the bind group must be rebuilt to
   * reference the new TextureView identity. Keying the cache on the physical
   * TextureView (or `::tex` texture handle for passes that recreate their bound
   * view every frame) makes invalidation automatic: a resized target yields a
   * new key object -> WeakMap miss -> factory rebuild, and dead views are GC'd
   * (same identity-invalidation mechanism as view/mesh caches, D-3). Replaces
   * the pre-fix `pp.*BindGroup === null` single-slot caches that never
   * invalidated on resize and submitted destroyed textures.
   */
  postProcessBgCache: WeakMap<object, unknown>;
  /**
   * Raw handle of the currently installed RenderPipelineAsset (0 = builtin).
   * Installation brands the next candidate topology; the prior compiled graph
   * remains last-known-good until the candidate compiles successfully.
   */
  installedPipelineHandle: number;
  /**
   * Active topology declaration resolved from the pipeline registry.
   */
  activePipeline: RenderPipelineDef;
  /**
   * Install-time config projected into `RenderPipelineTopology.config`.
   */
  installedPipelineConfig: RenderPipelineAsset['config'];
  /** Effective Standard profile for this private view; never renderer author state. */
  cameraStandardProfile?: StandardProfile | undefined;
  /**
   * feat-20260608-cluster-lighting M5 / w20 + M6 / w23 + M5 / w22:
   * once-per-frame fire dedup set for Standard per-frame fail-soft errors
   * (`standard-light-budget-exceeded`, `standard-cluster-index-overflow`). Cleared
   * at the end of each frame so the next frame re-fires if the condition
   * persists. Set<string> keyed by RenderErrorCode literal.
   */
  standardOncePerFrameFired: Set<string>;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1).
   * Lazily-allocated cube_array shadow atlas owned by the RenderSystem
   * lifetime. `null` until the first frame whose `lights.pointShadow` is
   * non-empty (zero-shadow scenes never allocate; AC-09). The atlas is
   * disposed by the renderer dispose path; subsequent frames with a non-empty
   * snapshot list re-allocate.
   */
  pointShadowAtlas: ShadowAtlas | null;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-3):
   * per-frame projection of `lights.pointShadow` from the extract stage. The
   * typed point-shadow pass reads this list to drive the 6 x N face iteration.
   * Empty array means the topology declares no point-shadow passes.
   */
  pointShadowSnapshots: readonly PointShadowSnapshot[];
  /**
   * feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
   * last fold-pass output, computed at `recordFrame` entry from the
   * transparent-sort-ordered dispatch + mode-gate (D-5: only mode 0
   * folds; other modes yield singleton buckets). Currently an
   * observational compute — the drawIndexed swap (1 instanced draw per
   * fold bucket) is the follow-on integration that wires each bucket
   * into the sprite-pass / geometry-pass dispatch loops. The bucket
   * count is the source of truth for `render.instancing.foldedDraws`
   * metric (M3 / w13) — every fold-eligible bucket (bucketSize >= 1
   * under mode 0 AND not bypassed) contributes one increment.
   */
  lastFoldBucketCount: number;
  /**
   * feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): per-frame projection
   * of `lights.spot` from the extract stage. The typed spot-shadow graph
   * pass reads this list to render each
   * castShadow spot's perspective depth into its `spotShadowDepth` atlas tile
   * (viewport keyed on `shadowAtlasTile`). `recordFrame` writes it before
   * graph execution. Spots with `shadowAtlasTile < 0` (castShadow:false,
   * degenerate direction, or clipped beyond cap 4) are skipped — zero
   * shadow-casting spots means zero spot shadow passes (AC-03).
   */
  spotShadowSnapshots: readonly SpotLightSnapshot[];
}

export interface MorphBufferCacheEntry {
  readonly buffer: GpuBuffer;
  readonly byteLength: number;
}

/**
 * feat-20260518-pbr-direct-lighting-mvp M5 / w22.11 (D-2 + D-10 + AC-06):
 * mutable per-frame dispatch counter object owned by `createRenderSystem`
 * and bumped here at the actual `pass.setPipeline(...)` call site (the
 * only point with both `mat.materialShaderId` and `mesh.layoutProjection` in scope).
 * Unlit / custom shader pipeline dispatch tracked here.
 */
export interface DispatchCounts {
  unlit: number;
  /** feat-20260523 M4-T07: 'standard' counter removed; schema-driven
   *  materials are tracked via materialShaderId in the pipeline cache. */
}

/**
 * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
 * createBindGroup counter. Closure-mutable object aligned with
 * DispatchCounts precedent. Reset in draw(world) entry, bumped on
 * cache-miss createBindGroup calls (M2-M4).
 */
export interface BindGroupCounts {
  createBindGroup: number;
  /**
   * Debug-only: records the variant of every cache-miss BindGroup created via
   * `getOrCreateFromChain` for unit-test observability. Production paths do
   * not read this array.
   */
  keys: string[];
}

/**
 * Successful Bloom record operations staged for the current frame. These
 * counters are promoted only after the shared renderer queue submission.
 */
export interface BloomFrameReceipts {
  readonly uploadCount: number;
  readonly bindGroupCount: number;
  readonly encodeCount: number;
}

/**
 * A renderable resolved against the AssetRegistry for the current frame:
 * its source snapshot, the GPU mesh handles, the row index used to correlate
 * transparent-sort output back to this entry, and an optional per-material
 * renderState override (bug-20260527-renderstate-pipeline-dispatch-gap D-4).
 * Module-scoped so RenderPipelineContext can type `validated` / `validatedOrdered`
 * without a dynamic type escape (was a recordFrame-local interface before F-4).
 */
export interface ValidatedRenderable {
  /** Physical source-transform slot, independent of this pass's row index. */
  readonly meshSlot: number;
  /** A fold head writes identity here; captures continue to use meshSlot. */
  readonly foldedMeshSlot?: number;
  /** Exact source submeshes selected by native batch execution; absent selects the whole mesh. */
  readonly submeshIndices?: readonly number[];
  readonly source: RenderableSnapshot;
  /** RenderResourceScope that owns the renderable's asset handles and material snapshots. */
  readonly world?: RenderResourceScope;
  readonly mesh: MeshGpuHandles;
  readonly renderableIndex: number;
  readonly renderState: MaterialRenderState | undefined;
  /**
   * Canonical authored material-variant request folded from the selected
   * pass's `defines` map. Capability axes are merged at the renderer seam;
   * this field carries only the pass-owned selection into record.
   */
  readonly variantSet?: string | undefined;
  /**
   * w10: per-pass stencil reference value folded from
   * {@link DispatchEntry.stencilReference} (draw-call dynamic state). The draw
   * loop calls `pass.setStencilReference(stencilReference ?? 0)` before each
   * draw; `undefined` falls back to the WebGPU default 0 (semantic no-op).
   */
  readonly stencilReference: number | undefined;
}

/**
 * Cross-frame validity token for the directional shadow atlas.
 *
 * The atlas is a render target, not authored state. Keeping its validity
 * token beside the other RenderFrameState caches lets recordFrame skip a
 * static caster submission without teaching the public render-pipeline
 * contract about caching. Every source that can change caster depth is part
 * of the token: world mutation or persistent caster content, selected material resources, graph/target identity, CSM matrices, and each validated caster's
 * resident Mesh publications and actual CPU LOD selection.
 *
 * @internal
 */
export interface DirectionalShadowCache {
  readonly worlds: readonly RenderResourceScope[];
  readonly worldStateTokens: readonly DirectionalShadowWorldState[];
  readonly shadowMaterials?:
    | readonly import('../scene/material-shadow-content').ShadowMaterialContent[]
    | undefined;
  readonly pipelineHandle: number;
  readonly graphTopologyKey: string | null;
  readonly shadowMapSize: number;
  readonly cascadeCount: number;
  readonly directionalShadowQuality: DirectionalShadowQuality;
  readonly lightViewProj: readonly Float32Array[];
  readonly meshReads: ShadowMeshReads;
  readonly meshEpoch: number;
  readonly lodSelection: object | undefined;
  /** Persistent caster evidence; absent when the frame had no persistent scene. */
  readonly casterContent: PersistentShadowCasterProjection['content'] | undefined;
}

/**
 * ECS state that can change the contents of a directional shadow map.
 *
 * The ECS-owned RenderReadLease is the only render-facing mutation boundary.
 * Its version is intentionally conservative: any published RenderResourceScope change
 * invalidates the cached atlas, while render never reaches through RenderResourceScope for
 * component-clock storage.
 */
export interface DirectionalShadowWorldState {
  readonly worldIdentity: string;
  readonly version: RenderReadVersion;
}
