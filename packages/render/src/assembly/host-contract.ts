import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { Result, RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import type { RecoverFailure } from '../errors/recover';
import type { ObservationUnavailableError, RenderError } from '../errors/render';
import type { RenderFeature, RenderFeatureDiagnostics } from '../features/types';
import type { GpuDrivenProductionInspection, LodOcclusionInspection } from '../inspection-types';
import type { MeshMaterialBindingObservation } from '../mesh-material-bindings';
import type { PublishedRenderFrameInput } from '../publication/contract';
import type { FrameObservation, FrameObservationOptions } from '../record/frame';
import type { CurrentGraphTarget, GraphTargetCaptureRequest } from '../record/frame-snapshot';
import type {
  DrawOwnerOptions,
  FrameReceipt,
  HealthSnapshot,
  RenderDebugOverlay,
  Renderer,
  RendererError,
  RendererErrorListener,
  RendererLostListener,
  RenderFrameInput,
  RenderPreparationSchedule,
  RenderResult,
} from '../render-contract';
import type { RenderSceneInspection } from '../render-system';
import type { DynamicGeometryHostImplementation } from './dynamic-geometry-host';

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
export interface RendererHostImplementation
  extends Pick<
    Renderer,
    | 'prepareDynamicGeometryPipelines'
    | 'setSurfaceDynamicInput'
    | 'attach'
    | 'prepareDynamicGeometry'
    | 'prepareDynamicGeometryCandidates'
    | 'preparePublishedMeshResidency'
    | 'prepareMeshResidency'
    | 'acceptDynamicGeometry'
    | 'acceptDynamicGeometryCandidates'
    | 'isDynamicGeometryCurrent'
    | 'dynamicGeometryReceipt'
    | 'cancelDynamicGeometry'
    | 'retireDynamicGeometry'
    | 'retireSupersededDynamicGeometry'
    | 'createRenderTarget'
    | 'resizeRenderTarget'
    | 'createRenderTargetTextureSource'
    | 'requestTargetReadback'
    | 'requestFramebufferSnapshot'
    | 'destroyRenderTarget'
    | 'importTexture'
    | 'nativeDevice'
    | 'setProfile'
    | 'setOutputColorSpace'
    | 'bounds'
    | 'currentDeviceGeneration'
    | 'inspect'
    | 'observeGeometry'
    | 'observe'
  > {
  publishDynamicGeometry: DynamicGeometryHostImplementation['publishDynamicGeometry'];
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
  drawFrameScheduled?: (
    request: PublishedRenderFrameInput,
    schedule: RenderPreparationSchedule,
  ) => Promise<RenderResult<FrameReceipt, RhiError | RenderError>>;
  /** Arm one upcoming frame for receipt-bound color observations. */
  requestObservation?: (
    domains: readonly import('../render-contract').FrameObservationDomain[],
  ) => RenderResult<void, RenderError>;
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
