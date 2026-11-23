import type {
  DynamicGeometryError,
  FeatureTextureObservation,
  GpuPassTimingObservation,
  GpuPassTimingOptions,
  MeshResidencyError,
  PublishedMeshPreparation,
  RenderFeatureCompletion,
  RenderFeatureSubmission,
  RenderInspection,
  RenderPublicationError,
  RenderPublicationIdentity,
  RenderPublicationMessage,
  RenderSceneBounds,
} from '@forgeax/engine-render';
import type { CaptureFrameOptions, RhiDebugError } from '@forgeax/engine-rhi-debug';
import type { RhiRemoteCaptureCompletion } from '../internal/rhi-capture';
import type {
  ClosedLevelFrameChanges,
  ClosedLevelFrameSelectionReceipt,
  ClosedLevelRowReceipt,
  ClosedLevelRowRequest,
} from './closed-level-row-protocol';
import type {
  ExecutionFrameCompletion,
  ExecutionFrameSubmitted,
  ExecutionInitMessage,
  RenderWorkerDiagnostics,
  SerializedRenderError,
} from './protocol';
import type { ExecutionDiagnosticsOptions, ExecutionRendererInspectionResult } from './types';

export const MESH_RESIDENCY_REQUEST_LIMIT = 32;
export const MESH_CONSUMPTION_LANES = Object.freeze(['cpu', 'gpu', 'mixed'] as const);
export interface MeshResidencyFailure {
  readonly code:
    | DynamicGeometryError['code']
    | MeshResidencyError['code']
    | RenderPublicationError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly actual?: unknown;
}

export type MeshResidencyRequest =
  | {
      readonly kind: 'mesh-reserve';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly bytes: number;
    }
  | {
      readonly kind: 'mesh-prepare';
      readonly requestId: number;
      readonly input: PublishedMeshPreparation;
      readonly reserved?: true;
      readonly entity?: number;
    }
  | {
      readonly kind: 'mesh-release';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly evict: boolean;
    };
export type MeshResidencyResponse = {
  readonly kind: 'mesh-reserved' | 'mesh-ready' | 'mesh-retired' | 'mesh-released';
  readonly requestId: number;
  readonly identity: RenderPublicationIdentity;
  readonly result:
    | { readonly ok: true; readonly deviceGeneration: number }
    | {
        readonly ok: false;
        readonly error: MeshResidencyFailure;
      };
};
/** Captured against the actual receipt before the next draw, delivered after its completion. */
export interface CompletedMeshConsumption {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly sourceFixedStep: number;
  /** Pairs of exact safe-integer request ID and MESH_CONSUMPTION_LANES index. */
  readonly bindings: Float64Array;
}

/** One source-owned feature receipt returned only after the published draw submits. */
export interface SubmittedFeatureReceipt {
  readonly identity: string;
  readonly feedback: unknown;
  readonly submission?: RenderFeatureSubmission;
}

export type RenderWorkerInput =
  | import('../configuration-apply').ConfigurationApplyRequest
  | {
      readonly kind: 'geometry-observe-next';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
    }
  | { readonly kind: 'geometry-observe-cancel'; readonly requestId: number }
  | {
      readonly kind: 'hdr-observe-next';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
    }
  | { readonly kind: 'hdr-observe-cancel'; readonly requestId: number }
  | {
      readonly kind: 'viewport-hit';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly request: import('@forgeax/engine-render').ViewportHitRequest;
    }
  | { readonly kind: 'viewport-hit-cancel'; readonly requestId: number }
  | MeshResidencyRequest
  | ClosedLevelRowRequest
  | {
      readonly kind: 'stage-shader-manifest';
      readonly url?: string;
    }
  | (Pick<
      ExecutionInitMessage,
      | 'startup'
      | 'bootstrapUrl'
      | 'bootstrapData'
      | 'canvas'
      | 'shaderManifestUrl'
      | 'build'
      | 'outputColorSpace'
      | 'renderBackend'
      | 'pipelineLibrary'
      | 'backgroundPipelineLibrary'
      | 'backgroundPipelineLibraryConcurrency'
      | 'viewportHitWarmup'
      | 'dynamicGeometryMeshBudgetBytes'
      | 'staticShadowBudgetBytes'
      | 'assetBudgetBytes'
      | 'featureTextureReadbackBudgetBytes'
      | 'textureMipSkip'
      | 'loadProgressScope'
    > & {
      readonly kind: 'init';
      readonly identity: RenderPublicationIdentity;
      /** Direct Host port for render-submitted / render-complete notices. */
      readonly hostPort?: MessagePort;
      /** Submits background tasks to the Engine Worker's dispatcher. */
      readonly taskPort?: MessagePort;
      readonly worldIdentity: string;
      readonly rhiCapture?: boolean;
      readonly gpuStub?: import('@forgeax/engine-rhi-webgpu').WebGpuStubProfile;
      readonly gpuPassTiming?: GpuPassTimingOptions;
      /** Default-off receipt-owned CPU shadow workload, without additional GPU operations. */
      readonly shadowWorkload?: boolean;
      readonly geometryLane?: ExecutionDiagnosticsOptions['geometryLane'];
      readonly featureReadOnlyDepthBatchDiagnostic?: ExecutionDiagnosticsOptions['featureReadOnlyDepthBatchDiagnostic'];
      readonly gbufferBatchOrderDiagnostic?: ExecutionDiagnosticsOptions['gbufferBatchOrderDiagnostic'];
      readonly renderTaskYield?: ExecutionDiagnosticsOptions['renderTaskYield'];
      readonly renderPipelineCapacity?: ExecutionDiagnosticsOptions['renderPipelineCapacity'];
    })
  | {
      readonly kind: 'draw';
      readonly worldIdentity: string;
      readonly frameId: number;
      readonly width: number;
      readonly height: number;
      readonly publication: RenderPublicationMessage;
      readonly groupSelection?: ClosedLevelFrameChanges;
      readonly sourceFixedStep: number;
      /** Engine Worker World update milliseconds for this published frame. */
      readonly engineUpdateMs?: number;
      /** Engine Worker milliseconds waiting for publication credit before this frame (0 = none). */
      readonly engineCreditWaitMs?: number;
    }
  | {
      readonly kind: 'capture';
      readonly requestId: number;
      readonly options: Omit<CaptureFrameOptions, 'signal'>;
    }
  | {
      readonly kind: 'terrain-height';
      readonly requestId: number;
      readonly frameId: number;
      readonly request: import('@forgeax/engine-render').SubmittedTerrainHeightRequest;
    }
  | { readonly kind: 'capture-cancel'; readonly requestId: number }
  | { readonly kind: 'memory-pressure' }
  | { readonly kind: 'bounds'; readonly requestId: number; readonly entity: number }
  | {
      readonly kind: 'inspect';
      readonly pipelineLibrary?: boolean;
      readonly pipelineLibraryCollection?: boolean;
      readonly pipelineLibraryLimits?: NonNullable<
        NonNullable<
          Parameters<import('@forgeax/engine-render').Renderer['inspect']>[0]
        >['pipelineLibraryLimits']
      >;
      readonly pipelineLibraryRequestedOnly?: boolean;
      readonly runtimeRequests?: boolean;
      readonly fields?: readonly (keyof RenderInspection)[];
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
    }
  | { readonly kind: 'dispose' };
