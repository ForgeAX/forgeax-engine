import {
  type Component,
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { setDerivedComponent } from '@forgeax/engine-ecs/projection';
import { mat4 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import {
  commitStandardOutputSubmission,
  discardStandardOutputStates,
  prepareStandardOutputResources,
  retirePendingStandardOutputGpu,
  stageStandardOutputStates,
} from '../pipeline/standard-output/resources';
import { renderTime } from '../publication/resource-scope';
import { resolveQueuedFrameTemporal } from '../record/frame';
import { activeFrameCameras } from '../record/frame-snapshot';
import { frameTargetExtent } from '../record/frame-targets';
import { computeViewProjectionMatrix } from '../record/helpers';
import type { RenderSystemInternals } from '../record/render-context';
import { hasLiveStandardOutputState } from '../render-system-record-attempt';
import {
  abortStagedTemporalGpuState,
  commitStagedTemporalGpuState,
  retireActiveTemporalGpuState,
} from '../temporal/gpu';
import { ViewGraphSeal, type ViewGraphSealState } from './graph-seal-systems';
import { viewLightsOf } from './render-lights';
import { ViewRecorder, ViewSubmission } from './render-views';
import {
  RenderCleanup,
  RenderPrepare,
  RenderQueue,
  renderSubmission,
  renderWorldFor,
} from './render-world';
import {
  RENDER_STANDARD_LIGHTING_SYSTEM,
  viewStandardLightingOf,
} from './standard-lighting-systems';
import { RENDER_RECORD_COMMIT_SYSTEM } from './submission-systems';
import { EMPTY_VIEW_STATE_UPDATE, readViewField, requireViewField } from './view-field';
import { stagedViewInputs, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { RENDER_VIEW_GRAPH_PREPARE_SYSTEM } from './view-record-systems';
import type { ViewSettlementOwner as TemporalOwner } from './view-settlement';
import { ownerOf, registerViewCommit } from './view-settlement';

/*
 * Temporal history of a view: TAA/CloudLayer frame transaction, GPU ping-pong
 * state, cloud history demand, the temporal view, and the Standard output
 * (auto-exposure, LUT) candidates. Recording only stages them. They advance
 * here, in RenderCommit, only for the view's accepted attempt of this frame
 * that submitted its scene picture; every candidate still staged afterwards
 * (rejected submit, preparation-only or pending attempt, device loss, aborted
 * or unrecorded attempt) is discarded in RenderCleanup and never advances
 * history, so the accepted temporal view never runs ahead of the GPU history.
 * A preparation-only attempt keeps only its staged Standard output GPU
 * resources pending, since no pass wrote them.
 */

/** RenderCommit: the accepted attempt's staged TAA frame transaction commits. */
export const RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM = 'render-temporal-frame-commit';
/** RenderCommit: the staged TAA/CloudLayer GPU writer becomes the accepted history. */
export const RENDER_TEMPORAL_GPU_COMMIT_SYSTEM = 'render-temporal-gpu-commit';
/** RenderCommit: the staged cloud history demand becomes active. */
export const RENDER_CLOUD_HISTORY_COMMIT_SYSTEM = 'render-cloud-history-commit';
/** RenderCommit: the staged temporal view is published; an off view retires idle history. */
export const RENDER_TEMPORAL_VIEW_COMMIT_SYSTEM = 'render-temporal-view-commit';
/** RenderCommit: staged auto-exposure and LUT candidates are promoted. */
export const RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM = 'render-standard-output-commit';
/** The temporal commit systems in their dependency order. */
export const RENDER_TEMPORAL_COMMIT_SYSTEMS: readonly string[] = [
  RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM,
  RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM,
  RENDER_TEMPORAL_GPU_COMMIT_SYSTEM,
  RENDER_CLOUD_HISTORY_COMMIT_SYSTEM,
  RENDER_TEMPORAL_VIEW_COMMIT_SYSTEM,
];
/** RenderCleanup: whatever temporal candidate is still staged is discarded. */
export const RENDER_TEMPORAL_DISCARD_SYSTEM = 'render-temporal-discard';

function retireFailure(internals: RenderSystemInternals): (cause: unknown) => void {
  return (cause) =>
    internals.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'submitted temporal resources remain valid until queue completion',
        hint: `temporal resource retirement failed: ${String(cause)}`,
      }),
    );
}

