import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import type { RenderFeatureFrameResult } from '../features/host';
import { postProcessShaderEntrySignature } from '../fullscreen-post-process-pass';
import type { RenderSystemInternals } from '../record/render-context';
import {
  type RenderFeatureGraphCandidate,
  recordRenderFeatureCandidate,
} from '../record/typed-frame-graph';
import { releasePreparedResourceBatches } from '../render-system-record-attempt';
import { sceneDataSurfaceBindings } from '../temporal/standard-scene-data-admission';
import {
  featureFrameOutcome,
  ViewFeatureInput,
  type ViewFeatureInputState,
  viewFeatureFrameResult,
} from './feature-systems';
import { ViewRecorder } from './render-views';
import { RenderCleanup, RenderQueue, renderSubmission, renderWorldFor } from './render-world';
import { readViewField, requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { ownerOf, type PostProcessSettlement, type ViewSettlementOwner } from './view-settlement';

/*
 * A view's composite/post plan. `render-feature-plan` (RenderQueue) runs after
 * `render-feature-batch` sealed the frame's Feature batch in RenderPrepare and
 * writes each recording view's {@link ViewFeaturePlans}: the Feature graph
 * candidate (plans, fullscreen effects, post identities, prepared-resource
 * key) with its post-process parameter buffers. Recording and graph compile
 * read only this plan: the fullscreen effects, the Feature post chain admission
 * and the plan revision never come from a recording parameter.
 * `render-feature-plan-release` (RenderCleanup) abandons a plan no recording took.
 */

/** RenderQueue system planning each recording view's Feature graph candidate. */
export const RENDER_FEATURE_PLAN_SYSTEM = 'render-feature-plan';
/** RenderCleanup system abandoning the plans of this frame that no recording took. */
export const RENDER_FEATURE_PLAN_RELEASE_SYSTEM = 'render-feature-plan-release';

/** The Feature composite/post plan graph compile reads for one view. */
export interface ViewFeaturePlan {
  /**
   * This frame's Feature graph candidate. Undefined compiles against the
   * accepted Feature graph state: a view without a Feature host, a capture
   * recorder, or a direct recorder outside a Render World view.
   */
  readonly candidate: RenderFeatureGraphCandidate | undefined;
}

/** The plan of a recording without a planned Feature candidate. */
export const EMPTY_VIEW_FEATURE_PLAN: ViewFeaturePlan = Object.freeze({
  candidate: undefined,
});

/**
 * One view's `render-feature-plan` outcome. `rejected` carries the closed
 * reason the view records no Features this frame (its recording reports the
 * error); `failed` is an unexpected cause its recording rethrows.
 */
export type ViewFeaturePlanOutcome =
  | { readonly kind: 'planned'; readonly plan: ViewFeaturePlan }
  | {
      readonly kind: 'rejected';
      readonly code: 'post-process-params-failed';
      readonly error: RhiError;
    }
  | { readonly kind: 'failed'; readonly cause: unknown };

interface ViewFeaturePlanState {
  frame: number;
  outcome: ViewFeaturePlanOutcome;
  /** Whether this frame's recording took the plan (it then settles the candidate). */
  taken: boolean;
}

/** A recording view's Feature plan; written only by `render-feature-plan`. */
export const ViewFeaturePlans = defineComponent('ViewFeaturePlans', {
  state: 'unique<ViewFeaturePlans>',
});

function planStateOf(world: World, entity: EntityHandle): ViewFeaturePlanState | undefined {
  if (!world.hasComponent(entity, ViewFeaturePlans)) return undefined;
  const state = world
    .resolveUniqueRef<ViewFeaturePlanState>(
      requireViewField(world, entity, ViewFeaturePlans, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

/** The view's Feature plan of this renderer frame; undefined when the system did not plan it. */
export function viewFeaturePlanOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewFeaturePlanOutcome | undefined {
  return entity === undefined ? undefined : planStateOf(world, entity)?.outcome;
}

/** A view `render-feature-plan` did not plan this frame. */
export interface FeaturePlanMissing {
  readonly code: 'feature-plan-missing';
  readonly system: typeof RENDER_FEATURE_PLAN_SYSTEM;
}

/** The message of a missing Feature plan. */
export function featurePlanMissingMessage(missing: FeaturePlanMissing): string {
  return `${missing.system} did not plan the recorded view`;
}

/**
 * The plan graph compile reads for this recording. A recording outside a
 * Render World view reads the empty plan; a view `render-feature-plan` did
 * not plan is data naming the system. Taking it transfers its settlement to the
 * recording.
 */
export function consumeViewFeaturePlan(
  internals: RenderSystemInternals,
): Result<ViewFeaturePlan, FeaturePlanMissing> {
  const entity = internals.viewEntity;
  if (entity === undefined) return ok(EMPTY_VIEW_FEATURE_PLAN);
  const state = planStateOf(renderWorldFor(internals), entity);
  if (state?.outcome.kind !== 'planned')
    return err({ code: 'feature-plan-missing', system: RENDER_FEATURE_PLAN_SYSTEM });
  state.taken = true;
  return ok(state.outcome.plan);
}

type PostProcessParamsCandidate = Extract<
  ReturnType<PostProcessSettlement['params']['prepare']>,
  { readonly ok: true }
>['value'];

/** Retire pipelines and modules of post-process entries the accepted frame replaced. */
function acceptFeaturePostProcess(
  { postProcess }: ViewSettlementOwner,
  featureFrame: RenderFeatureFrameResult,
  params: PostProcessParamsCandidate,
): void {
  for (const [id, previous] of postProcess.params.featureEntries) {
    const next = featureFrame.fullscreenEffects.get(id);
    if (next === undefined) {
      postProcess.clearPipelineCache(id);
      postProcess.invalidateModule(id);
    } else if (
      postProcessShaderEntrySignature(previous) !== postProcessShaderEntrySignature(next)
    ) {
      postProcess.clearPipelineEntry(id, previous);
      if (previous.source !== next.source) postProcess.invalidateModule(id);
    }
  }
  postProcess.params.accept(params);
  postProcess.params.featureEntries = featureFrame.fullscreenEffects;
}

function createViewFeaturePlan(
  owner: ViewSettlementOwner,
  featureFrame: RenderFeatureFrameResult,
  params: PostProcessParamsCandidate,
): ViewFeaturePlan {
  const { internals, frameState, postProcess } = owner;
  const sceneDataBindings = sceneDataSurfaceBindings(
    featureFrame.plans,
    frameState.standardSceneSurfaceAdmission,
  );
  const candidate: RenderFeatureGraphCandidate = {
    plans: featureFrame.plans,
    ...(sceneDataBindings.length === 0 || frameState.standardSceneSurfaceAdmission === undefined
      ? {}
      : { sceneDataAdmission: frameState.standardSceneSurfaceAdmission, sceneDataBindings }),
    fullscreenEffects: featureFrame.fullscreenEffects,
    postProcessIdentities: featureFrame.postProcessIdentities,
    ...(featureFrame.requiresPreparedResourceKey
      ? { preparedResourceKey: `frame-${frameState.frameNumber}` }
      : {}),
    onRejected: () => {
      releasePreparedResourceBatches(featureFrame, internals.errorRegistry);
      postProcess.params.discard(params);
    },
    onAbandoned: () => postProcess.params.discard(params),
    onAccepted: () => {
      acceptFeaturePostProcess(owner, featureFrame, params);
    },
  };
  return { candidate };
}

/** The view's Feature graph candidate and post-process parameters from its sealed Feature result. */
function planViewFeatures(
  owner: ViewSettlementOwner,
  featureFrame: RenderFeatureFrameResult,
): ViewFeaturePlanOutcome {
  const { internals, postProcess } = owner;
  if (recordContext(internals).featureHost === undefined)
    return { kind: 'planned', plan: EMPTY_VIEW_FEATURE_PLAN };
  const params = postProcess.params.prepare(featureFrame.fullscreenEffects);
  if (!params.ok) {
    releasePreparedResourceBatches(featureFrame, internals.errorRegistry);
    return { kind: 'rejected', code: 'post-process-params-failed', error: params.error };
  }
  const plan = createViewFeaturePlan(owner, featureFrame, params.value);
  if (plan.candidate !== undefined) recordRenderFeatureCandidate(internals, plan.candidate);
  return { kind: 'planned', plan };
}

/** The outcome for one view whose Feature input `render-feature-views` prepared this frame. */
function planView(
  world: World,
  input: ViewFeatureInputState,
  owner: ViewSettlementOwner,
): ViewFeaturePlanOutcome | undefined {
  if (input.outcome.kind !== 'prepared') return undefined;
  const hostInput = input.outcome.value.input;
  if (hostInput === undefined) return { kind: 'planned', plan: EMPTY_VIEW_FEATURE_PLAN };
  // An unsealed batch rejects the view's Feature recording before it reads a plan.
  const sealed = featureFrameOutcome(world);
  if (sealed?.kind !== 'sealed') return undefined;
  const result = viewFeatureFrameResult(sealed, hostInput.identity);
  if (result === undefined) return undefined;
  try {
    return planViewFeatures(owner, result);
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/**
 * Register `render-feature-plan` (RenderQueue) and `render-feature-plan-release`
 * (RenderCleanup) once. A plan failure is stored with its closed code, never thrown.
 */
export function registerFeaturePlanSystems(world: World): void {
  if (world.hasResource(FeaturePlanSystems)) return;
  world.insertResource(FeaturePlanSystems, true);
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_FEATURE_PLAN_SYSTEM,
      queries: [{ read: [ViewRecorder, ViewFeatureInput], optional: [ViewFeaturePlans] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewFeaturePlanState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const input = world
            .resolveUniqueRef<ViewFeatureInputState>(
              requireViewField(world, entity, ViewFeatureInput, 'state'),
            )
            .unwrap();
          if (input.frame !== frame) return;
          const outcome = planView(
            world,
            input,
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
          );
          if (outcome === undefined) return;
          const stored = readViewField(world, entity, ViewFeaturePlans, 'state');
          if (stored === undefined) {
            first.push({ entity: entity, state: { frame, outcome, taken: false } });
            return;
          }
          const state = world.resolveUniqueRef<ViewFeaturePlanState>(stored).unwrap();
          state.frame = frame;
          state.outcome = outcome;
          state.taken = false;
        });
        // A view's first plan attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewFeaturePlans,
              data: { state: world.allocUniqueRef('ViewFeaturePlans', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_FEATURE_PLAN_RELEASE_SYSTEM,
      queries: [{ read: [ViewFeaturePlans] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<ViewFeaturePlanState>(
              requireViewField(world, entity, ViewFeaturePlans, 'state'),
            )
            .unwrap();
          if (state.frame !== frame || state.taken || state.outcome.kind !== 'planned') return;
          state.taken = true;
          // No compile read the candidate: release its unpublished parameter buffers.
          state.outcome.plan.candidate?.onAbandoned?.();
        });
      },
    })
    .unwrap();
}

const FeaturePlanSystems = Object.freeze({ name: 'FeaturePlanSystems' });
