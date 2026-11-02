import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { SkinTaskBinding } from '../record/skin-tasks';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import { recordRetirementError } from '../render-system-record-attempt';
import { sparseRowsOf } from '../scene/frame-list';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import { RENDER_GPU_DRIVEN_PREPARE_SYSTEM } from './gpu-driven-systems';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCleanup, RenderQueue, renderSubmission } from './render-world';
import { recordsCaptures, viewShadowCastersOf } from './shadow-caster-systems';
import { RENDER_RECORD_COMMIT_SYSTEM, RENDER_RECORD_RETIRE_SYSTEM } from './submission-systems';
import { readViewField, requireViewField } from './view-field';
import { ViewFrame, type ViewFrameState, viewFrameOf } from './view-frame-systems';
import { recordContext } from './view-record-context';
import {
  ownerOf,
  RENDER_SKIN_COMPLETE_SYSTEM,
  RENDER_SKIN_TRACK_SYSTEM,
  registerViewCommit,
  type ViewSettlementOwner,
} from './view-settlement';

/** System names other Render World systems order against. */
export const RENDER_SKIN_DEMAND_SYSTEM = 'render-skin-demand';

/**
 * The CPU Skin rows a view may draw, keyed by `worldEntityKey`: the row's task
 * binding, composed and uploaded in RenderQueue, or `undefined` when the row
 * has no Scene slot or no current pose (no draw). Recording only reads it; a
 * CPU Skin draw whose row is absent is a `skin-demand-missing` diagnostic.
 */
export type SkinDemandSet = ReadonlyMap<number, SkinTaskBinding | undefined>;

/** The GPU raster lane `render-skin-demand` predicts this frame's GPU-drawn Skin rows from. */
export interface SkinDemandLane {
  /** The lane's GPU draw selection: a row it owns entirely draws on the GPU in the main view. */
  readonly selection: Pick<GpuDrawSelection, 'ownsAll'>;
  /** GPU Shadow executions covered by the current accepted program proof. */
  readonly shadowSelection: Pick<GpuDrawSelection, 'ownsAll'> | undefined;
}

/**
 * The Skin rows a CPU walk may draw, given the GPU lane `owner` that draws a
 * row it owns entirely; without an owner every row may draw on the CPU. A row
 * without GPU-driven draws (unbatched geometry) or a member of a binding the
 * selection does not cover stays.
 */
export function cpuSkinRows(
  rows: Iterable<RenderableSnapshot>,
  owner: Pick<GpuDrawSelection, 'ownsAll'> | undefined,
): Iterable<RenderableSnapshot> {
  if (owner === undefined) return rows;
  return (function* () {
    for (const row of rows) if (!owner.ownsAll(row)) yield row;
  })();
}

/** A view's demand set, or the structured cause its recording reports. */
export type SkinDemandResult =
  | { readonly ok: true; readonly value: SkinDemandSet }
  | { readonly ok: false; readonly cause: unknown };

/**
 * The CPU Skin rows this view's frame may draw, read only from the ViewFrame
 * cull, the view's `render-shadow-casters` projection and its GPU raster
 * lane. On the GPU lane the main view draws the residual rows of the
 * committed raster selection; before a commit (pipelines still preparing)
 * the latest staged lane predicts them. A consumer that records every Skin
 * row on the CPU (temporal scene data, coverage, outline, capture or the
 * direct lane) widens it to every author-visible Skin row. Shadow views add
 * the projected Skin casters the GPU shadow views do not draw.
 */
function* skinDemandRows(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  frame: ExtractedFrame,
): Generator<RenderableSnapshot> {
  const { internals } = owner;
  const capture = recordsCaptures(internals, frame);
  const camera = frame.cameras[0];
  const lane =
    capture ||
    recordContext(internals).captureView !== undefined ||
    camera?.dynamicResolution !== undefined ||
    camera?.outline !== undefined ||
    camera?.screenSpaceReflection !== undefined ||
    standardSceneTemporalDemand(camera, internals.standardProfile?.visibleSurface === true) ||
    viewFrameOf(world, entity)?.opts.geometryLane === 'direct'
      ? undefined
      : owner.scene.skinDemandLane();
  // Capture and TAA requests draw rows the camera frustum rejects.
  const admitted = !capture && camera?.antialias !== 'taa';
  const owned = lane === undefined ? undefined : frame.gpuOwned;
  const main =
    owned !== undefined
      ? (owned.residualSkin?.() ?? owned.residual(owned.selection))
      : cpuSkinRows(sparseRowsOf(frame.renderables, 'skin'), lane?.selection);
  for (const row of main)
    if (
      row.skinBinding !== undefined &&
      row.authorVisible !== false &&
      (!admitted || frame.cameraVisible?.(row) !== false)
    )
      yield row;
  yield* viewShadowCastersOf(world, entity, lane?.shadowSelection, capture) ?? [];
}

