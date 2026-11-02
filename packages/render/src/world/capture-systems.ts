import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { defineComponent } from '@forgeax/engine-ecs';
import { buildCaptureFaces, type CaptureFace } from '../capture/faces';
import type { RendererCaptureOwner } from '../capture/renderer-captures';
import type { CubeCaptureWork } from '../capture/scheduler';
import { preparePlanarCapture } from '../record/frame';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';
import type { CameraSnapshot, RendererError } from '../render-contract';
import { projectAuxiliaryCamerasForView } from '../render-system-extract';
import {
  featureFrameOutcome,
  RENDER_FEATURE_BATCH_SYSTEM,
  RENDER_FEATURE_VIEWS_SYSTEM,
  viewFeatureInputOf,
} from './feature-systems';
import { frameSubmitOutcome } from './frame-submit-systems';
import { ViewRecorder } from './render-views';
import { RenderCommit, RenderPrepare, renderSubmission } from './render-world';
import { readViewField, requireViewField } from './view-field';
import {
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
  type ViewRecordMode,
} from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const CUBE_CAPTURE_COMMIT_SYSTEM = 'cube-capture-commit';
export const RENDER_CAPTURE_SCHEDULE_SYSTEM = 'render-capture-schedule';
export const RENDER_VIEW_CAPTURE_COMMIT_SYSTEM = 'render-view-capture-commit';

/** The Renderer-shared capture work one view records: progressive cube faces and Feature scene inputs. */
export interface ViewCaptureRoute {
  readonly cube: readonly CubeCaptureWork[];
  readonly sceneInputs: readonly CubeCaptureGraphWork[];
}

/** One view's capture work this frame, prepared by `render-capture-schedule`. */
export interface ViewCaptureFrame extends ViewCaptureRoute {
  /** The view's auxiliary target cameras, re-projected against its display camera. */
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  /** Every non-probe face this view records, with the key its cascades fit under. */
  readonly faces: readonly CaptureFace[];
}

/** A view's `render-capture-schedule` outcome; `failed` is a cause its recording rethrows. */
export type ViewCaptureOutcome =
  | { readonly kind: 'prepared'; readonly value: ViewCaptureFrame }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** The Renderer-shared capture schedule one view produced, or the cause its recording rethrows. */
export type ViewCaptureScheduleOutcome =
  | { readonly kind: 'prepared'; readonly value: ViewCaptureRoute }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** Whether this attempt reaches recording, including capture work beside a held display view. */
export function recordsViewWork(
  mode: ViewRecordMode,
  captures: Pick<ViewCaptureFrame, 'cube' | 'sceneInputs' | 'auxiliaryCameras'>,
): boolean {
  return (
    mode === true ||
    captures.cube.length > 0 ||
    captures.sceneInputs.length > 0 ||
    captures.auxiliaryCameras.length > 0
  );
}

interface ViewCaptureWorkState {
  frame: number;
  outcome: ViewCaptureOutcome;
}

/** A recording view's capture work; written only by `render-capture-schedule`. */
export const ViewCaptureWork = defineComponent('ViewCaptureWork', {
  state: 'unique<ViewCaptureWork>',
});

