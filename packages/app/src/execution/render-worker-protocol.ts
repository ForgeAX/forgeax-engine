import type {
  DynamicGeometryError,
  GpuPassTimingObservation,
  GpuPassTimingOptions,
  MeshResidencyError,
  PublishedMeshPreparation,
  RenderInspection,
  RenderPublication,
  RenderPublicationError,
  RenderPublicationIdentity,
  RenderSceneBounds,
} from '@forgeax/engine-render';
import type { CaptureFrameOptions, RhiDebugError } from '@forgeax/engine-rhi-debug';
import type { RhiRemoteCaptureCompletion } from '../internal/rhi-capture';
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
      readonly kind: 'mesh-prepare';
      readonly requestId: number;
      readonly input: PublishedMeshPreparation;
      readonly entity?: number;
    }
  | {
      readonly kind: 'mesh-release';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly evict: boolean;
    };
export type MeshResidencyResponse = {
  readonly kind: 'mesh-ready' | 'mesh-released';
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

export type RenderWorkerInput =
  | {
      readonly kind: 'geometry-observe-next';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
    }
  | { readonly kind: 'geometry-observe-cancel'; readonly requestId: number }
  | MeshResidencyRequest
  | (Pick<
      ExecutionInitMessage,
      | 'bootstrapUrl'
      | 'bootstrapData'
      | 'canvas'
      | 'shaderManifestUrl'
      | 'build'
      | 'outputColorSpace'
      | 'pipelineLibrary'
      | 'dynamicGeometryMeshBudgetBytes'
      | 'assetBudgetBytes'
      | 'loadProgressScope'
    > & {
      readonly kind: 'init';
      readonly identity: RenderPublicationIdentity;
      /** Direct Host port for render-submitted / render-complete notices. */
      readonly hostPort?: MessagePort;
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
      readonly publication: RenderPublication;
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
  | { readonly kind: 'bounds'; readonly requestId: number; readonly entity: number }
  | {
      readonly kind: 'inspect';
      readonly pipelineLibrary?: boolean;
      readonly fields?: readonly (keyof RenderInspection)[];
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
    }
  | { readonly kind: 'dispose' };
export type RenderWorkerOutput =
  | {
      readonly kind: 'geometry-observation-result';
      readonly requestId: number;
      readonly identity: RenderPublicationIdentity;
      readonly worldIdentity: string;
      readonly result: import('./types').ExecutionGeometryObservationResult;
    }
  | MeshResidencyResponse
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
      readonly revision: number;
      readonly features: readonly { readonly identity: string; readonly feedback: unknown }[];
    }
  | {
      readonly kind: 'completed';
      readonly frame: ExecutionFrameCompletion;
      readonly revision: number;
      readonly buffers: ArrayBuffer[];
      readonly gpuPassTiming?: GpuPassTimingObservation;
      readonly meshConsumption?: CompletedMeshConsumption;
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
