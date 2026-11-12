import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { type VisibleSurfaceProjection, VisibleSurfaceRows } from '../raytracing/visible-surface';
import {
  commitDiffuseGi,
  type FrameDiffuseGi,
  prepareViewDiffuseGi,
  type ViewDiffuseGiOutcome,
} from '../record/frame-diffuse-gi';
import type { ProjectedRows } from '../scene/row-projection';
import { RENDER_CASCADE_FIT_SYSTEM } from './light-systems';
import { VIEW_REFLECTION_PROBES_SYSTEM } from './reflection-systems';
import { ViewCascadeFit } from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderCleanup, RenderCommit, RenderPrepare, renderSubmission } from './render-world';
import { RENDER_SCENE_PUBLISH_SYSTEM } from './scene-systems';
import { readViewField, requireViewField } from './view-field';
import { RENDER_VIEW_FRAME_SYSTEM, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { ownerOf } from './view-settlement';

export const GI_SUBMISSION_COMMIT_SYSTEM = 'gi-submission-commit';
export const GI_SUBMISSION_CLEANUP_SYSTEM = 'gi-submission-cleanup';
export const VISIBLE_SURFACE_ROWS_SYSTEM = 'visible-surface-rows';
export const VIEW_DIFFUSE_GI_SYSTEM = 'view-diffuse-gi';

/**
 * The diffuse GI frames of this Renderer frame. A view enqueues its GI owners
 * when it prepares them and marks them `submitted` once its submitted work is
 * accepted by the view's commit; the RenderCommit system advances the submitted frames'
 * accepted history, and RenderCleanup aborts every prepared frame the
 * Renderer frame did not commit.
 */
export interface GiSubmissionQueue {
  readonly prepared: FrameDiffuseGi[];
  readonly submitted: FrameDiffuseGi[];
}

export const GiSubmissions = Object.freeze({ name: 'GiSubmissions' });

/** The Renderer's GI submission queue; absent when no frame entry owns the Render World. */
export function giSubmissionsOf(world: World | undefined): GiSubmissionQueue | undefined {
  return world?.hasResource(GiSubmissions) === true
    ? world.getResource<GiSubmissionQueue>(GiSubmissions)
    : undefined;
}

/** The queue a view's GI preparation enqueues into; GI runs only inside a Renderer frame entry. */
export function requireGiSubmissions(internals: {
  readonly renderWorld?: World | undefined;
}): GiSubmissionQueue {
  const queue = giSubmissionsOf(internals.renderWorld);
  if (queue === undefined)
    throw new Error('diffuse GI submission requires the Renderer frame entry of its Render World');
  return queue;
}

/** Register the GI commit/cleanup systems and their queue on a Render World once. */
export function registerGiSystems(world: World): void {
  if (world.hasResource(GiSubmissions)) return;
  const queue: GiSubmissionQueue = { prepared: [], submitted: [] };
  world.insertResource(GiSubmissions, queue);
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: GI_SUBMISSION_COMMIT_SYSTEM,
      queries: [],
      fn: (world) => {
        const queue = world.getResource<GiSubmissionQueue>(GiSubmissions);
        for (const gi of queue.submitted) commitDiffuseGi(gi);
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: GI_SUBMISSION_CLEANUP_SYSTEM,
      queries: [],
      fn: (world) => {
        const queue = world.getResource<GiSubmissionQueue>(GiSubmissions);
        // A committed placement is settled, so its abort is a no-op; an
        // uncommitted candidate retires without becoming the accepted pair.
        for (const gi of queue.prepared) gi.probePlacement?.abort();
        queue.prepared.length = 0;
        queue.submitted.length = 0;
      },
    })
    .unwrap();
}

/**
 * The frame's visible-surface addresses, projected once from the shared
 * retained composition for every view. A projection failure is stored, never
 * thrown, so a view's admission rethrows it inside its own record recovery.
 */
export interface VisibleSurfaceState {
  readonly rows: VisibleSurfaceRows;
  projection: VisibleSurfaceProjection | undefined;
  failure: unknown;
}

export const VisibleSurfaceInput = Object.freeze({ name: 'VisibleSurfaceInput' });