function guarded<T extends { readonly kind: 'prepared' }>(
  run: () => T,
): T | { readonly kind: 'failed'; readonly cause: unknown } {
  try {
    return run();
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

const EMPTY_ROUTE: ViewCaptureRoute = Object.freeze({ cube: [], sceneInputs: [] });

/** The view's capture work prepared this renderer frame; undefined when the system did not run for it. */
export function viewCaptureWorkOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewCaptureOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewCaptureWork)) return undefined;
  const state = world
    .resolveUniqueRef<ViewCaptureWorkState>(
      requireViewField(world, entity, ViewCaptureWork, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** Schedule the Renderer's shared capture work from the first shared view's frame. */
function scheduleRendererCaptures(
  world: World,
  staged: ViewFrameState,
  { internals }: ViewSettlementOwner,
): ViewCaptureRoute {
  const snapshots =
    staged.result?.ok === true ? stagedViewInputs(world, staged).frame.cubeCameras : [];
  return {
    cube: internals.rendererCaptureOwner?.prepare(snapshots) ?? [],
    sceneInputs: recordContext(internals).featureSceneInputs?.work ?? [],
  };
}

/** One view's auxiliary cameras and planar mirror around its shared capture route. */
function prepareViewCaptures(
  world: World,
  staged: ViewFrameState,
  { internals, captures, frameState }: ViewSettlementOwner,
  route: ViewCaptureRoute,
  dropAuxiliary: boolean,
): ViewCaptureFrame {
  if (staged.result?.ok !== true) return { ...route, auxiliaryCameras: [], faces: [] };
  const view = stagedViewInputs(world, staged);
  // Publication carries planar authoring facts from the source realm.
  // Re-project them against this view's selected display camera.
  const auxiliaryCameras = dropAuxiliary
    ? []
    : projectAuxiliaryCamerasForView(view.cameras[0], view.frame.auxiliaryCameras);
  // Only a recording that reaches its captures selects the planar mirror;
  // a held view without capture work keeps its last selection.
  const records = recordsViewWork(view.mode, { ...route, auxiliaryCameras });
  const planar = records
    ? preparePlanarCapture(internals, captures, auxiliaryCameras, frameState.frameNumber)
    : undefined;
  const displayCamera = view.cameras[0];
  const faces =
    displayCamera === undefined
      ? []
      : buildCaptureFaces({
          ...route,
          auxiliaryCameras,
          planar,
          displayCamera,
          physicalOf: (target) => internals.getRenderTargetPhysical?.(target),
        });
  return { ...route, auxiliaryCameras, faces };
}

interface StagedCaptureView {
  readonly entity: EntityHandle;
  readonly staged: ViewFrameState;
  readonly owner: ViewSettlementOwner;
  readonly mode: ViewFrameState['mode'];
  /** The view joins the sealed Feature frame's shared work, as its recording will. */
  readonly shared: boolean;
  readonly stored: ViewCaptureWorkState | undefined;
}

/**
 * The shared capture recorder: the exclusive capture view, else the first
 * display view, else the first view that joins the shared Feature work.
 */
function sharedCaptureRecorder(views: readonly StagedCaptureView[]): StagedCaptureView | undefined {
  const shared = views.filter((view) => view.shared);
  return (
    shared.find((view) => view.mode === 'capture') ??
    shared.find((view) => view.mode === true) ??
    shared[0]
  );
}

/**
 * Register the per-Render-World view capture systems.
 *
 * `render-capture-schedule` (RenderPrepare, after the Feature batch seals)
 * schedules the Renderer's progressive cube faces and Feature scene inputs
 * once, routes them to the shared capture recorder, and prepares every
 * staged view's auxiliary cameras and planar mirror into {@link ViewCaptureWork}.
 * Recording reads that component and never re-runs the scheduler.
 *
 * `render-view-capture-commit` (RenderCommit) settles each prepared planar
 * capture with {@link renderSubmission}: only an accepted frame that recorded
 * it promotes it; any other frame rolls its selection back.
 */
export function registerViewCaptureSystems(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_CAPTURE_SCHEDULE_SYSTEM,
      after: [RENDER_FEATURE_VIEWS_SYSTEM, RENDER_FEATURE_BATCH_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewCaptureWork] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const sealed = featureFrameOutcome(world)?.kind === 'sealed';
        const views: StagedCaptureView[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame || staged.result?.ok !== true) return;
          const input = viewFeatureInputOf(world, entity);
          const stored = readViewField(world, entity, ViewCaptureWork, 'state');
          views.push({
            entity: entity,
            staged,
            owner: ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            mode: staged.mode,
            shared: sealed && input?.kind === 'prepared' && input.value.input !== undefined,
            stored:
              stored === undefined
                ? undefined
                : world.resolveUniqueRef<ViewCaptureWorkState>(stored).unwrap(),
          });
        });
        const recorder = sharedCaptureRecorder(views);
        // The first shared view's frame carries the cube snapshots, as its request did.
        const sharedView = views.find((view) => view.shared);
        const scheduled: ViewCaptureScheduleOutcome | undefined =
          sharedView === undefined
            ? undefined
            : guarded(() => ({
                kind: 'prepared' as const,
                value: scheduleRendererCaptures(world, sharedView.staged, sharedView.owner),
              }));
        const first: { entity: EntityHandle; state: ViewCaptureWorkState }[] = [];
        for (const view of views) {
          const outcome: ViewCaptureOutcome =
            view === recorder && scheduled?.kind === 'failed'
              ? scheduled
              : guarded(() => ({
                  kind: 'prepared' as const,
                  value: prepareViewCaptures(
                    world,
                    view.staged,
                    view.owner,
                    view === recorder && scheduled?.kind === 'prepared'
                      ? scheduled.value
                      : EMPTY_ROUTE,
                    view.shared && view.mode !== true,
                  ),
                }));
          if (view.stored === undefined) {
            first.push({ entity: view.entity, state: { frame, outcome } });
            continue;
          }
          view.stored.frame = frame;
          view.stored.outcome = outcome;
        }
        // A view's first capture work attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewCaptureWork,
              data: { state: world.allocUniqueRef('ViewCaptureWork', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_VIEW_CAPTURE_COMMIT_SYSTEM,
      queries: [{ read: [ViewRecorder, ViewCaptureWork] }],
      fn: (world, [rows]) => {
        const submission = renderSubmission(world);

        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<ViewCaptureWorkState>(
              requireViewField(world, entity, ViewCaptureWork, 'state'),
            )
            .unwrap();
          if (state.frame !== submission.frame) return;
          ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          ).captures.planar?.settle(submission.accepted);
        });
      },
    })
    .unwrap();
}

/**
 * Register the RenderCommit system that settles the Renderer's progressive cube
 * capture with the frame's {@link renderSubmission}: an accepted submission
 * advances the recorded faces at its GPU completion; a rejected or abandoned
 * one aborts the candidate without advancing the target's history.
 */
export function registerCaptureSystems(
  world: World,
  owner: RendererCaptureOwner,
  report: (error: RendererError) => void,
): void {
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: CUBE_CAPTURE_COMMIT_SYSTEM,
      queries: [],
      fn: (world) => {
        const submission = renderSubmission(world);
        const completed = owner.complete(
          submission.accepted && frameSubmitOutcome(world).captureReady,
          submission.completion,
        );
        if (!completed.ok) report(completed.error);
      },
    })
    .unwrap();
}