export type RenderWorkerOutput =
  | {
      readonly kind: 'viewport-hit-result';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly result: import('@forgeax/engine-render').ViewportHitResult;
    }
  | import('../configuration-apply').ConfigurationApplyResponse
  | {
      readonly kind: 'geometry-observation-result';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
      readonly result: import('./types').ExecutionGeometryObservationResult;
    }
  | {
      readonly kind: 'hdr-observation-result';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
      readonly result: import('./types').ExecutionHdrObservationResult;
    }
  | MeshResidencyResponse
  | ClosedLevelRowReceipt
  | ClosedLevelFrameSelectionReceipt
  | {
      readonly kind: 'inspect-result';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
      readonly result: ExecutionRendererInspectionResult<Partial<RenderInspection>>;
    }
  | {
      readonly kind: 'renderer-error';
      readonly identity: RenderPublicationIdentity;
      readonly error: SerializedRenderError;
      readonly renderer?: RenderWorkerDiagnostics;
    }
  | {
      readonly kind: 'terrain-height-result';
      readonly requestId: number;
      readonly result: import('@forgeax/engine-render').RenderResult<
        number | undefined,
        import('@forgeax/engine-types').TerrainError
      >;
    }
  | {
      readonly kind: 'bounds-result';
      readonly requestId: number;
      readonly bounds: RenderSceneBounds | undefined;
    }
  | {
      readonly kind: 'capture-result';
      readonly requestId: number;
      readonly result:
        | {
            readonly ok: true;
            /** The materialized container; its buffer is transferred, not cloned. */
            readonly value: {
              readonly kind: 'rhi-tape';
              readonly bytes: Uint8Array<ArrayBuffer>;
              readonly submittedFrame: RhiRemoteCaptureCompletion;
            };
          }
        | { readonly ok: false; readonly error: RhiDebugError };
    }
  | {
      readonly kind: 'ready';
      readonly deviceGeneration: number;
      readonly capabilities: import('@forgeax/engine-rhi').RhiCaps;
      readonly limits?: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: 'submitted';
      readonly frame: ExecutionFrameSubmitted;
      readonly identity: RenderPublicationIdentity;
      readonly revision: number;
      readonly features: readonly SubmittedFeatureReceipt[];
    }
  | {
      readonly kind: 'completed';
      readonly identity: RenderPublicationIdentity;
      readonly completion: RenderFeatureCompletion;
      readonly frame: ExecutionFrameCompletion;
      readonly revision: number;
      readonly buffers: ArrayBuffer[];
      readonly featureTextureReadbacks?: readonly FeatureTextureObservation[];
      readonly featureTextureReadbackError?: SerializedRenderError;
      readonly gpuPassTiming?: GpuPassTimingObservation;
      readonly meshConsumption?: CompletedMeshConsumption;
    }
  | {
      /** Receipt timing, posted when its readback resolves, after the frame's completion. */
      readonly kind: 'gpu-pass-timing';
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly gpuPassTiming: GpuPassTimingObservation;
      /** Frames this session rendered untimed because every timing slot was in flight. */
      readonly skippedFrames: number;
    }
  | {
      readonly kind: 'disposed';
      readonly error?: import('./protocol').ExecutionFaultMessage['detail'];
    }
  | {
      readonly kind: 'failed';
      readonly error: Pick<
        import('./protocol').ExecutionFaultMessage,
        'code' | 'expected' | 'hint' | 'detail'
      >;
      /** Actual Render Worker device facts captured at the failure boundary. */
      readonly renderer?: RenderWorkerDiagnostics;
      readonly stage: RenderWorkerInput['kind'];
      readonly publication?: RenderPublicationIdentity & {
        readonly revision: number;
        readonly frameId: number;
      };
      readonly recoverable: boolean;
    };
