import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import type { Transparency } from '../components/camera';
import { resolveTransparencyView, type TransparencyViewResolution } from '../oit/view';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { RenderSystemInternals } from '../record/render-context';
import type { DispatchList, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { TransmissionDemand } from '../transmission/projection';
import {
  RENDER_PHASE_SORT_SYSTEM,
  registerQueueSystems,
  type ViewPhaseQueue,
  ViewPhases,
} from './queue-systems';
import { RenderCleanup, RenderQueue, renderWorldFor } from './render-world';
import type { SsrAdmissionInput } from './ssr-admission-systems';
import type { SubsurfaceAdmissionInput } from './subsurface-admission-systems';
import { readViewField, requireViewField } from './view-field';

/*
 * Per-view pass plans. A recording stages what its families read before the
 * frame's RenderQueue barrier; one RenderQueue system per pass family writes
 * that family's plan after `render-phase-sort`, and graph compile consumes the
 * whole plan. A family is planned only here: compile and inspection read the
 * plan and never re-derive it.
 */

/** RenderQueue: weighted-blended or sorted transparent composition of a view. */
export const RENDER_TRANSPARENT_PLAN_SYSTEM = 'render-transparent-plan';
/** RenderQueue: transmission backdrop demand and single-layer medium of a view. */
export const RENDER_TRANSMISSION_PLAN_SYSTEM = 'render-transmission-plan';
/** RenderQueue: the opaque Forward or Deferred G-buffer lane and its late occlusion pass. */
export const RENDER_OPAQUE_PLAN_SYSTEM = 'render-opaque-plan';

/** What a view's pass families read; staged by its recording before the queue barrier. */
export interface PassPlanInput {
  /** The view camera's requested composition; a missing Camera requests `sorted`. */
  readonly requested: Transparency;
  readonly rgba16floatRenderable: boolean;
  /** The view's visible renderables; empty for a Camera-less frame. */
  readonly renderables: FrameList<RenderableSnapshot>;
  /**
   * The view's culled dispatch before `render-phase-sort`. A view that staged
   * it for the sort plans over the phase order, the dispatch it records.
   */
  readonly dispatch: DispatchList;
  /** Whether this view staged `dispatch` for `render-phase-sort` this attempt. */
  readonly phaseSorted: boolean;
  /** The view's accepted material frame. */
  readonly materials: MaterialFrame;
  /** Transmission demand of the view's scene composition. */
  readonly sceneTransmission: TransmissionDemand;
  /** Materials of pending candidate pipeline preparations, which build real lanes. */
  readonly preparation: MaterialFrame | undefined;
  /** The view's admitted Standard render path. */
  readonly renderPath: StandardProfile['renderPath'];
  /** The installed pipeline's GPU occlusion switch; omitted means on. */
  readonly gpuOcclusion: boolean | undefined;
  /** A Camera-less view records a clear-only frame. */
  readonly clearOnly: boolean;
  /** What `render-ssr-admission` reads for this view. */
  readonly ssr: SsrAdmissionInput;
  /** What `render-subsurface-admission` reads for this view. */
  readonly subsurface: SubsurfaceAdmissionInput;
  /**
   * The resident GPU Scene `render-gpu-driven-prepare` queries for this view's
   * execution; omitted when the view has no resident GPU Scene.
   */
  readonly gpuDrivenScene?: PersistentGpuDrivenState;
}

/** Transmission backdrop and single-layer medium lanes of one view. */
export interface TransmissionPassPlan {
  readonly demand: TransmissionDemand;
  readonly singleLayerMedium: boolean;
}

/**
 * The opaque scene lane of one view: Forward main or Deferred G-buffer, each
 * followed by its HZB-tested late pass (`main-late` / `g-buffer-late`) when
 * late occlusion is planned and the GPU-driven projection admits it.
 */
export interface OpaquePassPlan {
  readonly lane: 'forward' | 'deferred';
  readonly lateOcclusion: boolean;
}

/** The pass families graph compile reads for one view. */
export interface ViewPassPlan {
  /** The accepted material frame has opaque draws that opt out of analytic fog. */
  readonly unfoggedOpaque: boolean;
  readonly transparent: TransparencyViewResolution;
  readonly transmission: TransmissionPassPlan;
  /** Undefined only for an unplanned recording, which plans with {@link planOpaque}. */
  readonly opaque: OpaquePassPlan | undefined;
}

/**
 * The opaque lane of a view. A clear-only frame stays on the Forward lane so
 * Deferred resources cannot introduce work; GPU occlusion is on unless the
 * installed pipeline turns it off.
 */
export function planOpaque(
  input: Pick<PassPlanInput, 'renderPath' | 'gpuOcclusion' | 'clearOnly'>,
): OpaquePassPlan {
  return {
    lane: input.clearOnly ? 'forward' : input.renderPath,
    lateOcclusion: input.gpuOcclusion !== false,
  };
}

/**
 * The plan of a recording that has no planned view: a target capture (sorted
 * composition, no backdrop or medium) or a direct recorder outside a Render
 * World view.
 */
export const EMPTY_VIEW_PASS_PLAN: ViewPassPlan = Object.freeze({
  unfoggedOpaque: false,
  transparent: Object.freeze({
    inspection: Object.freeze({
      requested: 'sorted',
      resolved: 'sorted',
      accumulatedDrawCount: 0,
      sortedDrawCount: 0,
      ineligible: Object.freeze({
        'blend-not-eligible': 0,
        'depth-write-enabled': 0,
        'program-without-oit-output': 0,
      }),
    }),
    topology: undefined,
  }),
  transmission: Object.freeze({
    demand: Object.freeze({ activeCount: 0, needsRoughMips: false }),
    singleLayerMedium: false,
  }),
  opaque: undefined,
});

/** The staged input a recording stages before RenderQueue; absent means nothing was staged. */
export const PASS_PLAN_INPUT_STAGE = 'view-pass-plan-input';

/** Why a view's pass plan cannot be read: the closed code and the system that did not write it. */
export interface PassPlanMissing {
  readonly code: 'pass-plan-missing';
  readonly system:
    | typeof PASS_PLAN_INPUT_STAGE
    | typeof RENDER_TRANSPARENT_PLAN_SYSTEM
    | typeof RENDER_TRANSMISSION_PLAN_SYSTEM
    | typeof RENDER_OPAQUE_PLAN_SYSTEM;
}

function missingPassPlan(system: PassPlanMissing['system']): Result<never, PassPlanMissing> {
  return err({ code: 'pass-plan-missing', system });
}

/** The message of a missing pass plan. */
export function passPlanMissingMessage(missing: PassPlanMissing): string {
  return missing.system === PASS_PLAN_INPUT_STAGE
    ? 'A view pass plan requires its staged input'
    : `${missing.system} did not plan the staged view`;
}

/** One view's staged pass-plan input and the families planned from it. */
export class ViewPassPlanQueue {
  staged: PassPlanInput | undefined;
  transparent: TransparencyViewResolution | undefined;
  transmission: TransmissionPassPlan | undefined;
  opaque: OpaquePassPlan | undefined;

  /** Stage this attempt's input; a previous attempt's plan is dropped. */
  stage(input: PassPlanInput): void {
    this.staged = input;
    this.transparent = undefined;
    this.transmission = undefined;
    this.opaque = undefined;
  }

  /**
   * The plan every family system wrote for the staged input. A missing plan is
   * data naming the system that did not write it; the staged attempt is kept.
   */
  read(): Result<ViewPassPlan, PassPlanMissing> {
    const { staged, transparent, transmission, opaque } = this;
    if (staged === undefined) return missingPassPlan(PASS_PLAN_INPUT_STAGE);
    if (transparent === undefined) return missingPassPlan(RENDER_TRANSPARENT_PLAN_SYSTEM);
    if (transmission === undefined) return missingPassPlan(RENDER_TRANSMISSION_PLAN_SYSTEM);
    if (opaque === undefined) return missingPassPlan(RENDER_OPAQUE_PLAN_SYSTEM);
    return ok({
      transparent,
      transmission,
      opaque,
      unfoggedOpaque: staged.materials.hasUnfoggedOpaque,
    });
  }

  /** Release this frame's borrowed products after graph compile and recording finish. */
  clear(): void {
    this.staged = undefined;
    this.transparent = undefined;
    this.transmission = undefined;
    this.opaque = undefined;
  }

  /** Direct plan harness: read the plan and end the attempt. */
  take(): ViewPassPlan {
    const read = this.read();
    if (!read.ok) throw new Error(passPlanMissingMessage(read.error));
    this.staged = undefined;
    this.transparent = undefined;
    this.transmission = undefined;
    this.opaque = undefined;
    return read.value;
  }
}

export const ViewPassPlans = defineComponent('ViewPassPlans', {
  state: 'unique<ViewPassPlanQueue>',
});

/** A view entity's pass-plan queue, created on first use. */
export function viewPassPlanQueue(world: World, entity: EntityHandle): ViewPassPlanQueue {
  if (!world.hasComponent(entity, ViewPassPlans)) {
    const state = world.allocUniqueRef('ViewPassPlanQueue', new ViewPassPlanQueue());
    world.addComponent(entity, { component: ViewPassPlans, data: { state } }).unwrap();
  }
  return world
    .resolveUniqueRef<ViewPassPlanQueue>(requireViewField(world, entity, ViewPassPlans, 'state'))
    .unwrap();
}

/** Borrow the current plan without ending its frame; graph compile reads the same product. */
export function readViewPassPlan(
  world: World,
  entity: EntityHandle,
): Result<ViewPassPlan, PassPlanMissing> {
  if (!world.hasComponent(entity, ViewPassPlans)) return missingPassPlan(PASS_PLAN_INPUT_STAGE);
  return world
    .resolveUniqueRef<ViewPassPlanQueue>(requireViewField(world, entity, ViewPassPlans, 'state'))
    .unwrap()
    .read();
}

/**
 * The plan RenderQueue wrote for this recording's view. A recording outside a
 * Render World view has no planned families and records the empty plan.
 */
export function consumeViewPassPlan(
  internals: RenderSystemInternals,
): Result<ViewPassPlan, PassPlanMissing> {
  const entity = internals.viewEntity;
  if (entity === undefined) return ok(EMPTY_VIEW_PASS_PLAN);
  return readViewPassPlan(renderWorldFor(internals), entity);
}

/** Candidate pipeline preparations add their transmission demand to the scene's. */
function planTransmission(input: PassPlanInput): TransmissionPassPlan {
  const scene = input.sceneTransmission;
  const preparation = input.preparation;
  const prepared = preparation?.transmissionDemand;
  return {
    demand:
      prepared === undefined || prepared.activeCount <= 0
        ? scene
        : {
            activeCount: scene.activeCount + prepared.activeCount,
            needsRoughMips: scene.needsRoughMips || prepared.needsRoughMips,
            needsBackPass: scene.needsBackPass === true || prepared.needsBackPass === true,
          },
    singleLayerMedium: input.materials.hasMedium || preparation?.hasMedium === true,
  };
}

/**
 * Register the pass-family RenderQueue systems (transparent, transmission and
 * opaque) once, after `render-phase-sort` (which they require, so it registers
 * first) so a sorted view plans over the dispatch order it records.
 */
export function registerPassPlanSystems(world: World): void {
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: 'render-pass-plan-release',
      queries: [{ read: [ViewPassPlans] }],
      fn: (world, [rows]) => {
        rows.forEach((row) => {
          const entity = row.entity;
          world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap()
            .clear();
        });
      },
    })
    .unwrap();
  if (world.hasResource(PassPlanSystems)) return;
  world.insertResource(PassPlanSystems, true);
  registerQueueSystems(world);
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_TRANSPARENT_PLAN_SYSTEM,
      queries: [{ read: [ViewPassPlans], optional: [ViewPhases] }],
      after: [RENDER_PHASE_SORT_SYSTEM],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const queue = world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap();
          const input = queue.staged;
          if (input === undefined || queue.transparent !== undefined) return;
          const phases = input.phaseSorted
            ? readViewField(world, entity, ViewPhases, 'state')
            : undefined;
          const ordered =
            phases === undefined
              ? undefined
              : world.resolveUniqueRef<ViewPhaseQueue>(phases).unwrap().ordered;
          queue.transparent = resolveTransparencyView({
            requested: input.requested,
            rgba16floatRenderable: input.rgba16floatRenderable,
            renderables: input.renderables,
            materialFrame: input.materials,
            dispatch: ordered ?? input.dispatch,
          });
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_TRANSMISSION_PLAN_SYSTEM,
      queries: [{ read: [ViewPassPlans] }],
      after: [RENDER_PHASE_SORT_SYSTEM],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const queue = world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap();
          const input = queue.staged;
          if (input === undefined || queue.transmission !== undefined) return;
          queue.transmission = planTransmission(input);
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_OPAQUE_PLAN_SYSTEM,
      queries: [{ read: [ViewPassPlans] }],
      after: [RENDER_PHASE_SORT_SYSTEM],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const queue = world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap();
          const input = queue.staged;
          if (input === undefined || queue.opaque !== undefined) return;
          queue.opaque = planOpaque(input);
        });
      },
    })
    .unwrap();
}

const PassPlanSystems = Object.freeze({ name: 'PassPlanSystems' });
