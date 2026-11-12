import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { SelectedEnvironmentFrame } from '../environment/frame';
import { releaseAtmosphere, settleAtmospherePublish } from '../environment/storage';
import { commitSubmittedVolumetricFog } from '../record/volumetric-fog-commit';
import { captureOnlyCameras } from '../render-system-projections';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCleanup, RenderPrepare, renderSubmission } from './render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from './submission-systems';
import { readViewField, requireViewField } from './view-field';
import { RENDER_VIEW_FRAME_SYSTEM, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { recordContext } from './view-record-context';
import {
  ownerOf,
  RENDER_ATMOSPHERE_COMMIT_SYSTEM,
  RENDER_ENVIRONMENT_COMMIT_SYSTEM,
  RENDER_ENVIRONMENT_DISCARD_SYSTEM,
  RENDER_FOG_COMMIT_SYSTEM,
  registerViewCommit,
  type ViewSettlementOwner,
} from './view-settlement';

/*
 * Environment lifecycle of a view: the staged environment generation, the
 * atmosphere storage publications, and the volumetric fog candidate. Recording
 * only stages them. They publish here, in RenderCommit, for the view's
 * accepted scene submission of this frame. A rejected attempt of this frame
 * drops them in RenderCleanup; a view that did not record keeps what it staged.
 */

/**
 * Register the environment, atmosphere and fog commits and the rejection
 * cleanup on a Render World once. The commits chain in the order the old
 * submission settlement ran them.
 */
export function registerEnvironmentSystems(world: World): void {
  registerViewCommit(
    world,
    RENDER_ENVIRONMENT_COMMIT_SYSTEM,
    ({ frameState }) => {
      const generation = frameState.environmentGeneration;
      if (generation === undefined) return;
      frameState.environmentLifecycle?.publish(generation);
      frameState.environmentGeneration = undefined;
    },
    RENDER_RECORD_COMMIT_SYSTEM,
    'scene',
  );
  registerViewCommit(
    world,
    RENDER_ATMOSPHERE_COMMIT_SYSTEM,
    ({ frameState }) => settleAtmospherePublish(frameState, true),
    RENDER_ENVIRONMENT_COMMIT_SYSTEM,
    'scene',
  );
  registerViewCommit(
    world,
    RENDER_FOG_COMMIT_SYSTEM,
    ({ frameState, internals }) => {
      const staged = frameState.volumetricFogCandidate;
      if (staged === undefined) return;
      frameState.volumetricFogCandidate = undefined;
      commitSubmittedVolumetricFog(internals, frameState, staged);
    },
    RENDER_ATMOSPHERE_COMMIT_SYSTEM,
    'scene',
  );
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_ENVIRONMENT_DISCARD_SYSTEM,
      queries: [{ read: [ViewRecorder, ViewSubmission] }],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          const { frameState } = ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          );
          const stage = frameState.rejectedStage;
          frameState.rejectedStage = undefined;
          // The candidate fog never outlives its frame.
          frameState.volumetricFogCandidate = undefined;

          if (
            requireViewField(world, entity, ViewSubmission, 'attempt') !== frame ||
            requireViewField(world, entity, ViewSubmission, 'accepted')
          )
            return;
          settleAtmospherePublish(frameState, false);
          const generation = frameState.environmentGeneration;
          if (generation === undefined) return;
          if (stage !== undefined)
            frameState.environmentLifecycle?.recordStageFailure(stage, generation);
          frameState.environmentLifecycle?.discard(generation);
          frameState.environmentGeneration = undefined;
        });
      },
    })
    .unwrap();
}

/** RenderPrepare: the view's selected environment candidate and its rejection gate. */
export const VIEW_ENVIRONMENT_ADMIT_SYSTEM = 'render-environment-admit';

/**
 * `render-environment-admit` outcome. `admitted`: the view's environment
 * candidate is bound (or a camera-less view has none). `rejected`: a
 * camera-bearing frame without a usable environment, or a candidate that
 * failed to generate (its error was fired); the recording rejects the frame.
 * `failed`: the admission could not run; the recording rethrows `cause`.
 */
