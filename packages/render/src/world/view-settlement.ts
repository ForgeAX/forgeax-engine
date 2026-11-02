import type { World } from '@forgeax/engine-ecs';
import type { RhiDevice, RhiTextureFormatCapabilityReceipt } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import type { createPostProcessParamsOwner } from '../assembly/post-process-params';
import type { PendingRenderFeatureErrorReport } from '../features/error-reporting';
import type { MotionBlurValidationError } from '../features/motion-blur/motion-blur-params';
import type { PreparedResolverDeps } from '../features/prepared-resolver';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import type { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { MaterialTextureSourceInspection } from '../inspection-types';
import type { InstanceProjectionStore } from '../instances';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { LodInspectionOwner } from '../record/lod-inspection';
import type { RenderSystemInternals } from '../record/render-context';
import type { SkinTaskBinding } from '../record/skin-tasks';
import type { CubeCaptureGraphState } from '../record/target-capture-graph';
import type { ReflectionProbeRecordOwner } from '../reflection/record-owner';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentRenderScene } from '../scene/render-scene';
import type { SurfaceSubmissionObservationOwner } from '../surface/submission-observation';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCommit, renderSubmission } from './render-world';
import { requireViewField } from './view-field';

/** RenderCommit: the accepted attempt's staged shadow candidate becomes shadow history. */
export const RENDER_SHADOW_COMMIT_SYSTEM = 'render-shadow-commit';
/** RenderCleanup: an uncommitted shadow candidate is dropped and its mesh lease released. */
export const RENDER_SHADOW_DISCARD_SYSTEM = 'render-shadow-discard';

/** RenderCommit: the accepted scene submission publishes its staged environment generation. */
export const RENDER_ENVIRONMENT_COMMIT_SYSTEM = 'render-environment-commit';
/** RenderCommit: the accepted scene submission publishes its staged atmosphere storage. */
export const RENDER_ATMOSPHERE_COMMIT_SYSTEM = 'render-atmosphere-commit';
/** RenderCommit: the accepted scene submission promotes its staged volumetric fog. */
export const RENDER_FOG_COMMIT_SYSTEM = 'render-fog-commit';
/** RenderCleanup: a rejected attempt discards its environment and atmosphere candidates. */
export const RENDER_ENVIRONMENT_DISCARD_SYSTEM = 'render-environment-discard';

/** RenderCommit: the accepted submission's completion pins the view's Skin task buffers and roots. */
export const RENDER_SKIN_TRACK_SYSTEM = 'render-skin-track';
/** RenderCleanup: the view's recording Skin lifecycle completes after the record retirement. */
export const RENDER_SKIN_COMPLETE_SYSTEM = 'render-skin-complete';

/** RenderCommit: the accepted display submission commits the prepared GPU-driven frame's resources. */
export const RENDER_GPU_DRIVEN_COMMIT_SYSTEM = 'render-gpu-driven-commit';
/** RenderCleanup: a prepared GPU-driven frame that did not commit is aborted. */
export const RENDER_GPU_DRIVEN_ABORT_SYSTEM = 'render-gpu-driven-abort';

/** Staged-candidate commit systems registered after the temporal ones, in registration order. */
export const RENDER_SETTLEMENT_COMMIT_SYSTEMS: readonly string[] = [
  RENDER_SHADOW_COMMIT_SYSTEM,
  RENDER_ENVIRONMENT_COMMIT_SYSTEM,
  RENDER_ATMOSPHERE_COMMIT_SYSTEM,
  RENDER_FOG_COMMIT_SYSTEM,
  RENDER_GPU_DRIVEN_COMMIT_SYSTEM,
  RENDER_SKIN_TRACK_SYSTEM,
];
/** Staged-candidate cleanup systems registered after the temporal discard, in registration order. */
export const RENDER_SETTLEMENT_CLEANUP_SYSTEMS: readonly string[] = [
  RENDER_SHADOW_DISCARD_SYSTEM,
  RENDER_ENVIRONMENT_DISCARD_SYSTEM,
  RENDER_GPU_DRIVEN_ABORT_SYSTEM,
  RENDER_SKIN_COMPLETE_SYSTEM,
];

/**
 * A view recorder's owner bag: its frame state, the runtime that owns it and
 * the per-view owners Render World systems prepare or settle. Every per-view
 * system (temporal, environment, shadow, GI, reflection probes, ...) reaches
 * the view's state through this one handle.
 */