/** Payload of {@link ViewSkinDemand}; `frame` is the renderer frame `result` belongs to. */
export interface ViewSkinDemandState {
  frame: number;
  result: SkinDemandResult | undefined;
}

/** Every recording view's CPU Skin demand; written by `render-skin-demand` in RenderQueue. */
export const ViewSkinDemand = defineComponent('ViewSkinDemand', {
  state: 'unique<ViewSkinDemand>',
});

/** The view's demand of the current renderer frame; undefined when it was not prepared. */
export function viewSkinDemandOf(
  world: World,
  entity: EntityHandle | undefined,
): SkinDemandResult | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewSkinDemand)) return undefined;
  const state = world
    .resolveUniqueRef<ViewSkinDemandState>(requireViewField(world, entity, ViewSkinDemand, 'state'))
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.result : undefined;
}

/**
 * Register `render-skin-demand` (RenderQueue, after GPU preparation): each view whose
 * `render-view-frame` succeeded composes and uploads the palettes of the CPU
 * Skin rows its frame may draw: its main-view cull rows plus the
 * `render-shadow-casters` projection, less the rows the view's latest GPU
 * raster lane draws (candidate-set policy). Recording reads the set and a draw outside it is a
 * diagnostic. The system never throws; a failure is the view's result.
 */
export function registerSkinDemandSystem(world: World): void {
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_SKIN_DEMAND_SYSTEM,
      after: [RENDER_GPU_DRIVEN_PREPARE_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewSkinDemand] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: [EntityHandle, ViewSkinDemandState][] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const view = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (view.frame !== frame) return;
          // A held view records nothing; its draws consume no palettes.
          let result: SkinDemandResult | undefined;
          if (view.mode !== false && view.result?.ok === true) {
            try {
              const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
              result = {
                ok: true,
                value: owner.skin.prepareDemand(
                  skinDemandRows(world, entity, owner, view.result.value),
                ),
              };
            } catch (cause) {
              result = { ok: false, cause };
            }
          }
          const slot = readViewField(world, entity, ViewSkinDemand, 'state');
          if (slot === undefined) {
            first.push([entity, { frame, result }]);
            return;
          }
          const demand = world.resolveUniqueRef<ViewSkinDemandState>(slot).unwrap();
          demand.frame = frame;
          demand.result = result;
        });
        // A view's first demand attaches its component after the iteration.
        for (const [entity, state] of first)
          world
            .addComponent(entity, {
              component: ViewSkinDemand,
              data: { state: world.allocUniqueRef('ViewSkinDemand', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}

/**
 * Register the Skin settlement systems on every Render World:
 * - `render-skin-track` (RenderCommit) pins a submitted view's task buffers and
 *   Scene roots to the submission's GPU completion;
 * - `render-skin-complete` (RenderCleanup, after `render-record-retire`)
 *   completes the view's recording lifecycle, advancing Scene roots only for an
 *   accepted scene submission and discarding them otherwise.
 * A failure never throws into the World; every cause is reported together.
 */
export function registerSkinSettlement(world: World): void {
  registerViewCommit(
    world,
    RENDER_SKIN_TRACK_SYSTEM,
    ({ skin, internals }, renderWorld) => {
      const completion = renderSubmission(renderWorld).completion;
      if (completion === undefined) return;
      try {
        skin.trackSubmittedWork(completion);
      } catch (cause) {
        internals.errorRegistry.fire(recordRetirementError([cause]));
      }
    },
    RENDER_RECORD_COMMIT_SYSTEM,
  );
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_SKIN_COMPLETE_SYSTEM,
      queries: [{ read: [ViewRecorder, ViewSubmission] }],
      after: [RENDER_RECORD_RETIRE_SYSTEM],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          if (requireViewField(world, entity, ViewSubmission, 'attempt') !== frame) return;
          const { skin, internals } = ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          );
          const failures = skin.complete(
            requireViewField(world, entity, ViewSubmission, 'accepted') &&
              requireViewField(world, entity, ViewSubmission, 'scene'),
          );
          if (failures.length > 0) internals.errorRegistry.fire(recordRetirementError(failures));
        });
      },
    })
    .unwrap();
}
