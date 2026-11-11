import type { World } from '@forgeax/engine-ecs';
import type { RhiError } from '@forgeax/engine-rhi';
import type { SceneComposition } from '../scene/scene-composition';
import { ViewRecorder, ViewSubmission } from './render-views';
import { RenderCleanup, RenderCommit, renderSubmission } from './render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from './submission-systems';
import { requireViewField } from './view-field';
import {
  ownerOf,
  RENDER_FOG_COMMIT_SYSTEM,
  RENDER_GPU_DRIVEN_ABORT_SYSTEM,
  RENDER_GPU_DRIVEN_COMMIT_SYSTEM,
  registerViewCommit,
} from './view-settlement';

/** RenderCommit: the GPU Scene frame stamp and canonical submitted history advance. */
export const RENDER_SCENE_COMMIT_SYSTEM = 'render-scene-commit';
/** RenderCommit: each view adopts the raster lane its accepted attempt staged. */
export const RENDER_VIEW_RASTER_LANE_SYSTEM = 'render-view-raster-lane';

/**
 * The Renderer's shared scene rows advance once per accepted Renderer
 * submission, however many views drew them: the stamp when an accepted view
 * attempt of this frame submitted scene draws, and canonical history when one
 * of those attempts staged temporal data. Each view's GPU raster lane is
 * adopted the same way, for that view's accepted attempt only.
 */
export function registerSceneRowSystems(
  world: World,
  composition: SceneComposition,
  report: (error: RhiError) => void,
): void {
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_SCENE_COMMIT_SYSTEM,
      queries: [{ read: [ViewSubmission] }],
      after: [RENDER_RECORD_COMMIT_SYSTEM],
      fn: (world, [views]) => {
        const submission = renderSubmission(world);
        if (!submission.accepted) return;
        let scene = false;
        let temporal = false;
        for (const span of views.spans().unwrap()) {
          const columns = span.get(ViewSubmission);
          for (let index = 0; index < span.length; index++) {
            if (
              columns.accepted[index] !== 1 ||
              columns.scene[index] !== 1 ||
              columns.attempt[index] !== submission.frame
            )
              continue;
            scene = true;
            temporal ||= columns.temporal[index] === 1;
          }
        }
        if (!scene) return;
        const committed = composition.commitFrame(temporal);
        if (!committed.ok) report(committed.error);
      },
    })
    .unwrap();
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_VIEW_RASTER_LANE_SYSTEM,
      queries: [{ read: [ViewRecorder, ViewSubmission] }],
      // Next frame's CPU cull bypass follows only a lane this frame submitted.
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          if (
            !requireViewField(world, entity, ViewSubmission, 'accepted') ||
            requireViewField(world, entity, ViewSubmission, 'attempt') !== frame
          )
            return;
          ownerOf(
            world,
            requireViewField(world, entity, ViewRecorder, 'state'),
          ).scene.commitRasterLane();
        });
      },
    })
    .unwrap();
}

/**
 * The prepared GPU-driven frame of a view settles with its attempt: an
 * accepted scene submission commits its resource replacement and consumes the
 * surface dynamic input; whatever is still staged afterwards is aborted
 * (the abort is idempotent after a commit).
 */
export function registerGpuDrivenSettlement(world: World): void {
  registerViewCommit(
    world,
    RENDER_GPU_DRIVEN_COMMIT_SYSTEM,
    ({ frameState, internals }) => {
      const staged = frameState.gpuDrivenFrame;
      if (staged?.commit === undefined) return;
      staged.prepared._commitResourceReplacement(staged.commit.shadowGraphGeneration);
      const consumed = staged.prepared._consumeSurfaceDynamicInput?.(staged.commit.frameNumber);
      if (consumed !== undefined && !consumed.ok) internals.errorRegistry.fire(consumed.error);
    },
    RENDER_FOG_COMMIT_SYSTEM,
    'scene',
  );
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_GPU_DRIVEN_ABORT_SYSTEM,
      queries: [{ read: [ViewRecorder] }],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;

          const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
          owner.frameState.gpuDrivenFrame?.prepared._abortResourceReplacement?.();
          owner.frameState.gpuDrivenFrame = undefined;
        });
      },
    })
    .unwrap();
}
