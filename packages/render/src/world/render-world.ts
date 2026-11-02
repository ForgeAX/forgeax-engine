import { defineSchedule, type ScheduleToken, World } from '@forgeax/engine-ecs';
import type { SurfaceDynamicInputFrame } from '../surface/dynamic-input';
import { registerCaptureGraphSystems } from './capture-graph-systems';
import { registerDisplaySubmissionSystems } from './display-submission-systems';
import { registerEnvironmentSystems } from './environment-systems';
import { registerFeatureGraphSystems } from './feature-graph-systems';
import { frameSubmitOutcome, registerFrameSubmitSystems } from './frame-submit-systems';
import { registerGraphSealSystems } from './graph-seal-systems';
import { registerGraphSubmissionSystems } from './graph-submission-systems';
import { registerGraphSystems } from './graph-systems';
import { registerShadowSettlement } from './light-systems';
import { registerPostSystems } from './post-systems';
import {
  RenderRecordInput,
  type RenderRecordInputState,
  registerRecordSystems,
} from './record-systems';
import { registerGpuDrivenSettlement } from './scene-row-systems';
import { registerSkinSettlement } from './skin-systems';
import { registerSubmissionSystems } from './submission-systems';
import { registerSurfaceUiSystems } from './surface-ui-systems';
import { registerTemporalSystems } from './temporal-systems';
import { registerViewRecordSystems } from './view-record-systems';

/** One Render World per Renderer, shared by its views; it never advances simulation time. */
export function createRenderWorld(): World {
  const world = new World();
  // Registration: one line per migrated domain, in merge order.
  registerSubmissionSystems(world);
  registerPostSystems(world);
  registerTemporalSystems(world);
  registerShadowSettlement(world);
  registerEnvironmentSystems(world);
  registerGpuDrivenSettlement(world);
  registerSkinSettlement(world);
  registerRecordSystems(world);
  registerGraphSystems(world);
  registerCaptureGraphSystems(world);
  registerGraphSealSystems(world);
  registerGraphSubmissionSystems(world);
  registerDisplaySubmissionSystems(world);
  registerFeatureGraphSystems(world);
  registerViewRecordSystems(world);
  registerFrameSubmitSystems(world);
  registerSurfaceUiSystems(world);
  return world;
}

const PRIVATE_WORLDS = new WeakMap<object, World>();

/**
 * The shared Render World of a record context. Low-level kernel fixtures without
 * a Renderer receive an owner-scoped World; their external test driver runs it.
 */
export function renderWorldFor(owner: { readonly renderWorld?: World | undefined }): World {
  let world = owner.renderWorld ?? PRIVATE_WORLDS.get(owner);
  if (world === undefined) {
    world = createRenderWorld();
    PRIVATE_WORLDS.set(owner, world);
  }
  return world;
}

/*
 * Render World frame contract. A Renderer frame runs these schedules once, in
 * this order. {@link beginRenderFrame} runs Extract and Prepare; the frame's
 * frame driver runs Queue ({@link runRenderQueue}) for attempts, phase plans and
 * graph inputs, then Record ({@link runRenderRecord}) for compile, seal, encode
 * and the one physical submission, and publishes {@link RenderSubmission};
 * {@link endRenderFrame} runs Commit and Cleanup. Domain schedules cannot order
 * across each other, so the sequence below is the phase order; inside a phase,
 * systems order with `before`/`after` system names.
 *
 * A domain registers its systems in `world/<domain>-systems.ts` on the phase
 * that owns its product. Frame inputs are World resources the frame entry
 * writes before `beginRenderFrame`; system state lives in components or
 * resources, never in a closure-captured pending field. A system never runs a
 * schedule itself, and a migrated step deletes its old hand-driven call.
 */

/** Adopt this frame's source facts into Render World entities and resources (views, scene, lights). */
export const RenderExtract = defineSchedule('RenderExtract');
/** Derive per-view and shared render state from the extracted entities (cull, LOD, shadows, skin, GI). */
export const RenderPrepare = defineSchedule('RenderPrepare');
/**
 * Classify, batch and sort the prepared draws into phases. It runs at the
 * shared submission's queue barrier, after each view's recording staged its
 * culled dispatch and cameras and before any view records GPU work.
 */
export const RenderQueue = defineSchedule('RenderQueue');
/**
 * Open the submission's one command encoder (`RenderFrameEncoder`) and compile
 * every staged view graph (`render-graph-compile`) after Queue, at the
 * submission's compile barrier, before any view records GPU work. It is the
 * only phase that owns an encoder. A submission outside an open frame (a
 * UI-only frame or a direct recording) has no Queue phase or compile barrier:
 * it runs Record before it records, and its views compile in place.
 */
export const RenderRecord = defineSchedule('RenderRecord');
/**
 * After recording, accepted or not: commit what an accepted attempt consumed.
 * A view's state commits only for its accepted `ViewSubmission` of this
 * frame; renderer-wide state only for an accepted `RenderSubmission`.
 */
export const RenderCommit = defineSchedule('RenderCommit');
/** After Commit: release frame-scoped state. */
export const RenderCleanup = defineSchedule('RenderCleanup');

