import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { hasSsrSceneInputs } from '../record/main-pass';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import {
  admitSsrSpatial,
  notRequestedSsrAdmission,
  type SsrDependenciesInspection,
  type SsrSpatialAdmission,
} from '../ssr/admission';
import { type PassPlanInput, type ViewPassPlanQueue, ViewPassPlans } from './pass-plan-systems';
import { RENDER_PHASE_SORT_SYSTEM, type ViewPhaseQueue, ViewPhases } from './queue-systems';
import { RenderQueue, renderSubmission, renderWorldFor } from './render-world';
import { ViewStandardLighting, viewStandardLightingOf } from './standard-lighting-systems';
import { readViewField, requireViewField } from './view-field';

/** RenderQueue: the view's deferred or forward SSR admission and reflection-fallback demand. */
export const RENDER_SSR_ADMISSION_SYSTEM = 'render-ssr-admission';

/** What a view's SSR admission reads; staged with its pass-plan input before the queue barrier. */
export interface SsrAdmissionInput {
  /** The view camera, or the internal fallback snapshot of a Camera-less view. */
  readonly camera: CameraSnapshot;
  readonly dependencies: SsrDependenciesInspection;
  /** Whether this view's reflection probes demand the fallback lane. */
  readonly probeFallbackDemand: boolean;
  readonly capabilities: Pick<RhiCaps, 'compute' | 'storageTexture' | 'rgba16floatRenderable'>;
}

/** Closed reasons a view has no SSR admission. */
export type SsrAdmissionFailureCode = 'standard-lighting-unavailable' | 'scene-input-rejected';

/**
 * One view's `render-ssr-admission` outcome. `resolved`: the spatial admission
 * and whether the reflection fallback lane is demanded. `unavailable`: the view
 * prepared no Standard lighting, so its render path is unknown. `failed`: the
 * scene inputs could not be read; the recording rethrows `cause`.
 */
export type ViewSsrAdmissionOutcome =
  | {
      readonly kind: 'resolved';
      readonly admission: SsrSpatialAdmission;
      readonly reflectionFallbackCandidate: boolean;
      readonly reflectionFallbackDemand: boolean;
    }
  | { readonly kind: 'unavailable'; readonly code: 'standard-lighting-unavailable' }
  | { readonly kind: 'failed'; readonly code: 'scene-input-rejected'; readonly cause: unknown };

interface ViewSsrAdmissionState {
  frame: number;
  outcome: ViewSsrAdmissionOutcome;
}

/** A recording view's SSR admission; written only by `render-ssr-admission`. */
export const ViewSsrAdmission = defineComponent('ViewSsrAdmission', {
  state: 'unique<ViewSsrAdmission>',
});

