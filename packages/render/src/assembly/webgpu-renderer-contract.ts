import type { RhiCanvasContext, RhiCanvasTarget, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { ImportTransport } from '@forgeax/engine-types';
import type { RenderFeatureHost } from '../features/host';
import type {
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../lifecycle';
import type { OutputColorSpaceState } from '../output-color-space';
import type { GpuPassTimingError } from '../record/gpu-pass-timing/errors.js';
import type {
  GpuPassTimingCapture,
  GpuPassTimingFrameIdentity,
} from '../record/gpu-pass-timing/index.js';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  FrameObservationDomain,
  RenderDebugOverlay,
  RendererOptions,
  RenderPipelineObservationCaptureOwner,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import type { RhiBackendPack } from './backend-contract';
import type { BundlerOptions } from './bundler-contract';
import type { RendererAssemblyImplementation } from './host-contract';
import type { MeshSsboGrowResult, MeshSsboState } from './mesh-ssbo-grow';

export type WebGPUOutcome =
  | { kind: 'ok'; renderer: RendererAssemblyImplementation }
  | { kind: 'rhi-err'; error: RhiError }
  | { kind: 'throw'; error: Error };

export interface WebGPURendererInternals {
  canvas: RhiCanvasTarget;
  device: RhiDevice;
  context: RhiCanvasContext;
  options: RendererOptions | undefined;
  bundler: BundlerOptions | undefined;
  lostRegistry: LostListenerRegistry;
  errorRegistry: RhiErrorListenerRegistry;
  healthRegistry: HealthListenerRegistry;
  pack: RhiBackendPack;
  importTransport?: ImportTransport | undefined;
  growMeshSsbo?: (neededMeshSlots: number, neededMaterialSlots: number) => MeshSsboGrowResult;
  meshSsboState?: MeshSsboState;
  featureHost?: RenderFeatureHost;
  debugOverlay?: RenderDebugOverlay;
  volumetricFogShaders?: VolumetricFogShaderSources | undefined;
  ssrShaders?: SsrShaderSources | undefined;
  depthPyramidShaders?: DepthPyramidShaderSources | undefined;
  atmosphereShaders?: AtmosphereShaderSources | undefined;
  standardDeferredShaders?:
    | import('../pipeline/standard-deferred-lighting').StandardDeferredShaderSources
    | undefined;
  gpuPassTimingSubmittedWork?: Promise<void> | undefined;
  /** Null retires the loss observer when the Renderer is disposed. */
  lossObserver: { current: ((detail: string) => void) | null };
  /** Public output colour-space request and its current surface negotiation. */
  outputColorSpace: OutputColorSpaceState;
  generationState: {
    current: number;
    onStaleLoss?: () => void;
  };
  getMaterialShaderUvSetCount?: (materialShaderId: string) => number | undefined;
  gpuPassTimingFrameIdentity?: GpuPassTimingFrameIdentity | undefined;
  gpuPassTimingCapture?: GpuPassTimingCapture | undefined;
  gpuPassTimingBeginReason?: GpuPassTimingError | undefined;
  observationCaptureOwner?: RenderPipelineObservationCaptureOwner;
  observationCaptureDomains?: readonly FrameObservationDomain[] | undefined;
  observationFrameId?: number | undefined;
  observationGraphGeneration?: number | undefined;
}
