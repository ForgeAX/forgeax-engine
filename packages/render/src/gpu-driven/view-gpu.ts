import type {
  ComputeGraphPass,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  RenderBundle,
  Result,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  decodeGeometryCommands,
  decodeGeometryView,
  GEOMETRY_OBSERVATION_MAX_BYTES,
  type GeometryCommandCapture,
} from '../geometry-observation';
import type { GpuScene, GpuSceneTableBindingTarget } from '../gpu-scene';
import type { GpuInputReadFrame, GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_INDIRECT,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { SkinTaskBinding } from '../record/skin-tasks';
import type { SkinSceneFrame } from '../scene/skin-scene-inputs';
import type { LodOcclusionGpuSelection } from '../scene/visibility/inspection';
import type {
  SurfaceGpuIndirectParameters,
  SurfaceGpuIndirectReadbackError,
  SurfaceGpuReadbackSnapshot,
  SurfaceSubmissionCandidate,
} from '../surface/submission-observation';
import { batchLodLevelCount } from './batch-layout';
import { planDrawsSkin, type SubmissionPlan } from './batch-topology';
import { type LodViewCamera, writeLodViewConstants } from './lod-projection.wgsl';
import {
  type PreparedRasterBindings,
  type PreparedRasterBundleCache,
  type PreparedRasterCounters,
  PreparedRasterPass,
} from './prepared-raster-bundle';
import { invertLightViewProjection } from './production-raster-camera';
import { suppressionPatchOf } from './production-raster-prepare';
import {
  GpuResourceAllocationLedger,
  type GpuResourceAllocationToken,
} from './resource-allocation';
import { type SkinDemandLayout, skinDemandLayout, writeSkinDemandConstants } from './skin-demand';
import { GpuTaskResidency } from './task-residency';
import {
  deriveGpuDrivenViewBufferCapacities,
  growGpuDrivenVisibleCapacity,
  nextCapacity,
  type ViewBufferRequest,
  validateViewBufferRequests,
} from './view-buffer-capacity';

export {
  deriveGpuDrivenViewBufferCapacities,
  type GpuDrivenViewBufferCapacities,
  growGpuDrivenVisibleCapacity,
} from './view-buffer-capacity';

import { ViewBufferRetirement } from './view-buffer-retirement';
import { clearExitedIndirectCommands } from './view-indirect-retirement';
import {
  createInputBindingGroups,
  type GpuViewInputPreparation,
  type InputBindingFacts,
  type InputBindingGroups,
  inputBindingSceneFacts,
  inputBindingStorageMatches,
  inputBindingTablesMatch,
  type PreparingInputBindings,
  type ViewInputBuffers,
} from './view-input-bindings';
import { type EncodedViewTopology, encodedViewTopology } from './view-topology';

export { invertLightViewProjection } from './production-raster-camera';

import { GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL, GPU_DRIVEN_VIEW_WGSL } from './view.wgsl';
import {
  BATCH_STRIDE,
  COUNTER_STRIDE,
  COUNTER_WORDS,
  EARLY_VISIBLE_COUNTER_OFFSET,
  INDIRECT_COMMAND_BYTES,
  LOD_CONSTANTS_OFFSET,
  OCCLUSION_CONSTANTS_OFFSET,
  OCCLUSION_STATE_BYTES,
  OCCLUSION_STATE_OFFSET,
  orderScratchWords,
  SHADOW_CAMERA_CULL_OFFSET,
  SKIN_CONSTANTS_OFFSET,
  SKIN_RASTER_OFFSET,
  VIEW_BYTES,
  WORKGROUP_SIZE,
} from './view-layout';
import { prepareViewModule } from './view-native-module';
import { decodeCullingCounts, decodeLodSelection } from './view-telemetry';

export { GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL, GPU_DRIVEN_VIEW_WGSL } from './view.wgsl';
export { GPU_DRIVEN_BATCH_STRIDE } from './view-layout';

const COMPUTE_STAGE = 0x4;
export type GpuLodLane = 'gpu' | 'cpu';

export function selectGpuLodLane(caps: {
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly indirectDrawing: boolean;
}): GpuLodLane {
  return caps.compute && caps.storageBuffer && caps.indirectDrawing ? 'gpu' : 'cpu';
}

interface ViewBuffers extends ViewInputBuffers {
  readonly lodReadback: Buffer;
  readonly visibleSurfaceRows?: Buffer;
}

/** Actual private successor, issued only while the original View still owns its old roots. */
export interface ViewStorageTarget {
  readonly view: GpuDrivenView;
  readonly before: ViewInputBuffers;
  readonly after: ViewInputBuffers;
  readonly surfaceRows: Buffer | undefined;
  readonly previousLateVisibleBase: number;
  readonly lateVisibleBase: number;
  readonly previousLateIndirectBase: number;
  readonly lateIndirectBase: number;
  readonly skin: SkinTaskBinding | undefined;
  isCurrent(): boolean;
}

interface PreparedViewBufferGeneration {
  readonly next: ViewBuffers;
  readonly previous: ViewBuffers | undefined;
  readonly candidate: number;
  readonly visible: number;
  readonly batch: number;
  readonly indirect: number;
  readonly suppression: number;
  readonly order: number;
  readonly skin: SkinDemandLayout | undefined;
  readonly joints: number;
  readonly lateMirror: boolean;
  readonly initial: InitialViewStorage | undefined;
  readonly groups: InputBindingGroups | undefined;
  readonly consumers: GpuViewInputPreparation | undefined;
}

interface InitialViewStorage {
  phase: 'preparing' | 'closed' | 'accepted';
  readonly created: Partial<MutableViewBuffers>;
}

interface ViewAddressPreparation {
  readonly scene: GpuScene;
  readonly current: () => boolean;
  readonly words: number;
  readonly oldWords: number;
  readonly facts: InputBindingFacts;
  readonly skinLayout: SkinDemandLayout | undefined;
  readonly batchCapacity: number;
  readonly orderCapacity: number;
  readonly created: Partial<Pick<MutableViewBuffers, 'batches' | 'counters'>>;
  readonly mirror: Uint32Array<ArrayBuffer>;
  next?: ViewBuffers | undefined;
  groups?: InputBindingGroups | undefined;
  closed: boolean;
  published: boolean;
}

type MutableViewBuffers = { -readonly [Name in keyof ViewBuffers]: ViewBuffers[Name] };

export type LodTelemetryCopy = {
  readonly buffers: ViewBuffers;
  readonly plan: SubmissionPlan;
  readonly resourceGeneration: number;
  readonly indirectBufferIdentity: number;
  readonly indirectReadbackOffset: number;
  readonly surfaceReadbackSnapshot?: () => SurfaceGpuReadbackSnapshot | undefined;
  readonly submit?: ViewTelemetrySubmit;
  /** The copy follows the late phase, so its counters include occlusion facts. */
  readonly occlusion: boolean;
};

/**
 * Camera facts for the late HZB test. They must describe the same view that
 * rasterized the pyramid source; `historyKey` changes (camera switch, resize,
 * history reset) discard the per-instance visibility history.
 */
export interface GpuDrivenOcclusionCamera {
  /** Unjittered projection * view, column-major. */
  readonly viewProjection: Float32Array;
  readonly near: number;
  readonly far: number;
  readonly orthographic: boolean;
  readonly historyKey: string;
}

/**
 * Main-camera visibility test for a shadow view's casters. The widening is the
 * receiver's sampling footprint, so a skipped caster darkens no visible pixel.
 */
export interface GpuDrivenShadowCameraCull {
  readonly camera: GpuDrivenOcclusionCamera;
  /** The shadow view's light view-projection, column-major. */
  readonly lightViewProjection: Float32Array;
  /** Light NDC widening for the receiver filter kernel. */
  readonly ndcDilation: number;
  /** World widening for the receiver's normal offset. */
  readonly worldDilation: number;
}

export interface GpuDrivenLodSubmitIdentity {
  readonly frameId: number;
  readonly deviceGeneration: number;
}

/** Identity captured by the existing shadow telemetry copy, never by map completion. */
export interface GpuDrivenCullingProducerReceipt extends GpuDrivenLodSubmitIdentity {
  readonly graphGeneration?: number;
  readonly viewKey: string;
  readonly viewGeneration: number;
  readonly sourceRevision: number;
}

export interface GpuDrivenCullingObservation {
  readonly producer: GpuDrivenCullingProducerReceipt;
  /** Compute buffers captured by the copy, excluding the view material-resource generation. */
  readonly resourceGeneration: number;
  readonly indirectBufferIdentity: number;
  readonly planRevision: number;
  readonly candidateCount: number;
  readonly batchCount: number;
  /** Compacted candidate/instance rows; not entities, triangles or triangle clusters. */
  readonly visible: number;
  /** An overflowing batch contributes zero visible rows, as in readLodSelection. */
  readonly overflow: boolean;
  readonly texelCulled: number;
  readonly cameraCulled: number;
}

type ViewTelemetrySubmit = GpuDrivenLodSubmitIdentity & {
  readonly cullingProducer?: GpuDrivenCullingProducerReceipt;
};

/**
 * One view's selection dispatches, offered to a caller that encodes several
 * views' selections in one compute pass.
 */
export interface GpuDrivenSelectionWork<FrameCtx extends RenderGraphFrame> {
  readonly name: string;
  readonly accesses: NonNullable<ComputeGraphPass<FrameCtx>['accesses']>;
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  readonly encode: NonNullable<ComputeGraphPass<FrameCtx>['encodeDirect']>;
}

/**
 * Collects selection work instead of declaring a compute pass per view. The
 * collector must declare its shared selection pass before it calls `after`,
 * which declares this view's passes that read the selection.
 */
export interface GpuDrivenSelectionBatch<FrameCtx extends RenderGraphFrame> {
  add(work: GpuDrivenSelectionWork<FrameCtx>, after: () => Result<void, RenderGraphError>): void;
}

/** Late occlusion keeps its own early pass; other batched views share one. */
function isSelectionBatched<FrameCtx extends RenderGraphFrame>(
  batch: GpuDrivenSelectionBatch<FrameCtx> | undefined,
  lateOcclusion: boolean,
): boolean {
  return batch !== undefined && !lateOcclusion;
}

/** Declares one view's selection work as its own compute pass. */
function addSelectionWorkPass<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  work: GpuDrivenSelectionWork<FrameCtx>,
) {
  return builder.addComputePass(work.name, {
    accesses: work.accesses,
    ...(work.executeIf === undefined ? {} : { executeIf: work.executeIf }),
    encodeDirect: work.encode,
  });
}

/**
 * Declares a view's early readback. A batched selection defers it until the
 * batch has declared its shared selection pass; otherwise it is declared now.
 */
function addEarlyReadback<FrameCtx extends RenderGraphFrame>(
  batch: GpuDrivenSelectionBatch<FrameCtx> | undefined,
  work: GpuDrivenSelectionWork<FrameCtx> | undefined,
  addReadback: () => Result<unknown, RenderGraphError>,
): Result<unknown, RenderGraphError> {
  if (batch === undefined || work === undefined) return addReadback();
  batch.add(work, () => {
    const readback = addReadback();
    return readback.ok ? ok(undefined) : readback;
  });
  return ok(undefined);
}

export interface GpuDrivenViewGraphResources {
  readonly visibleSurfaceRows?: GraphBuffer;
  readonly primitive: GraphBuffer;
  readonly instance: GraphBuffer;
  readonly transform: GraphBuffer;
  readonly material: GraphBuffer;
  readonly visible: GraphBuffer;
  readonly indirect: GraphBuffer;
  readonly overflow: GraphBuffer;
  /**
   * Present when `addPasses` reserved the two-phase occlusion path. The caller
   * adds the late cull after its early depth pyramid exists; until then the
   * early phase draws every frustum-visible candidate.
   */
  readonly addLateOcclusion?: (
    pyramid: GraphTextureView,
  ) => Result<GpuDrivenLateOcclusionGraph, RenderGraphError>;
}

export interface GpuDrivenLateOcclusionGraph {
  readonly passNames: readonly string[];
  /** Byte offset of the late-phase indirect region inside `indirect`. */
  readonly lateIndirectByteOffset: number;
  /**
   * First item of the late-phase mirror inside `visible`: the late command of
   * a segment at item `base` draws the window starting at
   * `lateVisibleBase + base` from instance zero.
   */
  readonly lateVisibleBase: number;
}

export interface GpuDrivenViewInspection {
  readonly shadowBundles?: PreparedRasterCounters;
  readonly topologyRevision: number | undefined;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly visibleCapacity: number;
  readonly candidateCapacity: number;
  /** Allocated visible-index capacity; distinct from logical candidates. */
  readonly visibleBufferCapacity: number;
  readonly batchCapacity: number;
  readonly indirectCapacity: number;
  readonly updateCount: number;
  readonly uploadBytes: number;
  /** Shared arena bytes actually uploaded by this update; other views may reuse them. */
  readonly sharedInputUploadBytes: number;
  /** Bytes of the per-primitive suppression bitmap uploaded this frame (dirty words only). */
  readonly suppressionUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly viewConstantsUploadBytes: number;
  readonly bindGroupCreates: number;
  readonly bufferRebuilds: number;
  readonly resourceGeneration: number;
  /** Logical Engine allocation facts; physical VRAM residency is unknown. */
  readonly resourceAllocation: import('../inspection-types').GpuResourceAllocationInspection;
}

export interface GpuDrivenLodSelectionInspection {
  /** Exact resource generation whose selector rows were copied. */
  readonly resourceGeneration?: number;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly indirectDrawCount: number;
  readonly visible: number;
  readonly occluded: number;
  /** True when the selector had to reject or clamp a visible candidate. */
  readonly overflow: boolean;
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  readonly batches: readonly {
    readonly batchId: number;
    readonly candidateCount: number;
    readonly visible: number;
    readonly occluded: number;
    readonly overflow: boolean;
    readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  }[];
  readonly geometryWork: number;
  readonly rootGeometryWork: number;
  /** In-frustum candidates dropped below the view's minimum caster diameter. */
  readonly texelCulled: number;
  /** Shadow casters whose shadowed receivers the main camera cannot see. */
  readonly cameraCulled: number;
  /** Actual early selector rejection, after per-view suppression. */
  readonly frustumCulled: number;
  /** Native whole-selector scope retained across the World LOD-subset join. */
  readonly gpuSelection?: LodOcclusionGpuSelection;
  /**
   * Two-phase HZB facts when the submitted graph ran the late phase:
   * candidates the pyramid rejected and visible items drawn only late.
   */
  readonly occlusion?: { readonly culled: number; readonly late: number };
  /**
   * Actual visible rows copied from the submitted GPU selector, each with the
   * slot generation encoded in that submission; a reader joins only rows whose
   * current generation still matches.
   */
  readonly actualMembers: readonly {
    readonly batchId: number;
    readonly primitiveIndex: number;
    readonly generation: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  }[];
  /** Surface subset projected by the material producer after readback. */
  readonly surfaceActualMemberIds?: readonly string[];
  /** Decoded indexed/non-indexed command words for the exact Surface copy. */
  readonly surfaceIndirectParameters?: readonly SurfaceGpuIndirectParameters[];
  /** Fail-closed readback reason when the copied command range is unusable. */
  readonly surfaceIndirectReadbackError?: SurfaceGpuIndirectReadbackError;
  /** Exact Surface recording whose selector bytes were copied. */
  readonly surfaceReadback?: SurfaceGpuReadbackSnapshot;
  /** Public receipt identity captured when the telemetry copy was encoded. */
  readonly submit?: GpuDrivenLodSubmitIdentity;
}

const VISIBLE_ENTRY_BYTES = 16;

const SHADOW_RASTER_PASS = new PreparedRasterPass({
  colorFormats: [],
  depthStencilFormat: 'depth32float',
  sampleCount: 1,
});

export type GpuDrivenViewCreationInput = {
  readonly device: RhiDevice;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  readonly labelPrefix?: string;
  /**
   * @internal
   * Falsifier hook: scales the HZB screen footprint. Production uses 1.
   */
  readonly occlusionFootprintScale?: number;
  /** Compile the shadow caster cull against the main camera's pyramid. */
  readonly shadowCameraCull?: boolean;
  /** Stock shadow consumers need only batch counters; detailed LOD reads are unavailable. */
  readonly readback?: 'complete' | 'culling-counts';
};
export type GpuDrivenViewCreationStep = void | Promise<void>;

function viewCreationInvalid(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'the original live View construction demand and device',
    hint: 'discard this candidate and prepare again for the current owner',
  });
}

function viewCreationSupported(device: RhiDevice, completion: boolean): Result<void, RhiError> {
  if (!device.caps.compute || !device.caps.storageBuffer || !device.caps.indirectDrawing) {
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: 'compute && storageBuffer && indirectDrawing',
        hint: 'use the CPU projection and direct submission fallback on this device',
      }),
    );
  }
  if (completion && device.createComputePipelineAsync === undefined)
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: 'completion-qualified native compute pipeline construction',
        hint: 'use a backend with asynchronous pipeline preparation before qualifying this View',
      }),
    );
  return ok(undefined);
}

function* createViewResource<T>(
  current: () => boolean,
  create: () => Result<T, RhiError>,
): Generator<void, Result<T, RhiError>> {
  if (!current()) return err(viewCreationInvalid());
  const result = create();
  if (!result.ok) return result;
  if (!current()) return err(viewCreationInvalid());
  yield;
  return current() ? result : err(viewCreationInvalid());
}

function* prepareViewPipeline(
  device: RhiDevice,
  descriptor: import('@forgeax/engine-rhi').ComputePipelineDescriptor,
  completion: boolean,
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep, Result<ComputePipeline, RhiError>> {
  if (!current()) return err(viewCreationInvalid());
  const prepare = device.createComputePipelineAsync;
  if (completion && prepare === undefined)
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: 'completion-qualified native compute pipeline construction',
        hint: 'use a backend with asynchronous pipeline preparation before qualifying this View',
      }),
    );
  const requested = completion
    ? prepare?.call(device, descriptor)
    : device.createComputePipeline(descriptor);
  let result: Result<ComputePipeline, RhiError> | undefined;
  if (requested instanceof Promise) {
    const done = requested.then(
      (value) => {
        result = value;
      },
      (cause) => {
        result = err(
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'successful completion of the requested native View pipeline',
                hint: cause instanceof Error ? cause.message : String(cause),
              }),
        );
      },
    );
    while (result === undefined) yield done;
  } else result = requested;
  if (!current()) return err(viewCreationInvalid());
  yield;
  return result ?? err(viewCreationInvalid());
}