function commitTemporalFrame({ frameState, internals }: TemporalOwner): void {
  if (!frameState.temporalFrameTransaction.inspect().staged) return;
  const temporal = frameState.temporalFrameTransaction.commit({ accepted: true });
  if (temporal.ok) return;
  internals.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'the staged temporal frame to commit after queue submission',
      hint: 'discard the temporal candidate and retry the next frame',
      detail: { error: temporal.error },
    }),
  );
}

function commitTemporalGpu({ frameState, internals }: TemporalOwner): void {
  commitStagedTemporalGpuState(frameState, internals.device.queue, {
    onReplaced: () => internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve'),
    onRetireFailure: retireFailure(internals),
  });
}

function commitCloudHistory({ frameState }: TemporalOwner): void {
  const staged = frameState.pendingCloudHistoryActive;
  if (staged === undefined) return;
  frameState.cloudHistoryActive = staged;
  delete frameState.pendingCloudHistoryActive;
}

function commitTemporalView({ frameState, internals }: TemporalOwner): void {
  if (frameState.temporalView.commit() !== 'off' || frameState.cloudHistoryActive === true) return;
  internals.clearPostProcessPipelineCache?.('forgeax.taa-resolve');
  // Retire frame-sized resources, not the device-owned prewarmed shader. The
  // next TAA frame must not start an async cold compile.
  retireActiveTemporalGpuState(frameState, internals.device.queue, retireFailure(internals));
}

/**
 * Discard every candidate still staged. An accepted preparation-only attempt
 * (`preparationOnly`) never ran the Standard output passes, so its staged
 * auto-exposure/LUT GPU resources hold no history and stay pending for the
 * next scene attempt on the same device instead of being reallocated by every
 * preparation barrier; every other uncommitted attempt retires them.
 */
function discardTemporal({ frameState }: TemporalOwner, preparationOnly: boolean): void {
  if (frameState.temporalFrameTransaction.inspect().staged)
    frameState.temporalFrameTransaction.commit({ accepted: false });
  abortStagedTemporalGpuState(frameState);
  delete frameState.pendingCloudHistoryActive;
  frameState.temporalView.discard();
  discardStandardOutputStates(frameState);
  if (!preparationOnly) retirePendingStandardOutputGpu(frameState);
}

/**
 * Register the temporal commit and discard systems on a Render World once.
 * The commits chain in the order their state depends on: the view commit reads
 * the cloud history the previous commit published and retires GPU history the
 * GPU commit just replaced.
 */
export function registerTemporalSystems(world: World): void {
  registerViewCommit(
    world,
    RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM,
    commitTemporalFrame,
    RENDER_RECORD_COMMIT_SYSTEM,
    true,
  );
  registerViewCommit(
    world,
    RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM,
    ({ frameState, internals }) =>
      commitStandardOutputSubmission(frameState, internals.device.queue),
    RENDER_TEMPORAL_FRAME_COMMIT_SYSTEM,
    true,
  );
  registerViewCommit(
    world,
    RENDER_TEMPORAL_GPU_COMMIT_SYSTEM,
    commitTemporalGpu,
    RENDER_STANDARD_OUTPUT_COMMIT_SYSTEM,
    true,
  );
  registerViewCommit(
    world,
    RENDER_CLOUD_HISTORY_COMMIT_SYSTEM,
    commitCloudHistory,
    RENDER_TEMPORAL_GPU_COMMIT_SYSTEM,
    true,
  );
  registerViewCommit(
    world,
    RENDER_TEMPORAL_VIEW_COMMIT_SYSTEM,
    commitTemporalView,
    RENDER_CLOUD_HISTORY_COMMIT_SYSTEM,
    true,
  );
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_TEMPORAL_DISCARD_SYSTEM,
      queries: [{ read: [ViewRecorder], optional: [ViewSubmission] }],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          const preparationOnly =
            readViewField(world, entity, ViewSubmission, 'accepted') === true &&
            requireViewField(world, entity, ViewSubmission, 'attempt') === frame &&
            !requireViewField(world, entity, ViewSubmission, 'scene');
          discardTemporal(
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            preparationOnly,
          );
        });
      },
    })
    .unwrap();
}

/** RenderPrepare: a display view stages this frame's TAA/CloudLayer frame transaction candidate. */
export const RENDER_TEMPORAL_STAGE_SYSTEM = 'render-temporal-stage';
/** RenderPrepare: a view prepares its Standard output resources and stages the auto-exposure/LUT candidates. */
export const RENDER_STANDARD_OUTPUT_STAGE_SYSTEM = 'render-standard-output-stage';