/** The view's admission written this renderer frame; undefined when the system did not run for it. */
export function viewSsrAdmissionOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewSsrAdmissionOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewSsrAdmission)) return undefined;
  const state = world
    .resolveUniqueRef<ViewSsrAdmissionState>(
      requireViewField(world, entity, ViewSsrAdmission, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/**
 * The resolved admission this recording draws with; a rejected input rethrows
 * inside its record recovery. A direct recorder outside a Render World view
 * has no SSR dependencies, so its camera is never admitted for SSR.
 */
export function consumeViewSsrAdmission(
  internals: RenderSystemInternals,
  camera: Pick<CameraSnapshot, 'near' | 'far'>,
): Extract<ViewSsrAdmissionOutcome, { kind: 'resolved' }> {
  if (internals.viewEntity === undefined)
    return {
      kind: 'resolved',
      admission: notRequestedSsrAdmission('forward', camera.far - camera.near),
      reflectionFallbackCandidate: false,
      reflectionFallbackDemand: false,
    };
  const outcome = viewSsrAdmissionOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome === undefined)
    throw new Error(`${RENDER_SSR_ADMISSION_SYSTEM} did not admit the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'unavailable')
    throw new Error(`${RENDER_SSR_ADMISSION_SYSTEM}: ${outcome.code}`);
  return outcome;
}

/** Whether this view's frame demands the reflection fallback lane; false until admitted. */
export function reflectionFallbackDemandOf(internals: RenderSystemInternals): boolean {
  const outcome = viewSsrAdmissionOf(renderWorldFor(internals), internals.viewEntity);
  return outcome?.kind === 'resolved' && outcome.reflectionFallbackDemand;
}

/** Admit one view's SSR against its prepared render path; never throws. */
function admitViewSsr(
  world: World,
  entity: EntityHandle,
  input: PassPlanInput,
  dispatch: PassPlanInput['dispatch'],
): ViewSsrAdmissionOutcome {
  const lighting = viewStandardLightingOf(world, entity);
  if (lighting?.kind !== 'prepared' || !lighting.lighting.ok)
    return { kind: 'unavailable', code: 'standard-lighting-unavailable' };
  const { camera, dependencies, probeFallbackDemand, capabilities } = input.ssr;
  const reportedPath = lighting.lighting.value.standard.prepared.renderPath;
  const renderPath = reportedPath === 'deferred' ? 'deferred' : 'forward';
  const reflectionFallbackCandidate =
    probeFallbackDemand ||
    (dependencies.requested === true && dependencies.reflectionFallback !== undefined);
  try {
    const sceneInputs =
      (reflectionFallbackCandidate || camera.screenSpaceReflection !== undefined) &&
      hasSsrSceneInputs(
        { renderables: input.renderables, dispatch, materialFrame: input.materials },
        reportedPath,
      );
    const admission = admitSsrSpatial({
      camera,
      environment: {
        lane: renderPath,
        m0: dependencies.admission,
        sceneInputs,
        // Standard geometry produces current motion/coverage in this graph,
        // including its first frame. Prior history is optional.
        temporal: sceneInputs,
        reflectionFallback: dependencies.reflectionFallback !== undefined,
        capabilities: {
          compute: capabilities.compute,
          storageTexture: capabilities.storageTexture,
          rgba16floatRenderable: capabilities.rgba16floatRenderable,
          r32floatSampledStorage: dependencies.format?.verdict === 'admitted',
        },
        recovery: true,
      },
    });
    return {
      kind: 'resolved',
      admission,
      reflectionFallbackCandidate,
      reflectionFallbackDemand:
        (reflectionFallbackCandidate || admission.status === 'admitted') && sceneInputs,
    };
  } catch (cause) {
    return { kind: 'failed', code: 'scene-input-rejected', cause };
  }
}

/**
 * Register `render-ssr-admission` (RenderQueue, after `render-phase-sort`):
 * each staged view admits SSR over the dispatch order it records and its
 * prepared Standard render path, and stores a frame-stamped outcome. A
 * rejected input is stored, never thrown.
 */
export function registerSsrAdmissionSystem(world: World): void {
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_SSR_ADMISSION_SYSTEM,
      after: [RENDER_PHASE_SORT_SYSTEM],
      queries: [
        {
          read: [ViewPassPlans],
          optional: [ViewPhases, ViewStandardLighting, ViewSsrAdmission],
        },
      ],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewSsrAdmissionState }[] = [];

        views.forEach((row) => {
          const entity = row.entity;

          const input = world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap().staged;
          if (input === undefined) return;
          const stored = readViewField(world, entity, ViewSsrAdmission, 'state');
          const previous =
            stored === undefined
              ? undefined
              : world.resolveUniqueRef<ViewSsrAdmissionState>(stored).unwrap();
          if (previous?.frame === frame) return;
          const phases = input.phaseSorted
            ? readViewField(world, entity, ViewPhases, 'state')
            : undefined;
          const ordered =
            phases === undefined
              ? undefined
              : world.resolveUniqueRef<ViewPhaseQueue>(phases).unwrap().ordered;
          const outcome = admitViewSsr(world, entity, input, ordered ?? input.dispatch);
          if (previous === undefined) {
            first.push({ entity: entity, state: { frame, outcome } });
            return;
          }
          previous.frame = frame;
          previous.outcome = outcome;
        });
        // A view's first admission attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewSsrAdmission,
              data: { state: world.allocUniqueRef('ViewSsrAdmission', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