/**
 * The Renderer's one submission/completion contract. Its shared submission
 * publishes the outcome ({@link publishRenderSubmission}) before
 * `RenderCommit`/`RenderCleanup` run; the frame entry reads the same
 * completion for its receipt and frame credit. `accepted` is queue acceptance
 * with every Feature scene input ready; `completion` is the submitted work's
 * GPU completion (set whenever the queue accepted the work), never implied by
 * submission itself. Per-view outcomes are each view entity's `ViewSubmission`.
 */
export interface RenderSubmissionState {
  /** The renderer frame `beginRenderFrame` opened. */
  frame: number;
  /** Whether a frame is open: `beginRenderFrame` ran and `endRenderFrame` has not closed it. */
  open: boolean;
  /** Device generation the published submission ran on; its completion recycles only that generation. */
  generation: number;
  accepted: boolean;
  completion: Promise<void> | undefined;
  /** The same completion ignoring completion holds: the frame credit returns on it. */
  creditCompletion: Promise<void> | undefined;
}

/** What a shared submission publishes. */
export type RenderSubmissionOutcome = Pick<
  RenderSubmissionState,
  'accepted' | 'completion' | 'creditCompletion' | 'generation'
>;

/** World resource key of the frame's {@link RenderSubmissionState}. */
export const RenderSubmission = Object.freeze({ name: 'RenderSubmission' });

/** The Render World's retained submission outcome. */
export function renderSubmission(world: World): RenderSubmissionState {
  if (!world.hasResource(RenderSubmission))
    world.insertResource<RenderSubmissionState>(RenderSubmission, {
      frame: 0,
      open: false,
      generation: 0,
      accepted: false,
      completion: undefined,
      creditCompletion: undefined,
    });
  return world.getResource<RenderSubmissionState>(RenderSubmission);
}

/** World resource key of the published {@link SurfaceDynamicInputFrame}; absent when none is published. */
export const RenderSurfaceDynamicInput = Object.freeze({ name: 'RenderSurfaceDynamicInput' });

/** Publish (or, with `undefined`, withdraw) the Surface dynamic page every view records with. */
export function publishSurfaceDynamicInput(
  world: World,
  frame: SurfaceDynamicInputFrame | undefined,
): void {
  if (frame === undefined) world.removeResource(RenderSurfaceDynamicInput);
  else world.insertResource<SurfaceDynamicInputFrame>(RenderSurfaceDynamicInput, frame);
}

/** The Surface dynamic page published for the Render World's views, if any. */
export function surfaceDynamicInputOf(world: World): SurfaceDynamicInputFrame | undefined {
  return world.hasResource(RenderSurfaceDynamicInput)
    ? world.getResource<SurfaceDynamicInputFrame>(RenderSurfaceDynamicInput)
    : undefined;
}

/** Whether the owner's Render World published an accepted submission for the open frame. */
export function frameAccepted(owner: { readonly renderWorld?: World | undefined }): boolean {
  return renderSubmission(renderWorldFor(owner)).accepted;
}

/**
 * The single writer of a submission outcome. A scene-free UI submission runs
 * Record outside an open scene frame and publishes the same physical facts.
 */
export function publishRenderSubmission(world: World, outcome: RenderSubmissionOutcome): void {
  Object.assign(renderSubmission(world), outcome);
}

const BEFORE_RECORD: readonly ScheduleToken[] = [RenderExtract, RenderPrepare];

function run(world: World, schedule: ScheduleToken): void {
  const ran = world.run(schedule);
  if (!ran.ok) throw ran.error;
}

/** Open renderer frame `frame`, then run the phases before view recording: Extract, Prepare. */
export function beginRenderFrame(world: World, frame: number): void {
  const submission = renderSubmission(world);
  submission.frame = frame;
  submission.open = true;
  submission.accepted = false;
  submission.completion = undefined;
  submission.creditCompletion = undefined;
  for (const schedule of BEFORE_RECORD) run(world, schedule);
}

/** Run the frame's Queue phase at the shared submission's queue barrier. */
export function runRenderQueue(world: World): void {
  run(world, RenderQueue);
}

/**
 * Run the submission's Record phase with its frame input. A failure returns as
 * data so the submission still settles every view and runs Commit/Cleanup.
 */
export function runRenderRecord(
  world: World,
  input: RenderRecordInputState,
): ReturnType<World['run']> {
  world.insertResource<RenderRecordInputState>(RenderRecordInput, input);
  frameSubmitOutcome(world).recordStarted = true;
  return world.run(RenderRecord);
}

/**
 * Close the frame after its submission settled or was abandoned: Commit, then
 * Cleanup. Cleanup runs even when Commit failed, so every staged attempt and
 * retirement of the frame still settles. Only an open frame closes: a frame
 * entry calls it unconditionally, including when the frame never opened.
 */
export function endRenderFrame(world: World): void {
  if (!renderSubmission(world).open) return;
  try {
    run(world, RenderCommit);
  } finally {
    try {
      run(world, RenderCleanup);
    } finally {
      renderSubmission(world).open = false;
    }
  }
}