export interface ViewSettlementOwner {
  readonly frameState: RenderFrameState;
  readonly internals: RenderSystemInternals;
  /** The view's recording Skin lifecycle, tracked and completed by the Skin systems. */
  readonly skin: SkinSettlement;
  /** The view's scene: its GPU scene, raster lane and the shared probe projection. */
  readonly scene: PersistentRenderScene;
  /** The view's reflection-probe table, captures and fallback; prepared by `view-reflection-probes`. */
  readonly reflectionProbes: ReflectionProbeRecordOwner;
  /** The SSR format-capability receipt of each device this view recorded on. */
  readonly ssrFormats: WeakMap<RhiDevice, RhiTextureFormatCapabilityReceipt>;
  /** The view's progressive cube and planar capture state; the capture systems prepare and settle it. */
  readonly captures: CubeCaptureGraphState;
  /** The view's post-process parameter buffers and pipeline caches; the Feature plan systems drive them. */
  readonly postProcess: PostProcessSettlement;
  /** Live render-system state a Feature's prepared graphics resolver reads. */
  readonly preparedResolver: PreparedResolverDeps;
  /** The view's LOD/occlusion inspection cell. */
  readonly lod: LodInspectionOwner;
  /** The view's GPU-driven production; replaced when the device recovers. */
  readonly gpuDriven: GpuDrivenProduction;
  /** The view's same-submit surface counters, joined by the LOD observation. */
  readonly surfaceSubmission: SurfaceSubmissionObservationOwner;
  /** The view's instance projection store; its residency facts are inspected per frame. */
  readonly instanceCollections: InstanceProjectionStore;
  /** Facts of the view's last record attempt that inspection projects. */
  readonly recorded: ViewRecordFacts;
  /** Frame input scopes, profiler identity and counters of this view; one data authority. */
  readonly recording: ViewRecordingState;
  /** Record this view's staged `ViewFrame` of the current Render World frame. */

  /**
   * Release the view's frame-state GPU bookkeeping when its recorder retires
   * or the Renderer disposes. Idempotent; the first failure is rethrown after
   * every step ran.
   */
  disposeFrameState(): void;
}

/** The recording state formerly captured by the RenderSystem constructor. */
export interface ViewRecordingState {
  preparedWorlds: readonly RenderResourceScope[];
  directFrameId: number;
  readonly dispatchCounts: { unlit: number };
  readonly pendingFeatureErrors: Map<string, PendingRenderFeatureErrorReport>;
}

/** Facts one view's record attempt leaves for inspection; the recording writes them. */
export interface ViewRecordFacts {
  /** The display camera of the last scene the view prepared; cleared by a motion-blur parameter failure. */
  camera: CameraSnapshot | undefined;
  /** The last public motion-blur parameter failure; cleared after a valid extraction. */
  motionBlurInvalidParams: MotionBlurValidationError | undefined;
  /** Frustum-culling counters of the last extracted frame. */
  frustum: { readonly culled: number; readonly total: number };
  /** Candidate entities rejected by author visibility in the last frame. */
  readonly visibility: { explicitlyHidden: number };
  /** Material texture-source probe counters of the last extraction that ran the probe. */
  materialTextureSources: MaterialTextureSourceInspection;
  /** Cache-miss bind groups created by the last recording; reset when its features prepare. */
  readonly bindGroups: { createBindGroup: number; keys: string[] };
}

/** The post-process owner of a view and the pipeline caches it retires. */
export interface PostProcessSettlement {
  readonly params: ReturnType<typeof createPostProcessParamsOwner>;
  clearPipelineCache(id: string): void;
  clearPipelineEntry(id: string, entry: PostProcessShaderEntry): void;
  invalidateModule(id: string): void;
}

/** The recording Skin lifecycle the Render World Skin systems drive. */
export interface SkinSettlement {
  /** Bytes of palette uploads this recording has staged. */
  readonly paletteUploadBytes: number;
  /** Open the view's recording Skin frame; `render-view-frame` calls it once per staged view. */
  beginRecording(): void;
  /** Compose and upload the palettes of the CPU Skin rows a view may draw, keyed by `worldEntityKey`. */
  prepareDemand(
    rows: Iterable<Pick<RenderableSnapshot, 'worldId' | 'entityKey'>>,
  ): Map<number, SkinTaskBinding | undefined>;
  /** The submitted work pins this recording's task buffers and Scene roots until completion. */
  trackSubmittedWork(completed: Promise<void>): void;
  /** Retire task buffers and advance or discard Scene roots; every failure cause is returned. */
  complete(sceneAccepted: boolean): unknown[];
}

/** The owner bag `createRendererState` published on its record internals. */
export function viewOwnerOf(
  internals: Pick<RenderSystemInternals, 'viewOwner'>,
): ViewSettlementOwner {
  const owner = internals.viewOwner;
  if (owner === undefined) throw new Error('createRendererState publishes the view owner bag');
  return owner;
}

/** The owner bag a view recorder's unique state stores. */
export function ownerOf(world: World, state: Handle<string, 'unique'>): ViewSettlementOwner {
  return world.resolveUniqueRef<{ readonly owner: ViewSettlementOwner }>(state).unwrap().owner;
}

/**
 * Register a RenderCommit system running `commit` for each view whose attempt
 * of this frame was accepted; `scene` additionally requires a submitted scene.
 */
export function registerViewCommit(
  world: World,
  name: string,
  commit: (owner: ViewSettlementOwner, world: World) => void,
  after: string,
  scene = false,
): void {
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name,
      queries: [{ read: [ViewRecorder, ViewSubmission] }],
      after: [after],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          if (
            !requireViewField(world, entity, ViewSubmission, 'accepted') ||
            requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
          )
            return;
          if (scene && !requireViewField(world, entity, ViewSubmission, 'scene')) return;
          commit(ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')), world);
        });
      },
    })
    .unwrap();
}
