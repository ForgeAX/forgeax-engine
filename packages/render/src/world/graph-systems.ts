import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { setDerivedComponent } from '@forgeax/engine-ecs/projection';
import { settleClusterWorkConformanceFrame } from '../record/cluster-work-conformance';
import type { ViewGraphCompileOutcome } from '../record/graph-adoption';
import {
  compileViewGraph,
  type GraphCandidateSettlement,
  promoteGraphCandidate,
  retire,
  rollbackGraphCandidate,
  settleFeatureGraphState,
} from '../record/typed-frame-graph';
import { recordFailureError } from '../render-system-record-attempt';
import { ViewFeaturePlans, viewFeaturePlanOf } from './feature-plan-systems';
import { ViewDiffuseGi } from './gi-systems';
import { ViewGpuDriven } from './gpu-driven-systems';
import { ViewPassPlans } from './pass-plan-systems';
import { RENDER_ENCODER_OPEN_SYSTEM, renderFrameEncoder } from './record-systems';
import { ViewCascadeFit } from './render-lights';
import { ViewRecorder, ViewSubmission, viewAccepted } from './render-views';
import { RenderCleanup, RenderCommit, RenderRecord, renderSubmission } from './render-world';
import { ViewSsrAdmission } from './ssr-admission-systems';
import { ViewStandardLighting } from './standard-lighting-systems';
import { ViewSubsurfaceAdmission } from './subsurface-admission-systems';
import { EMPTY_VIEW_STATE_UPDATE, readViewField, requireViewField } from './view-field';
import { readViewGraphInput, type ViewGraphCompileRequest } from './view-graph-input';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';
import { ViewTopologyInputs } from './view-topology-systems';

/*
 * Per-view graph compile. A recording stages its `GraphCompileInput` on its
 * view entity and pauses at the submission's compile barrier; once every view
 * reached it, `render-graph-compile` (RenderRecord, after
 * `render-encoder-open`) compiles each staged view with the pure
 * `compileViewGraph` and stores the frame-stamped outcome. The recording then
 * adopts that outcome (`adoptViewGraph`) before it encodes.
 * `render-graph-compile-release` (RenderCleanup) settles a candidate no
 * recording adopted. A recording outside a Render World frame compiles in
 * place through the same pure function.
 *
 * `render-graph-settle` (first in RenderCommit) settles each view that
 * recorded this frame: a `viewAccepted` view promotes its adopted graph
 * candidate and keeps the Feature state it committed; any other view rolls
 * both back, stashing a graph that waits on pipeline preparation. It then
 * advances the view's `frameNumber`, the per-attempt identity.
 */

/** RenderRecord system compiling each staged view graph. */
export const RENDER_GRAPH_COMPILE_SYSTEM = 'render-graph-compile';
/** RenderCleanup system settling this frame's candidates no recording adopted. */
export const RENDER_GRAPH_COMPILE_RELEASE_SYSTEM = 'render-graph-compile-release';
/**
 * RenderCommit, first: each view that recorded this frame promotes or rolls
 * back its adopted graph and Feature state, then advances its `frameNumber`.
 */
export const RENDER_GRAPH_SETTLE_SYSTEM = 'render-graph-settle';

/** How `render-graph-settle` settled a view's attempt of renderer frame `frame`. */
export type ViewGraphSettlement =
  | {
      readonly frame: number;
      readonly kind: 'settled';
      readonly accepted: boolean;
      readonly graph: GraphCandidateSettlement;
    }
  | { readonly frame: number; readonly kind: 'failed'; readonly cause: unknown };

/**
 * One view's compile candidate: the input its recording staged for renderer
 * frame `frame`, and the outcome `render-graph-compile` wrote from it.
 */
export class ViewGraphCandidateSlot {
  frame = -1;
  staged: ViewGraphCompileRequest | undefined;
  outcome: ViewGraphCompileOutcome | undefined;
  /** Written only by `render-graph-settle`. */
  settled: ViewGraphSettlement | undefined;