/** What the `visible-surface-rows` system reads from its Renderer. */
export interface VisibleSurfaceSource {
  /** The Standard profile enables visible surfaces. */
  readonly enabled: () => boolean;
  /** The shared composition's complete retained rows, published in RenderPrepare. */
  readonly retained: () => ProjectedRows | undefined;
  /** The device's row budget. */
  readonly maxRecords: () => number;
}

/** The frame's visible-surface state; absent when no composition owner registered it. */
export function visibleSurfaceOf(world: World): VisibleSurfaceState | undefined {
  return world.hasResource(VisibleSurfaceInput)
    ? world.getResource<VisibleSurfaceState>(VisibleSurfaceInput)
    : undefined;
}

/**
 * Register the RenderPrepare system that keeps the visible-surface rows current
 * from the frame's adopted scene changes. Each update re-projects only changed
 * rows, so steady frames stay O(changes) however many views read them.
 */
export function registerVisibleSurfaceSystem(world: World, source: VisibleSurfaceSource): void {
  const state: VisibleSurfaceState = {
    rows: new VisibleSurfaceRows(),
    projection: undefined,
    failure: undefined,
  };
  world.insertResource(VisibleSurfaceInput, state);
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: VISIBLE_SURFACE_ROWS_SYSTEM,
      queries: [],
      // The rows read the composition's published step, staged materials included.
      after: [RENDER_SCENE_PUBLISH_SYSTEM],
      runIf: source.enabled,
      fn: (world) => {
        const state = world.getResource<VisibleSurfaceState>(VisibleSurfaceInput);
        state.projection = undefined;
        state.failure = undefined;
        const retained = source.retained();
        if (retained === undefined) return;
        const updated = state.rows.update(retained, source.maxRecords());
        if (updated.ok) state.projection = updated.value;
        else state.failure = updated.error;
      },
    })
    .unwrap();
}

interface ViewDiffuseGiState {
  frame: number;
  outcome: ViewDiffuseGiOutcome;
}

/** A recording view's RenderPrepare GI; written only by `view-diffuse-gi`. */
export const ViewDiffuseGi = defineComponent('ViewDiffuseGi', { state: 'unique<ViewDiffuseGi>' });

/** The view's GI prepared this renderer frame; undefined when `view-diffuse-gi` did not run for it. */
export function viewDiffuseGiOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewDiffuseGiOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewDiffuseGi)) return undefined;
  const state = world
    .resolveUniqueRef<ViewDiffuseGiState>(requireViewField(world, entity, ViewDiffuseGi, 'state'))
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/**
 * Register `view-diffuse-gi` (RenderPrepare): each staged view whose frame
 * resolved configures its dynamic resolution and prepares its GI owners from
 * its camera, hoisted extent, `render-cascade-fit` lights, its GPU scene and
 * the `visible-surface-rows` projection. The prepared owners enter the
 * {@link GiSubmissions} queue the `gi-submission-*` systems settle. A failure
 * is stored with its closed code, never thrown; the view's recording rethrows
 * its cause.
 */
export function registerViewDiffuseGiSystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: VIEW_DIFFUSE_GI_SYSTEM,
      after: [
        RENDER_VIEW_FRAME_SYSTEM,
        RENDER_CASCADE_FIT_SYSTEM,
        VISIBLE_SURFACE_ROWS_SYSTEM,
        // Probe capture work rejects probe placement on the same view.
        VIEW_REFLECTION_PROBES_SYSTEM,
      ],
      // The cascade fit is read through `viewLightsOf`; an unfitted view has none.
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewDiffuseGi, ViewCascadeFit] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewDiffuseGiState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame || staged.result?.ok !== true) return;
          const outcome = prepareViewDiffuseGi(
            world,
            entity,
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            staged,
          );
          const stored = readViewField(world, entity, ViewDiffuseGi, 'state');
          if (stored === undefined) {
            first.push({ entity: entity, state: { frame, outcome } });
            return;
          }
          const state = world.resolveUniqueRef<ViewDiffuseGiState>(stored).unwrap();
          state.frame = frame;
          state.outcome = outcome;
        });
        // A view's first GI attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewDiffuseGi,
              data: { state: world.allocUniqueRef('ViewDiffuseGi', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
