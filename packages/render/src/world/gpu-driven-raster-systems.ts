import type { World } from '@forgeax/engine-ecs';
import { EMPTY_GPU_DRAW_SELECTION, type GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { GpuDrivenMaterialProgramIndex } from '../gpu-driven/material-artifacts';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type { GpuDrivenRecordInput } from '../record/frame';
import type { RenderSystemInternals } from '../record/render-context';
import type { GpuRasterOwnership } from '../scene/render-scene';
import {
  RENDER_GPU_DRIVEN_PREPARE_SYSTEM,
  storeViewGpuDrivenOutcome,
  ViewGpuDriven,
  ViewGpuDrivenPrepareInput,
  viewGpuDrivenOf,
  viewGpuDrivenSourcesOf,
} from './gpu-driven-systems';
import { RENDER_OPAQUE_PLAN_SYSTEM, ViewPassPlans, viewPassPlanQueue } from './pass-plan-systems';
import { ViewRecorder } from './render-views';
import { RenderQueue, renderWorldFor } from './render-world';
import { RENDER_SKIN_DEMAND_SYSTEM } from './skin-systems';
import { requireViewField } from './view-field';
import { ownerOf } from './view-settlement';

export const RENDER_GPU_DRIVEN_RASTER_SYSTEM = 'render-gpu-driven-raster';

/** The raster geometry and shadow ownership this view's frame records. */
export interface GpuDrivenRasterLane {
  readonly raster: PreparedGpuDrivenFrame | undefined;
  readonly selection: GpuDrawSelection;
  readonly ownership: GpuRasterOwnership | undefined;
}

/** One derivation shared by the Queue system and a direct positional recorder. */
function rasterLane(
  frame: GpuDrivenRecordInput | undefined,
  prepared: PreparedGpuDrivenFrame | undefined,
  captureShadows: boolean,
  programs: GpuDrivenMaterialProgramIndex | undefined,
): GpuDrivenRasterLane {
  const raster = frame?.geometryLane === 'direct' ? undefined : prepared;
  const selection = raster?.selection ?? EMPTY_GPU_DRAW_SELECTION;
  const shadows =
    !captureShadows &&
    raster?.shadowSelection !== undefined &&
    raster.shadowViewPool !== undefined &&
    programs !== undefined
      ? { selection: raster.shadowSelection, programs }
      : undefined;
  return {
    raster,
    selection,
    ownership: raster === undefined ? undefined : { selection, shadows },
  };
}

/** A view records the Queue product; a direct recorder retains its positional lane. */
export function consumeViewGpuDrivenRaster(
  internals: RenderSystemInternals,
  input: GpuDrivenRecordInput | undefined,
  frame: GpuDrivenRecordInput | undefined,
  prepared: PreparedGpuDrivenFrame | undefined,
  captureShadows: boolean,
  programs: GpuDrivenMaterialProgramIndex | undefined,
): GpuDrivenRasterLane {
  if (internals.viewEntity === undefined || input === undefined) {
    const lane = rasterLane(frame, prepared, captureShadows, programs);
    input?.onRasterLane?.(lane.ownership);
    return lane;
  }
  const outcome = viewGpuDrivenOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome?.kind === 'failed') throw outcome.cause;
  if (outcome?.kind !== 'selected' || outcome.raster === undefined)
    throw new Error(`${RENDER_GPU_DRIVEN_RASTER_SYSTEM} did not stage the recorded view`);
  return outcome.raster;
}

/** Stage the next lane after Skin consumed the previous one, and refine HZB before compile. */
export function registerGpuDrivenRasterSystem(world: World): void {
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_GPU_DRIVEN_RASTER_SYSTEM,
      after: [
        RENDER_GPU_DRIVEN_PREPARE_SYSTEM,
        RENDER_SKIN_DEMAND_SYSTEM,
        RENDER_OPAQUE_PLAN_SYSTEM,
      ],
      queries: [
        {
          read: [ViewRecorder, ViewGpuDriven, ViewPassPlans],
          optional: [ViewGpuDrivenPrepareInput],
        },
      ],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const outcome = viewGpuDrivenOf(world, entity);
          if (outcome?.kind !== 'selected' || outcome.raster !== undefined) return;
          try {
            const sources = viewGpuDrivenSourcesOf(world, entity);
            if (sources === undefined) return;
            const lane = rasterLane(
              outcome.gpuLane ? sources.gpuDriven : undefined,
              outcome.preparation?.prepared,
              sources.captureShadows === true,
              sources.shadowCasterProjection?.materialPrograms,
            );
            ownerOf(
              world,
              requireViewField(world, entity, ViewRecorder, 'state'),
            ).scene.stageRasterLane(lane.ownership);
            const queue = viewPassPlanQueue(world, entity);
            if (queue.opaque !== undefined)
              queue.opaque = {
                ...queue.opaque,
                lateOcclusion: queue.opaque.lateOcclusion && lane.raster !== undefined,
              };
            storeViewGpuDrivenOutcome(world, entity, { ...outcome, raster: lane });
          } catch (cause) {
            storeViewGpuDrivenOutcome(world, entity, {
              kind: 'failed',
              code: 'raster-lane-rejected',
              cause,
            });
          }
        });
      },
    })
    .unwrap();
}
