import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { Result, RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import type { Handle, RenderPipelineAsset } from '@forgeax/engine-types';
import type {
  DynamicGeometryCandidate,
  DynamicGeometryError,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
  DynamicGeometryReceipt,
  MeshResidencyError,
  MeshResidencyPhaseObserver,
  PreparedMeshResidency,
} from '../dynamic-geometry';
import type { RecoverFailure } from '../errors/recover';
import type { ObservationUnavailableError, RenderError } from '../errors/render';
import type { RenderFeature, RenderFeatureDiagnostics } from '../features/types';
import type { GpuDrivenProductionInspection, LodOcclusionInspection } from '../inspection-types';
import type { MeshMaterialBindingObservation } from '../mesh-material-bindings';
import type { OutputColorSpace } from '../output-color-space';
import type {
  PreparedPublishedMeshResidency,
  PublishedMeshPreparation,
  PublishedRenderFrameInput,
  RenderPublicationError,
  RenderPublicationIdentity,
} from '../publication/contract';
import type { FrameObservation, FrameObservationOptions } from '../record/frame';
import type { CurrentGraphTarget, GraphTargetCaptureRequest } from '../record/frame-snapshot';
import type {
  DrawOwnerOptions,
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  HealthSnapshot,
  RenderDebugOverlay,
  RendererError,
  RendererErrorListener,
  RendererLostListener,
  RenderFrameInput,
  RenderInspection,
  RenderProfile,
  RenderResult,
  RenderWorldLease,
} from '../render-contract';
import type { RenderSceneInspection } from '../render-system';
import type { RenderSceneBounds } from '../scene/render-scene-types';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import type {
  FramebufferSnapshotRequest,
  FramebufferSnapshotTicket,
  RenderTarget,
  RenderTargetDescriptor,
  RenderTargetReadbackRequest,
  RenderTargetReadbackTicket,
  RenderTargetTextureSource,
  RenderTargetTextureSourceOptions,
} from '../targets/contracts';

type RenderShaderModuleFactory = (
  device: RhiDevice,
  desc: { readonly label?: string | undefined; readonly code: string },
) => Promise<Result<ShaderModule, RhiError>>;

/** Package-local source projected to the sole public Renderer.subscribe channel. */
export type RendererHostEvent =
  | { readonly kind: 'error'; readonly error: RendererError }
  | { readonly kind: 'health'; readonly health: HealthSnapshot };

export type RendererHostEventListener = (event: RendererHostEvent) => void;

/**
 * Narrow assembly contract consumed by exposeRenderer and constructRendererHost.
 * Legacy diagnostics remain on RendererLegacyHostAdapter and cannot leak into
 * the public Renderer type.
 */
export interface RendererHostImplementation {
  /** Publish one renderer-owned read-only Surface dynamic page for the next frame. */
  setSurfaceDynamicInput(frame: SurfaceDynamicInputFrame | undefined): void;
  attach(world: World): RenderResult<RenderWorldLease, RenderError>;
  prepareDynamicGeometry(
    input: DynamicGeometryPrepareInput,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  /** Prepare one complete roster under the existing aggregate byte budget. */
  prepareDynamicGeometryCandidates(
    inputs: readonly DynamicGeometryPrepareInput[],
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  /** Prepare source-namespaced Mesh buffers and wait for physical queue completion. */
  preparePublishedMeshResidency(
    input: PublishedMeshPreparation,
  ): Promise<Result<PreparedPublishedMeshResidency, RenderPublicationError | MeshResidencyError>>;
  prepareMeshResidency(
    world: World,
    meshHandle: Handle<'MeshAsset', 'shared'>,
    observePhase?: MeshResidencyPhaseObserver,
  ): Result<PreparedMeshResidency, MeshResidencyError>;
  acceptDynamicGeometry(
    candidate: DynamicGeometryCandidate,
    ordering: DynamicGeometryOrdering,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  /**
   * Atomically swap distinct entities in one attached World. Returned failures
   * retain old bindings; an uncertain rollback throws to require paired rebuild.
   * Invoke inside PhysicsWorld.admitDerivedShapeCandidates commitGeometry.
   */
  acceptDynamicGeometryCandidates(
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  /** Whether the original candidate still owns current physical residency. */
  isDynamicGeometryCurrent(candidate: DynamicGeometryCandidate): boolean;
  dynamicGeometryReceipt(candidate: DynamicGeometryCandidate): DynamicGeometryReceipt | undefined;
  cancelDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  retireDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  publishDynamicGeometry(
    frame: {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly completed?: Promise<unknown>;
    },
    worlds?: readonly object[],
    fixedStep?: number,
  ): readonly DynamicGeometryReceipt[];
  createRenderTarget(descriptor: RenderTargetDescriptor): RenderResult<RenderTarget, RenderError>;
  resizeRenderTarget(
    target: RenderTarget,
    descriptor: RenderTargetDescriptor,
  ): RenderResult<void, RenderError>;
  createRenderTargetTextureSource(
    target: RenderTarget,
    options: RenderTargetTextureSourceOptions,
  ): RenderResult<RenderTargetTextureSource, RenderError>;
  requestTargetReadback(
    target: RenderTarget,
    request: RenderTargetReadbackRequest,
  ): RenderResult<RenderTargetReadbackTicket, RenderError>;
  requestFramebufferSnapshot(
    target: RenderTarget,
    request: FramebufferSnapshotRequest,
  ): RenderResult<FramebufferSnapshotTicket, RenderError>;
  destroyRenderTarget(target: RenderTarget): RenderResult<void, RenderError>;
  importTexture(
    input: import('../textures/external-texture').ExternalTextureInput,
  ): Promise<RenderResult<import('../textures/external-texture').ExternalTexture, RenderError>>;
  nativeDevice(): RenderResult<GPUDevice, RenderError>;
  setProfile(profile: RenderProfile): RenderResult<void, RenderError>;
  setOutputColorSpace(colorSpace: OutputColorSpace): RenderResult<void, RenderError>;
  /** Detached world bounds for one record in the last extracted World; undefined if unavailable. */
  bounds(world: World | RenderPublicationIdentity, entity: number): RenderSceneBounds | undefined;
  /** Direct read of the active device owner, independent of diagnostic projections. */
  currentDeviceGeneration?: () => number;
  inspect(): RenderInspection;
  /**
   * Internal bounded inspection for high-cardinality producers. The public
   * snapshot also carries the full persistent render-scene record table, which
   * is intentionally not materialized for per-frame performance evidence.
   */
  inspectLodOcclusion(): {
    readonly lodOcclusion: LodOcclusionInspection | undefined;
    readonly gpuDriven: GpuDrivenProductionInspection;
  };
  drawFrame(
    request: RenderFrameInput | PublishedRenderFrameInput,
  ): RenderResult<FrameReceipt, RhiError | RenderError>;
  /** Arm one upcoming frame for receipt-bound color observations. */
  requestObservation?: (
    domains: readonly import('../render-contract').FrameObservationDomain[],
  ) => RenderResult<void, RenderError>;
  observe(
    receipt: FrameReceipt,
    request: FrameObservationRequest,
  ): Promise<RenderResult<FrameReceiptObservation, RenderError>>;
  releaseSurface(): RenderResult<void, RhiError>;
  restoreSurface(): RenderResult<void, RhiError>;
  recover(): Promise<Result<void, RecoverFailure>>;
  dispose(): RenderResult<void, RenderError>;
  /** @internal Single event source used to construct public Renderer.subscribe. */
  subscribeHostEvents(listener: RendererHostEventListener): () => void;

  readonly device: RhiDevice;
  /** @internal */
  readonly _internal_createShaderModule: RenderShaderModuleFactory;
  /** @internal */
  readonly _internal_setRenderOverlay: (overlay: RenderDebugOverlay | undefined) => void;
  readonly assetRegistry: AssetRegistry;
  readonly initialization: Promise<RenderResult<void, RhiError>>;
}

/**
 * @internal
 * Temporary package-local compatibility surface for unmigrated render tests
 * and producers. It is intentionally absent from RendererHostImplementation.
 */
export interface RendererLegacyHostAdapter {
  attachScene(world: World): RenderResult<void, RhiError>;
  detachScene(world: World): void;
  draw(
    worldsOrRequest: readonly World[] | RenderFrameInput | PublishedRenderFrameInput,
    options?: DrawOwnerOptions,
  ): RenderResult<void | FrameReceipt, RhiError | RenderError>;
  observeCurrentFrame(
    options: FrameObservationOptions,
  ): Promise<RenderResult<FrameObservation, ObservationUnavailableError>>;
  /** @internal Test-only current compiled graph target diagnostic. */
  getCurrentGraphTarget(name: string): CurrentGraphTarget | undefined;
  requestGraphTargetCapture(request: GraphTargetCaptureRequest): void;
  onLost(listener: RendererLostListener): () => void;
  onError(listener: RendererErrorListener): () => void;
  health(): HealthSnapshot;
  readonly frustumStats: { readonly culled: number; readonly total: number };
  readonly visibilityStats: { readonly explicitlyHidden: number };
  readonly renderScene: RenderSceneInspection;
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  readonly perFramePassNames: readonly string[];
  renderFeatureDiagnostics(): readonly RenderFeatureDiagnostics[];
  /** @internal Install Standard pipeline-asset config for producer fixtures. */
  configureStandard(config: RenderPipelineAsset['config']): void;
  installRenderFeature(feature: RenderFeature<unknown>): Promise<RenderResult<void, RenderError>>;
  uninstallRenderFeature(feature: RenderFeature<unknown>): Promise<RenderResult<void, RenderError>>;
  readonly bindGroupCounts: { readonly createBindGroup: number; readonly keys: readonly string[] };
}

/** @internal Concrete factory object before it is narrowed by exposeRenderer. */
export interface RendererAssemblyImplementation
  extends RendererHostImplementation,
    RendererLegacyHostAdapter {}
