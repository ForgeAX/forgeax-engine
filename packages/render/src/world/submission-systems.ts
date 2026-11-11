import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderResourceScope } from '../publication/resource-scope';
import { materialSamplesTarget } from '../record/target-capture-graph';
import type { RenderableSnapshot } from '../render-system-extract';
import {
  markFramePending,
  missingDrawEvidence,
  projectFramePresentation,
  projectResidualDisplayRows,
  skyCubemapPending,
  verifySubmittedShadows,
} from '../render-system-presentation';
import {
  directionalShadowSubmitted,
  type RecordAttempt,
  type RecordOutcome,
  recordFailureError,
  recordRetirementError,
} from '../render-system-record-attempt';
import type { FrameList } from '../scene/frame-list';
import { settleDirectionalShadow } from './directional-shadow-inspection';
import {
  type RecordHistory,
  recordHistoryOf,
  type StagedRecord,
  ViewRecordHistory,
} from './record-history';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCleanup, RenderCommit, renderSubmission } from './render-world';
import { settleViewTransmission } from './transmission-systems';
import { type ViewDrawReceipt, ViewDraws } from './view-draw-receipt';
import { readViewField, requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

/*
 * The Renderer's submission lifecycle. Every record attempt and every GPU
 * resource release enters it the same way, whether the frame submitted, was
 * rejected, a view retired, the device was lost or the Renderer disposed:
 *
 * - A view's record attempt stages its {@link StagedRecord} on the view's
 *   {@link ViewRecordHistory}. RenderCommit publishes the outcome of every
 *   attempt of this frame that reached its queue submit (presentation,
 *   directional-shadow and transmission inspection) and commits it only when
 *   the frame accepted its recording; RenderCleanup retires every staged
 *   attempt exactly once, accepted or not.
 * - A release that GPU work may still read is a {@link SubmissionRetirement}.
 *   Inside an open frame it waits for that frame's completion; outside one
 *   (dispose, device-loss or owner reset, done before or after a frame) or
 *   for another device generation it waits for its own queue's completion.
 *
 * Graph promotion and graph-submission products settle before GI history;
 * `render-graph-settle` runs before this commit, so it reads the settled graph.
 */

/**
 * RenderCommit, first root: each record attempt of this frame publishes its
 * outcome; an accepted one commits its record history, terrain presentation
 * and temporal capture. A commit system consuming those products (scene rows,
 * terrain receipt) orders `after` it.
 */
export const RENDER_RECORD_COMMIT_SYSTEM = 'render-record-commit';
/** RenderCleanup: every staged record attempt retires, submitted or not. */
export const RENDER_RECORD_RETIRE_SYSTEM = 'render-record-retire';
/** RenderCleanup: staged releases wait for the frame's completion. */
export const RENDER_SUBMISSION_RETIRE_SYSTEM = 'render-submission-retire';

/** A release that waits until the GPU work that may read its resource completed. */
export interface SubmissionRetirement {
  /** Device generation that owns the resource. */
  readonly generation: number;
  /** That device's queue, for work outside a submission of its generation. */
  readonly queue: { onSubmittedWorkDone(): Promise<unknown> };
  readonly release: () => void;
}

interface SubmissionQueue {
  readonly retirements: SubmissionRetirement[];
}

/** World resource key of the frame's staged retirements. */
export const RenderSubmissionQueue = Object.freeze({ name: 'RenderSubmissionQueue' });

function queueOf(world: World): SubmissionQueue {
  registerSubmissionSystems(world);
  return world.getResource<SubmissionQueue>(RenderSubmissionQueue);
}

/** Release a GPU resource once the work that may still read it completed. */
export function retireAfterSubmission(world: World, retirement: SubmissionRetirement): void {
  if (renderSubmission(world).open) queueOf(world).retirements.push(retirement);
  else settleRetirement(retirement, undefined);
}

function settleRetirement(
  retirement: SubmissionRetirement,
  completion: Promise<unknown> | undefined,
): void {
  void (completion ?? retirement.queue.onSubmittedWorkDone()).then(
    retirement.release,
    retirement.release,
  );
}

/** Register the submission lifecycle systems and their queue on a Render World once. */
export function registerSubmissionSystems(world: World): void {
  if (world.hasResource(RenderSubmissionQueue)) return;
  const queue: SubmissionQueue = { retirements: [] };
  world.insertResource(RenderSubmissionQueue, queue);
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_RECORD_COMMIT_SYSTEM,
      queries: [
        {
          read: [ViewRecorder, ViewRecordHistory],
          write: [ViewSubmission],
          optional: [ViewDraws],
        },
      ],
      fn: (world, [views]) => {
        const { frame, accepted } = renderSubmission(world);

        views.forEach((row) => {
          const entity = row.entity;

          const history = recordHistoryOf(
            world,
            requireViewField(world, entity, ViewRecordHistory, 'state'),
          );
          if (history.staged.length === 0) return;
          const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
          const drawsState = readViewField(world, entity, ViewDraws, 'state');
          const receipt =
            drawsState === undefined
              ? undefined
              : world.resolveUniqueRef<ViewDrawReceipt>(drawsState).unwrap();
          for (const staged of history.staged) {
            if (staged.frame !== frame) continue;
            try {
              publishRecordOutcome(world, entity, owner, staged.attempt);
              settleDirectionalShadow(
                world,
                entity,
                owner,
                history.directionalShadow,
                staged,
                accepted,
              );
              // A queue-accepted attempt whose frame was not accepted (a Feature scene input pending) commits nothing.
              if (!accepted || !staged.accepted) continue;
              if (commitRecordOutcome(owner, history, staged, receipt))
                world.set(entity, ViewSubmission, { temporal: true }).unwrap();
            } catch (cause) {
              const error = recordFailureError(cause);
              settleDirectionalShadow(
                world,
                entity,
                owner,
                history.directionalShadow,
                { ...staged, failure: error },
                accepted,
              );
              owner.internals.errorRegistry.fire(error);
            }
          }
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_RECORD_RETIRE_SYSTEM,
      queries: [{ read: [ViewRecorder, ViewRecordHistory] }],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const staged = recordHistoryOf(
            world,
            requireViewField(world, entity, ViewRecordHistory, 'state'),
          ).staged;
          if (staged.length === 0) return;
          const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
          for (const record of staged.splice(0)) retireRecord(owner, record);
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_SUBMISSION_RETIRE_SYSTEM,
      queries: [],
      after: [RENDER_RECORD_RETIRE_SYSTEM],
      // A completion is a FIFO queue fence: it covers every earlier frame that
      // may still read a released resource of its generation.
      fn: (world) => {
        const { completion, generation } = renderSubmission(world);
        for (const retirement of queue.retirements.splice(0))
          settleRetirement(
            retirement,
            retirement.generation === generation ? completion : undefined,
          );
      },
    })
    .unwrap();
}

/**
 * Publish what an attempt that reached its queue submit proved, accepted or
 * not: the presentation candidate, the directional-shadow candidate and the
 * transmission inspection of the graph it submitted. A successful queue
 * submit is necessary but not sufficient for the startup presentation fact:
 * the same visible snapshots and producer-owned GPU stores consumed by record
 * must show no missing geometry, material binding, sky cubemap or requested
 * shadow work behind a clear/fallback pass.
 */
function publishRecordOutcome(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  attempt: RecordAttempt,
): void {
  const outcome = attempt.outcome;
  if (outcome === undefined) return;
  const { frameState, internals } = owner;
  const presentation = outcome.presentation;
  if (frameState.pipelinePreparationPending) {
    markFramePending(
      presentation,
      frameState.pipelinePreparationPendingReason ?? { code: 'pipeline-preparation' },
    );
  }
  const directionalShadowReady = directionalShadowSubmitted(frameState, internals, outcome.lights);
  if (attempt.submitted && presentation.presentation === 'ready' && outcome.cameraCount > 0)
    verifySubmittedPresentation(owner, attempt, outcome, directionalShadowReady);
  settleViewTransmission(world, entity, owner, attempt.sceneSubmitted);
}

function verifySubmittedPresentation(
  { frameState, internals }: ViewSettlementOwner,
  attempt: RecordAttempt,
  outcome: RecordOutcome,
  directionalShadowReady: boolean,
): void {
  const { frame, presentation, draws } = outcome;
  const scopes = attempt.scopes;
  const resourceScope = scopes[attempt.composition.owners.resourceOwner] as RenderResourceScope;
  const handles = [frame.skylight?.equirectHandle, frame.skybox?.equirectHandle];
  if (skyCubemapPending(handles, internals, resourceScope))
    markFramePending(presentation, { code: 'sky-cubemap' });
  if (
    recordContext(internals).getPipelineState() === null ||
    frameState.compiledFrameGraph === null
  )
    markFramePending(presentation, { code: 'compiled-graph-unavailable' });
  const gpuOwned = frame.gpuOwned;
  const displayRows =
    gpuOwned === undefined
      ? outcome.presentationRenderables
      : projectResidualDisplayRows(frame, gpuOwned, draws.gpuSelection);
  const renderables = captureWritableRows(internals, displayRows);
  const missing =
    presentation.presentation === 'pending'
      ? undefined
      : missingDrawEvidence(
          renderables,
          outcome.worldKeys,
          draws.presentedDraws,
          scopes,
          internals,
        );
  if (missing !== undefined) markFramePending(presentation, missing);
  if (presentation.presentation === 'ready') {
    presentation.presentation = projectFramePresentation({
      renderables,
      ...(gpuOwned === undefined ? {} : { coveredBindings: draws.gpuSelection.coveredBindings() }),
      preparedWorlds: scopes,
      internals,
      onPending: (reason) => {
        presentation.reason ??= reason;
      },
    });
  }
  verifySubmittedShadows(presentation, outcome.lights, directionalShadowReady);
}

/**
 * A capture view never draws a row whose material samples its own target
 * (the capture graph excludes that same-pass attachment/binding conflict),
 * so presentation evidence is required only for the rows it can write.
 */
function captureWritableRows(
  internals: ViewSettlementOwner['internals'],
  rows: FrameList<RenderableSnapshot>,
): FrameList<RenderableSnapshot> {
  const targets = new Set(
    recordContext(internals).captureView?.state.work.map((work) => work.target),
  );
  if (targets.size === 0) return rows;
  const samplesCapture = (material: RenderableSnapshot['materials'][number]): boolean => {
    for (const target of targets) if (materialSamplesTarget(material.snapshot, target)) return true;
    return false;
  };
  const writable = (row: RenderableSnapshot) => !row.materials.some(samplesCapture);
  return rows.every(writable) ? rows : rows.filter(writable);
}

/**
 * The accepted attempt becomes the view's record history (count, generation,
 * presentation, draws), stages its terrain presentation and commits its
 * temporal capture. Returns whether it staged temporal history.
 */
function commitRecordOutcome(
  { internals, scene }: ViewSettlementOwner,
  history: RecordHistory,
  { attempt, generation }: StagedRecord,
  receipt: ViewDrawReceipt | undefined,
): boolean {
  history.submittedFrames += 1;
  history.lastGeneration = generation;
  const outcome = attempt.outcome;
  // A preparation barrier (no display submit) only counts.
  if (outcome === undefined || !attempt.submitted) return false;
  const { presentation, reason } = outcome.presentation;
  history.presentation = presentation;
  history.pendingReason =
    presentation === 'pending' && reason !== undefined ? Object.freeze(reason) : undefined;
  history.materialDraws = outcome.draws.drawObservation.commit(presentation === 'ready');
  if (presentation === 'ready') receipt?.stageTerrainPresented(outcome.draws.presentedDraws);
  // Queue acceptance can precede complete material/graph preparation. A
  // pending picture cannot become color, motion or jitter history.
  if (!attempt.sceneSubmitted || presentation !== 'ready') {
    scene.discardTemporalFrame();
    return false;
  }
  const temporal = scene.temporalStaged;
  const temporalCommit = scene.commitTemporalFrame(presentation === 'ready');
  if (!temporalCommit.ok) internals.errorRegistry.fire(temporalCommit.error);
  return temporal;
}

/**
 * Every staged attempt retires once: an unaccepted one drops its temporal
 * capture, and the profiler frame it began ends. Retirement failures are
 * reported together with the recording's own cause.
 */
function retireRecord({ internals, scene }: ViewSettlementOwner, staged: StagedRecord): void {
  const failures: unknown[] = [];
  try {
    if (!staged.accepted) scene.discardTemporalFrame();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0) {
    if (staged.failure !== undefined) failures.unshift(staged.failure);
    internals.errorRegistry.fire(recordRetirementError(failures));
  }
  if (!staged.ownsProfileFrame) return;
  try {
    staged.attempt.profileSession?.endFrame();
  } catch {
    // Profiler failures never alter rendering.
  }
}