export class GpuDrivenView {
  private addressPreparation: ViewAddressPreparation | undefined;
  private initialStorage: InitialViewStorage | undefined;
  private readonly bufferRetirement: ViewBufferRetirement;
  private preparingInputBindings: PreparingInputBindings | undefined;
  private inputReads: GpuInputReadFrame | undefined;
  private updating = false;
  private encodedTopology: EncodedViewTopology | undefined;
  private shadowRaster: PreparedRasterCounters | undefined;
  private buffers: ViewBuffers | undefined;
  private surfaceRows: Uint32Array | undefined;
  private supersededBuffers: Partial<ViewBuffers>[] = [];
  private bindGroup: BindGroup | undefined;
  private skinBindGroup: BindGroup | undefined;
  private skinFinalizeBindGroup: BindGroup | undefined;
  private skinPipelines: readonly ComputePipeline[] | undefined;
  private skinLayout: SkinDemandLayout | undefined;
  private skinJointCapacity = 0;
  private skinActive = false;
  private skinRasterBinding: SkinTaskBinding | undefined;
  private readonly viewBytes = new ArrayBuffer(VIEW_BYTES);
  private readonly viewFloats = new Float32Array(this.viewBytes);
  private readonly viewWords = new Uint32Array(this.viewBytes);
  private readonly viewData = new DataView(this.viewBytes);
  private readonly viewUpload = new Uint8Array(this.viewBytes);
  private candidateCapacity = 0;
  /** Stable-order records address flattened executions, not shared member storage. */
  private orderCandidateCapacity = 0;
  private sceneRef: GpuScene | undefined;
  private readonly memberResidency: GpuTaskResidency;
  private visibleBufferCapacity = 0;
  /**
   * Two-phase occlusion mirrors late items after the union region. Only a view
   * that has been given an occlusion camera reserves it; once reserved it stays,
   * so toggling occlusion never thrashes the allocation.
   */
  private lateMirror = false;
  private batchCapacity = 0;
  private indirectCapacity = 0;
  private plan: SubmissionPlan | undefined;
  private sceneInputs: Buffer | undefined;
  private sceneInputBytes = 0;
  private scenePrimitive: Buffer | undefined;
  private sceneInstance: Buffer | undefined;
  private sceneTransform: Buffer | undefined;
  private sceneTableIdentity: object | undefined;
  private sceneMaterial: Buffer | undefined;
  private sceneMaterialBytes = 0;
  private sceneCapacity = 0;
  private sceneTransformBytes = 0;
  private updateCount = 0;
  private uploadBytes = 0;
  private sharedInputUploadBytes = 0;
  private batchUploadBytes = 0;
  private viewConstantsUploadBytes = 0;
  private suppressionUploadBytes = 0;
  /** Bitmap words reserved after the batch table in the batches buffer. */
  private suppressionWordCapacity = 0;
  /** CPU mirror of the uploaded admission bitmap; diffed to upload dirty words only. */
  private suppressionMirror = new Uint32Array(0);
  /** A replacement batches buffer has no bitmap yet; the next update seeds it whole. */
  private suppressionReseed = false;
  /** Bitmap the mirror currently equals; `null` when unknown and a full diff must run. */
  private suppressionSource: Uint32Array | undefined | null = null;
  private bindGroupCreates = 0;
  private bufferRebuilds = 0;
  private resourceGeneration = 0;
  /**
   * Generation of the pass list this view adds to a graph. View and scene
   * buffers are resolved live when the graph executes, so buffer growth
   * advances only `resourceGeneration`; this changes only when imports or
   * passes are added or removed (first binding, Skin tasks, surface rows).
   */
  private graphGeneration = 0;
  private graphShape: string | undefined;
  private materialResourceGeneration = 0;
  private readonly allocationLedger = new GpuResourceAllocationLedger();
  private readonly allocationTokens = new WeakMap<Buffer, GpuResourceAllocationToken>();
  /** The last readback copy that was actually encoded and is not consumed. */
  private telemetryPending: LodTelemetryCopy | undefined;
  /** Receipt identity for the copy pass encoded by the current frame. */
  private telemetrySubmit: ViewTelemetrySubmit | undefined;
  /** Counts-only views copy their counters only while an owner will read them. */
  private cullingReadbackDemand = true;
  /** Coalesce observers while the readback buffer is map-pending. */
  private lodSelectionReadback:
    | {
        readonly promise: Promise<GpuDrivenLodSelectionInspection | undefined>;
      }
    | undefined;
  private lodSelection: GpuDrivenLodSelectionInspection | undefined;
  /** Camera of the pyramid source; undefined keeps the single-phase path. */
  private occlusionCamera: GpuDrivenOcclusionCamera | undefined;
  /**
   * The last projected graph tests shadow casters against a camera pyramid.
   * A cull input enables the test only then, so a view never records a
   * camera-dependent raster its graph did not perform.
   */
  cameraCullBound = false;
  /** Which bit region the next late phase writes; flips when it is encoded. */
  private visibilityParity = 0;
  /** History key and readiness of the region the last late phase wrote. */
  private visibilityHistoryKey: string | undefined;
  private visibilityHistoryReady = false;
  private readonly pyramidBindGroups = new WeakMap<TextureView, BindGroup>();
  private shadowCameraCullPipeline: ComputePipeline | undefined;

  private constructor(
    private readonly device: RhiDevice,
    private readonly bindGroupLayout: BindGroupLayout,
    private readonly pipelineLayout: PipelineLayout,
    private readonly resetPipeline: ComputePipeline,
    private readonly cullPipeline: ComputePipeline,
    private readonly finalizePipeline: ComputePipeline,
    private readonly labelPrefix: string,
    private readonly pyramidLayout: BindGroupLayout,
    private readonly lateCullPipeline: ComputePipeline,
    private readonly lateFinalizePipeline: ComputePipeline,
    private readonly footprintScale: number,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
    private readonly latePipelineLayout: PipelineLayout,
    private readonly shadowCameraCullEligible: boolean,
    private readonly viewModule: ShaderModule,
    private readonly readback: 'complete' | 'culling-counts',
    private readonly orderScanPipeline: ComputePipeline,
    private readonly orderPlacePipeline: ComputePipeline,
    private readonly lateOrderPlacePipeline: ComputePipeline,
  ) {
    this.memberResidency = new GpuTaskResidency(device);
    this.bufferRetirement = new ViewBufferRetirement(
      device,
      this.allocationLedger,
      this.allocationTokens,
    );
  }

  /**
   * Compiled on the first update with a camera cull input, so views that never
   * receive one skip the larger module. Undefined while the module compiles.
   */
  private shadowCameraCull(): Result<ComputePipeline | undefined, RhiError> {
    if (this.shadowCameraCullPipeline !== undefined) return ok(this.shadowCameraCullPipeline);
    const module = this.shaderModuleFactory.createShaderModule({
      label: 'gpu-driven-view-shadow-camera',
      code: GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL,
    });
    if (!module.ok) return module.error.code === 'rhi-not-available' ? ok(undefined) : module;
    const created = this.device.createComputePipeline({
      label: `${this.labelPrefix}.cullViewShadowCamera`,
      layout: this.latePipelineLayout,
      compute: { module: module.value, entryPoint: 'cullViewShadowCamera' },
    });
    if (!created.ok) return created;
    this.shadowCameraCullPipeline = created.value;
    return created;
  }

  private *prepareShadowCamera(
    current: () => boolean,
  ): Generator<GpuDrivenViewCreationStep, Result<void, RhiError>> {
    const module = yield* prepareViewModule(
      this.shaderModuleFactory,
      {
        label: 'gpu-driven-view-shadow-camera',
        code: GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL,
      },
      current,
    );
    if (!module.ok) return module;
    const pipeline = yield* prepareViewPipeline(
      this.device,
      {
        label: `${this.labelPrefix}.cullViewShadowCamera`,
        layout: this.latePipelineLayout,
        compute: { module: module.value, entryPoint: 'cullViewShadowCamera' },
      },
      true,
      current,
    );
    if (!pipeline.ok) return pipeline;
    this.shadowCameraCullPipeline = pipeline.value;
    return ok(undefined);
  }