  /** Stage this attempt's input; a previous attempt's outcome is dropped. */
  stage(frame: number, input: ViewGraphCompileRequest): void {
    this.frame = frame;
    this.staged = input;
    this.outcome = undefined;
  }

  /** Take the outcome compiled for frame `frame`; the candidate ends either way. */
  take(frame: number): ViewGraphCompileOutcome | undefined {
    const outcome = this.frame === frame ? this.outcome : undefined;
    this.staged = undefined;
    this.outcome = undefined;
    return outcome;
  }
}

/** A recording view's graph compile candidate; its outcome is written only by `render-graph-compile`. */
export const ViewGraphCandidate = defineComponent('ViewGraphCandidate', {
  state: 'unique<ViewGraphCandidate>',
});

function candidateSlot(world: World, entity: EntityHandle): ViewGraphCandidateSlot {
  if (!world.hasComponent(entity, ViewGraphCandidate)) {
    const state = world.allocUniqueRef('ViewGraphCandidate', new ViewGraphCandidateSlot());
    world.addComponent(entity, { component: ViewGraphCandidate, data: { state } }).unwrap();
  }
  return world
    .resolveUniqueRef<ViewGraphCandidateSlot>(
      requireViewField(world, entity, ViewGraphCandidate, 'state'),
    )
    .unwrap();
}

/** The compile outcome of a view `render-graph-compile` did not compile this frame. */

/**
 * Whether a recording in `world` stops at the compile barrier: the frame is
 * open and its RenderRecord has not run yet. A submission outside an open
 * frame runs RenderRecord before any view records, so its views compile in place.
 */
export function awaitsRenderRecord(world: World): boolean {
  return renderSubmission(world).open && renderFrameEncoder(world).kind !== 'open';
}

/**
 * Wait at the compile barrier without staging a compile: a Render World view
 * that records no view graph (capture-only) still encodes only after
 * RenderRecord opened the frame encoder.
 */

/** Stage only the recording facts the component-reading compiler still needs. */
export function stageViewGraphCompile(
  world: World,
  entity: EntityHandle,
  request: ViewGraphCompileRequest,
): void {
  candidateSlot(world, entity).stage(renderSubmission(world).frame, request);
}

/** Hand the current compiler product to its one graph-seal owner. */
export function takeViewGraphCompile(
  world: World,
  entity: EntityHandle,
): ViewGraphCompileOutcome | undefined {
  return world.hasComponent(entity, ViewGraphCandidate)
    ? candidateSlot(world, entity).take(renderSubmission(world).frame)
    : undefined;
}

/**
 * Compile this recording's view graph. A Render World view that
 * `awaitsRenderRecord` stages its input and waits at the compile barrier for
 * `render-graph-compile`; any other recording (a direct recorder, or a
 * submission whose RenderRecord already ran) compiles in place.
 * A view the system did not compile is data, never a throw.
 */

/**
 * Promote or roll back one view's adopted graph candidate and Feature state.
 * A view that is not accepted while its pipelines are still preparing stashes
 * its graph for the next attempt. `frameNumber` advances on every attempt: it
 * is attempt identity (prepared-resource keys, bundle caches, observation
 * ids), not accepted history.
 */
function settleViewGraph(
  { frameState, internals }: ViewSettlementOwner,
  frame: number,
  accepted: boolean,
  submitted: boolean,
): ViewGraphSettlement {
  try {
    const graph = accepted
      ? promoteGraphCandidate(frameState)
      : rollbackGraphCandidate(frameState, frameState.pipelinePreparationPending === true);
    settleFeatureGraphState(internals, accepted);
    settleClusterWorkConformanceFrame(
      frameState.standardClusterWorkConformance,
      frameState.frameNumber,
      accepted ? 'submitted' : submitted ? 'pending' : 'unsubmitted',
    );
    return { frame, kind: 'settled', accepted, graph };
  } catch (cause) {
    internals.errorRegistry.fire(recordFailureError(cause));
    return { frame, kind: 'failed', cause };
  } finally {
    frameState.frameNumber += 1;
  }
}