/**
 * What `render-temporal-stage` did for a view this frame. `skipped`: the view
 * does not record a display picture or its lighting was not admitted, so there
 * is no temporal candidate. `failed` is reported on the error registry and
 * leaves nothing staged, so history cannot advance.
 */
export type TemporalStageOutcome =
  | {
      readonly kind: 'staged';
      readonly frameId: number;
      readonly currentViewProjection: Float32Array;
    }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly cause: unknown };

/**
 * What `render-standard-output-stage` did for a view. `rejected`: resource
 * preparation returned a structured error the recording reports and then
 * records nothing. `failed`: an unexpected cause the recording rethrows inside
 * its own record recovery.
 */
export type StandardOutputStageOutcome =
  | { readonly kind: 'staged' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'rejected'; readonly error: RhiError }
  | { readonly kind: 'failed'; readonly cause: unknown };

interface ViewStageState<T> {
  frame: number;
  outcome: T;
}

/** A view's frame-stamped temporal stage outcome; written only by `render-temporal-stage`. */
export const ViewTemporalStage = defineComponent('ViewTemporalStage', {
  state: 'unique<ViewTemporalStage>',
});
/** A view's frame-stamped Standard output stage outcome; written only by `render-standard-output-stage`. */
export const ViewStandardOutputStage = defineComponent('ViewStandardOutputStage', {
  state: 'unique<ViewStandardOutputStage>',
});

type StageComponent = Component<string, { readonly state: `unique<${string}>` }>;

