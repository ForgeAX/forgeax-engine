import type { World } from '@forgeax/engine-ecs';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import type { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';
import type { CompositionEntry } from '../scene/scene-composition';
import { RenderPrepare } from './render-world';
import { RENDER_SCENE_PUBLISH_SYSTEM, sceneRowStep } from './scene-systems';

/*
 * Material adoption and the batch plan of the shared scene composition (E08).
 * The `render-scene` RenderExtract system applies the frame's rows and appends
 * the step to the `RenderSceneRows` store; each of these RenderPrepare systems
 * consumes it through its own cursor (adopt the rows' materials, run the
 * step's Pass query, publish its batch plan) before `render-scene-publish`
 * syncs the GPU Scene and accepts the observation. A failure is stored in
 * `RenderSceneDelta.failure` (each view rethrows it), gates the later steps
 * and leaves the observation unaccepted, so the next frame re-observes the
 * same changes.
 */

/** System names other Render World systems order against. */
export const RENDER_MATERIAL_ADOPT_SYSTEM = 'render-material-adopt';
export const RENDER_MATERIAL_PASSES_SYSTEM = 'render-material-passes';
export const RENDER_BATCH_PLAN_SYSTEM = 'render-batch-plan';

/** A bound row: its stable slot and the complete published snapshot. */
export interface BoundRenderable {
  readonly slot: number;
  readonly snapshot: RenderableSnapshot;
}

/** One applied row change as material adoption consumes it. */
export interface SceneMaterialChange {
  /** Slots whose binding retires (removed and recreated rows). */
  readonly retired: Iterable<{ readonly slot: number }>;
  /** Complete published rows; each replaces its slot's binding. */
  readonly bound: Iterable<BoundRenderable>;
  /** Membership delta for the batch topology; undefined when already applied. */
  readonly topology: RenderSceneApplyResult | undefined;
  /** Material assets whose accepted version changed this frame. */
  readonly materialUpdates: readonly MaterialResource[];
}

/** Retired slots of an applied delta: removed rows, then recreated rows. */
export function* retiredSlots(delta: RenderSceneApplyResult): Iterable<RenderSceneSlot> {
  yield* delta.removedSlots;
  yield* delta.recreatedSlots;
}

/** Complete rows of an applied publication delta (created, recreated, content-updated). */
export function* publishedRows(delta: RenderSceneApplyResult): Iterable<RenderSceneSlot> {
  yield* delta.createdSlots;
  yield* delta.recreatedSlots;
  yield* delta.contentUpdatedSlots;
}

/**
 * `render-material-adopt`: retire bindings, bind published rows, apply batch
 * membership, adopt changed material versions, then adopt Mesh changes. One
 * order for every source path (Worker publication, local partial apply,
 * steady frame, recompose).
 */
export function adoptSceneMaterials(entry: CompositionEntry, change: SceneMaterialChange): void {
  const dispatch = entry.materialDispatch;
  for (const { slot } of change.retired) dispatch.remove(slot);
  for (const { slot, snapshot } of change.bound) dispatch.bind(slot, snapshot);
  if (change.topology !== undefined) entry.topology.apply(change.topology);
  for (const material of change.materialUpdates) dispatch.adopt(material);
  dispatch.prepare(entry.projection.meshFrame());
}

/**
 * `render-batch-plan`: the batch plan a view reads. Accepted material classes
 * are adopted first, so every row's batch keeps its full binding-source
 * attribution before the plan is published.
 */
export function sourcePlanOf(entry: CompositionEntry): SubmissionPlan {
  entry.topology.adoptMaterials(entry.materialDispatch.materials(), entry.projection.slotAt);
  return entry.topology.sourcePlan();
}

/** Register the composition's material and batch-plan RenderPrepare systems. */
export function registerMaterialSystems(world: World): void {
  world
    .addSystem(RenderPrepare, {
      name: RENDER_MATERIAL_ADOPT_SYSTEM,
      queries: [],
      before: [RENDER_SCENE_PUBLISH_SYSTEM],
      fn: sceneRowStep(world, (stage) => adoptSceneMaterials(stage.entry, stage.change)),
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      name: RENDER_MATERIAL_PASSES_SYSTEM,
      queries: [],
      after: [RENDER_MATERIAL_ADOPT_SYSTEM],
      before: [RENDER_SCENE_PUBLISH_SYSTEM],
      fn: sceneRowStep(world, (stage, composition) => composition.queryMaterialPasses(stage.entry)),
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      name: RENDER_BATCH_PLAN_SYSTEM,
      queries: [],
      after: [RENDER_MATERIAL_ADOPT_SYSTEM],
      before: [RENDER_SCENE_PUBLISH_SYSTEM],
      fn: sceneRowStep(world, (stage, composition) =>
        composition.acceptBatchPlan(stage.entry, sourcePlanOf(stage.entry)),
      ),
    })
    .unwrap();
}
