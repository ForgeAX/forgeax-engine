import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RhiError } from '@forgeax/engine-rhi';
import type { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type { GpuDrivenLaneReason } from '../inspection-types';
import {
  buildFrameGpuDrivenInput,
  type FrameGpuDrivenInput,
  type FrameGpuDrivenSources,
} from '../record/frame-gpu-driven-input';
import type { RenderSystemInternals } from '../record/render-context';
import { runProfiledRenderPhase, runRecordProfilePhase } from '../record/render-context';
import { querySceneExecution } from '../record/resident-meshes';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { GpuDrivenRasterLane } from './gpu-driven-raster-systems';
import { type ViewPassPlanQueue, ViewPassPlans } from './pass-plan-systems';
import { RenderQueue, renderSubmission, renderWorldFor } from './render-world';
import {
  RENDER_SSR_ADMISSION_SYSTEM,
  ViewSsrAdmission,
  viewSsrAdmissionOf,
} from './ssr-admission-systems';
import { ViewStandardLighting, viewStandardLightingOf } from './standard-lighting-systems';
import { readViewField, requireViewField } from './view-field';

/** RenderQueue: the view's GPU-driven frame selection and its executed GPU Scene query. */
export const RENDER_GPU_DRIVEN_PREPARE_SYSTEM = 'render-gpu-driven-prepare';

/** The resident GPU Scene a view staged and the execution plan queried from it. */
export interface ViewGpuDrivenScene {
  readonly source: PersistentGpuDrivenState;
  readonly queried: PersistentGpuDrivenState;
}

/**
 * One view's `render-gpu-driven-prepare` outcome. `selected`: whether the
 * frame keeps the GPU-driven lane, the closed reason the observation reports
 * when it does not, and the view's GPU Scene with its execution plan queried
 * (undefined without a resident GPU Scene). `unavailable`: the view has no
 * resolved SSR admission over prepared Standard lighting, so its lane cannot
 * be chosen. `failed`: the GPU Scene query rejected; the recording rethrows
 * `cause`.
 */
export type ViewGpuDrivenOutcome =
  | {
      readonly kind: 'selected';
      readonly gpuLane: boolean;
      readonly laneReason: GpuDrivenLaneReason | undefined;
      readonly scene: ViewGpuDrivenScene | undefined;
      readonly preparation?: ViewGpuDrivenPreparation;
      readonly raster?: GpuDrivenRasterLane;
    }
  | { readonly kind: 'unavailable'; readonly code: 'ssr-admission-unavailable' }
  | {
      readonly kind: 'rejected';
      readonly code: 'owner-prepare-rejected' | 'shadow-views-rejected';
      readonly error: RhiError | GpuDrivenPreparationError;
    }
  | {
      readonly kind: 'failed';
      readonly code: 'scene-query-rejected' | 'input-rejected' | 'raster-lane-rejected';
      readonly cause: unknown;
    };

/** The resident inputs and owner result this view records without preparing again. */
export interface ViewGpuDrivenPreparation {
  readonly input: FrameGpuDrivenInput;
  readonly prepared: PreparedGpuDrivenFrame | undefined;
  /** Captured before prepare can replace resources. */
  readonly resourceGeneration: number | undefined;
}

interface ViewGpuDrivenPrepareState {
  frame: number;
  sources: FrameGpuDrivenSources;
}

export const ViewGpuDrivenPrepareInput = defineComponent('ViewGpuDrivenPrepareInput', {
  state: 'unique<ViewGpuDrivenPrepareInput>',
});

/** Stage this attempt's producer facts before the shared Queue barrier. */
export function stageViewGpuDrivenPrepareInput(
  world: World,
  entity: EntityHandle,
  sources: FrameGpuDrivenSources,
): void {
  const frame = renderSubmission(world).frame;
  if (!world.hasComponent(entity, ViewGpuDrivenPrepareInput)) {
    const state = world.allocUniqueRef('ViewGpuDrivenPrepareInput', { frame, sources });
    world.addComponent(entity, { component: ViewGpuDrivenPrepareInput, data: { state } }).unwrap();
  } else {
    const state = world
      .resolveUniqueRef<ViewGpuDrivenPrepareState>(
        requireViewField(world, entity, ViewGpuDrivenPrepareInput, 'state'),
      )
      .unwrap();
    state.frame = frame;
    state.sources = sources;
  }
}

/** This frame's staged producer facts, shared with the raster Queue system. */
export function viewGpuDrivenSourcesOf(
  world: World,
  entity: EntityHandle,
): FrameGpuDrivenSources | undefined {
  if (!world.hasComponent(entity, ViewGpuDrivenPrepareInput)) return undefined;
  const state = world
    .resolveUniqueRef<ViewGpuDrivenPrepareState>(
      requireViewField(world, entity, ViewGpuDrivenPrepareInput, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.sources : undefined;
}

/** Replace the current outcome with the raster system's product or failure. */
export function storeViewGpuDrivenOutcome(
  world: World,
  entity: EntityHandle,
  outcome: ViewGpuDrivenOutcome,
): void {
  const state = world
    .resolveUniqueRef<ViewGpuDrivenState>(requireViewField(world, entity, ViewGpuDriven, 'state'))
    .unwrap();
  state.frame = renderSubmission(world).frame;
  state.outcome = outcome;
}

/** Prepare only from this frame's staged facts; all failures remain view data. */
function prepareViewGpuDriven(
  world: World,
  entity: EntityHandle,
  outcome: ViewGpuDrivenOutcome,
): ViewGpuDrivenOutcome {
  if (outcome.kind !== 'selected' || !world.hasComponent(entity, ViewGpuDrivenPrepareInput))
    return outcome;
  const staged = world
    .resolveUniqueRef<ViewGpuDrivenPrepareState>(
      requireViewField(world, entity, ViewGpuDrivenPrepareInput, 'state'),
    )
    .unwrap();
  if (staged.frame !== renderSubmission(world).frame) return outcome;
  try {
    const { sources } = staged;
    const lighting = viewStandardLightingOf(world, entity);
    if (
      lighting?.kind !== 'prepared' ||
      !lighting.lighting.ok ||
      lighting.fence.pipelineState === null
    )
      return { kind: 'unavailable', code: 'ssr-admission-unavailable' };
    const gpuDriven = withScene(sources.gpuDriven, outcome.scene?.queried);
    const frame = outcome.gpuLane ? gpuDriven : undefined;
    const input = buildFrameGpuDrivenInput(
      sources,
      gpuDriven,
      frame,
      lighting.lighting.value.standard,
      lighting.fence.pipelineState,
    );
    const resourceGeneration = sources.gpuDriven.owner.resourceGeneration;
    const request = input.request;
    const prepared =
      request === undefined
        ? undefined
        : runProfiledRenderPhase(sources.internals.profiler?.activeSession(), 'record', () =>
            runRecordProfilePhase(sources.profilePhase, 'record/gpu-driven-prepare', () =>
              sources.gpuDriven.owner.prepare(request),
            ),
          );
    if (prepared !== undefined && !prepared.ok)
      return { kind: 'rejected', code: 'owner-prepare-rejected', error: prepared.error };
    const value = prepared?.value;
    // Cleanup owns this immediately, even if no recording resumes after Queue.
    if (value !== undefined) sources.frameState.gpuDrivenFrame = { prepared: value };
    return { ...outcome, preparation: { input, prepared: value, resourceGeneration } };
  } catch (cause) {
    return { kind: 'failed', code: 'input-rejected', cause };
  }
}

interface ViewGpuDrivenState {
  frame: number;
  outcome: ViewGpuDrivenOutcome;
}

/** A view's GPU preparation and raster outcome; shadow rejection may settle it during recording. */
export const ViewGpuDriven = defineComponent('ViewGpuDriven', {
  state: 'unique<ViewGpuDriven>',
});

/** The view's selection written this renderer frame; undefined when the system did not run for it. */
export function viewGpuDrivenOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewGpuDrivenOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewGpuDriven)) return undefined;
  const state = world
    .resolveUniqueRef<ViewGpuDrivenState>(requireViewField(world, entity, ViewGpuDriven, 'state'))
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/**
 * The forward Standard PBR GPU raster owns one color target while the
 * reflection fallback adds an MRT attachment, so a forward frame keeps the
 * ordinary CPU producer. Deferred writes the fallback in its lighting pass,
 * never in a raster pass, so the G-buffer keeps the GPU-driven lane (and the
 * visible-surface table that ray-traced GI requires). Capture views have
 * independent draw ownership; display-camera GPU work remains active while
 * their faces and SSR fallback attachments are recorded.
 */
function selectViewGpuDriven(
  world: World,
  entity: EntityHandle,
  source: PersistentGpuDrivenState | undefined,
): ViewGpuDrivenOutcome {
  const ssr = viewSsrAdmissionOf(world, entity);
  const lighting = viewStandardLightingOf(world, entity);
  if (ssr?.kind !== 'resolved' || lighting?.kind !== 'prepared' || !lighting.lighting.ok)
    return { kind: 'unavailable', code: 'ssr-admission-unavailable' };
  const fallbackLaneLimit =
    ssr.reflectionFallbackCandidate &&
    lighting.lighting.value.standard.prepared.renderPath !== 'deferred';
  let scene: ViewGpuDrivenScene | undefined;
  try {
    // Native source plans expand their tasks only for an executed view.
    scene = source === undefined ? undefined : { source, queried: querySceneExecution(source) };
  } catch (cause) {
    return { kind: 'failed', code: 'scene-query-rejected', cause };
  }
  return {
    kind: 'selected',
    gpuLane: !fallbackLaneLimit,
    laneReason: fallbackLaneLimit ? 'reflection-fallback-mrt' : undefined,
    scene,
  };
}

/** The input a recording draws its GPU-driven work from. */
export interface GpuDrivenSceneInput {
  readonly scene: PersistentGpuDrivenState | undefined;
}

/** A recording's GPU-driven input with its scene queried, and the lane this frame draws with. */
export interface ConsumedViewGpuDriven<T extends GpuDrivenSceneInput> {
  /** The input with its executed GPU Scene query; the CPU lane still reads its rows. */
  readonly input: T | undefined;
  /** `input` when the frame keeps the GPU-driven lane. */
  readonly frame: T | undefined;
  readonly preparation?: ViewGpuDrivenPreparation;
  readonly rejected?: true;
}

function withScene<T extends GpuDrivenSceneInput>(
  input: T,
  scene: PersistentGpuDrivenState | undefined,
): T {
  return scene === input.scene ? input : { ...input, scene };
}

/** A direct recorder outside a Render World view queries its own scene and keeps its lane. */
function consumeDirectGpuDriven<T extends GpuDrivenSceneInput>(
  gpuDriven: T | undefined,
): ConsumedViewGpuDriven<T> {
  const scene = gpuDriven?.scene;
  const input =
    gpuDriven === undefined || scene === undefined
      ? gpuDriven
      : withScene(gpuDriven, querySceneExecution(scene));
  return { input, frame: input };
}

/**
 * The GPU-driven input this recording draws with: the GPU Scene query and
 * lane `render-gpu-driven-prepare` wrote in RenderQueue. The observation of
 * the recording reports the reason a GPU lane was declined; a rejected query
 * rethrows inside the recording's own recovery. A direct recorder outside a
 * Render World view has no reflection fallback demand, so it keeps the lane
 * it was given.
 */
export function consumeViewGpuDriven<T extends GpuDrivenSceneInput>(
  internals: RenderSystemInternals,
  gpuDriven: T | undefined,
  observe: (reason: GpuDrivenLaneReason | undefined) => void,
): ConsumedViewGpuDriven<T> {
  if (internals.viewEntity === undefined) {
    observe(undefined);
    return consumeDirectGpuDriven(gpuDriven);
  }
  const outcome = viewGpuDrivenOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome === undefined)
    throw new Error(`${RENDER_GPU_DRIVEN_PREPARE_SYSTEM} did not select the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'unavailable')
    throw new Error(`${RENDER_GPU_DRIVEN_PREPARE_SYSTEM}: ${outcome.code}`);
  if (outcome.kind === 'rejected') {
    internals.errorRegistry.fire(outcome.error);
    return { input: undefined, frame: undefined, rejected: true };
  }
  observe(outcome.laneReason);
  if (gpuDriven?.scene !== undefined && gpuDriven.scene !== outcome.scene?.source)
    throw new Error(`${RENDER_GPU_DRIVEN_PREPARE_SYSTEM} did not query the recorded GPU Scene`);
  const input = gpuDriven === undefined ? undefined : withScene(gpuDriven, outcome.scene?.queried);
  return {
    input,
    frame: outcome.gpuLane ? input : undefined,
    ...(outcome.preparation === undefined ? {} : { preparation: outcome.preparation }),
  };
}

/** Consume the staged resident inputs, retaining the positional path only for direct recorders. */
export function consumeRecordingGpuDriven(
  sources: Omit<FrameGpuDrivenSources, 'gpuDriven'>,
  gpuDriven: FrameGpuDrivenSources['gpuDriven'] | undefined,
  standard: Parameters<typeof buildFrameGpuDrivenInput>[3],
  pipeline: Parameters<typeof buildFrameGpuDrivenInput>[4],
) {
  const { internals, frameState } = sources;
  const consumed = consumeViewGpuDriven(internals, gpuDriven, (reason) =>
    frameState.surfaceSubmissionObservation?.setActualLaneReason(reason),
  );
  if (consumed.rejected) return undefined;
  const preparation = consumed.preparation;
  if (
    internals.viewEntity !== undefined &&
    consumed.input !== undefined &&
    preparation === undefined
  )
    throw new Error(`${RENDER_GPU_DRIVEN_PREPARE_SYSTEM} did not prepare the recorded view`);
  const input =
    preparation?.input ??
    buildFrameGpuDrivenInput(sources, consumed.input, consumed.frame, standard, pipeline);
  return { ...consumed, gpuInput: input, prepared: preparation?.prepared };
}

/**
 * Register `render-gpu-driven-prepare` (RenderQueue, after
 * `render-ssr-admission`): each view admitted this frame selects whether its
 * frame keeps the GPU-driven lane, queries the execution plan of the GPU
 * Scene it staged, and stores a frame-stamped outcome. A view without an
 * admission stores `unavailable` and a rejected query `failed`; the system
 * never throws.
 */
export function registerGpuDrivenPrepareSystem(world: World): void {
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_GPU_DRIVEN_PREPARE_SYSTEM,
      after: [RENDER_SSR_ADMISSION_SYSTEM],
      queries: [
        {
          read: [ViewPassPlans, ViewSsrAdmission],
          optional: [ViewStandardLighting, ViewGpuDrivenPrepareInput, ViewGpuDriven],
        },
      ],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewGpuDrivenState }[] = [];

        views.forEach((row) => {
          const entity = row.entity;

          if (viewSsrAdmissionOf(world, entity) === undefined) return;
          const stored = readViewField(world, entity, ViewGpuDriven, 'state');
          const previous =
            stored === undefined
              ? undefined
              : world.resolveUniqueRef<ViewGpuDrivenState>(stored).unwrap();
          if (previous?.frame === frame) return;
          const staged = world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap().staged;
          const outcome = prepareViewGpuDriven(
            world,
            entity,
            selectViewGpuDriven(world, entity, staged?.gpuDrivenScene),
          );
          if (previous === undefined) {
            first.push({ entity: entity, state: { frame, outcome } });
            return;
          }
          previous.frame = frame;
          previous.outcome = outcome;
        });
        // A view's first selection attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewGpuDriven,
              data: { state: world.allocUniqueRef('ViewGpuDriven', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