function stageOutcomeOf<T>(
  world: World,
  entity: EntityHandle | undefined,
  component: StageComponent,
): T | undefined {
  if (entity === undefined || !world.hasComponent(entity, component)) return undefined;
  const state = world
    .resolveUniqueRef<ViewStageState<T>>(requireViewField(world, entity, component, 'state'))
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** The view's temporal stage written this renderer frame; undefined when the system did not run for it. */
export function viewTemporalStageOf(
  world: World,
  entity: EntityHandle | undefined,
): TemporalStageOutcome | undefined {
  return stageOutcomeOf<TemporalStageOutcome>(world, entity, ViewTemporalStage);
}

/**
 * The Standard output this recording draws with: the preparation
 * `render-standard-output-stage` ran for the recorded view. A rejected
 * preparation is returned for the recording to report; an unexpected cause
 * rethrows inside its record recovery.
 */
export function consumeViewStandardOutput(
  internals: RenderSystemInternals,
): Exclude<StandardOutputStageOutcome, { readonly kind: 'failed' }> {
  const outcome = stageOutcomeOf<StandardOutputStageOutcome>(
    renderWorldFor(internals),
    internals.viewEntity,
    ViewStandardOutputStage,
  );
  if (outcome === undefined)
    throw new Error(`${RENDER_STANDARD_OUTPUT_STAGE_SYSTEM} did not stage the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  return outcome;
}

/** A staged view that records, with the facts both stage systems read. */
interface StageableView {
  readonly entity: EntityHandle;
  readonly owner: TemporalOwner;
  readonly staged: ViewFrameState;
}

function stageableViews(
  world: World,
  rows: Iterable<{ readonly entity: EntityHandle }>,
  frame: number,
): StageableView[] {
  const views: StageableView[] = [];
  for (const row of rows) {
    const entity = row.entity;

    const staged = world
      .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
      .unwrap();
    if (staged.frame !== frame || staged.result?.ok !== true) continue;
    // A view whose lighting was not admitted records nothing this frame.
    if (viewStandardLightingOf(world, entity)?.kind !== 'prepared') continue;
    if (viewLightsOf(world, entity) === undefined) continue;
    views.push({
      entity: entity,
      owner: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
      staged,
    });
  }
  return views;
}

function storeStage<T>(
  world: World,
  component: StageComponent,
  stored: readonly { readonly entity: EntityHandle; readonly outcome: T }[],
  frame: number,
): void {
  for (const { entity, outcome } of stored) {
    if (world.hasComponent(entity, component)) {
      const state = world
        .resolveUniqueRef<ViewStageState<T>>(requireViewField(world, entity, component, 'state'))
        .unwrap();
      state.frame = frame;
      state.outcome = outcome;
    } else
      world
        .addComponent(entity, {
          component,
          data: { state: world.allocUniqueRef(component.name, { frame, outcome }) },
        })
        .unwrap();
  }
}

function stageTemporalFrame(
  { frameState, internals }: TemporalOwner,
  staged: ViewFrameState,
): TemporalStageOutcome {
  if (staged.mode !== true || staged.result?.ok !== true) return { kind: 'skipped' };
  try {
    const camera = activeFrameCameras(staged.result.value.cameras)[0];
    if (camera === undefined) return { kind: 'skipped' };
    const currentViewProjection = computeViewProjectionMatrix(camera, mat4.create());
    const { targetW, targetH } = frameTargetExtent(internals, false);
    frameState.temporalFrameTransaction.stage({
      frameId: frameState.frameNumber,
      currentViewProjection,
      jitter: [0, 0],
      viewport: { width: targetW, height: targetH },
      cameraPosition: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0],
    });
    return { kind: 'staged', frameId: frameState.frameNumber, currentViewProjection };
  } catch (cause) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the temporal frame to stage before recording',
        hint: 'the view records without advancing temporal history this frame',
        detail: { error: { code: 'temporal-stage-failed', message: String(cause) } },
      }),
    );
    return { kind: 'failed', cause };
  }
}

function stageStandardOutput(
  world: World,
  { frameState, internals }: TemporalOwner,
  staged: ViewFrameState,
): StandardOutputStageOutcome {
  try {
    const view = stagedViewInputs(world, staged);
    const camera = view.cameras[0];
    if (!hasLiveStandardOutputState(frameState, camera?.output)) return { kind: 'skipped' };
    const cameraScope = view.scopes[view.composition.owners.cameraOwner];
    if (cameraScope === undefined) return { kind: 'skipped' };
    const prepared = prepareStandardOutputResources(frameState, internals, camera, cameraScope);
    if (!prepared.ok) return { kind: 'rejected', error: prepared.error };
    if (hasLiveStandardOutputState(frameState, camera?.output)) {
      const deltaTime = renderTime(cameraScope).delta;
      stageStandardOutputStates(
        frameState,
        internals,
        camera,
        Number.isFinite(deltaTime) ? Math.max(0, deltaTime) : 0,
      );
    }
    return { kind: 'staged' };
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/**
 * Register `render-temporal-stage` and `render-standard-output-stage`
 * (RenderPrepare, after `render-standard-lighting`): each recording view
 * stages its TAA/CloudLayer frame candidate and its auto-exposure/LUT
 * candidates before its recording runs. The RenderCommit systems above
 * promote them for an accepted scene submission and RenderCleanup discards
 * the rest. A failure is stored (and reported), never thrown.
 */
export const RENDER_TEMPORAL_RESOLVE_SYSTEM = 'render-temporal-resolve';

export function registerTemporalStageSystems(world: World): void {
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_TEMPORAL_RESOLVE_SYSTEM,
      after: [RENDER_VIEW_GRAPH_PREPARE_SYSTEM],
      queries: [{ write: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          setDerivedComponent(world, entity, ViewGraphSeal, EMPTY_VIEW_STATE_UPDATE).unwrap();
          const state = world
            .resolveUniqueRef<ViewGraphSealState>(
              requireViewField(world, entity, ViewGraphSeal, 'state'),
            )
            .unwrap();
          if (state.frame !== frame || state.prepared === undefined || state.temporal !== undefined)
            return;
          try {
            state.temporal = resolveQueuedFrameTemporal(state.prepared);
          } catch (cause) {
            state.temporal = { kind: 'failed', cause };
          }
        });
      },
    })
    .unwrap();
  const query = { read: [ViewRecorder, ViewFrame] as const };
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_TEMPORAL_STAGE_SYSTEM,
      after: [RENDER_STANDARD_LIGHTING_SYSTEM],
      queries: [query],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const stored = stageableViews(world, rows, frame).map(({ entity, owner, staged }) => ({
          entity,
          outcome: stageTemporalFrame(owner, staged),
        }));
        storeStage(world, ViewTemporalStage, stored, frame);
      },
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_STANDARD_OUTPUT_STAGE_SYSTEM,
      after: [RENDER_STANDARD_LIGHTING_SYSTEM],
      queries: [query],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const stored = stageableViews(world, rows, frame).map(({ entity, owner, staged }) => ({
          entity,
          outcome: stageStandardOutput(world, owner, staged),
        }));
        storeStage(world, ViewStandardOutputStage, stored, frame);
      },
    })
    .unwrap();
}