  private prepareSkinForSubmission(
    plan: SubmissionPlan,
    skin: SkinSceneFrame | undefined,
  ): Result<void, RhiError> | undefined {
    this.skinActive = (skin?.current.jointCapacity ?? 0) > 0 && planDrawsSkin(plan);
    if (!this.skinActive || this.skinPipelines !== undefined) return undefined;
    // Resolve reads dispatch arguments indirectly; its bind group must omit the
    // writable alias of that buffer, even though finalize writes it earlier.
    const layout = this.device.createBindGroupLayout({
      label: `${this.labelPrefix}-skin-bgl`,
      entries: [
        ...[0, 1, 2, 3, 4].map((binding) => ({
          binding,
          visibility: COMPUTE_STAGE,
          buffer: { type: 'read-only-storage' as const },
        })),
        { binding: 5, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        { binding: 7, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
      ],
    });
    if (!layout.ok) return layout;
    const pipelineLayout = this.device.createPipelineLayout({
      label: `${this.labelPrefix}-skin-pl`,
      bindGroupLayouts: [layout.value],
    });
    if (!pipelineLayout.ok) return pipelineLayout;
    // The kernels share the view module created with this view; another label
    // would compile identical WGSL asynchronously and fail the first Skin frame.
    const pipelines: ComputePipeline[] = [];
    for (const entryPoint of [
      'clearSkinDemand',
      'resetSkinDemand',
      'claimSkinDemand',
      'finalizeSkinDemand',
      'resolveSkinDemand',
    ]) {
      const pipeline = this.device.createComputePipeline({
        label: `${this.labelPrefix}.${entryPoint}`,
        layout: entryPoint === 'finalizeSkinDemand' ? this.pipelineLayout : pipelineLayout.value,
        compute: { module: this.viewModule, entryPoint },
      });
      if (!pipeline.ok) return pipeline;
      pipelines.push(pipeline.value);
    }
    this.skinPipelineLayout = layout.value;
    this.skinPipelines = pipelines;
    return undefined;
  }
  private skinPipelineLayout: BindGroupLayout | undefined;

  /** Physical task output, captured by raster bindings until GPU completion. */
  skinTaskBinding(): SkinTaskBinding | undefined {
    return this.skinActive ? this.skinRasterBinding : undefined;
  }

  /**
   * @internal Whether the next executed cull of a `culling-counts` view is
   * read back. When false its graph skips the telemetry copy (no GPU copy and
   * no pending observation); the cull and raster work are unchanged. Views
   * with complete readback always copy, so inspection stays available.
   */
  _setCullingReadbackDemand(demand: boolean): void {
    this.cullingReadbackDemand = demand;
  }

  /** A counts-only view whose owner will not read this frame's counters. */
  private cullingReadbackSkipped(): boolean {
    return this.readback === 'culling-counts' && !this.cullingReadbackDemand;
  }

  setTelemetrySubmit(identity: GpuDrivenLodSubmitIdentity | undefined): void {
    this.telemetrySubmit = identity;
  }

  /** @internal Only enables CPU decoding on telemetry copies/maps already issued by the view. */
  _setCullingTelemetrySubmit(identity: GpuDrivenCullingProducerReceipt | undefined): void {
    if (identity === undefined) {
      this.telemetrySubmit = undefined;
      return;
    }
    const producer = Object.freeze({
      frameId: identity.frameId,
      deviceGeneration: identity.deviceGeneration,
      ...(identity.graphGeneration === undefined
        ? {}
        : { graphGeneration: identity.graphGeneration }),
      viewKey: identity.viewKey,
      viewGeneration: identity.viewGeneration,
      sourceRevision: identity.sourceRevision,
    });
    this.telemetrySubmit = Object.freeze({
      frameId: producer.frameId,
      deviceGeneration: producer.deviceGeneration,
      cullingProducer: producer,
    });
  }

  static create(input: GpuDrivenViewCreationInput): Result<GpuDrivenView, RhiError> {
    const work = GpuDrivenView.construct(input, false, () => true);
    for (;;) {
      const next = work.next();
      if (next.done) return next.value;
      if (next.value instanceof Promise) {
        work.return(err(viewCreationInvalid()));
        return err(viewCreationInvalid());
      }
    }
  }

  /** Native calls are separate work units; yielded completion must settle before resumption. */
  static prepareCreation(
    input: GpuDrivenViewCreationInput,
    current: () => boolean,
  ): Generator<GpuDrivenViewCreationStep, Result<GpuDrivenView, RhiError>> {
    // Retain only construction facts, never the caller's containing frame/context.
    return GpuDrivenView.construct(
      {
        device: input.device,
        shaderModuleFactory: input.shaderModuleFactory,
        labelPrefix: input.labelPrefix ?? 'gpu-driven-view',
        occlusionFootprintScale: input.occlusionFootprintScale ?? 1,
        shadowCameraCull: input.shadowCameraCull === true,
        readback: input.readback ?? 'complete',
      },
      true,
      current,
    );
  }

  private static *construct(
    input: GpuDrivenViewCreationInput,
    completion: boolean,
    current: () => boolean,
  ): Generator<GpuDrivenViewCreationStep, Result<GpuDrivenView, RhiError>> {
    if (!current()) return err(viewCreationInvalid());
    const { device, shaderModuleFactory } = input;
    const labelPrefix = input.labelPrefix ?? 'gpu-driven-view';
    const supported = viewCreationSupported(device, completion);
    if (!supported.ok) return supported;
    const layout = yield* createViewResource(current, () =>
      device.createBindGroupLayout({
        label: `${labelPrefix}-bgl`,
        entries: [
          { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
          { binding: 4, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
          { binding: 5, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
          { binding: 6, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
          { binding: 7, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
          { binding: 8, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
        ],
      }),
    );
    if (!layout.ok) return layout;
    const pipelineLayout = yield* createViewResource(current, () =>
      device.createPipelineLayout({
        label: `${labelPrefix}-pl`,
        bindGroupLayouts: [layout.value],
      }),
    );
    if (!pipelineLayout.ok) return pipelineLayout;
    const module = yield* createViewResource(current, () =>
      shaderModuleFactory.createShaderModule({
        label: 'gpu-driven-view',
        code: GPU_DRIVEN_VIEW_WGSL,
      }),
    );
    if (!module.ok) return module;
    const createPipeline = function* (entryPoint: string) {
      return yield* prepareViewPipeline(
        device,
        {
          label: `${labelPrefix}.${entryPoint}`,
          layout: pipelineLayout.value,
          compute: {
            module: module.value,
            entryPoint,
            ...(device.caps.firstInstanceIndirect &&
            (entryPoint === 'finalizeView' || entryPoint === 'finalizeViewLate')
              ? { constants: { INDIRECT_FIRST_INSTANCE: 1 } }
              : {}),
          },
        },
        completion,
        current,
      );
    };
    const reset = yield* createPipeline('resetView');
    if (!reset.ok) return reset;
    const cull = yield* createPipeline('cullView');
    if (!cull.ok) return cull;
    const finalize = yield* createPipeline('finalizeView');
    if (!finalize.ok) return finalize;
    const lateFinalize = yield* createPipeline('finalizeViewLate');
    if (!lateFinalize.ok) return lateFinalize;
    const orderScan = yield* createPipeline('scanVisibleOrder');
    if (!orderScan.ok) return orderScan;
    const orderPlace = yield* createPipeline('placeVisibleOrder');
    if (!orderPlace.ok) return orderPlace;
    const lateOrderPlace = yield* createPipeline('placeVisibleOrderLate');
    if (!lateOrderPlace.ok) return lateOrderPlace;
    const pyramidLayout = yield* createViewResource(current, () =>
      device.createBindGroupLayout({
        label: `${labelPrefix}-occlusion-bgl`,
        entries: [
          {
            binding: 0,
            visibility: COMPUTE_STAGE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
        ],
      }),
    );
    if (!pyramidLayout.ok) return pyramidLayout;
    const latePipelineLayout = yield* createViewResource(current, () =>
      device.createPipelineLayout({
        label: `${labelPrefix}-occlusion-pl`,
        bindGroupLayouts: [layout.value, pyramidLayout.value],
      }),
    );
    if (!latePipelineLayout.ok) return latePipelineLayout;
    const lateCull = yield* prepareViewPipeline(
      device,
      {
        label: `${labelPrefix}.cullViewLate`,
        layout: latePipelineLayout.value,
        compute: { module: module.value, entryPoint: 'cullViewLate' },
      },
      completion,
      current,
    );
    if (!lateCull.ok) return lateCull;
    if (!current()) return err(viewCreationInvalid());
    const view = new GpuDrivenView(
      device,
      layout.value,
      pipelineLayout.value,
      reset.value,
      cull.value,
      finalize.value,
      labelPrefix,
      pyramidLayout.value,
      lateCull.value,
      lateFinalize.value,
      input.occlusionFootprintScale ?? 1,
      shaderModuleFactory,
      latePipelineLayout.value,
      input.shadowCameraCull === true,
      module.value,
      input.readback ?? 'complete',
      orderScan.value,
      orderPlace.value,
      lateOrderPlace.value,
    );
    return yield* view.completeCreation(completion, current);
  }

  private *completeCreation(
    completion: boolean,
    current: () => boolean,
  ): Generator<GpuDrivenViewCreationStep, Result<GpuDrivenView, RhiError>> {
    if (completion && this.shadowCameraCullEligible) {
      const prepared = yield* this.prepareShadowCamera(current);
      if (!prepared.ok) return prepared;
    }
    return ok(this);
  }

  /** Initial static execution storage, using the actual plan's ordinary capacity recipe. */
  *prepareInitialStorage(
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
    layout: { readonly surfaceRows: boolean; readonly lateMirror: boolean },
  ): Generator<void, Result<void, RhiError>> {
    if (this.buffers !== undefined || this.updating) return err(viewCreationInvalid());
    this.updating = true;
    const role: InitialViewStorage = { phase: 'preparing', created: {} };
    this.initialStorage = role;
    try {
      const capacity = deriveGpuDrivenViewBufferCapacities(plan);
      const live = () => {
        this.bufferRetirement.assertHealthy();
        this.memberResidency.assertLive(scene.inputs);
        const valid = current();
        this.bufferRetirement.assertHealthy();
        this.memberResidency.assertLive(scene.inputs);
        return (
          valid &&
          this.initialStorage === role &&
          role.phase === 'preparing' &&
          this.updating &&
          scene.live
        );
      };
      return yield* this.rebuildBufferSteps(
        capacity.candidate,
        capacity.visible,
        capacity.batch,
        capacity.indirect,
        Math.max(1, Math.ceil(scene.rowAddressExtent / 32)),
        layout.surfaceRows,
        0,
        0,
        layout.lateMirror,
        nextCapacity(plan.candidateCount),
        live,
        role,
      );
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      this.closeInitialStorage(role);
      this.updating = false;
    }
  }

  private closeInitialStorage(role: InitialViewStorage): void {
    if (role.phase === 'preparing') role.phase = 'closed';
    if (this.initialStorage === role) this.initialStorage = undefined;
    if (role.phase === 'closed') this.destroyAfterSubmittedWork([role.created]);
  }

  /** Grow this View's native capacity without selecting the prospective execution. */
  *prepareStorageCapacity(
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
    layout: { readonly surfaceRows: boolean; readonly lateMirror: boolean },
    prepareConsumers: (target: ViewStorageTarget) => Result<GpuViewInputPreparation, RhiError>,
  ): Generator<void, Result<void, RhiError>> {
    const previous = this.buffers;
    if (
      this.updating ||
      previous === undefined ||
      this.sceneRef !== scene ||
      this.sceneInputs === undefined ||
      this.initialStorage !== undefined ||
      this.addressPreparation !== undefined
    )
      return err(viewCreationInvalid());
    const capacities = deriveGpuDrivenViewBufferCapacities(plan);
    const words = Math.max(1, Math.ceil(scene.rowAddressExtent / 32));
    const surfaceRows = layout.surfaceRows || previous.visibleSurfaceRows !== undefined;
    const lateMirror = layout.lateMirror || this.lateMirror;
    if (this.storageCapacityFits(capacities, plan.candidateCount, words, surfaceRows, lateMirror))
      return current() ? ok(undefined) : err(viewCreationInvalid());
    const role: InitialViewStorage = { phase: 'preparing', created: {} };
    this.initialStorage = role;
    const live = () => {
      this.assertInputScene(scene);
      const owned = () =>
        !this.updating &&
        this.initialStorage === role &&
        role.phase === 'preparing' &&
        this.buffers === previous &&
        this.sceneRef === scene;
      return owned() && current() && owned();
    };
    try {
      return yield* this.rebuildBufferSteps(
        Math.max(capacities.candidate, this.candidateCapacity),
        Math.max(capacities.visible, this.visibleBufferCapacity),
        Math.max(capacities.batch, this.batchCapacity),
        Math.max(capacities.indirect, this.indirectCapacity),
        words,
        surfaceRows,
        this.skinJointCapacity,
        Math.max(plan.candidateCount, this.skinLayout?.candidateCapacity ?? 0),
        lateMirror,
        nextCapacity(plan.candidateCount),
        live,
        role,
        (next, skin, nextVisible, nextIndirect) => {
          const input = this.sceneInputs;
          if (input === undefined || !scene.inputs.isCurrentBuffer(input))
            return err(viewCreationInvalid());
          const before = this.inputBindingFacts(scene, previous);
          const groups = createInputBindingGroups(
            this.device,
            this.bindGroupLayout,
            this.labelPrefix,
            { ...before, ...inputBindingSceneFacts(scene, next, undefined) },
            input,
            () => live() && this.inputBindingFactsMatch(before),
          );
          if (!groups.ok) return groups;
          const target: ViewStorageTarget = Object.freeze({
            view: this,
            before: previous,
            after: next,
            surfaceRows: next.visibleSurfaceRows,
            previousLateVisibleBase: this.lateVisibleBase(),
            lateVisibleBase: lateMirror ? nextVisible : 0,
            previousLateIndirectBase: this.indirectCapacity * INDIRECT_COMMAND_BYTES,
            lateIndirectBase: nextIndirect * INDIRECT_COMMAND_BYTES,
            skin:
              skin === undefined
                ? undefined
                : {
                    data: next.visible,
                    auxiliary: next.view,
                    dataOffset: 0,
                    auxiliaryOffset: SKIN_RASTER_OFFSET,
                    dataSize: skin.outputBytes,
                    auxiliarySize: 16,
                  },
            isCurrent: () => live() && this.inputBindingFactsMatch(before),
          });
          const consumers = prepareConsumers(target);
          if (!consumers.ok) return consumers;
          return ok({ ...groups.value, consumers: consumers.value });
        },
      );
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      this.closeInitialStorage(role);
    }
  }

  private storageCapacityFits(
    capacities: ReturnType<typeof deriveGpuDrivenViewBufferCapacities>,
    candidates: number,
    words: number,
    surfaceRows: boolean,
    lateMirror: boolean,
  ): boolean {
    return (
      capacities.candidate <= this.candidateCapacity &&
      capacities.visible <= this.visibleBufferCapacity &&
      capacities.batch <= this.batchCapacity &&
      capacities.indirect <= this.indirectCapacity &&
      nextCapacity(candidates) <= this.orderCandidateCapacity &&
      words <= this.suppressionWordCapacity &&
      surfaceRows === (this.buffers?.visibleSurfaceRows !== undefined) &&
      lateMirror === this.lateMirror
    );
  }

  /** Encode and retain fixed resident member roots; this does not flush or reserve View buffers. */
  prepareResidentMembers(plan: SubmissionPlan, scene: GpuScene): Result<void, RhiError> {
    try {
      this.memberResidency.prepareResident(plan, scene.inputs);
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    }
  }

  /** Header/member custody only; native upload and View capacity remain separate demands. */
  prepareResidentHeaders(plan: SubmissionPlan, scene: GpuScene): Result<void, RhiError> {
    const owner = scene.inputs;
    const guard = owner.captureGuard();
    const revision = scene.syncRevision;
    let inputs: GpuInputReadFrame | undefined;
    let failure: { readonly cause: unknown } | undefined;
    try {
      this.memberResidency.assertLive(owner);
      inputs = owner.capture();
      const encoded = encodedViewTopology(plan, scene, inputs);
      inputs.seal().unwrap();
      this.memberResidency.prepareHeaders(plan, owner, encoded, encoded.rows, encoded.headers);
    } catch (cause) {
      failure = { cause };
    }
    if (inputs !== undefined)
      try {
        this.memberResidency.releaseRead(owner, inputs);
      } catch (cause) {
        failure = {
          cause:
            failure === undefined
              ? cause
              : new AggregateError(
                  [failure.cause, cause],
                  'Resident header preparation and retirement failed',
                ),
        };
      }
    if (failure !== undefined) {
      if (failure.cause instanceof RhiError) return err(failure.cause);
      throw failure.cause;
    }
    try {
      this.memberResidency.assertLive(owner);
      if (!guard() || scene.inputs !== owner || !scene.live || scene.syncRevision !== revision)
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'current View, Scene and Inputs after all header retirement',
            hint: 'discard stale header preparation and retry under the source owner guard',
          }),
        );
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    }
  }

  /** First, unpublished View only: seed static topology without consuming a warm frame. */
  prepareInitialTopology(
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
  ): Result<void, RhiError> {
    const buffers = this.buffers;
    if (this.sceneRef === scene) return this.prepareExistingTopology(plan, scene, current);
    if (
      this.updating ||
      buffers === undefined ||
      this.bindGroup !== undefined ||
      this.sceneRef !== undefined ||
      this.plan !== undefined
    )
      return err(this.inputReadError('an unbound first View with its original source demand'));
    this.updating = true;
    try {
      if (!current() || this.buffers !== buffers) return err(viewCreationInvalid());
      const headers = this.prepareResidentHeaders(plan, scene);
      if (!headers.ok) return headers;
      if (!current() || this.buffers !== buffers) return err(viewCreationInvalid());
      const encoded = this.readInitialTopology(plan, scene);
      if (!current() || this.buffers !== buffers) return err(viewCreationInvalid());
      const uploaded = this.uploadTopology(plan, scene, encoded, buffers, true);
      if (!uploaded.ok) return uploaded;
      const suppression = this.updateSuppression(buffers.batches, true, undefined);
      if (!suppression.ok) return suppression;
      if (!current() || this.buffers !== buffers) return err(viewCreationInvalid());
      this.plan = plan;
      this.adoptScene(scene);
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      this.updating = false;
    }
  }

  /** Existing execution keeps active control; only shared resident headers receive static data. */
  private prepareExistingTopology(
    plan: SubmissionPlan,
    scene: GpuScene,
    current: () => boolean,
  ): Result<void, RhiError> {
    const buffers = this.buffers;
    if (this.updating || buffers === undefined || !current() || this.buffers !== buffers)
      return err(viewCreationInvalid());
    const prepared = this.prepareResidentHeaders(plan, scene);
    if (!prepared.ok) return prepared;
    return current() && this.buffers === buffers ? ok(undefined) : err(viewCreationInvalid());
  }

  private readInitialTopology(plan: SubmissionPlan, scene: GpuScene): EncodedViewTopology {
    const reads = scene.inputs.capture();
    let encoded: EncodedViewTopology | undefined;
    let failure: { readonly cause: unknown } | undefined;
    try {
      encoded = encodedViewTopology(plan, scene, reads);
      reads.seal().unwrap();
    } catch (cause) {
      failure = { cause };
    } finally {
      try {
        this.memberResidency.releaseRead(scene.inputs, reads);
      } catch (cause) {
        failure = {
          cause:
            failure === undefined
              ? cause
              : new AggregateError(
                  [failure.cause, cause],
                  'Initial topology and read retirement failed',
                ),
        };
      }
    }
    if (failure !== undefined) throw failure.cause;
    if (encoded === undefined) throw viewCreationInvalid();
    return encoded;
  }

  update(
    plan: SubmissionPlan,
    scene: GpuScene,
    inputs: GpuInputReadFrame,
    planes: Float32Array,
    lodCamera?: LodViewCamera,
    minCasterDiameter = 0,
    suppressedPrimitives?: Uint32Array,
    lodShadow = false,
    occlusionCamera?: GpuDrivenOcclusionCamera,
    visibleSurfaceRows?: Uint32Array,
    shadowCameraCull?: GpuDrivenShadowCameraCull,
    skin?: SkinSceneFrame,
    capsuleDirectional = false,
  ): Result<void, RhiError> {
    if (visibleSurfaceRows !== undefined && visibleSurfaceRows.length !== plan.candidateCount) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'one submitted visible-surface address per view candidate',
          hint: 'derive receiver addresses from the same ordered submission plan before updating the view',
        }),
      );
    }
    const wasUpdating = this.updating;
    try {
      this.assertInputMutation(scene, inputs);
      this.updating = true;
      this.resetUpdateTelemetry();
      const skinPrepared = this.prepareSkinForSubmission(plan, skin);
      if (skinPrepared?.ok === false) return skinPrepared;
      const inputUploadStart = scene.inputs.uploadBytes;
      const encoded = encodedViewTopology(
        plan,
        scene,
        inputs,
        this.sceneRef === scene ? this.encodedTopology : undefined,
      );
      const sharedInput = inputs.buffer();
      if (!sharedInput.ok) return sharedInput;
      this.sharedInputUploadBytes = scene.inputs.uploadBytes - inputUploadStart;
      this.uploadBytes += this.sharedInputUploadBytes;
      const ensured = this.ensureBuffers(
        plan,
        scene,
        suppressedPrimitives,
        visibleSurfaceRows !== undefined,
        skin,
        this.lateMirror || occlusionCamera !== undefined,
      );
      if (!ensured.ok) return ensured;
      const buffersRebuilt = ensured.value;
      const buffers = this.buffers;
      if (buffers === undefined) return ok(undefined);
      const cleared = this.retireExitedCommands(plan, buffersRebuilt);
      if (!cleared.ok) return cleared;
      const topology = this.uploadTopology(plan, scene, encoded, buffers, buffersRebuilt);
      if (!topology.ok) return topology;
      const surfaceRows = this.uploadSurfaceRows(buffers, visibleSurfaceRows, buffersRebuilt);
      if (!surfaceRows.ok) return surfaceRows;
      this.writeViewConstants(
        plan,
        planes,
        minCasterDiameter,
        sharedInput.value.resourceRoot,
        capsuleDirectional,
      );
      this.writeLodConstants(lodCamera, lodShadow);
      this.writeOcclusionConstants(occlusionCamera);
      const cameraCull = this.writeShadowCameraCullConstants(shadowCameraCull);
      if (!cameraCull.ok) return cameraCull;
      this.writeSkinConstants(skin, plan);
      const viewWrite = this.device.queue.writeBuffer(buffers.view, 0, this.viewUpload);
      if (!viewWrite.ok) return viewWrite;
      this.viewConstantsUploadBytes = this.viewBytes.byteLength;
      this.uploadBytes += this.viewBytes.byteLength;
      const suppressionUpdated = this.updateSuppression(
        buffers.batches,
        this.suppressionReseed,
        suppressedPrimitives,
      );
      if (!suppressionUpdated.ok) return suppressionUpdated;
      const bound = this.ensureBindGroups(scene, sharedInput.value.buffer, buffers, buffersRebuilt);
      if (!bound.ok) return bound;
      this.plan = plan;
      this.sceneInputs = sharedInput.value.buffer;
      this.sceneInputBytes = sharedInput.value.byteLength;
      this.memberResidency.adoptActive(scene.inputs, encoded, encoded.rows, encoded.headers);
      this.adoptScene(scene);
      this.assertInputScene(scene);
      this.inputReads = inputs;
      this.updateCount += 1;
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      this.updating = wasUpdating;
    }
  }

  private retireExitedCommands(plan: SubmissionPlan, replaced: boolean): Result<void, RhiError> {
    if (replaced || this.buffers === undefined) return ok(undefined);
    const cleared = clearExitedIndirectCommands(
      this.device,
      this.buffers.indirect,
      this.plan,
      plan,
      this.indirectCapacity * INDIRECT_COMMAND_BYTES,
    );
    if (!cleared.ok) return cleared;
    this.uploadBytes += cleared.value;
    return ok(undefined);
  }

  /** A retained-depth hit still observes this frame's real input lifetime. */
  observeInputReads(scene: GpuScene, reads: GpuInputReadFrame): Result<void, RhiError> {
    const wasUpdating = this.updating;
    try {
      this.assertInputMutation(scene, reads);
      if (this.sceneRef !== scene || !scene.inputs.readIsCurrent(reads))
        throw this.inputReadError('a current read from this retained View Scene');
      this.updating = true;
      if (
        this.sceneInputs !== undefined &&
        (!scene.inputs.isCurrentBuffer(this.sceneInputs) ||
          !scene.inputs.readHoldsBuffer(reads, this.sceneInputs))
      ) {
        const shared = reads.buffer();
        if (!shared.ok) return shared;
        if (this.buffers === undefined) throw this.inputReadError('retained native View buffers');
        if (shared.value.buffer !== this.sceneInputs) {
          const bound = this.ensureBindGroups(scene, shared.value.buffer, this.buffers, false);
          if (!bound.ok) return bound;
        }
        this.sceneInputs = shared.value.buffer;
        this.sceneInputBytes = shared.value.byteLength;
      }
      this.assertInputScene(scene);
      if (!scene.inputs.readIsCurrent(reads))
        throw this.inputReadError('unchanged input facts after binding refresh');
      this.inputReads = reads;
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      this.updating = wasUpdating;
    }
  }

  private inputReadError(expected: string): RhiError {
    return new RhiError({
      code: 'rhi-descriptor-invalid',
      expected,
      hint: 'refresh the View in its actual open input read domain before encoding compute',
    });
  }

  private assertInputScene(scene: GpuScene): void {
    this.bufferRetirement.assertHealthy();
    this.memberResidency.assertLive(scene.inputs);
    if (!scene.live) throw this.inputReadError('a live GPU Scene incarnation');
  }

  private assertInputMutation(scene: GpuScene, reads: GpuInputReadFrame): void {
    this.assertInputScene(scene);
    if (this.updating || !scene.inputs.ownsRead(reads))
      throw this.inputReadError('one actual input read issued by this Scene outside View mutation');
  }

  private inputBufferForExecution(buffer: Buffer, compute: boolean): Buffer {
    const scene = this.sceneRef;
    const reads = this.inputReads;
    if (scene === undefined || reads === undefined || this.updating)
      throw this.inputReadError('an observed input read outside View mutation');
    this.assertInputScene(scene);
    if (
      this.sceneTableIdentity === undefined ||
      !scene.readHoldsTableRoot(reads, this.sceneTableIdentity)
    )
      throw this.inputReadError('a real held read of every bound Scene table incarnation');
    if (!scene.inputs.ownsRead(reads)) throw this.inputReadError('this Scene input issuer');
    const held = scene.inputs.readHoldsBuffer(
      reads,
      buffer,
      compute ? this.viewWords[29] : undefined,
    );
    if (
      !held &&
      (compute || !scene.inputs.readIsCurrent(reads) || !scene.inputs.isCurrentBuffer(buffer))
    )
      throw this.inputReadError('a held matching input snapshot before actual GPU reads');
    return buffer;
  }

  /**
   * Preparation may overwrite the same physical buffers without changing their
   * generation. Only its subsequent submit can rebind receipt identity.
   */
  private resetUpdateTelemetry(): void {
    this.telemetrySubmit = undefined;
    this.sharedInputUploadBytes = 0;
    this.suppressionUploadBytes = 0;
    this.batchUploadBytes = 0;
    this.viewConstantsUploadBytes = 0;
    this.bindGroupCreates = 0;
    // The cached graph owns the readback copy.  Do not arm an observation latch
    // here: a graph can be compiled but not submitted, and its copy can be
    // skipped while the previous mapAsync is pending.  The encode callback
    // records only a copy that really reached the command encoder.
    this.lodSelection = undefined;
  }

  /**
   * Rebuild view storage when topology, Skin demand, surface mode or
   * suppression capacity outgrows it. Returns whether buffers were replaced.
   */
  private ensureBuffers(
    plan: SubmissionPlan,
    scene: GpuScene,
    suppressedPrimitives: Uint32Array | undefined,
    surfaceRows: boolean,
    skin: SkinSceneFrame | undefined,
    lateMirror: boolean,
  ): Result<boolean, RhiError> {
    const skinJointCapacity = Math.max(
      this.skinJointCapacity,
      this.skinActive ? (skin?.current.jointCapacity ?? 0) : 0,
    );
    // A shared membership may execute in several Passes. Task references
    // address actual candidate work, independently of unique member storage.
    const skinCandidates = this.skinLayout?.candidateCapacity ?? 0;
    const skinCandidateCapacity = Math.max(plan.candidateCount, skinCandidates);
    const skinGrows =
      (skinJointCapacity > 0 && skinCandidateCapacity > skinCandidates) ||
      skinJointCapacity > this.skinJointCapacity;
    const suppressionWords = Math.max(
      1,
      Math.ceil(scene.rowAddressExtent / 32),
      suppressedPrimitives?.length ?? 0,
    );
    const structureGrows =
      skinGrows ||
      lateMirror !== this.lateMirror ||
      surfaceRows !== (this.buffers?.visibleSurfaceRows !== undefined) ||
      this.buffers === undefined ||
      suppressionWords > this.suppressionWordCapacity;
    if (this.plan === plan && !structureGrows) return ok(false);
    // Candidate records and compacted visible indices are different
    // capacity domains: every LOD level owns an aligned visible segment,
    // so the visible address space exceeds the logical candidate count.
    // Never let it inflate candidate/LOD-row storage allocations.
    const capacities = deriveGpuDrivenViewBufferCapacities(plan);
    const orderCandidateCapacity = nextCapacity(plan.candidateCount);
    if (
      !structureGrows &&
      capacities.candidate <= this.candidateCapacity &&
      orderCandidateCapacity <= this.orderCandidateCapacity &&
      capacities.visible <= this.visibleBufferCapacity &&
      capacities.batch <= this.batchCapacity &&
      capacities.indirect <= this.indirectCapacity
    )
      return ok(false);
    const rebuilt = this.rebuildBuffers(
      capacities.candidate,
      capacities.visible,
      capacities.batch,
      capacities.indirect,
      suppressionWords,
      surfaceRows,
      skinJointCapacity,
      skinCandidateCapacity,
      lateMirror,
      orderCandidateCapacity,
    );
    return rebuilt.ok ? ok(true) : rebuilt;
  }

  /**
   * Upload the encoded topology when it, its storage or its scene changed.
   * Any accepted write may partially replace the old topology, so a later
   * failure must force reseeding even when the caller retries the old plan.
   */
  private uploadTopology(
    plan: SubmissionPlan,
    scene: GpuScene,
    encoded: EncodedViewTopology,
    buffers: ViewBuffers,
    buffersRebuilt: boolean,
  ): Result<void, RhiError> {
    const previous = buffersRebuilt ? undefined : this.encodedTopology;
    if (
      this.plan === plan &&
      !buffersRebuilt &&
      this.sceneRef === scene &&
      encoded.batchBytes === previous?.batchBytes
    )
      return ok(undefined);
    this.plan = undefined;
    this.encodedTopology = undefined;
    const batchWrite = this.writeChangedWords(
      buffers.batches,
      encoded.batchBytes,
      previous?.batchBytes,
    );
    if (!batchWrite.ok) return batchWrite;
    this.encodedTopology = encoded;
    this.batchUploadBytes = batchWrite.value;
    this.uploadBytes += batchWrite.value;
    return ok(undefined);
  }

  /**
   * Physical buffers retain their accepted bytes. Trim equal words at both
   * ends instead of re-uploading the static roster for a local edit. One
   * aligned interval per table keeps queue work bounded even for scattered
   * changes; a replacement or partial failure always seeds the full table.
   */
  private writeChangedWords(
    buffer: Buffer,
    bytes: Uint8Array,
    before: Uint8Array | undefined,
  ): Result<number, RhiError> {
    if (bytes === before) return ok(0);
    let start = 0;
    let end = bytes.byteLength / 4;
    if (before !== undefined) {
      const next = new Uint32Array(bytes.buffer, bytes.byteOffset, end);
      const old = new Uint32Array(before.buffer, before.byteOffset, before.byteLength / 4);
      const common = Math.min(end, old.length);
      while (start < common && next[start] === old[start]) start++;
      while (end > start && end <= old.length && next[end - 1] === old[end - 1]) end--;
    }
    const size = (end - start) * 4;
    if (size === 0) return ok(0);
    const written = this.device.queue.writeBuffer(buffer, start * 4, bytes, start * 4, size);
    return written.ok ? ok(size) : written;
  }

  /** Upload receiver addresses when they or their storage changed; clear them when absent. */
  private uploadSurfaceRows(
    buffers: ViewBuffers,
    visibleSurfaceRows: Uint32Array | undefined,
    buffersRebuilt: boolean,
  ): Result<void, RhiError> {
    if (visibleSurfaceRows === undefined || buffers.visibleSurfaceRows === undefined) {
      this.surfaceRows = undefined;
      return ok(undefined);
    }
    // Producers never mutate a published row array, so identity proves equality.
    if (
      !buffersRebuilt &&
      (this.surfaceRows === visibleSurfaceRows ||
        (this.surfaceRows?.length === visibleSurfaceRows.length &&
          visibleSurfaceRows.every((row, index) => this.surfaceRows?.[index] === row)))
    )
      return ok(undefined);
    const written = this.device.queue.writeBuffer(
      buffers.visibleSurfaceRows,
      0,
      visibleSurfaceRows,
    );
    if (!written.ok) return written;
    this.surfaceRows = visibleSurfaceRows;
    this.uploadBytes += visibleSurfaceRows.byteLength;
    return ok(undefined);
  }

  /** Reset the view constants and write the frustum and roster header words. */
  private writeViewConstants(
    plan: SubmissionPlan,
    planes: Float32Array,
    minCasterDiameter: number,
    resourceRoot: number,
    capsuleDirectional: boolean,
  ): void {
    this.viewUpload.fill(0);
    const viewFloats = this.viewFloats;
    viewFloats.set(planes.subarray(0, 24));
    const viewU32 = this.viewWords;
    viewU32[24] = plan.candidateCount;
    viewU32[25] = plan.batches.length;
    viewU32[26] = this.batchCapacity;
    viewFloats[27] = minCasterDiameter;
    viewU32[28] = this.suppressionBase() / 4;
    viewU32[29] = resourceRoot;
    viewU32[30] = capsuleDirectional ? 1 : 0;
    viewU32[31] = this.orderBase();
  }

  /**
   * The per-frame history words (enabled, parity bases) stay zero here; the
   * early cull encode fills them only when its graph also records the late
   * phase, so a graph without it can never skip a previously hidden item.
   */
  private writeOcclusionConstants(occlusionCamera: GpuDrivenOcclusionCamera | undefined): void {
    this.occlusionCamera = occlusionCamera;
    if (occlusionCamera === undefined) return;
    const viewFloats = this.viewFloats;
    viewFloats.set(occlusionCamera.viewProjection.subarray(0, 16), OCCLUSION_CONSTANTS_OFFSET / 4);
    viewFloats[OCCLUSION_CONSTANTS_OFFSET / 4 + 16] = occlusionCamera.near;
    viewFloats[OCCLUSION_CONSTANTS_OFFSET / 4 + 17] = occlusionCamera.far;
    this.viewWords[OCCLUSION_CONSTANTS_OFFSET / 4 + 18] = occlusionCamera.orthographic ? 1 : 0;
    viewFloats[OCCLUSION_CONSTANTS_OFFSET / 4 + 19] = this.footprintScale;
  }

  /**
   * Without a cull input the enable word stays zero, so a graph that binds
   * the camera cull still draws every caster the frustum admits.
   */
  private writeShadowCameraCullConstants(
    shadowCameraCull: GpuDrivenShadowCameraCull | undefined,
  ): Result<void, RhiError> {
    const lightInverse =
      shadowCameraCull === undefined || !this.shadowCameraCullEligible
        ? undefined
        : invertLightViewProjection(shadowCameraCull.lightViewProjection);
    if (shadowCameraCull === undefined || lightInverse === undefined) return ok(undefined);
    const cameraPipeline = this.shadowCameraCull();
    if (!cameraPipeline.ok) return cameraPipeline;
    if (cameraPipeline.value === undefined) return ok(undefined);
    const viewFloats = this.viewFloats;
    const base = SHADOW_CAMERA_CULL_OFFSET / 4;
    const camera = shadowCameraCull.camera;
    viewFloats.set(camera.viewProjection.subarray(0, 16), base);
    viewFloats[base + 16] = camera.near;
    viewFloats[base + 17] = camera.far;
    this.viewWords[base + 18] = camera.orthographic ? 1 : 0;
    viewFloats[base + 19] = this.footprintScale;
    viewFloats.set(shadowCameraCull.lightViewProjection.subarray(0, 16), base + 20);
    viewFloats.set(lightInverse, base + 36);
    viewFloats[base + 52] = shadowCameraCull.ndcDilation;
    viewFloats[base + 53] = shadowCameraCull.worldDilation;
    this.viewWords[base + 54] = 1;
    return ok(undefined);
  }

  /**
   * Without a LOD camera the zero height scale reports an invalid height,
   * so every chain resolves to its root.
   */
  private writeLodConstants(lodCamera: LodViewCamera | undefined, shadow: boolean): void {
    if (lodCamera !== undefined) {
      writeLodViewConstants(this.viewData, LOD_CONSTANTS_OFFSET, lodCamera, shadow);
    }
  }

  /** Skin demand constants exist only while this view has an active Skin layout. */
  private writeSkinConstants(skin: SkinSceneFrame | undefined, plan: SubmissionPlan): void {
    const layout = this.skinLayout;
    if (!this.skinActive || skin === undefined || layout === undefined) {
      // A retained Skin allocation does not make the next rigid view a Skin task.
      // Clear its candidate count as well as the raster address to prevent the
      // selector from consulting a previous task's descriptors and bounds.
      this.viewWords.fill(0, SKIN_CONSTANTS_OFFSET / 4, (SKIN_CONSTANTS_OFFSET + 48) / 4);
      this.viewWords.fill(0, SKIN_RASTER_OFFSET / 4, (SKIN_RASTER_OFFSET + 16) / 4);
      return;
    }
    writeSkinDemandConstants(
      this.viewData,
      SKIN_CONSTANTS_OFFSET,
      layout,
      skin.current.root,
      skin.previous?.root ?? 0xffffffff,
      plan.candidateCount,
      this.skinCounterBase(),
      0,
      Number(this.device.limits.maxComputeWorkgroupsPerDimension) || 65535,
    );
    this.viewWords[SKIN_RASTER_OFFSET / 4] = layout.candidateBase;
    this.viewWords[SKIN_RASTER_OFFSET / 4 + 1] = layout.descriptorBase;
  }

  private skinBindingsReady(): boolean {
    return (
      !this.skinActive ||
      (this.skinBindGroup !== undefined && this.skinFinalizeBindGroup !== undefined)
    );
  }

  /** Recreate the cull and Skin task bind groups when their scene or view storage changed. */
  private ensureBindGroups(
    scene: GpuScene,
    inputBuffer: Buffer,
    buffers: ViewBuffers,
    buffersRebuilt: boolean,
  ): Result<void, RhiError> {
    const sceneChanged =
      this.scenePrimitive !== scene.primitiveBuffer ||
      this.sceneInstance !== scene.instanceBuffer ||
      this.sceneTransform !== scene.transformBuffer ||
      this.sceneInputs !== inputBuffer;
    const skinBindingsReady = this.skinBindingsReady();
    if (this.bindGroup !== undefined && !sceneChanged && !buffersRebuilt && skinBindingsReady)
      return ok(undefined);
    // Graph passes read the current scene bindings and imports at execute
    // time, so a scene or input buffer swap alone does not recompile them.
    const graphShapeChanged = this.bindGroup === undefined || buffersRebuilt || !skinBindingsReady;
    const facts = this.inputBindingFacts(scene, buffers);
    const groups = createInputBindingGroups(
      this.device,
      this.bindGroupLayout,
      this.labelPrefix,
      facts,
      inputBuffer,
      () => this.inputBindingFactsMatch(facts),
    );
    if (!groups.ok) return groups;
    if (!this.inputBindingFactsMatch(facts))
      return err(this.inputReadError('unchanged native View bindings after creation'));
    this.bindGroup = groups.value.cull;
    this.skinBindGroup = groups.value.skin;
    this.skinFinalizeBindGroup = groups.value.finalize;
    this.bindGroupCreates = this.skinBindGroup === undefined ? 1 : 3;
    if (graphShapeChanged) this.resourceGeneration += 1;
    this.adoptGraphBindingShape();
    return ok(undefined);
  }

  private adoptGraphBindingShape(): void {
    const shape = `${this.skinLayout !== undefined}|${this.buffers?.visibleSurfaceRows !== undefined}`;
    if (shape !== this.graphShape) {
      this.graphShape = shape;
      this.graphGeneration += 1;
    }
  }

  private inputBindingFacts(
    scene: GpuScene,
    buffers: ViewBuffers,
    target?: GpuSceneTableBindingTarget,
  ): InputBindingFacts {
    return {
      ...inputBindingSceneFacts(scene, buffers, target),
      viewScene: this.sceneRef,
      input: this.sceneInputs,
      cull: this.bindGroup,
      skin: this.skinBindGroup,
      finalize: this.skinFinalizeBindGroup,
      skinLayout: buffers.skinIndirect === undefined ? undefined : this.skinPipelineLayout,
      viewTables: [
        this.scenePrimitive,
        this.sceneInstance,
        this.sceneTransform,
        this.sceneMaterial,
      ],
    };
  }

  private inputBindingFactsMatch(facts: InputBindingFacts): boolean {
    try {
      this.assertInputScene(facts.scene);
    } catch {
      return false;
    }
    return (
      this.sceneRef === facts.viewScene &&
      this.sceneInputs === facts.input &&
      this.bindGroup === facts.cull &&
      this.skinBindGroup === facts.skin &&
      this.skinFinalizeBindGroup === facts.finalize &&
      (facts.buffers.skinIndirect === undefined ? undefined : this.skinPipelineLayout) ===
        facts.skinLayout &&
      this.buffers === facts.buffers &&
      inputBindingStorageMatches(facts) &&
      inputBindingTablesMatch(
        facts,
        this.scenePrimitive,
        this.sceneInstance,
        this.sceneTransform,
        this.sceneMaterial,
      )
    );
  }

  /** Prepare only the address-keyed storage; existing execution/raster structure stays intact. */
  *prepareAddressCapacity(
    scene: GpuScene,
    extent: number,
    current: () => boolean,
  ): Generator<void> {
    if (this.sceneRef !== scene || !scene.live || !current())
      throw this.inputReadError('the exact live View Scene and original caller');
    if (this.sceneRef !== scene || !Number.isSafeInteger(extent) || extent < 0)
      throw this.inputReadError('a nonnegative Scene-issued address extent');
    this.assertInputScene(scene);
    if (
      this.updating ||
      this.addressPreparation !== undefined ||
      this.preparingInputBindings !== undefined
    )
      throw this.inputReadError('an idle View after the caller guard');
    const words = nextCapacity(Math.max(1, Math.ceil(extent / 32)));
    if (words <= this.suppressionWordCapacity) return;
    if (
      this.updating ||
      this.addressPreparation !== undefined ||
      this.preparingInputBindings !== undefined ||
      this.buffers === undefined ||
      this.plan === undefined ||
      this.bindGroup === undefined ||
      this.sceneInputs === undefined
    )
      throw this.inputReadError('one initialized idle View address preparation');
    const requests = this.addressStorageRequests(words);
    const role: ViewAddressPreparation = {
      scene,
      current,
      words,
      oldWords: this.suppressionWordCapacity,
      facts: this.inputBindingFacts(scene, this.buffers),
      skinLayout: this.skinLayout,
      batchCapacity: this.batchCapacity,
      orderCapacity: this.orderCandidateCapacity,
      created: {},
      mirror: new Uint32Array(words),
      closed: false,
      published: false,
    };
    this.addressPreparation = role;
    try {
      this.assertAddressPreparation(role);
      const storage =
        GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST;
      for (const [name, size] of requests) {
        this.assertAddressPreparation(role);
        this.updating = true;
        try {
          const buffer = this.device
            .createBuffer({ label: `${this.labelPrefix}-address-${name}`, size, usage: storage })
            .unwrap();
          role.created[name] = buffer;
          this.allocationTokens.set(buffer, this.allocationLedger.allocate(size));
        } finally {
          this.updating = false;
        }
        this.assertAddressPreparation(role);
        yield;
      }
      this.prepareAddressGroups(role);
      yield;
      this.publishAddressStorage(role);
    } finally {
      this.releaseAddressStorage(role);
    }
  }

  coversAddressExtent(scene: GpuScene, extent: number): boolean {
    return (
      this.sceneRef === scene &&
      scene.live &&
      this.buffers !== undefined &&
      !this.suppressionReseed &&
      Math.ceil(extent / 32) <= this.suppressionWordCapacity
    );
  }

  private addressStorageRequests(words: number) {
    const requests = [
      ['batches', this.batchCapacity * BATCH_STRIDE + words * 4],
      ['counters', this.countersBytes() + (words - this.suppressionWordCapacity) * 8],
    ] as const;
    const knownLimits = [
      this.device.limits.maxStorageBufferBindingSize,
      this.device.limits.maxBufferSize,
    ].filter(
      (limit): limit is number => limit !== undefined && Number.isFinite(limit) && limit > 0,
    );
    const limit = Math.min(0xffffffff, ...knownLimits);
    if (
      !Number.isSafeInteger(words) ||
      words > 0xffffffff / 4 ||
      requests.some(([, size]) => size > limit)
    )
      throw this.inputReadError('View address storage within native buffer and u32 layout limits');
    return requests;
  }

  private assertAddressPreparation(role: ViewAddressPreparation): void {
    // Frames may change the accepted plan while private address buffers are
    // prepared. Publication copies the latest bytes from the same storage.
    if (
      this.addressPreparation !== role ||
      role.closed ||
      !role.current() ||
      this.addressPreparation !== role ||
      role.closed ||
      this.sceneRef !== role.scene ||
      !this.inputBindingFactsMatch(role.facts) ||
      this.plan === undefined ||
      this.skinLayout?.counterWords !== role.skinLayout?.counterWords ||
      this.batchCapacity !== role.batchCapacity ||
      this.orderCandidateCapacity !== role.orderCapacity ||
      this.suppressionWordCapacity !== role.oldWords ||
      this.suppressionReseed ||
      this.suppressionMirror.length !== role.oldWords
    )
      throw this.inputReadError('current fixed View execution and original address storage');
  }

  private prepareAddressGroups(role: ViewAddressPreparation): void {
    this.assertAddressPreparation(role);
    const { batches, counters } = role.created;
    const input = role.facts.input;
    if (batches === undefined || counters === undefined || input === undefined)
      throw this.inputReadError('both private address buffers and original Inputs');
    const next = { ...(this.buffers as ViewBuffers), batches, counters };
    this.updating = true;
    try {
      role.groups = createInputBindingGroups(
        this.device,
        this.bindGroupLayout,
        this.labelPrefix,
        {
          ...role.facts,
          buffers: next,
          storage: [batches, next.view, counters, next.visible, next.indirect, next.skinIndirect],
        },
        input,
        () => {
          this.assertAddressPreparation(role);
          return true;
        },
      ).unwrap();
      this.assertAddressPreparation(role);
      role.next = next;
    } finally {
      this.updating = false;
    }
  }

  /** Copy the latest submitted history and scratch, never an earlier preparation snapshot. */
  private copyAddressStorage(role: ViewAddressPreparation): void {
    const next = role.next;
    if (next === undefined) throw this.inputReadError('prepared native address storage');
    const before = role.facts.buffers;
    const batchBytes = role.batchCapacity * COUNTER_STRIDE;
    const oldBits = role.oldWords * 4,
      nextBits = role.words * 4;
    const encoder = this.device
      .createCommandEncoder({ label: `${this.labelPrefix}-address-carry` })
      .unwrap();
    encoder.copyBufferToBuffer(
      before.batches,
      0,
      next.batches,
      0,
      role.batchCapacity * BATCH_STRIDE + oldBits,
    );
    const regions = [
      [0, 0, batchBytes],
      [batchBytes, batchBytes, oldBits],
      [batchBytes + oldBits, batchBytes + nextBits, oldBits],
      [
        batchBytes + oldBits * 2,
        batchBytes + nextBits * 2,
        this.countersBytes() - batchBytes - oldBits * 2,
      ],
    ] as const;
    for (const [from, to, size] of regions)
      if (size > 0) encoder.copyBufferToBuffer(before.counters, from, next.counters, to, size);
    const commands = encoder.finish().unwrap();
    this.assertAddressPreparation(role);
    this.device.queue.submit([commands]).unwrap();
  }

  private writeAddressOffsets(role: ViewAddressPreparation): void {
    const buffer = role.facts.buffers.view;
    const skinBase = role.batchCapacity * COUNTER_WORDS + role.words * 2;
    const orderBase = skinBase + (role.skinLayout?.counterWords ?? 0);
    const write = (offset: number, values: readonly number[]) => {
      this.device.queue.writeBuffer(buffer, offset, new Uint32Array(values)).unwrap();
      this.assertAddressPreparation(role);
    };
    write(31 * 4, [orderBase]);
    if (role.skinLayout !== undefined) write(SKIN_CONSTANTS_OFFSET + 16, [skinBase]);
    const bits = role.batchCapacity * COUNTER_WORDS;
    write(OCCLUSION_STATE_OFFSET + 8, [
      bits + (1 - this.visibilityParity) * role.words,
      bits + this.visibilityParity * role.words,
      role.words,
    ]);
    this.viewWords[31] = orderBase;
    if (role.skinLayout !== undefined) this.viewWords[SKIN_CONSTANTS_OFFSET / 4 + 4] = skinBase;
  }

  private publishAddressStorage(role: ViewAddressPreparation): void {
    this.assertAddressPreparation(role);
    const next = role.next,
      groups = role.groups;
    if (next === undefined || groups === undefined)
      throw this.inputReadError('complete private address storage and bindings');
    this.updating = true;
    let uniformStarted = false;
    try {
      this.copyAddressStorage(role);
      this.assertAddressPreparation(role);
      role.mirror.set(this.suppressionMirror);
      uniformStarted = true;
      this.writeAddressOffsets(role);
      this.assertAddressPreparation(role);
      const old = { batches: role.facts.buffers.batches, counters: role.facts.buffers.counters };
      this.buffers = next;
      this.bindGroup = groups.cull;
      this.skinBindGroup = groups.skin;
      this.skinFinalizeBindGroup = groups.finalize;
      this.suppressionWordCapacity = role.words;
      this.suppressionMirror = role.mirror;
      this.suppressionSource = null;
      this.telemetryPending = undefined;
      this.telemetrySubmit = undefined;
      this.lodSelection = undefined;
      role.published = true;
      this.retireGeneration(old);
      this.destroyAfterSubmittedWork([old]);
    } catch (cause) {
      if (uniformStarted) role.scene.failBindingPublication(cause);
      throw cause;
    } finally {
      this.updating = false;
    }
  }

  private releaseAddressStorage(role: ViewAddressPreparation): void {
    role.closed = true;
    if (this.addressPreparation === role) this.addressPreparation = undefined;
    role.groups = undefined;
    role.next = undefined;
    if (role.published) return;
    const created = { ...role.created };
    delete role.created.batches;
    delete role.created.counters;
    this.retireGeneration(created);
    this.destroyAfterSubmittedWork([created]);
  }

  /** Privately create both cull and cached Skin bindings for this Inputs issuer. */
  ownsInputScene(scene: GpuScene): boolean {
    return this.sceneRef === scene;
  }

  prepareInputBindings(
    scene: GpuScene,
    preparation: GpuSceneInputPreparation,
    tables?: GpuSceneTableBindingTarget,
  ): Result<GpuViewInputPreparation, RhiError> {
    const target = scene.inputs.preparationTarget(preparation);
    if (
      this.updating ||
      this.preparingInputBindings !== undefined ||
      this.sceneRef !== scene ||
      this.buffers === undefined ||
      (this.bindGroup === undefined && this.sceneInputs !== undefined) ||
      target === undefined
    )
      return err(this.inputReadError('one initialized View and an actual private Inputs target'));
    if (tables !== undefined && !scene.capacityTargetMatches(tables))
      return err(this.inputReadError('actual Scene-issued table target'));
    const facts = this.inputBindingFacts(scene, this.buffers, tables);
    const role: PreparingInputBindings = {
      target: target.buffer,
      bytes: target.byteLength,
      facts,
      groups: undefined,
    };
    this.preparingInputBindings = role;
    this.updating = true;
    let accepted = false;
    try {
      const groups = createInputBindingGroups(
        this.device,
        this.bindGroupLayout,
        this.labelPrefix,
        facts,
        role.target,
        () =>
          this.preparingInputBindings === role &&
          this.inputBindingFactsMatch(facts) &&
          scene.inputs.preparationTarget(preparation) === target,
      );
      if (!groups.ok) return groups;
      role.groups = groups.value;
      if (
        !this.preparedInputBindingsMatch(role) ||
        scene.inputs.preparationTarget(preparation) !== target
      )
        return err(
          this.inputReadError('unchanged View and original private target after creation'),
        );
      accepted = true;
      return ok(
        Object.freeze({
          isCurrent: () =>
            !this.updating &&
            this.preparedInputBindingsMatch(role) &&
            (scene.inputs.preparationIsCurrent(preparation) ||
              scene.inputs.isCurrentBuffer(role.target)),
          publish: () => this.publishInputBindings(role),
          release: () => this.releaseInputBindings(role),
        }),
      );
    } finally {
      this.updating = false;
      if (!accepted) this.releaseInputBindings(role);
    }
  }

  private preparedInputBindingsMatch(role: PreparingInputBindings): boolean {
    return (
      this.preparingInputBindings === role &&
      role.facts !== undefined &&
      role.groups !== undefined &&
      this.inputBindingFactsMatch(role.facts)
    );
  }

  private publishInputBindings(role: PreparingInputBindings): Result<void, RhiError> {
    if (
      this.updating ||
      !this.preparedInputBindingsMatch(role) ||
      role.facts === undefined ||
      role.groups === undefined ||
      !role.facts.scene.inputs.isCurrentBuffer(role.target)
    )
      return err(this.inputReadError('original View facts and its accepted actual Inputs target'));
    const initial = role.facts.cull === undefined;
    this.bindGroup = role.groups.cull;
    this.skinBindGroup = role.groups.skin;
    this.skinFinalizeBindGroup = role.groups.finalize;
    if (initial) {
      this.resourceGeneration += 1;
      this.adoptGraphBindingShape();
    }
    this.sceneInputs = role.target;
    this.sceneInputBytes = role.bytes;
    if (role.facts.target !== undefined) {
      this.adoptScene(role.facts.scene);
      this.inputReads = undefined;
    }
    this.releaseInputBindings(role);
    return ok(undefined);
  }

  private releaseInputBindings(role: PreparingInputBindings): void {
    role.facts = undefined;
    role.groups = undefined;
    if (this.preparingInputBindings === role) this.preparingInputBindings = undefined;
  }

  /** Retain the scene buffers this view's bind groups and receipts now address. */
  private adoptScene(scene: GpuScene): void {
    this.sceneTableIdentity = scene.tableBindingIdentity;
    this.scenePrimitive = scene.primitiveBuffer;
    this.sceneInstance = scene.instanceBuffer;
    this.sceneTransform = scene.transformBuffer;
    if (this.sceneMaterial !== scene.materialBuffer) this.materialResourceGeneration += 1;
    this.sceneMaterial = scene.materialBuffer;
    this.sceneMaterialBytes = scene.materialByteLength;
    this.sceneRef = scene;
    this.sceneCapacity = scene.rowCapacity;
    this.sceneTransformBytes = scene.transformByteLength;
  }

  get computeResourceGeneration(): number {
    return this.resourceGeneration;
  }

  /** Graph-shape generation: advances only when this view's passes or imports change. */
  get graphResourceGeneration(): number {
    return this.graphGeneration;
  }

  get currentResourceGeneration(): number {
    return this.resourceGeneration + this.materialResourceGeneration;
  }

  resolveShadowBundle(
    cache: PreparedRasterBundleCache,
    observed: PreparedRasterBindings,
    current?: () => boolean,
  ): RenderBundle {
    this.shadowRaster ??= { hits: 0, builds: 0, commands: 0, evictions: 0 };
    return cache.resolveOne(SHADOW_RASTER_PASS, this.device, observed, this.shadowRaster, current);
  }

  shadowBundleCurrent(cache: PreparedRasterBundleCache): (() => boolean) | undefined {
    return cache.captureCurrent(SHADOW_RASTER_PASS);
  }

  recordShadow(pass: RhiRenderPassEncoder, bundles: readonly RenderBundle[]): void {
    if (bundles.length === 0) return;
    const executed = pass.executeBundles(bundles);
    if (!executed.ok) throw executed.error;
  }

  inspect(): GpuDrivenViewInspection {
    return {
      ...(this.shadowRaster === undefined ? {} : { shadowBundles: { ...this.shadowRaster } }),
      topologyRevision: this.plan?.revision,
      candidateCount: this.plan?.candidateCount ?? 0,
      batchCount: this.plan?.batches.length ?? 0,
      visibleCapacity: this.plan?.visibleCapacity ?? 0,
      candidateCapacity: this.candidateCapacity,
      visibleBufferCapacity: this.visibleBufferCapacity,
      batchCapacity: this.batchCapacity,
      indirectCapacity: this.indirectCapacity,
      updateCount: this.updateCount,
      uploadBytes: this.uploadBytes,
      sharedInputUploadBytes: this.sharedInputUploadBytes,
      batchUploadBytes: this.batchUploadBytes,
      viewConstantsUploadBytes: this.viewConstantsUploadBytes,
      suppressionUploadBytes: this.suppressionUploadBytes,
      bindGroupCreates: this.bindGroupCreates,
      bufferRebuilds: this.bufferRebuilds,
      resourceGeneration: this.currentResourceGeneration,
      resourceAllocation: this.allocationLedger.inspect(),
    };
  }

  /** Shared GPU Scene inputs this view last read; vertex stages share it. */
  get sceneInputBuffer(): Buffer | undefined {
    return this.sceneInputs;
  }

  currentInputBindings(scene: GpuScene, input: Buffer): boolean {
    return (
      !this.updating &&
      this.sceneRef === scene &&
      this.buffers !== undefined &&
      this.bindGroup !== undefined &&
      this.sceneInputs === input &&
      this.sceneTableIdentity === scene.tableBindingIdentity &&
      this.scenePrimitive === scene.primitiveBuffer &&
      this.sceneInstance === scene.instanceBuffer &&
      this.sceneTransform === scene.transformBuffer &&
      this.sceneMaterial === scene.materialBuffer &&
      scene.inputs.isCurrentBuffer(input)
    );
  }

  get visibleSurfaceRowsBuffer(): Buffer | undefined {
    return this.buffers?.visibleSurfaceRows;
  }

  get visibleBuffer(): Buffer | undefined {
    return this.buffers?.visible;
  }

  get indirectBuffer(): Buffer | undefined {
    return this.buffers?.indirect;
  }

  get overflowBuffer(): Buffer | undefined {
    return this.buffers?.counters;
  }

  get overflowByteOffset(): number {
    return 4;
  }

  /** Read selected levels written by the GPU cull pass for the last submit. */
  readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> {
    if (this.readback === 'culling-counts') return Promise.resolve(undefined);
    const inFlight = this.lodSelectionReadback;
    if (inFlight !== undefined) return inFlight.promise;

    const copy = this.readableTelemetryCopy();
    if (copy === undefined) return Promise.resolve(this.lodSelection);
    const promise = this.readLodSelectionCopy(copy).finally(() => {
      if (this.lodSelectionReadback?.promise === promise) this.lodSelectionReadback = undefined;
    });
    this.lodSelectionReadback = { promise };
    return promise;
  }

  /** Explicit one-shot diagnostic. Caller keeps the issued frame current until this read completes. */
  async readGeometryCommands(
    commands: readonly GeometryCommandCapture[],
    receipt: { frameId: number; deviceGeneration: number },
  ) {
    const buffers = this.buffers,
      plan = this.plan,
      submit = this.telemetrySubmit,
      generation = this.resourceGeneration;
    const current = () =>
      this.buffers === buffers &&
      this.plan === plan &&
      this.resourceGeneration === generation &&
      this.telemetrySubmit === submit;
    if (
      buffers === undefined ||
      plan === undefined ||
      submit?.frameId !== receipt.frameId ||
      submit.deviceGeneration !== receipt.deviceGeneration
    )
      throw Error('receipt-unavailable');
    if (
      commands.some(
        (c) => c.bufferIdentity !== getOpaqueResourceIdentity(buffers.indirect as object),
      )
    )
      throw Error('indirect-buffer-mismatch');
    const indirectBytes = this.indirectCapacity * INDIRECT_COMMAND_BYTES * 2;
    const visibleBytes = this.visiblePrefixBytes(this.visibleBufferCapacity, this.lateMirror);
    const counterBytes = this.batchCapacity * COUNTER_STRIDE;
    const viewOffset = indirectBytes + visibleBytes + counterBytes;
    const size = viewOffset + VIEW_BYTES;
    if (size > GEOMETRY_OBSERVATION_MAX_BYTES) throw Error('readback-budget');
    const created = this.device.createBuffer({
      label: 'geometry-observation-once',
      size,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) throw created.error;
    let releaseMap: (() => void) | undefined;
    let decoded:
      | {
          commands: ReturnType<typeof decodeGeometryCommands>;
          viewConstants: ReturnType<typeof decodeGeometryView>;
        }
      | undefined;
    let failure: unknown;
    try {
      const encoded = this.device.createCommandEncoder({ label: 'geometry-observation-once' });
      if (!encoded.ok) throw encoded.error;
      encoded.value.copyBufferToBuffer(buffers.indirect, 0, created.value, 0, indirectBytes);
      encoded.value.copyBufferToBuffer(
        buffers.visible,
        0,
        created.value,
        indirectBytes,
        visibleBytes,
      );
      encoded.value.copyBufferToBuffer(
        buffers.counters,
        0,
        created.value,
        indirectBytes + visibleBytes,
        counterBytes,
      );
      encoded.value.copyBufferToBuffer(buffers.view, 0, created.value, viewOffset, VIEW_BYTES);
      const finished = encoded.value.finish();
      if (!finished.ok) throw finished.error;
      const sent = this.device.queue.submit([finished.value]);
      if (!sent.ok) throw sent.error;
      const result = await created.value.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
      if (!result.ok) throw result.error;
      releaseMap = () => result.value.unmap();
      const range = result.value.getMappedRange();
      if (!range.ok) throw range.error;
      if (!current()) throw Error('superseded');
      const values = new DataView(range.value);
      const earlyCountOffsets = new Map<string, number>();
      let batchIndex = 0;
      for (const batch of plan.batches) {
        const i = batchIndex++;
        if (values.getUint32(indirectBytes + visibleBytes + i * COUNTER_STRIDE + 4, true) !== 0)
          throw Error('selector-overflow');
        for (let level = 0; level < batchLodLevelCount(batch); level++)
          earlyCountOffsets.set(
            `${batch.batchId}:${level}`,
            i * COUNTER_STRIDE + (EARLY_VISIBLE_COUNTER_OFFSET + level) * 4,
          );
      }
      const decodedCommands = decodeGeometryCommands({
        bytes: values,
        commands,
        indirectBytes,
        visibleBytes,
        countersOffset: indirectBytes + visibleBytes,
        earlyCountOffsets,
        firstInstanceIndirect: this.device.caps.firstInstanceIndirect,
      });
      decoded = {
        commands: decodedCommands,
        viewConstants: decodeGeometryView(
          new DataView(range.value, viewOffset, VIEW_BYTES),
          OCCLUSION_CONSTANTS_OFFSET,
          OCCLUSION_STATE_OFFSET,
        ),
      };
    } catch (error) {
      failure = error;
    } finally {
      // Always attempt both cleanup operations, preserving the original observation failure.
      try {
        releaseMap?.();
      } catch (error) {
        failure ??= error;
      }
      try {
        const destroyed = this.device.destroyBuffer(created.value);
        if (!destroyed.ok) failure ??= destroyed.error;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    if (decoded === undefined) throw Error('readback-unavailable');
    return decoded;
  }

  /** Shadows consume batch cull counters, not visible-member or Surface observations. */
  readCullingCounts(): Promise<
    | (Pick<GpuDrivenLodSelectionInspection, 'texelCulled' | 'cameraCulled'> & {
        readonly observation?: GpuDrivenCullingObservation;
      })
    | undefined
  > {
    const copy = this.readableTelemetryCopy();
    if (copy === undefined) return Promise.resolve(undefined);
    // Counters lead the readback; mapping the visible-member and indirect
    // tail would cost bytes proportional to the candidate capacity per view.
    const counterBytes = Math.max(4, copy.plan.batches.length * COUNTER_STRIDE);
    return this.readTelemetryCopy(copy, counterBytes, (values) =>
      decodeCullingCounts(copy, values),
    );
  }

  private readableTelemetryCopy(): LodTelemetryCopy | undefined {
    const buffers = this.buffers;
    const copy = this.telemetryPending;
    return buffers !== undefined &&
      copy !== undefined &&
      copy.buffers === buffers &&
      copy.plan === this.plan &&
      copy.resourceGeneration === this.resourceGeneration &&
      typeof buffers.lodReadback.mapAsync === 'function' &&
      buffers.lodReadback.mapState === 'unmapped'
      ? copy
      : undefined;
  }

  /** `bytes` maps only the readback prefix the decoder reads; undefined maps all of it. */
  private async readTelemetryCopy<T>(
    copy: LodTelemetryCopy,
    bytes: number | undefined,
    decode: (values: DataView<ArrayBuffer>) => T,
  ): Promise<T | undefined> {
    const buffers = copy.buffers;
    const mapped =
      bytes === undefined
        ? await buffers.lodReadback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
        : await buffers.lodReadback.mapAsync(GPU_BUFFER_USAGE_MAP_READ, 0, bytes);
    if (!mapped.ok) return undefined;
    const range =
      bytes === undefined ? mapped.value.getMappedRange() : mapped.value.getMappedRange(0, bytes);
    if (!range.ok) {
      mapped.value.unmap();
      return undefined;
    }
    try {
      // Decode only the submitted copy. A later plan may share these buffers;
      // replacement resources cannot supply this range's counter capacities.
      if (
        this.buffers !== buffers ||
        this.resourceGeneration !== copy.resourceGeneration ||
        this.telemetryPending !== copy
      ) {
        return undefined;
      }
      const result = decode(new DataView(range.value));
      this.telemetryPending = undefined;
      return result;
    } finally {
      mapped.value.unmap();
    }
  }

  private readLodSelectionCopy(
    copy: LodTelemetryCopy,
  ): Promise<GpuDrivenLodSelectionInspection | undefined> {
    return this.readTelemetryCopy(copy, undefined, (values) => {
      const selection = decodeLodSelection(copy, values, this.batchCapacity, this.indirectCapacity);
      this.lodSelection = selection;
      return selection;
    });
  }

  private preparedSkinTask(): Result<
    {
      pipelines: readonly ComputePipeline[];
      taskBinding: BindGroup;
      finalizeBinding: BindGroup;
    },
    RenderGraphError
  > {
    const pipelines = this.skinPipelines;
    const taskBinding = this.skinBindGroup;
    const finalizeBinding = this.skinFinalizeBindGroup;
    if (pipelines === undefined || taskBinding === undefined || finalizeBinding === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'prepared Skin task pipelines and physical buffer bindings',
          hint: 'update the view with its fixed Skin frame before building task passes',
        }),
      );
    }
    return ok({ pipelines, taskBinding, finalizeBinding });
  }

  private importVisibleSurfaceRows<FrameCtx extends RenderGraphFrame>(
    builder: RenderGraphBuilder<FrameCtx>,
    labelPrefix: string,
    buffers: ViewBuffers,
  ): Result<GraphBuffer | undefined, RenderGraphError> {
    let visibleSurfaceRows: GraphBuffer | undefined;
    if (buffers.visibleSurfaceRows !== undefined) {
      const imported = builder.importBuffer(
        `${labelPrefix}.visible-surface-rows`,
        {
          size: this.visibleBufferCapacity * 4,
          usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
        },
        () => this.buffers?.visibleSurfaceRows ?? (buffers.visibleSurfaceRows as Buffer),
      );
      if (!imported.ok) return imported;
      visibleSurfaceRows = imported.value;
    }
    return ok(visibleSurfaceRows);
  }

  /** Physical kernels shared by camera and light views. View.update owns all buffer generations. */
  get hasSkinDemand(): boolean {
    return this.skinActive && this.skinLayout !== undefined;
  }

  get cameraLateIndirectOffset(): number {
    return this.indirectCapacity * INDIRECT_COMMAND_BYTES;
  }

  get cameraLateVisibleBase(): number {
    return this.lateVisibleBase();
  }

  recordSkinDemand(pass: RhiComputePassEncoder): void {
    const buffers = this.buffers;
    if (buffers?.skinIndirect === undefined || this.sceneInputs === undefined)
      throw viewCreationInvalid();
    const task = this.preparedSkinTask().unwrap();
    this.inputBufferForExecution(this.sceneInputs, true);
    for (let stage = 0; stage < 4; stage++)
      this.dispatchSkinStage(
        pass,
        stage,
        task.pipelines,
        stage === 3 ? task.finalizeBinding : task.taskBinding,
        buffers.skinIndirect,
        this.plan?.candidateCount ?? 0,
      );
  }

  recordViewSelection(
    pass: RhiComputePassEncoder,
    late: boolean,
    receiverDepth?: TextureView,
  ): void {
    const group = this.bindGroup;
    const plan = this.plan;
    if (plan === undefined || group === undefined || this.sceneInputs === undefined)
      throw viewCreationInvalid();
    this.inputBufferForExecution(this.sceneInputs, true);
    if (this.hasSkinDemand) {
      const args = this.buffers?.skinIndirect;
      if (args === undefined) throw viewCreationInvalid();
      const task = this.preparedSkinTask().unwrap();
      this.dispatchSkinStage(pass, 4, task.pipelines, task.taskBinding, args, plan.candidateCount);
    }
    this.cameraCullBound = receiverDepth !== undefined && this.shadowCameraCullEligible;
    const receiver = this.cameraCullBound ? this.shadowCameraCullPipeline : undefined;
    if (late) this.writeOcclusionState();
    this.dispatchSelection(pass, this.resetPipeline, group, plan.batches.length);
    this.compactSelection(
      pass,
      receiver ?? this.cullPipeline,
      group,
      receiver !== undefined && receiverDepth !== undefined
        ? this.pyramidBindGroup(receiverDepth)
        : undefined,
      plan.candidateCount,
      false,
    );
    this.dispatchSelection(pass, this.finalizePipeline, group, plan.batches.length);
  }

  recordCameraLateCull(pass: RhiComputePassEncoder, pyramid: TextureView): void {
    const group = this.bindGroup;
    const plan = this.plan;
    if (plan === undefined || group === undefined || this.sceneInputs === undefined)
      throw viewCreationInvalid();
    this.inputBufferForExecution(this.sceneInputs, true);
    this.compactSelection(
      pass,
      this.lateCullPipeline,
      group,
      this.pyramidBindGroup(pyramid),
      plan.candidateCount,
      true,
    );
    this.finishLateSelection();
  }

  recordCameraLateFinalize(pass: RhiComputePassEncoder): void {
    const group = this.bindGroup;
    const plan = this.plan;
    if (plan === undefined || group === undefined || this.sceneInputs === undefined)
      throw viewCreationInvalid();
    this.inputBufferForExecution(this.sceneInputs, true);
    this.dispatchSelection(pass, this.lateFinalizePipeline, group, plan.batches.length);
  }

  recordSelectionReadback(
    encoder: RhiCommandEncoder,
    late: boolean,
    surfaceObservation?: () => SurfaceSubmissionCandidate | undefined,
  ): void {
    const buffers = this.buffers;
    if (buffers === undefined) throw viewCreationInvalid();
    if (!this.cullingReadbackSkipped() && this.readbackAvailable(buffers))
      this.writeSelectionReadback(encoder, buffers, late, surfaceObservation);
  }

  private dispatchSkinStage(
    pass: RhiComputePassEncoder,
    stage: number,
    pipelines: readonly ComputePipeline[],
    group: BindGroup,
    args: Buffer,
    candidates: number,
  ): void {
    pass.setPipeline(pipelines[stage] as ComputePipeline);
    pass.setBindGroup(0, group);
    if (stage === 4) pass.dispatchWorkgroupsIndirect(args, 0);
    else if (stage === 1 || stage === 3) pass.dispatchWorkgroups(1);
    else {
      const count = stage === 0 ? (this.skinLayout?.rosterCapacity ?? 0) : candidates;
      const groups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));
      const limit = Number(this.device.limits.maxComputeWorkgroupsPerDimension) || 65535;
      pass.dispatchWorkgroups(Math.min(groups, limit), Math.ceil(groups / limit));
    }
  }

