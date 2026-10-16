import type { MipmapEncoderWork } from '@forgeax/engine-assets-runtime';
import type { Buffer, RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { RenderFeatureHost } from '../features/host';
import type { RenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RecoveryPipelineReadiness } from '../record/recovery-pipeline';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { RenderFeatureGraphCandidate } from '../record/typed-frame-graph';
import type { PersistentGpuDrivenCandidate } from '../scene/render-scene';

/** The single Points/Lines owner's staged device-generation handoff. */
export interface RecoveryPointsLinesCandidate {
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
  publish(): void;
  release(): void;
}

/** Candidate-only device/runtime inputs used by the recovery prepare seam. */
export interface RecoveryGraphCandidateRuntime {
  readonly internals: RenderSystemInternals;
  readonly pipelineState: PipelineState;
}

/** Detached graph state prepared on a replacement device, before publication. */
export interface RecoveryGraphCandidate {
  readonly frameState: RenderFrameState;
  readonly setupWorks: readonly MipmapEncoderWork[];
  readonly device: RhiDevice;
  readonly generation: number;
  readonly gpuDrivenProduction?: GpuDrivenProduction;
  readonly gpuDrivenScene?: PersistentGpuDrivenCandidate;
  /** Staged CPU-expanded Points/Lines buffers owned by the same RenderSystem. */
  readonly pointsLines?: RecoveryPointsLinesCandidate;
  readonly featureHost?: RenderFeatureHost;
  readonly featureGpuWork?: RenderFeatureGpuWorkOwner;
  readonly featureSceneInputs?: RenderSystemInternals['featureSceneInputs'];
  readonly featureGraphCandidate?: RenderFeatureGraphCandidate;
  readonly postProcessPipelines?: ReadonlyMap<string, RenderPipeline>;
  readonly recoveryReadiness: RecoveryPipelineReadiness;
  /** Release all candidate roots before publication; safe to call repeatedly. */
  readonly release: () => void;
  /** Transfer candidate-root ownership to the published RenderSystem. */
  readonly markPublished: () => void;
}

/** Candidate setup completion; completion is bounded by the recovery owner. */
export interface RecoveryGraphSetupSubmission {
  readonly completion?: PromiseLike<unknown>;
}

export type RecoveryGraphCandidatePreparation =
  | { readonly kind: 'no-seed' }
  | { readonly kind: 'ready'; readonly candidate: RecoveryGraphCandidate }
  | { readonly kind: 'failed'; readonly reason: string; readonly cause?: unknown };

/** Explicit candidate-owned inputs for lifecycle-root preparation. */
export interface RecoveryRootRuntime {
  readonly scope: DeviceScope;
  readonly device: RhiDevice;
  readonly gpuStore: GpuResidencyCache;
  readonly graphCandidate?: RecoveryGraphCandidate | undefined;
}

/** Candidate roots plus the one synchronous owner switch at publication. */
export interface RecoveryRootBundle {
  readonly roots: readonly LifecycleResourceSpec<unknown>[];
  publish(): void;
  discard(): void;
}

/** Device-bound post-process resources prepared off to the side of the active renderer. */
export interface RecoveryPostProcessResources {
  readonly device: RhiDevice;
  readonly paramsBuffers: Map<string, Buffer>;
}
