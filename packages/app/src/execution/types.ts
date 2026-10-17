import type { AudioState } from '@forgeax/engine-audio';
import type { HostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import type { WorldExecutionHealth } from '@forgeax/engine-ecs/shared';
import type {
  GpuPassTimingOptions,
  RenderFrameInput,
  RenderInspection,
} from '@forgeax/engine-render';
import type { RhiCaps } from '@forgeax/engine-rhi';
import type { Result, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { AppError } from '../errors';

export const EXECUTION_WORKERS = ['engine', 'render', 'kernels'] as const;
export type ExecutionWorker = (typeof EXECUTION_WORKERS)[number];
/** Auto enables each supported worker; true requires it; false disables it. */
export type ExecutionWorkerPolicy = 'auto' | boolean;
export type ExecutionWorkersOptions = Readonly<
  Partial<Record<ExecutionWorker, ExecutionWorkerPolicy>>
>;
export type ExecutionWorkerDecision = {
  readonly requested: ExecutionWorkerPolicy;
  readonly enabled: boolean;
  readonly reason: 'enabled' | 'disabled' | 'engine-disabled' | 'capability-unavailable';
  readonly missingCapabilities: readonly ExecutionCapabilityName[];
};
export type ExecutionSelection = Readonly<Record<ExecutionWorker, ExecutionWorkerDecision>>;

export const EXECUTION_CAPABILITY_NAMES = [
  'worker',
  'offscreenCanvas',
  'workerAnimationFrame',
  'workerWebGpu',
  'crossOriginIsolated',
  'sharedArrayBuffer',
  'atomicsWait',
] as const;
export type ExecutionCapabilityName = (typeof EXECUTION_CAPABILITY_NAMES)[number];

export interface ExecutionCapabilityFact {
  readonly available: boolean;
  readonly reason: string;
}

export type ExecutionCapabilities = Readonly<
  Record<ExecutionCapabilityName, ExecutionCapabilityFact>
>;

export type ExecutionEngineHealth = 'idle' | 'starting' | 'running' | 'stopped' | 'faulted';
export type ExecutionWorldHealth = WorldExecutionHealth;

export type KernelDispatchReason =
  | 'no-eligible-kernel'
  | 'zero-work'
  | 'small-span'
  | 'forced-inline'
  | 'shared'
  | 'poisoned';

export interface ExecutionMeasurement {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly jitter: number;
}

export interface ExecutionFault {
  readonly source: 'bootstrap' | 'handshake' | 'runtime' | 'kernel' | 'world' | 'rebuild';
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
  readonly partialWrite: boolean;
  readonly retryable: boolean;
}

export interface ExecutionAudioReport {
  readonly cache?: AudioState['cache'];
  readonly preparation?: AudioState['preparation'];
  readonly music?: AudioState['music'];
  readonly streaming?: AudioState['streaming'];
  readonly owner: 'host';
  readonly contextState: 'running' | 'suspended' | 'closed';
  readonly activeSourceCount: number;
  readonly lastError: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail: unknown;
  } | null;
}

/**
 * Renderer-independent frame pacing facts owned by the active host loop.
 * `inFlight` is always `submitted - completed`; `highWater` records the
 * greatest observed in-flight depth and `throttledTicks` counts frame-loop
 * ticks that could not acquire the selected owner's frame credit, even if
 * completion resumes their coalesced frame before the next Host callback.
 */
export interface ExecutionFrameInspection {
  readonly submitted: number;
  readonly completed: number;
  readonly inFlight: number;
  readonly highWater: number;
  readonly throttledTicks: number;
}

/**
 * Serializable asset-catalog configuration copied into the selected Engine
 * realm. The URL is resolved by that realm, so a Worker never closes over a
 * Host-side CatalogSource or Registry instance.
 */
export interface ExecutionAssetCatalog {
  readonly url: string;
  readonly expectedScope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
  /** Optional dev binding used by the Worker to lazy-import a missing pack. */
  readonly runtimeBinding?: RuntimeAssetBinding;
}

/** Actual device facts copied from the Render Worker's existing ready message. */
export type ExecutionRenderCapabilities = Pick<
  RhiCaps,
  'backendKind' | 'compute' | 'storageBuffer'
>;
export type ExecutionRenderLimits = Readonly<{
  maxStorageBuffersPerShaderStage: number;
}>;

export interface ExecutionReport {
  readonly schemaVersion: 3;
  readonly workers: ExecutionSelection;
  readonly capabilities: ExecutionCapabilities;
  readonly engine: {
    readonly realm: 'host' | 'worker';
    readonly health: ExecutionEngineHealth;
  };
  readonly world: {
    readonly identity: string | null;
    readonly health: ExecutionWorldHealth;
    readonly partialWrite: boolean;
    readonly retryable: boolean;
  };
  readonly kernelDispatch: {
    readonly eligible: boolean;
    readonly usedShared: boolean;
    readonly reason: KernelDispatchReason;
    readonly dispatched: number;
    readonly completed: number;
  };
  readonly frame: ExecutionFrameInspection;
  readonly performance: {
    readonly hostFrameMs: ExecutionMeasurement | null;
    readonly engineUpdateMs: ExecutionMeasurement | null;
    readonly kernelWaitMs: ExecutionMeasurement | null;
    readonly hostAudioMs: ExecutionMeasurement | null;
  };
  readonly audio: ExecutionAudioReport;
  readonly render?: {
    readonly epoch: number;
    readonly state: 'alive' | 'rebuilding' | 'failed' | 'stopped';
    readonly submittedFrame: number;
    readonly completedFrame: number;
    /** Capabilities from the actual Render Worker device, not Host feature detection. */
    readonly capabilities?: ExecutionRenderCapabilities;
    readonly limits?: ExecutionRenderLimits;
  };
  readonly fault: ExecutionFault | null;
}

export interface ExecutionOptions {
  /** Host-only factory, called again after rebuild; never transferred to a Worker. */
  readonly createHostAudio?: () => HostAudioConsumer;
  /** Each omitted worker policy defaults to auto, including render plus kernels. */
  readonly workers?: ExecutionWorkersOptions;
  /** Absolute or import.meta.url-relative URL of an ExecutionBootstrapEntry module. */
  readonly bootstrap: string | URL;
  /** Structured-cloneable input supplied identically to main and Worker realms. */
  readonly bootstrapData?: ExecutionBootstrapValue;
  /**
   * Realm side of an optional typed host/game channel. The engine transfers it
   * to a Worker when needed and otherwise preserves the same port contract.
   */
  readonly bootstrapPort?: MessagePort;
  /**
   * Serializable CatalogSource configuration constructed inside the selected
   * execution realm. This is the asset delivery seam for Worker execution;
   * `CreateAppOptions.assetCatalog` remains realm-bound and is rejected when
   * execution is requested.
   */
  readonly assetCatalog?: ExecutionAssetCatalog;
  /** Opt-in diagnostics created inside the selected execution realm. */
  readonly diagnostics?: ExecutionDiagnosticsOptions;
  /** Omit for the normal deadline; null waits until startup completes or is cancelled. */
  readonly startupTimeoutMs?: number | null;
  readonly frameTimeoutMs?: number;
}

/** Structured-cloneable diagnostics switches shared by main and Worker hosts. */
export interface ExecutionDiagnosticsOptions {
  /** Startup-only, default-off native view read-only depth raster batching experiment. */
  readonly featureReadOnlyDepthBatchDiagnostic?: boolean;
  /** Startup-only, explicit audited GBuffer ordering experiment. */
  readonly gbufferBatchOrderDiagnostic?: import('@forgeax/engine-render').RenderProfile['gbufferBatchOrderDiagnostic'];
  /** Allow one task turn before a successor draw while a real GPU receipt is pending. */
  readonly renderTaskYield?: 'none' | 'completion' | 'features';
  /** Bound sealed publications across simulation, preparation and GPU completion. */
  readonly renderPipelineCapacity?: 2 | 3 | 4;
  /** Compare geometry submission lanes with the same scene and Worker topology. */
  readonly geometryLane?: RenderFrameInput['geometryLane'];
  /** Create the existing Profiler in the selected realm. */
  readonly profiler?: boolean;
  /** Attach the existing RHI recorder in the selected realm. */
  readonly rhiCapture?: boolean;
  /** Construct bounded GPU pass timing inside the Renderer-owning realm. */
  readonly gpuPassTiming?: GpuPassTimingOptions;
}

export type ExecutionBootstrapValue =
  | null
  | boolean
  | number
  | string
  | readonly ExecutionBootstrapValue[]
  | { readonly [key: string]: ExecutionBootstrapValue };

export interface ExecutionControl {
  report(): ExecutionReport;
  rebuild(): Promise<Result<ExecutionReport, AppError>>;
}

/** Full detached facts from the actual selected Renderer, never execution-counter projections. */
export type ExecutionRendererInspectionResult =
  | { readonly ok: true; readonly value: RenderInspection }
  | {
      readonly ok: false;
      readonly error: Pick<
        Extract<AppError, { readonly code: 'app-renderer-inspection-unavailable' }>,
        'code' | 'expected' | 'hint' | 'detail'
      >;
    };

export type ExecutionGeometryObservationResult =
  | { readonly ok: true; readonly value: import('@forgeax/engine-render').GeometryObservation }
  | Extract<ExecutionRendererInspectionResult, { readonly ok: false }>;

/** Public `execution` root injected into App.remoteEval/executeScript in the Engine realm. */
export interface ExecutionRendererInspectionContext {
  /** One intrusive diagnostic frame; not ordinary FPS acceptance. */
  observeNextGeometry(options?: {
    readonly signal?: AbortSignal;
  }): Promise<ExecutionGeometryObservationResult>;
  inspectRenderer(options?: {
    readonly pipelineLibrary?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<ExecutionRendererInspectionResult>;
}