/**
 * Register `render-graph-compile` (RenderRecord),
 * `render-graph-compile-release` (RenderCleanup) and `render-graph-settle`
 * (RenderCommit) once. No system throws: a thrown compile is the `failed`
 * outcome its recording rethrows, a thrown settle the view's `failed` settlement.
 */
export function registerGraphSystems(world: World): void {
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_GRAPH_SETTLE_SYSTEM,
      // Every later commit reads the settled graph and generation.
      before: [RenderCommit],
      queries: [{ read: [ViewRecorder, ViewSubmission], optional: [ViewGraphCandidate] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; slot: ViewGraphCandidateSlot }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          if (requireViewField(world, entity, ViewSubmission, 'attempt') !== frame) return;
          const settled = settleViewGraph(
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            frame,
            viewAccepted(world, entity) && requireViewField(world, entity, ViewSubmission, 'scene'),
            renderSubmission(world).completion !== undefined,
          );
          const stored = readViewField(world, entity, ViewGraphCandidate, 'state');
          if (stored !== undefined) {
            world.resolveUniqueRef<ViewGraphCandidateSlot>(stored).unwrap().settled = settled;
            return;
          }
          const slot = new ViewGraphCandidateSlot();
          slot.settled = settled;
          first.push({ entity: entity, slot });
        });
        // A view's first settlement attaches its candidate component after the iteration.
        for (const { entity, slot } of first)
          world
            .addComponent(entity, {
              component: ViewGraphCandidate,
              data: { state: world.allocUniqueRef('ViewGraphCandidate', slot) },
            })
            .unwrap();
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_GRAPH_COMPILE_SYSTEM,
      after: [RENDER_ENCODER_OPEN_SYSTEM],
      queries: [
        {
          write: [ViewGraphCandidate],
          read: [ViewRecorder],
          optional: [
            ViewStandardLighting,
            ViewTopologyInputs,
            ViewSsrAdmission,
            ViewDiffuseGi,
            ViewGpuDriven,
            ViewFeaturePlans,
            ViewPassPlans,
            ViewSubsurfaceAdmission,
            ViewCascadeFit,
          ],
        },
      ],
      // Only a submission whose encoder opened records the compiled graphs.
      runIf: (renderWorld) => renderFrameEncoder(renderWorld).kind === 'open',
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          setDerivedComponent(world, entity, ViewGraphCandidate, EMPTY_VIEW_STATE_UPDATE).unwrap();
          const slot = world
            .resolveUniqueRef<ViewGraphCandidateSlot>(
              requireViewField(world, entity, ViewGraphCandidate, 'state'),
            )
            .unwrap();
          if (slot.frame !== frame || slot.staged === undefined || slot.outcome !== undefined)
            return;
          try {
            const input = readViewGraphInput(
              world,
              entity,
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
              slot.staged,
            );
            slot.outcome = input.ok
              ? compileViewGraph(input.value)
              : { kind: 'failed', frame, cause: input.error };
          } catch (cause) {
            slot.outcome = { kind: 'failed', frame, cause };
          }
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_GRAPH_COMPILE_RELEASE_SYSTEM,
      queries: [
        { write: [ViewGraphCandidate], read: [ViewRecorder], optional: [ViewFeaturePlans] },
      ],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          setDerivedComponent(world, entity, ViewGraphCandidate, EMPTY_VIEW_STATE_UPDATE).unwrap();
          const slot = world
            .resolveUniqueRef<ViewGraphCandidateSlot>(
              requireViewField(world, entity, ViewGraphCandidate, 'state'),
            )
            .unwrap();
          const staged = slot.staged;
          const outcome = slot.take(frame);
          if (staged === undefined) return;
          // No recording adopted the candidate: retire its fresh graph and
          // release the Feature plan it consumed, as an untaken plan is released.
          const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
          if (outcome?.kind === 'compiled') retire(owner.frameState, outcome.graph);
          const feature = viewFeaturePlanOf(world, entity);
          if (feature?.kind === 'planned') feature.plan.candidate?.onAbandoned?.();
        });
      },
    })
    .unwrap();
}