export type ViewEnvironmentOutcome =
  | { readonly kind: 'admitted' | 'rejected' }
  | { readonly kind: 'failed'; readonly cause: unknown };

const ADMITTED = Object.freeze({ kind: 'admitted' } as const);
const REJECTED = Object.freeze({ kind: 'rejected' } as const);

interface ViewEnvironmentState {
  frame: number;
  outcome: ViewEnvironmentOutcome;
}

/** A recording view's environment admission; written only by `render-environment-admit`. */
export const ViewEnvironment = defineComponent('ViewEnvironment', {
  state: 'unique<ViewEnvironment>',
});

/** The view's admission written this renderer frame; undefined when the system did not run for it. */
export function viewEnvironmentOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewEnvironmentOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewEnvironment)) return undefined;
  const state = world
    .resolveUniqueRef<ViewEnvironmentState>(
      requireViewField(world, entity, ViewEnvironment, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** The recording takes its view's environment admission; a failed admission rethrows. */
export function consumeViewEnvironment(
  world: World,
  entity: EntityHandle | undefined,
): 'admitted' | 'rejected' {
  const outcome = viewEnvironmentOf(world, entity);
  if (outcome === undefined)
    throw new Error(`${VIEW_ENVIRONMENT_ADMIT_SYSTEM} did not admit the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  return outcome.kind;
}

/** Bind the selected environment candidate; a rejected camera-bearing frame fails atomically. */
function admitViewEnvironment(
  { frameState, internals }: ViewSettlementOwner,
  staged: ViewFrameState,
): ViewEnvironmentOutcome {
  if (staged.result?.ok !== true) return REJECTED;
  const frame = staged.result.value;
  const cameraCount =
    staged.mode === 'capture'
      ? captureOnlyCameras(frame.cameras, staged.opts.cameraEntityKey).length
      : frame.cameras.length;
  const environment = frame.environment;
  frameState.environmentFrame = environment as SelectedEnvironmentFrame | undefined;
  if (environment?.source.kind !== 'atmosphere') releaseAtmosphere(internals);
  const lifecycle = frameState.environmentLifecycle;
  if (lifecycle === undefined) return REJECTED;
  lifecycle.bindScope(recordContext(internals).deviceScope);
  if (frame.fogFailure !== undefined) lifecycle.recordSelectionFailure(frame.fogFailure);
  if (!frame.environmentReady || environment === undefined) {
    frameState.temporalView.discard();
    // A world with no camera still has a valid clear-only render path: no
    // environment candidate and no off/taa temporal state. Camera-bearing
    // rejected extraction remains an atomic render failure.
    return cameraCount === 0 ? ADMITTED : REJECTED;
  }
  const candidate = lifecycle.ensure(environment);
  if (!candidate.ok) {
    lifecycle.recordCandidateFailure(candidate.error);
    internals.errorRegistry.fire(candidate.error);
    return REJECTED;
  }
  if (!lifecycle.isActive(candidate.value)) frameState.environmentGeneration = candidate.value;
  return ADMITTED;
}

/**
 * Register `render-environment-admit` (RenderPrepare): each staged view whose
 * frame resolved binds its environment candidate before its recording starts.
 * A failure is stored as the `rejected` outcome, never thrown.
 */
export function registerEnvironmentAdmissionSystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: VIEW_ENVIRONMENT_ADMIT_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewEnvironment] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewEnvironmentState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame || staged.result?.ok !== true) return;
          let outcome: ViewEnvironmentOutcome;
          try {
            outcome = admitViewEnvironment(
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
              staged,
            );
          } catch (cause) {
            outcome = { kind: 'failed', cause };
          }
          const stored = readViewField(world, entity, ViewEnvironment, 'state');
          if (stored === undefined) {
            first.push({ entity: entity, state: { frame, outcome } });
            return;
          }
          const state = world.resolveUniqueRef<ViewEnvironmentState>(stored).unwrap();
          state.frame = frame;
          state.outcome = outcome;
        });
        // A view's first admission attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewEnvironment,
              data: { state: world.allocUniqueRef('ViewEnvironment', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
