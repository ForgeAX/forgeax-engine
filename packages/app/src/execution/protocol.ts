import type { AudioIntent, MusicState } from '@forgeax/engine-audio';
import type { SharedSpanBinding } from '@forgeax/engine-ecs/shared';
import type { GamepadFeedbackIntent, InputBackendSample } from '@forgeax/engine-input';
import type { RenderError, RenderPublicationIdentity } from '@forgeax/engine-render';
import type { BrowserFrameSubmitted } from '../browser-frame-signal';
import type { AppError } from '../errors';
import type { CanvasDrawingBufferSize } from '../types';
import type {
  ExecutionAssetCatalog,
  ExecutionFault,
  ExecutionFrameInspection,
  ExecutionRenderCapabilities,
  ExecutionRenderLimits,
} from './types';

export interface ExecutionFrameMessage {
  readonly kind: 'frame';
  readonly musicState?: MusicState;
  readonly audioPreparation?: import('@forgeax/engine-audio').AudioPreparationReceipt;
  readonly rejectedAudioPublications?: readonly import('@forgeax/engine-audio').AudioClipIdentity[];
  readonly worldIdentity: string;
  readonly frameId: number;
  readonly deltaSeconds: number;
  /** Host render-sample time before ECS applies its simulation clamp. */
  readonly sampleTimeSeconds?: number;
  /** Explicit pause/resume or replay lifecycle boundary for temporal owners. */
  readonly temporalReset?: boolean;
  readonly inputSample: InputBackendSample;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface ExecutionFrameCompletion {
  readonly shadowWorkload?: import('@forgeax/engine-render').ShadowWorkloadObservation;
  readonly kind: 'frame-complete';
  readonly worldIdentity: string;
  readonly frameId: number;
  /** Renderer queue-submit generation for the browser compositor witness. */
  readonly deviceGeneration?: number;
  /** Compiled graph generation paired with the submitted picture. */
  readonly graphGeneration?: number;
  /**
   * Serialized output mapping for the accepted frame. `undefined` means that
   * no accepted submitted display context is available; consumers must fail
   * closed rather than manufacture identity from the omission.
   */
  readonly barrelDistortion?: import('@forgeax/engine-render').BarrelDistortionMapping;
  /** Renderer presentation readiness from the completed FrameReceipt. */
  readonly presentation?: import('@forgeax/engine-render').FramePresentation;
  readonly presentationPendingReason?: import('@forgeax/engine-render').FramePresentationPendingReason;
  readonly engineUpdateMs: number;
  readonly kernelWaitMs: number;
  readonly audioIntents?: readonly AudioIntent[];
  readonly feedbackIntents?: readonly GamepadFeedbackIntent[];
  readonly kernelDispatch?: {
    readonly eligible: boolean;
    readonly usedShared: boolean;
    readonly reason: import('./types').KernelDispatchReason;
    readonly dispatched: number;
    readonly completed: number;
  };
}

export interface ExecutionFrameSubmitted
  extends Omit<BrowserFrameSubmitted, 'receipt' | 'worldIdentity'> {
  readonly kind: 'frame-submitted';
  readonly worldIdentity: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
}

export type FrameCompletionDisposition = 'accepted' | 'duplicate' | 'stale-world' | 'late';

export class FrameCreditLedger {
  private nextFrameId = 1;
  private inFlight: number | null = null;
  private completed = 0;
  private completedCount = 0;
  private submitted = 0;
  private highWater = 0;
  private throttledTicks = 0;

  constructor(readonly worldIdentity: string) {}

  issue(
    deltaSeconds: number,
    sampleInput: () => InputBackendSample,
    canvasSize: CanvasDrawingBufferSize = { width: 0, height: 0 },
    sampleTimeSeconds?: number,
    temporalReset = false,
  ): ExecutionFrameMessage | undefined {
    if (this.inFlight !== null) {
      this.throttledTicks += 1;
      return undefined;
    }
    const frameId = this.nextFrameId;
    this.nextFrameId += 1;
    this.inFlight = frameId;
    this.submitted += 1;
    this.highWater = Math.max(this.highWater, 1);
    return {
      kind: 'frame',
      worldIdentity: this.worldIdentity,
      frameId,
      deltaSeconds,
      ...(sampleTimeSeconds === undefined ? {} : { sampleTimeSeconds }),
      ...(temporalReset ? { temporalReset: true } : {}),
      inputSample: sampleInput(),
      canvasWidth: canvasSize.width,
      canvasHeight: canvasSize.height,
    };
  }