  private dispatchSelection(
    pass: RhiComputePassEncoder,
    pipeline: ComputePipeline,
    group: BindGroup,
    count: number,
  ): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(Math.max(1, count) / WORKGROUP_SIZE));
  }

  private compactSelection(
    pass: RhiComputePassEncoder,
    pipeline: ComputePipeline,
    group: BindGroup,
    pyramid: BindGroup | undefined,
    candidateCount: number,
    late: boolean,
  ): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (pyramid !== undefined) pass.setBindGroup(1, pyramid);
    const groups = Math.ceil(Math.max(1, candidateCount) / WORKGROUP_SIZE);
    pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.orderScanPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(late ? this.lateOrderPlacePipeline : this.orderPlacePipeline);
    pass.dispatchWorkgroups(groups);
  }

  private finishLateSelection(): void {
    this.visibilityParity ^= 1;
    this.visibilityHistoryKey = this.occlusionCamera?.historyKey;
    this.visibilityHistoryReady = true;
  }

  private readbackAvailable(buffers: ViewBuffers): boolean {
    const mapped = buffers.lodReadback.mapState;
    return mapped === undefined || mapped === 'unmapped';
  }

  private writeSelectionReadback(
    encoder: RhiCommandEncoder,
    buffers: ViewBuffers,
    occlusion: boolean,
    surfaceSubmissionObservation?: () => SurfaceSubmissionCandidate | undefined,
    counters = buffers.counters,
    destination = buffers.lodReadback,
    visible = buffers.visible,
    indirect = buffers.indirect,
  ): void {
    const indirectReadbackOffset =
      this.batchCapacity * COUNTER_STRIDE + this.visibleBufferCapacity * 16;
    encoder.copyBufferToBuffer(counters, destination, this.batchCapacity * COUNTER_STRIDE);
    if (this.readback === 'complete') {
      encoder.copyBufferToBuffer(
        visible,
        0,
        destination,
        this.batchCapacity * COUNTER_STRIDE,
        this.visibleBufferCapacity * 16,
      );
      encoder.copyBufferToBuffer(
        indirect,
        0,
        destination,
        indirectReadbackOffset,
        this.indirectCapacity * INDIRECT_COMMAND_BYTES,
      );
    }
    const submittedPlan = this.plan;
    if (this.buffers === buffers && submittedPlan !== undefined) {
      const submittedObservation = surfaceSubmissionObservation?.();
      this.telemetryPending = {
        buffers,
        plan: submittedPlan,
        resourceGeneration: this.resourceGeneration,
        indirectBufferIdentity: getOpaqueResourceIdentity(buffers.indirect as object),
        indirectReadbackOffset,
        ...(submittedObservation === undefined
          ? {}
          : {
              surfaceReadbackSnapshot: () => submittedObservation.gpuReadbackSnapshot(),
            }),
        ...(this.telemetrySubmit === undefined ? {} : { submit: this.telemetrySubmit }),
        occlusion,
      };
    }
  }

  addPasses<FrameCtx extends RenderGraphFrame>(
    builder: RenderGraphBuilder<FrameCtx>,
    labelPrefix = 'gpu-driven',
    includeCompute = true,
    surfaceSubmissionObservation?: () => SurfaceSubmissionCandidate | undefined,
    executeIf?: (frame: FrameCtx) => boolean,
    lateOcclusion = false,
    shadowCameraPyramid?: GraphTextureView,
    resolveDrawResources?: () => void,
    computePassMode: 'separate' | 'combined' = 'separate',
    selectionBatch?: GpuDrivenSelectionBatch<FrameCtx>,
  ): Result<GpuDrivenViewGraphResources, RenderGraphError> {
    const buffers = this.buffers;
    const bindGroup = this.bindGroup;
    const plan = this.plan;
    if (buffers === undefined || bindGroup === undefined || plan === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'GpuDrivenView.update(...) precedes addPasses(...)',
          hint: 'publish the current SubmissionPlan and view planes first',
          detail: {
            resourceLabel: 'gpu-driven-view',
            field: 'state',
            expected: 'updated',
            actual: 'not-updated',
          },
        }),
      );
    }
    const importBuffer = (
      name: string,
      buffer: Buffer | (() => Buffer),
      size: number,
      usage: number,
      resolveBefore?: () => void,
    ) =>
      builder.importBuffer(name, { size, usage }, () => {
        resolveBefore?.();
        return typeof buffer === 'function' ? buffer() : buffer;
      });
    // Scene and input buffers may be replaced without a new graph; resolve
    // the current ones when the graph executes.
    const live = (current: () => Buffer | undefined, fallback: Buffer) => () =>
      current() ?? fallback;
    const capturedInputs = this.sceneInputs as Buffer;
    const liveBindGroup = () => {
      this.inputBufferForExecution(
        this.bindGroup === undefined ? capturedInputs : (this.sceneInputs ?? capturedInputs),
        true,
      );
      return this.bindGroup ?? bindGroup;
    };
    // View buffers grow without a new graph as well: every import, dispatch
    // and readback resolves the current generation when the graph executes.
    const currentBuffers = () => this.buffers ?? buffers;
    const scenePrefix = labelPrefix === 'gpu-driven' ? 'gpu-scene' : `${labelPrefix}.scene`;
    const primitive = importBuffer(
      `${scenePrefix}.primitive`,
      live(() => this.scenePrimitive, this.scenePrimitive as Buffer),
      this.sceneCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
      resolveDrawResources,
    );
    if (!primitive.ok) return primitive;
    const transform = importBuffer(
      `${scenePrefix}.transform`,
      live(() => this.sceneTransform, this.sceneTransform as Buffer),
      this.sceneTransformBytes,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!transform.ok) return transform;
    const instance = importBuffer(
      `${scenePrefix}.instance`,
      live(() => this.sceneInstance, this.sceneInstance as Buffer),
      this.sceneCapacity * GPU_SCENE_LAYOUTS.instance.stride,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!instance.ok) return instance;
    const material = importBuffer(
      `${scenePrefix}.material`,
      live(() => this.sceneMaterial, this.sceneMaterial as Buffer),
      this.sceneMaterialBytes,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!material.ok) return material;
    const candidates = importBuffer(
      `${labelPrefix}.candidates`,
      () => this.inputBufferForExecution(this.sceneInputs ?? capturedInputs, false),
      this.sceneInputBytes,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!candidates.ok) return candidates;
    const importedSurfaceRows = this.importVisibleSurfaceRows(builder, labelPrefix, buffers);
    if (!importedSurfaceRows.ok) return importedSurfaceRows;
    const visibleSurfaceRows = importedSurfaceRows.value;
    const batches = importBuffer(
      `${labelPrefix}.batches`,
      () => currentBuffers().batches,
      this.suppressionBase() + this.suppressionWordCapacity * 4,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!batches.ok) return batches;
    const view = importBuffer(
      `${labelPrefix}.view`,
      () => currentBuffers().view,
      VIEW_BYTES,
      GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!view.ok) return view;
    const counters = importBuffer(
      `${labelPrefix}.counters`,
      () => currentBuffers().counters,
      this.countersBytes(),
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!counters.ok) return counters;
    const lodReadback = importBuffer(
      `${labelPrefix}.lod-selection-readback`,
      () => currentBuffers().lodReadback,
      this.readbackBytes(this.batchCapacity, this.visibleBufferCapacity, this.indirectCapacity),
      GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (!lodReadback.ok) return lodReadback;
    const visible = importBuffer(
      `${labelPrefix}.visible`,
      () => currentBuffers().visible,
      this.visibleBytes(),
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!visible.ok) return visible;
    const indirect = importBuffer(
      `${labelPrefix}.indirect`,
      () => currentBuffers().indirect,
      this.indirectBytes(),
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_SRC,
    );
    if (!indirect.ok) return indirect;
    if (!includeCompute) {
      return ok({
        visible: visible.value,
        primitive: primitive.value,
        instance: instance.value,
        transform: transform.value,
        material: material.value,
        indirect: indirect.value,
        overflow: counters.value,
      });
    }
    // A compiled graph outlives plan revisions that keep the same buffer
    // capacities (spawn churn, LOD regrouping). Dispatch sizes therefore
    // follow the plan uploaded for the submitted frame; the shaders bound
    // every invocation by the counts in the view constants.
    const submitted = (): Pick<SubmissionPlan, 'batches' | 'candidateCount'> => this.plan ?? plan;
    let resolveSkin: ComputeGraphPass<FrameCtx>['encodeDirect'];
    let skinArgs: GraphBuffer | undefined;
    if (this.skinLayout !== undefined) {
      const argumentBuffer = buffers.skinIndirect;
      if (argumentBuffer === undefined)
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'dedicated Skin dispatch arguments',
            hint: 'update this view from its current Skin layout',
          }),
        );
      const importedArgs = importBuffer(
        `${labelPrefix}.skin-indirect`,
        live(() => this.buffers?.skinIndirect, argumentBuffer),
        12,
        GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_SRC,
      );
      if (!importedArgs.ok) return importedArgs;
      skinArgs = importedArgs.value;
      const task = this.preparedSkinTask();
      if (!task.ok) return task;
      const { pipelines, taskBinding, finalizeBinding } = task.value;
      const taskEnabled = (frame: FrameCtx) => this.skinActive && (executeIf?.(frame) ?? true);
      const encodeSkinStage = (
        pass: Parameters<NonNullable<ComputeGraphPass<FrameCtx>['encodeDirect']>>[0],
        stage: number,
      ): void => {
        const liveTaskGroup = stage === 3 ? this.skinFinalizeBindGroup : this.skinBindGroup;
        const taskGroup = liveTaskGroup ?? (stage === 3 ? finalizeBinding : taskBinding);
        this.inputBufferForExecution(
          liveTaskGroup === undefined ? capturedInputs : (this.sceneInputs ?? capturedInputs),
          true,
        );
        this.dispatchSkinStage(
          pass,
          stage,
          pipelines,
          taskGroup,
          currentBuffers().skinIndirect ?? argumentBuffer,
          submitted().candidateCount,
        );
      };
      const skinPass = (
        name: string,
        first: number,
        end: number,
        indirectUsage: 'storage-read-write' | 'indirect-read' | undefined,
      ) =>
        builder.addComputePass(
          `${labelPrefix}.skin-${name}`,
          {
            accesses: [
              { resource: primitive.value, usage: 'storage-read' },
              { resource: instance.value, usage: 'storage-read' },
              { resource: transform.value, usage: 'storage-read' },
              { resource: candidates.value, usage: 'storage-read' },
              { resource: batches.value, usage: 'storage-read' },
              { resource: view.value, usage: 'uniform-read' },
              { resource: counters.value, usage: 'storage-read-write' },
              { resource: visible.value, usage: 'storage-read-write' },
              ...(indirectUsage === undefined
                ? []
                : [{ resource: importedArgs.value, usage: indirectUsage }]),
            ],
            executeIf: taskEnabled,
            encodeDirect: (pass, _graphframe, _graphresources) => {
              for (let stage = first; stage < end; stage++) encodeSkinStage(pass, stage);
            },
          },
          'transfer',
        );
      const declareSkin = (): Result<void, RenderGraphError> => {
        if (computePassMode === 'combined') {
          // Dedicated Skin arguments stay read-only while selection writes its
          // separate draw arguments, so resolve can share selection's scope.
          resolveSkin = (pass, frame) => {
            if (taskEnabled(frame)) encodeSkinStage(pass, 4);
          };
          const demand = skinPass('demand', 0, 4, 'storage-read-write');
          return demand.ok ? ok(undefined) : demand;
        }
        const stages = ['clear', 'reset', 'claim', 'finalize', 'resolve'] as const;
        for (let stage = 0; stage < stages.length; stage++) {
          const result = skinPass(
            stages[stage] as string,
            stage,
            stage + 1,
            stage === 3 ? 'storage-read-write' : stage === 4 ? 'indirect-read' : undefined,
          );
          if (!result.ok) return result;
        }
        return ok(undefined);
      };
      const declaredSkin = declareSkin();
      if (!declaredSkin.ok) return declaredSkin;
    }
    // Each dispatch has its own WebGPU usage scope. Skin work remains before
    // reset so its overflow state is propagated into this selection.
    let lateRecorded = false;
    const cameraCull = this.shadowCameraCullEligible ? shadowCameraPyramid : undefined;
    this.cameraCullBound = cameraCull !== undefined;
    const resetSelection: NonNullable<ComputeGraphPass<FrameCtx>['encodeDirect']> = (pass) =>
      this.dispatchSelection(pass, this.resetPipeline, liveBindGroup(), submitted().batches.length);
    const compactSelection: NonNullable<ComputeGraphPass<FrameCtx>['encodeDirect']> = (
      pass,
      _frame,
      graphResources,
    ) => {
      if (lateRecorded) this.writeOcclusionState();
      const cameraPipeline = cameraCull === undefined ? undefined : this.shadowCameraCullPipeline;
      const group = liveBindGroup();
      const pyramid =
        cameraCull !== undefined && cameraPipeline !== undefined
          ? this.pyramidBindGroup(graphResources.textureView(cameraCull).unwrap())
          : undefined;
      this.compactSelection(
        pass,
        cameraPipeline ?? this.cullPipeline,
        group,
        pyramid,
        submitted().candidateCount,
        false,
      );
    };
    const finalizeSelection: NonNullable<ComputeGraphPass<FrameCtx>['encodeDirect']> = (pass) =>
      this.dispatchSelection(
        pass,
        this.finalizePipeline,
        liveBindGroup(),
        submitted().batches.length,
      );
    const compactAccesses: ComputeGraphPass<FrameCtx>['accesses'] = [
      { resource: primitive.value, usage: 'storage-read' },
      { resource: instance.value, usage: 'storage-read' },
      { resource: transform.value, usage: 'storage-read' },
      { resource: candidates.value, usage: 'storage-read' },
      { resource: batches.value, usage: 'storage-read' },
      { resource: view.value, usage: 'uniform-read' },
      { resource: counters.value, usage: 'storage-read-write' },
      { resource: visible.value, usage: 'storage-read-write' },
      ...(cameraCull === undefined
        ? []
        : [{ resource: cameraCull, usage: 'sampled-read' as const }]),
    ];
    // A batch encodes this selection in a shared pass; late occlusion keeps
    // its own early pass because its late phase follows the camera pyramid.
    const batched = isSelectionBatched(selectionBatch, lateOcclusion);
    let batchedWork: GpuDrivenSelectionWork<FrameCtx> | undefined;
    // Physical pass declaration is independent from the selection kernels,
    // Skin program and readback/late-occlusion graph lifetime.
    const declareSelection = (): Result<void, RenderGraphError> => {
      if (computePassMode === 'combined') {
        const work: GpuDrivenSelectionWork<FrameCtx> = {
          name: `${labelPrefix}.view-selection`,
          accesses: [
            ...compactAccesses,
            { resource: indirect.value, usage: 'storage-read-write' },
            ...(skinArgs === undefined
              ? []
              : [{ resource: skinArgs, usage: 'indirect-read' as const }]),
          ],
          executeIf,
          encode: (pass, frame, resources) => {
            resolveSkin?.(pass, frame, resources);
            resetSelection(pass, frame, resources);
            compactSelection(pass, frame, resources);
            finalizeSelection(pass, frame, resources);
          },
        };
        if (batched) {
          batchedWork = work;
          return ok(undefined);
        }
        const selection = addSelectionWorkPass(builder, work);
        if (!selection.ok) return selection;
      } else {
        const reset = builder.addComputePass(
          `${labelPrefix}.view-reset`,
          {
            accesses: [
              { resource: view.value, usage: 'uniform-read' },
              { resource: counters.value, usage: 'storage-read-write' },
            ],
            ...(executeIf === undefined ? {} : { executeIf }),
            encodeDirect: resetSelection,
          },
          'transfer',
        );
        if (!reset.ok) return reset;
        const cull = builder.addComputePass(`${labelPrefix}.frustum-compact`, {
          accesses: compactAccesses,
          ...(executeIf === undefined ? {} : { executeIf }),
          encodeDirect: compactSelection,
        });
        if (!cull.ok) return cull;
        const finalize = builder.addComputePass(
          `${labelPrefix}.finalize-indirect`,
          {
            accesses: [
              { resource: batches.value, usage: 'storage-read' },
              { resource: view.value, usage: 'uniform-read' },
              // Read-write: the finalize snapshots the early per-level counts.
              { resource: counters.value, usage: 'storage-read-write' },
              { resource: indirect.value, usage: 'storage-read-write' },
            ],
            ...(executeIf === undefined ? {} : { executeIf }),
            encodeDirect: finalizeSelection,
          },
          'transfer',
        );
        if (!finalize.ok) return finalize;
      }
      return ok(undefined);
    };
    const declaredSelection = declareSelection();
    if (!declaredSelection.ok) return declaredSelection;
    const addReadback = (occlusion: boolean) =>
      builder.addCopyPass(
        `${labelPrefix}.lod-selection-readback`,
        {
          accesses: [
            { resource: counters.value, usage: 'copy-src' },
            ...(this.readback === 'complete'
              ? [
                  { resource: visible.value, usage: 'copy-src' as const },
                  { resource: indirect.value, usage: 'copy-src' as const },
                ]
              : []),
            { resource: lodReadback.value, usage: 'copy-dst' },
          ],
          ...(executeIf === undefined ? {} : { executeIf }),
          encodeDirect: (encoder, _graphframe, resources) => {
            const current = currentBuffers();
            if (this.cullingReadbackSkipped() || !this.readbackAvailable(current)) return;
            this.writeSelectionReadback(
              encoder,
              current,
              occlusion,
              surfaceSubmissionObservation,
              resources.buffer(counters.value).unwrap(),
              resources.buffer(lodReadback.value).unwrap(),
              this.readback === 'complete'
                ? resources.buffer(visible.value).unwrap()
                : current.visible,
              this.readback === 'complete'
                ? resources.buffer(indirect.value).unwrap()
                : current.indirect,
            );
          },
        },
        'transfer',
      );
    const resources = {
      ...(visibleSurfaceRows === undefined ? {} : { visibleSurfaceRows }),
      visible: visible.value,
      primitive: primitive.value,
      instance: instance.value,
      transform: transform.value,
      material: material.value,
      indirect: indirect.value,
      overflow: counters.value,
    };
    if (!lateOcclusion) {
      const readback = addEarlyReadback(selectionBatch, batchedWork, () => addReadback(false));
      if (!readback.ok) return readback;
      return ok(resources);
    }
    const owner = this;
    const addLateOcclusion = (
      pyramid: GraphTextureView,
    ): Result<GpuDrivenLateOcclusionGraph, RenderGraphError> => {
      let preparedPyramid: { readonly view: TextureView; readonly group: BindGroup } | undefined;
      const lateCull = builder.addComputePass(
        `${labelPrefix}.occlusion-cull`,
        {
          accesses: [
            { resource: primitive.value, usage: 'storage-read' },
            { resource: instance.value, usage: 'storage-read' },
            { resource: transform.value, usage: 'storage-read' },
            { resource: candidates.value, usage: 'storage-read' },
            { resource: batches.value, usage: 'storage-read' },
            { resource: view.value, usage: 'uniform-read' },
            { resource: counters.value, usage: 'storage-read-write' },
            { resource: visible.value, usage: 'storage-read-write' },
            { resource: pyramid, usage: 'sampled-read' },
          ],
          ...(executeIf === undefined ? {} : { executeIf }),
          preparedResourcesCurrent: () =>
            owner.buffers !== undefined &&
            preparedPyramid !== undefined &&
            owner.pyramidBindGroups.get(preparedPyramid.view) === preparedPyramid.group,
          *prepareResources(resources, current) {
            const view = resources.createdTextureView(pyramid);
            if (view === undefined || !current()) throw viewCreationInvalid();
            const group = owner.pyramidBindGroup(view, current);
            if (!current()) throw viewCreationInvalid();
            preparedPyramid = { view, group };
            yield;
          },
          encodeDirect: (pass, _graphframe, graphResources) => {
            this.compactSelection(
              pass,
              this.lateCullPipeline,
              liveBindGroup(),
              this.pyramidBindGroup(graphResources.textureView(pyramid).unwrap()),
              submitted().candidateCount,
              true,
            );
            this.finishLateSelection();
          },
        },
        'transfer',
      );
      if (!lateCull.ok) return lateCull;
      const lateFinalize = builder.addComputePass(
        `${labelPrefix}.occlusion-finalize-indirect`,
        {
          accesses: [
            { resource: batches.value, usage: 'storage-read' },
            { resource: view.value, usage: 'uniform-read' },
            { resource: counters.value, usage: 'storage-read-write' },
            { resource: indirect.value, usage: 'storage-read-write' },
          ],
          ...(executeIf === undefined ? {} : { executeIf }),
          encodeDirect: (pass, _graphframe, _graphresources) => {
            this.dispatchSelection(
              pass,
              this.lateFinalizePipeline,
              liveBindGroup(),
              submitted().batches.length,
            );
          },
        },
        'transfer',
      );
      if (!lateFinalize.ok) return lateFinalize;
      const readback = addReadback(true);
      if (!readback.ok) return readback;
      lateRecorded = true;
      return ok({
        passNames: Object.freeze([
          `${labelPrefix}.occlusion-cull`,
          `${labelPrefix}.occlusion-finalize-indirect`,
        ]),
        // Late regions start after the current early capacities.
        get lateIndirectByteOffset() {
          return owner.indirectCapacity * INDIRECT_COMMAND_BYTES;
        },
        get lateVisibleBase() {
          return owner.lateVisibleBase();
        },
      });
    };
    return ok({ ...resources, addLateOcclusion });
  }

  /**
   * Fill the per-frame occlusion words of the view constants. Queue writes
   * land before the command buffer that the current graph encode produces.
   */
  private writeOcclusionState(): void {
    const buffers = this.buffers;
    const camera = this.occlusionCamera;
    if (buffers === undefined) return;
    const state = new Uint32Array(OCCLUSION_STATE_BYTES / 4);
    if (camera !== undefined) {
      const bitsBase = this.batchCapacity * COUNTER_WORDS;
      const words = this.suppressionWordCapacity;
      const next = this.visibilityParity;
      state[0] = 1;
      state[1] =
        this.visibilityHistoryReady && this.visibilityHistoryKey === camera.historyKey ? 1 : 0;
      state[2] = bitsBase + (1 - next) * words;
      state[3] = bitsBase + next * words;
      state[4] = words;
      state[5] = (this.indirectCapacity * INDIRECT_COMMAND_BYTES) / 4;
      state[6] = this.lateVisibleBase();
    }
    // A late phase that never encodes leaves no history for the next frame.
    this.visibilityHistoryReady = false;
    const written = this.device.queue.writeBuffer(
      buffers.view,
      OCCLUSION_STATE_OFFSET,
      new Uint8Array(state.buffer),
    );
    if (!written.ok) throw written.error;
  }

  private pyramidBindGroup(pyramid: TextureView, current?: () => boolean): BindGroup {
    const owned = () => this.buffers !== undefined;
    if (!owned() || (current !== undefined && !current()) || !owned()) throw viewCreationInvalid();
    const cached = this.pyramidBindGroups.get(pyramid);
    if (cached !== undefined) return cached;
    const created = this.device
      .createBindGroup({
        label: `${this.labelPrefix}-occlusion-bg`,
        layout: this.pyramidLayout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: pyramid } }],
      })
      .unwrap();
    if (!owned() || (current !== undefined && !current()) || !owned()) throw viewCreationInvalid();
    this.pyramidBindGroups.set(pyramid, created);
    return created;
  }

  /** Skin scratch follows the original counters and visibility history. */
  private skinCounterBase(): number {
    return (this.batchCapacity * COUNTER_STRIDE) / 4 + this.suppressionWordCapacity * 2;
  }
  /** Visible-order scratch follows the Skin counters. */
  private orderBase(): number {
    return this.skinCounterBase() + (this.skinLayout?.counterWords ?? 0);
  }
  private countersBytes(): number {
    return (
      (this.orderBase() + orderScratchWords(this.batchCapacity, this.orderCandidateCapacity)) * 4
    );
  }
  private visibleBytes(): number {
    return (
      this.skinLayout?.outputBytes ??
      this.visiblePrefixBytes(this.visibleBufferCapacity, this.lateMirror)
    );
  }
  /** Union region plus, when reserved, the late-phase mirror of two-phase occlusion. */
  private visiblePrefixBytes(capacity: number, lateMirror: boolean): number {
    return capacity * VISIBLE_ENTRY_BYTES * (lateMirror ? 2 : 1);
  }
  /** Without a reserved mirror, late items alias the union region and draw nothing new. */
  private lateVisibleBase(): number {
    return this.lateMirror ? this.visibleBufferCapacity : 0;
  }
  private indirectBytes(): number {
    return this.indirectCapacity * INDIRECT_COMMAND_BYTES * 2;
  }

  dispose(): void {
    if (this.preparingInputBindings !== undefined)
      this.releaseInputBindings(this.preparingInputBindings);
    this.inputReads = undefined;
    this.shadowRaster = undefined;
    const failures: unknown[] = [];
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (cause) {
        failures.push(cause);
      }
    };
    attempt(() => {
      if (this.initialStorage !== undefined) this.closeInitialStorage(this.initialStorage);
    });
    attempt(() => {
      if (this.addressPreparation !== undefined)
        this.releaseAddressStorage(this.addressPreparation);
    });
    attempt(() => this.bufferRetirement.assertHealthy());
    attempt(() => this.memberResidency.dispose());
    const buffers = [
      ...this.supersededBuffers,
      ...(this.buffers === undefined ? [] : [this.buffers]),
    ];
    this.supersededBuffers = [];
    this.buffers = undefined;
    this.surfaceRows = undefined;
    this.skinBindGroup = undefined;
    this.skinFinalizeBindGroup = undefined;
    this.skinRasterBinding = undefined;
    this.skinLayout = undefined;
    this.skinJointCapacity = 0;
    this.skinActive = false;
    this.bindGroup = undefined;
    this.plan = undefined;
    this.encodedTopology = undefined;
    this.visibleBufferCapacity = 0;
    this.lateMirror = false;
    this.sceneInputs = undefined;
    this.sceneInputBytes = 0;
    this.scenePrimitive = undefined;
    this.sceneInstance = undefined;
    this.sceneTransform = undefined;
    this.sceneTableIdentity = undefined;
    this.sceneMaterial = undefined;
    this.sceneCapacity = 0;
    this.sceneTransformBytes = 0;
    this.suppressionWordCapacity = 0;
    this.suppressionMirror = new Uint32Array(0);
    this.suppressionSource = null;
    this.telemetryPending = undefined;
    this.telemetrySubmit = undefined;
    this.occlusionCamera = undefined;
    this.visibilityHistoryReady = false;
    this.lodSelectionReadback = undefined;
    this.lodSelection = undefined;
    for (const generation of buffers) attempt(() => this.retireGeneration(generation));
    attempt(() => this.destroyAfterSubmittedWork(buffers));
    void this.pipelineLayout;
    if (failures.length > 0) throw new AggregateError(failures, 'View disposal failed');
  }

  /**
   * @internal
   * Accept the current buffer generation after its typed graph compiles.
   * Superseded imports stay alive while the last-known-good graph remains
   * executable, then retire behind the queue fence only after promotion.
   */
  _commitResourceReplacement(): void {
    const buffers = this.supersededBuffers;
    if (buffers.length === 0) return;
    this.supersededBuffers = [];
    this.destroyAfterSubmittedWork(buffers);
  }

  /**
   * @internal
   * Grow every view buffer after a GPU overflow was observed. The next
   * `update` rewrites the same plan into the replacement generation, so the
   * failed generation cannot be reused even when topology identity is stable.
   */
  _recoverFromOverflow(): Result<void, RhiError> {
    if (this.buffers === undefined) return ok(undefined);
    return this.rebuildBuffers(
      this.candidateCapacity * 2,
      this.visibleBufferCapacity * 2,
      this.batchCapacity * 2,
      this.indirectCapacity * 2,
      this.suppressionWordCapacity,
      this.buffers.visibleSurfaceRows !== undefined,
      this.skinJointCapacity,
      (this.skinLayout?.candidateCapacity ?? 0) * 2,
      this.lateMirror,
    );
  }

  /** The persistent view owns its telemetry demand, independently of candidate capacity. */
  private readbackBytes(batches: number, visible: number, indirect: number): number {
    return (
      batches * COUNTER_STRIDE +
      (this.readback === 'complete' ? visible * 16 + indirect * INDIRECT_COMMAND_BYTES : 0)
    );
  }

  /** Byte offset of the admission bitmap inside the batches buffer. */
  private suppressionBase(): number {
    return this.batchCapacity * BATCH_STRIDE;
  }

  /**
   * Upload only the bitmap words that differ from the last upload. The bitmap
   * covers every GPU Scene slot, so admission changes never touch the plan,
   * the candidate records or the render bundles that read them. A rebuilt
   * batches buffer starts undefined, so it receives the whole bitmap once.
   */
  private updateSuppression(
    buffer: Buffer,
    reseed: boolean,
    target: Uint32Array | undefined,
  ): Result<void, RhiError> {
    const base = this.suppressionBase();
    if (reseed) {
      this.suppressionReseed = false;
      this.suppressionMirror = new Uint32Array(this.suppressionWordCapacity);
      if (target !== undefined) this.suppressionMirror.set(target);
      const initial = this.device.queue.writeBuffer(
        buffer,
        base,
        new Uint8Array(this.suppressionMirror.buffer),
      );
      if (!initial.ok) return initial;
      this.suppressionUploadBytes += this.suppressionMirror.byteLength;
    } else if (target === this.suppressionSource) {
      // Same bitmap object: the mirror already equals it.
    } else if (
      target !== undefined &&
      this.suppressionSource !== null &&
      this.suppressionSource !== undefined &&
      suppressionPatchOf(target)?.base === this.suppressionSource
    ) {
      // A patched successor of the uploaded bitmap: visit only the words it
      // changed, so the upload cost follows the changes rather than capacity.
      const patch = suppressionPatchOf(target)?.words ?? [];
      const mirror = this.suppressionMirror;
      const dirty = [...patch].sort((a, b) => a - b);
      let index = 0;
      while (index < dirty.length) {
        const first = dirty[index] as number;
        let word = first;
        while (index < dirty.length && (dirty[index] as number) <= word) {
          word = (dirty[index] as number) + 1;
          index += 1;
        }
        for (let at = first; at < word; at++) mirror[at] = target[at] ?? 0;
        const written = this.device.queue.writeBuffer(
          buffer,
          base + first * 4,
          new Uint8Array(mirror.buffer, first * 4, (word - first) * 4),
        );
        if (!written.ok) return written;
        this.suppressionUploadBytes += (word - first) * 4;
      }
    } else {
      const mirror = this.suppressionMirror;
      let word = 0;
      while (word < mirror.length) {
        if (mirror[word] === (target?.[word] ?? 0)) {
          word += 1;
          continue;
        }
        const first = word;
        while (word < mirror.length && mirror[word] !== (target?.[word] ?? 0)) {
          mirror[word] = target?.[word] ?? 0;
          word += 1;
        }
        const written = this.device.queue.writeBuffer(
          buffer,
          base + first * 4,
          new Uint8Array(mirror.buffer, first * 4, (word - first) * 4),
        );
        if (!written.ok) return written;
        this.suppressionUploadBytes += (word - first) * 4;
      }
    }
    this.suppressionSource = target;
    this.uploadBytes += this.suppressionUploadBytes;
    return ok(undefined);
  }

  private rebuildBuffers(
    candidateCapacity: number,
    visibleCapacity: number,
    batchCapacity: number,
    indirectCapacity: number,
    suppressionWords: number,
    surfaceRows = this.buffers?.visibleSurfaceRows !== undefined,
    skinJointCapacity = this.skinJointCapacity,
    skinCandidateCapacity = this.skinLayout?.candidateCapacity ?? candidateCapacity,
    lateMirror = this.lateMirror,
    orderCandidateCapacity = this.orderCandidateCapacity,
  ): Result<void, RhiError> {
    const work = this.rebuildBufferSteps(
      candidateCapacity,
      visibleCapacity,
      batchCapacity,
      indirectCapacity,
      suppressionWords,
      surfaceRows,
      skinJointCapacity,
      skinCandidateCapacity,
      lateMirror,
      orderCandidateCapacity,
      () => true,
    );
    for (;;) {
      const next = work.next();
      if (next.done) return next.value;
    }
  }

  private visibleBufferCeiling(skinTail: number, lateMirror: boolean): number {
    const limit = Number(this.device.limits.maxStorageBufferBindingSize);
    return Number.isFinite(limit) && limit > 0
      ? (limit - skinTail - 64) / this.visiblePrefixBytes(1, lateMirror)
      : Number.MAX_SAFE_INTEGER;
  }

  private adoptSkinStorage(
    buffers: ViewBuffers,
    skinLayout: SkinDemandLayout | undefined,
    skinJointCapacity: number,
  ): void {
    this.skinLayout = skinLayout;
    this.skinJointCapacity = skinJointCapacity;
    this.skinBindGroup = undefined;
    this.skinFinalizeBindGroup = undefined;
    this.skinRasterBinding =
      skinLayout === undefined
        ? undefined
        : {
            data: buffers.visible,
            auxiliary: buffers.view,
            dataOffset: 0,
            auxiliaryOffset: SKIN_RASTER_OFFSET,
            dataSize: skinLayout.outputBytes,
            auxiliarySize: 16,
          };
  }

  private *rebuildBufferSteps(
    candidateCapacity: number,
    visibleCapacity: number,
    batchCapacity: number,
    indirectCapacity: number,
    suppressionWords: number,
    surfaceRows: boolean,
    skinJointCapacity: number,
    skinCandidateCapacity: number,
    lateMirror: boolean,
    orderCandidateCapacity: number,
    current: () => boolean,
    initial?: InitialViewStorage,
    prepareGroups?: (
      buffers: ViewBuffers,
      skin: SkinDemandLayout | undefined,
      visibleCapacity: number,
      indirectCapacity: number,
    ) => Result<InputBindingGroups & { readonly consumers: GpuViewInputPreparation }, RhiError>,
  ): Generator<void, Result<void, RhiError>> {
    const nextCandidate = nextCapacity(candidateCapacity);
    const nextOrderCandidate = nextCapacity(
      Math.max(orderCandidateCapacity, this.orderCandidateCapacity),
    );
    const nextSuppression = Math.max(nextCapacity(suppressionWords), this.suppressionWordCapacity);
    const nextBatch = nextCapacity(batchCapacity);
    const nextIndirect = nextCapacity(indirectCapacity);
    // The late mirror starts at the capacity and raster binds its windows at
    // static storage offsets, so the capacity keeps the 64-entry alignment
    // BatchTopology gives every early window. Skin output follows the visible
    // prefix inside the same binding, so its tail shares the binding budget.
    const skinTail =
      skinJointCapacity > 0
        ? skinDemandLayout(skinCandidateCapacity, skinJointCapacity).outputBytes
        : 0;
    const visibleCeiling = this.visibleBufferCeiling(skinTail, lateMirror);
    const nextVisible = growGpuDrivenVisibleCapacity(
      // A changed mirror reserves a new allocation; its capacity restarts exact.
      lateMirror === this.lateMirror ? this.visibleBufferCapacity : 0,
      visibleCapacity,
      visibleCeiling,
    );
    const skinLayout =
      skinJointCapacity > 0
        ? skinDemandLayout(
            skinCandidateCapacity,
            skinJointCapacity,
            this.visiblePrefixBytes(nextVisible, lateMirror),
          )
        : undefined;
    const previous = this.buffers;
    const created: Partial<MutableViewBuffers> = initial?.created ?? {};
    let accepted = false;
    let consumers: GpuViewInputPreparation | undefined;
    const allocate = (
      name: keyof ViewBuffers,
      size: number,
      usage: number,
    ): Result<void, RhiError> => {
      const endCreation = this.bufferRetirement.beginCreation();
      try {
        const buffer = this.device.createBuffer({
          label: `gpu-driven-view-${name}`,
          size,
          usage,
          mappedAtCreation: false,
        });
        if (!buffer.ok) return buffer;
        created[name] = buffer.value;
        const token = this.allocationLedger.allocate(size);
        this.allocationTokens.set(buffer.value, token);
        // Disposal may precede the native return. Transfer the exact late receipt before settlement.
        if (initial?.phase === 'closed') this.closeInitialStorage(initial);
        return ok(undefined);
      } finally {
        endCreation();
      }
    };
    const storage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC;
    const requests: readonly ViewBufferRequest<keyof ViewBuffers>[] = [
      {
        name: 'batches',
        size: nextBatch * BATCH_STRIDE + nextSuppression * 4,
        usage: storage | GPU_BUFFER_USAGE_COPY_DST,
        storage: true,
      },
      {
        name: 'view',
        size: VIEW_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
        storage: false,
      },
      {
        name: 'counters',
        size:
          nextBatch * COUNTER_STRIDE +
          nextSuppression * 2 * 4 +
          (skinLayout?.counterWords ?? 0) * 4 +
          orderScratchWords(nextBatch, nextOrderCandidate) * 4,
        usage: storage | GPU_BUFFER_USAGE_COPY_DST,
        storage: true,
      },
      {
        name: 'visible',
        size: skinLayout?.outputBytes ?? this.visiblePrefixBytes(nextVisible, lateMirror),
        usage: storage,
        storage: true,
      },
      {
        name: 'indirect',
        // Main region plus the late-phase region of two-phase occlusion.
        size: nextIndirect * INDIRECT_COMMAND_BYTES * 2,
        usage: storage | GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        storage: true,
      },
      ...(skinLayout === undefined
        ? []
        : [
            {
              name: 'skinIndirect' as const,
              size: 12,
              usage: storage | GPU_BUFFER_USAGE_INDIRECT,
              storage: true,
            },
          ]),
      ...(surfaceRows
        ? [
            {
              name: 'visibleSurfaceRows' as const,
              size: nextVisible * 4,
              usage: storage | GPU_BUFFER_USAGE_COPY_DST,
              storage: true,
            },
          ]
        : []),
      {
        name: 'lodReadback',
        size: this.readbackBytes(nextBatch, nextVisible, nextIndirect),
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        storage: false,
      },
    ];
    const valid = validateViewBufferRequests(this.device, requests);
    if (!valid.ok) return valid;
    const live = () => current() && this.buffers === previous;
    try {
      for (const request of requests) {
        const result = yield* createViewResource(live, () =>
          allocate(request.name, request.size, request.usage),
        );
        if (!result.ok) return result;
      }
      if (!live()) return err(viewCreationInvalid());
      const next = created as ViewBuffers;
      const preparedGroups = prepareGroups?.(next, skinLayout, nextVisible, nextIndirect);
      if (preparedGroups !== undefined && !preparedGroups.ok) return preparedGroups;
      consumers = preparedGroups?.value.consumers;
      if (!live()) return err(viewCreationInvalid());
      return this.publishBufferGeneration(
        {
          next,
          previous,
          candidate: nextCandidate,
          visible: nextVisible,
          batch: nextBatch,
          indirect: nextIndirect,
          suppression: nextSuppression,
          order: nextOrderCandidate,
          skin: skinLayout,
          joints: skinJointCapacity,
          lateMirror,
          initial,
          groups: preparedGroups?.value,
          consumers,
        },
        live,
        () => {
          accepted = true;
        },
      );
    } finally {
      consumers?.release();
      if (!accepted) this.destroyAfterSubmittedWork([created]);
    }
  }

  /** Complete private consumers and latest dynamic migration before the pure pointer publication. */
  private publishBufferGeneration(
    generation: PreparedViewBufferGeneration,
    current: () => boolean,
    adopted: () => void,
  ): Result<void, RhiError> {
    const { previous, next, batch, suppression, skin, consumers } = generation;
    if (!current()) return err(viewCreationInvalid());
    if (previous !== undefined && this.visibilityHistoryReady) {
      const carried = this.carryVisibilityHistory(previous, next, batch, suppression);
      if (!carried.ok) return carried;
    }
    let constants: Uint32Array<ArrayBuffer> | undefined;
    let mirror: Uint32Array<ArrayBuffer> | undefined;
    if (consumers !== undefined && previous !== undefined) {
      if (!current() || !consumers.isCurrent()) return err(viewCreationInvalid());
      const migrated = this.migrateActiveStorage(next, batch, suppression, skin);
      if (!migrated.ok) return migrated;
      constants = migrated.value;
      mirror = new Uint32Array(suppression);
      mirror.set(this.suppressionMirror);
      if (!current() || !consumers.isCurrent()) return err(viewCreationInvalid());
      const published = consumers.publish();
      if (!published.ok) return published;
    }
    this.adoptBufferGeneration(generation, constants, mirror);
    adopted();
    // No native calls occur inside pointer publication. In-flight old commands
    // retain their exact resources until this owner's real queue fence settles.
    if (previous !== undefined) {
      this.retireGeneration(previous);
      if (consumers !== undefined) this.destroyAfterSubmittedWork([previous]);
    }
    return ok(undefined);
  }

  private adoptBufferGeneration(
    generation: PreparedViewBufferGeneration,
    constants: Uint32Array<ArrayBuffer> | undefined,
    mirror: Uint32Array<ArrayBuffer> | undefined,
  ): void {
    const { previous, next, skin, joints, consumers, groups, initial } = generation;
    if (previous !== undefined && consumers === undefined) this.supersededBuffers.push(previous);
    this.buffers = next;
    if (constants !== undefined) this.viewWords.set(constants);
    this.adoptSkinStorage(next, skin, joints);
    if (consumers === undefined) {
      this.plan = undefined;
      this.encodedTopology = undefined;
      this.surfaceRows = undefined;
    }
    this.candidateCapacity = generation.candidate;
    this.orderCandidateCapacity = generation.order;
    this.visibleBufferCapacity = generation.visible;
    this.lateMirror = generation.lateMirror;
    this.batchCapacity = generation.batch;
    this.indirectCapacity = generation.indirect;
    this.suppressionWordCapacity = generation.suppression;
    this.suppressionReseed = consumers === undefined;
    if (mirror !== undefined) {
      this.suppressionMirror = mirror;
      this.suppressionSource = null;
    }
    this.bufferRebuilds += 1;
    this.bindGroup = groups?.cull;
    this.skinBindGroup = groups?.skin;
    this.skinFinalizeBindGroup = groups?.finalize;
    if (groups !== undefined) {
      this.resourceGeneration += 1;
      this.adoptGraphBindingShape();
    }
    this.telemetryPending = undefined;
    if (initial !== undefined) initial.phase = 'accepted';
  }

  /** Copy current active data at the final handoff, never a preparation-time snapshot. */
  private migrateActiveStorage(
    next: ViewBuffers,
    batches: number,
    words: number,
    skin: SkinDemandLayout | undefined,
  ): Result<Uint32Array<ArrayBuffer>, RhiError> {
    const encoded = this.encodedTopology;
    if (this.plan === undefined || encoded === undefined) return err(viewCreationInvalid());
    const written = this.device.queue.writeBuffer(next.batches, 0, encoded.batchBytes);
    if (!written.ok) return written;
    const suppressed = this.device.queue.writeBuffer(
      next.batches,
      batches * BATCH_STRIDE,
      this.suppressionMirror,
    );
    if (!suppressed.ok) return suppressed;
    const constants = new Uint32Array(this.viewWords);
    constants[26] = batches;
    constants[28] = (batches * BATCH_STRIDE) / 4;
    const skinCounterBase = batches * COUNTER_WORDS + words * 2;
    constants[31] = skinCounterBase + (skin?.counterWords ?? 0);
    if (this.skinActive && skin !== undefined) {
      const base = SKIN_CONSTANTS_OFFSET / 4;
      writeSkinDemandConstants(
        new DataView(constants.buffer),
        SKIN_CONSTANTS_OFFSET,
        skin,
        constants[base] ?? 0,
        constants[base + 1] ?? 0xffffffff,
        this.plan.candidateCount,
        skinCounterBase,
        0,
        Number(this.device.limits.maxComputeWorkgroupsPerDimension) || 65535,
      );
      constants[SKIN_RASTER_OFFSET / 4] = skin.candidateBase;
      constants[SKIN_RASTER_OFFSET / 4 + 1] = skin.descriptorBase;
    }
    const bits = batches * COUNTER_WORDS;
    constants[OCCLUSION_STATE_OFFSET / 4 + 2] = bits + (1 - this.visibilityParity) * words;
    constants[OCCLUSION_STATE_OFFSET / 4 + 3] = bits + this.visibilityParity * words;
    constants[OCCLUSION_STATE_OFFSET / 4 + 4] = words;
    const uniform = this.device.queue.writeBuffer(next.view, 0, constants);
    if (!uniform.ok) return uniform;
    if (this.surfaceRows !== undefined && next.visibleSurfaceRows !== undefined) {
      const surface = this.device.queue.writeBuffer(next.visibleSurfaceRows, 0, this.surfaceRows);
      if (!surface.ok) return surface;
    }
    return ok(constants);
  }

  /**
   * Capacity growth must not cost the HZB history: a World joining the view
   * would otherwise draw every candidate in the early phase for one frame.
   * Copy the region the next frame reads as `previousBase`; rows past the old
   * bitmap stay zero and take the late test, which still draws them if visible.
   */
  private carryVisibilityHistory(
    from: ViewBuffers,
    to: ViewBuffers,
    toBatchCapacity: number,
    toWords: number,
  ): Result<void, RhiError> {
    const fromWords = this.suppressionWordCapacity;
    if (fromWords === 0) return ok(undefined);
    const region = 1 - this.visibilityParity;
    const encoder = this.device.createCommandEncoder({
      label: `${this.labelPrefix}-visibility-history-carry`,
    });
    if (!encoder.ok) return encoder;
    encoder.value.copyBufferToBuffer(
      from.counters,
      (this.batchCapacity * COUNTER_WORDS + region * fromWords) * 4,
      to.counters,
      (toBatchCapacity * COUNTER_WORDS + region * toWords) * 4,
      fromWords * 4,
    );
    const commands = encoder.value.finish();
    if (!commands.ok) return commands;
    return this.device.queue.submit([commands.value]);
  }

  /** Await this owner's actual cleanup; errors retain native receipt responsibility. */
  settleRetirement(): Promise<Result<void, RhiError>> {
    return this.bufferRetirement.settle();
  }

  private destroyAfterSubmittedWork(generations: readonly Partial<ViewBuffers>[]): void {
    const scene = this.sceneRef;
    this.bufferRetirement.retire(
      generations.flatMap((buffers) => Object.values(buffers)),
      (failure) => {
        scene?.failBindingPublication(failure);
      },
    );
  }

  private retireGeneration(generation: Partial<ViewBuffers>): void {
    for (const buffer of Object.values(generation)) {
      const token = this.allocationTokens.get(buffer);
      if (token !== undefined) this.allocationLedger.retire(token);
    }
  }
}