  complete(
    message: ExecutionFrameCompletion | ExecutionSimulationCompletion,
  ): FrameCompletionDisposition {
    if (message.worldIdentity !== this.worldIdentity) return 'stale-world';
    if (message.frameId <= this.completed) return 'duplicate';
    if (message.frameId !== this.inFlight) return 'late';
    this.completed = message.frameId;
    this.completedCount += 1;
    this.inFlight = null;
    return 'accepted';
  }

  inspect(): ExecutionFrameInspection {
    return {
      submitted: this.submitted,
      completed: this.completedCount,
      inFlight: this.inFlight === null ? 0 : 1,
      highWater: this.highWater,
      throttledTicks: this.throttledTicks,
    };
  }

  get hasCreditInFlight(): boolean {
    return this.inFlight !== null;
  }
}

export interface ExecutionInitMessage {
  readonly kind: 'init';
  /** App-owned startup policy also bounds Renderer realm creation and replacement. */
  readonly startupTimeoutMs: number | null;
  readonly canvas: OffscreenCanvas;
  readonly bootstrapUrl: string;
  readonly bootstrapData?: import('./types').ExecutionBootstrapValue;
  readonly bootstrapPort?: MessagePort;
  /** Realm-serializable asset catalog configuration. */
  readonly assetCatalog?: ExecutionAssetCatalog;
  readonly shaderManifestUrl?: string;
  /** Exact checkout revision emitted by the host build-tool adapter. */
  readonly build?: string;
  readonly time?: import('@forgeax/engine-ecs').TimePolicy;
  readonly animation?: import('@forgeax/engine-animation').AnimationPlaybackOptions;
  readonly diagnostics?: import('./types').ExecutionDiagnosticsOptions;
  /** Installed in the Engine Worker and forwarded to the Render Worker realm. */
  readonly gpuStub?: import('@forgeax/engine-rhi-webgpu').WebGpuStubProfile;
  /** Renderer-realm display output color space; the Renderer owns negotiation. */
  readonly outputColorSpace?: import('@forgeax/engine-render').OutputColorSpace;
  /** Captured exact pipeline recipes, prepared before renderer initialization completes. */
  readonly pipelineLibrary?: import('@forgeax/engine-rhi').PipelineLibraryManifest;
  readonly dynamicGeometryMeshBudgetBytes?: number;
  readonly assetBudgetBytes?: number;
  readonly workers: import('./types').ExecutionSelection;
}

export interface ExecutionHostControlMessage {
  readonly kind: 'host-control';
  readonly command: 'set-pointer-lock-allowed';
  readonly allowed: boolean;
}

export interface ExecutionReadyMessage {
  readonly kind: 'ready';
  readonly worldIdentity: string;
  readonly realm: 'worker';
  readonly workerWebGpu: boolean;
}

export interface ExecutionFaultMessage extends ExecutionFault {
  readonly kind: 'fault';
  readonly worldIdentity: string | null;
}

export interface ExecutionRebuildMessage {
  readonly kind: 'rebuild';
  readonly canvas?: OffscreenCanvas;
  readonly worldIdentity: string;
}

export interface ExecutionRebuiltMessage {
  readonly kind: 'rebuilt';
  readonly previousWorldIdentity: string;
  readonly worldIdentity: string;
}

/** A serialized inspection request executed by the selected Engine realm. */
export interface ExecutionInspectMessage {
  readonly kind: 'inspect';
  readonly requestId: number;
  readonly code: string;
  /** World identity observed by the caller before the request was queued. */
  readonly worldIdentity: string;
}

export interface ExecutionInspectCancelMessage {
  readonly kind: 'inspect-cancel';
  readonly requestId: number;
  readonly worldIdentity: string;
}

export interface ExecutionInspectStartedMessage {
  readonly kind: 'inspect-started';
  readonly requestId: number;
  readonly worldIdentity: string;
}

/** Worker-side cancellation admission witness. `admitted` means execution may continue. */
export interface ExecutionInspectCanceledMessage {
  readonly kind: 'inspect-canceled';
  readonly requestId: number;
  readonly worldIdentity: string;
  readonly admitted: boolean;
}

export interface ExecutionInspectResultMessage {
  readonly kind: 'inspect-result';
  readonly requestId: number;
  readonly worldIdentity: string;
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
}

/** Out-of-band profiler cleanup fenced to the capture's owning World. */
export interface ExecutionProfileFinishMessage {
  readonly kind: 'profile-finish';
  readonly worldIdentity?: string;
  readonly captureId?: string;
}

/** Simulation completion releases source credit; it is never a presentation witness. */
export interface ExecutionSimulationCompletion extends Omit<ExecutionFrameCompletion, 'kind'> {
  readonly kind: 'simulation-complete';
  readonly renderRejection?: Pick<ExecutionFaultMessage, 'code' | 'expected' | 'hint' | 'detail'>;
}

/** Host-owned surface transfer; both identities fence delayed recovery replies. */
export interface ExecutionSurfaceResultMessage {
  readonly kind: 'surface-result';
  readonly worldIdentity: string;
  readonly requestId: number;
  readonly result:
    | { readonly ok: true; readonly value: OffscreenCanvas }
    | {
        readonly ok: false;
        readonly error: Pick<AppError, 'code' | 'expected' | 'hint' | 'detail'>;
      };
}

export type HostToEngineMessage =
  | ExecutionSurfaceResultMessage
  | { readonly kind: 'render-replace'; readonly epoch: number; readonly canvas: OffscreenCanvas }
  | ExecutionInitMessage
  | ExecutionFrameMessage
  | ExecutionRebuildMessage
  | ExecutionInspectMessage
  | ExecutionInspectCancelMessage
  | { readonly kind: 'input-clear' }
  | { readonly kind: 'input-lease-open' }
  | ExecutionProfileFinishMessage
  | { readonly kind: 'dispose' };
/** Plain public error data; native Error cloning drops producer guidance. */
export interface SerializedRenderError {
  readonly code: RenderError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}

/** Actual Render Worker device facts copied with an asynchronous Renderer error. */
export interface RenderWorkerDiagnostics {
  readonly state?: import('@forgeax/engine-render').RendererState;
  readonly frameId?: number;
  readonly capabilities?: Pick<
    import('@forgeax/engine-rhi').RhiCaps,
    'backendKind' | 'compute' | 'storageBuffer'
  >;
  readonly limits?: Readonly<Record<string, number>>;
  readonly inspectionError?: string;
}

export interface ExecutionRenderErrorMessage {
  readonly kind: 'render-error';
  readonly identity: RenderPublicationIdentity;
  readonly worldIdentity: string;
  readonly error: SerializedRenderError;
  readonly renderer?: RenderWorkerDiagnostics;
  /** Only the first error is retained during the ready-to-listen handoff. */
  readonly omittedBeforeListenerCount?: number;
}

export type EngineToHostMessage =
  | { readonly kind: 'kernel-worker'; readonly workerId: number; readonly port: MessagePort }
  | { readonly kind: 'kernel-retire'; readonly workerId: number }
  /**
   * The Render Worker session posts its render-submitted / render-complete
   * notices on this port, so Host credit never queues behind an Engine World tick.
   */
  | { readonly kind: 'render-host-port'; readonly epoch: number; readonly port: MessagePort }
  | { readonly kind: 'surface-request'; readonly worldIdentity: string; readonly requestId: number }
  | { readonly kind: 'disposed'; readonly error?: unknown }
  | ExecutionSimulationCompletion
  | {
      readonly kind: 'render-ready';
      readonly epoch: number;
      readonly capabilities?: ExecutionRenderCapabilities;
      readonly limits?: ExecutionRenderLimits;
    }
  | ExecutionRenderErrorMessage
  | { readonly kind: 'render-lost'; readonly epoch: number; readonly detail: string }
  | {
      readonly kind: 'render-submitted';
      readonly epoch: number;
      readonly frame: ExecutionFrameSubmitted;
    }
  | {
      readonly kind: 'render-complete';
      readonly epoch: number;
      readonly frame: ExecutionFrameCompletion;
    }
  | ExecutionReadyMessage
  | ExecutionFrameSubmitted
  | ExecutionFrameCompletion
  | ExecutionFaultMessage
  | ExecutionRebuiltMessage
  | ExecutionInspectStartedMessage
  | ExecutionInspectCanceledMessage
  | ExecutionInspectResultMessage
  | ExecutionHostControlMessage;

/** Kernel pool to kernel Worker messages; the pool sends, the Worker runtime receives. */
export interface KernelJobMessage {
  readonly kind: 'kernel-job';
  readonly moduleUrl: string;
  readonly binding: SharedSpanBinding;
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

export interface KernelInitMessage {
  readonly kind: 'kernel-init';
  readonly ready: Int32Array;
}

export interface KernelPreloadMessage {
  readonly kind: 'kernel-preload';
  readonly moduleUrl: string;
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

export interface KernelWorkerConnectMessage {
  readonly kind: 'kernel-connect';
  readonly port: MessagePort;
}

export type HostToKernelMessage = KernelJobMessage | KernelInitMessage | KernelPreloadMessage;
