import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { drainFramePreparation, type FramePreparation } from '../assembly/frame-recording';
import { prepareRenderFrame } from '../assembly/render-frame';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { GpuTimingCapture } from '../record/gpu-timing';
import { activeRenderProfileSession } from '../record/profile-session';
import type { RenderSystemInternals } from '../record/render-context';
import type { DrawOptions } from '../render-contract';
import { createRendererState, type RendererState } from '../render-system';
import { RenderViewFrameSource, RenderViewInput, RenderViews } from '../world/render-views';
import {
  beginRenderFrame,
  endRenderFrame,
  renderSubmission,
  renderWorldFor,
} from '../world/render-world';
import { stageRenderScene } from '../world/view-frame-systems';
import { registerViewRecorderSystem, throwViewFailure } from '../world/view-output-systems';
import { viewOwnerOf } from '../world/view-settlement';
import { viewSourceFixture } from './view-source.fixture';

export * from '../render-system';

/** Standalone test adapter; production exposes device state and uses the Renderer World entry. */
export interface RenderSystem extends RendererState {
  /** Returns true only when this invocation reached queue submission. */
  draw(
    world: World,
    opts: DrawOptions,
    renderReadLease?: RenderReadLease,
    timingCapture?: GpuTimingCapture,
    publication?: PreparedRenderPublication,
  ): boolean;
  prepareSubmission(
    world: World,
    opts: DrawOptions,
    renderReadLease?: RenderReadLease,
    timingCapture?: GpuTimingCapture,
    publication?: PreparedRenderPublication,
    isCurrent?: () => boolean,
  ): FramePreparation;
}

export function createRenderSystem(internals: RenderSystemInternals): RenderSystem {
  const state = createRendererState(internals);
  const viewOwner = viewOwnerOf(internals);
  /**
   * A RenderSystem without a Renderer runs its private Render World's frames
   * itself, with the one primary view it records.
   */
  let privateFrame = 0;
  let privateViews:
    | {
        views: RenderViews;
        source: RenderViewFrameSource;
      }
    | undefined;

  return {
    ...state,
    draw(...args) {
      return drainFramePreparation(this.prepareSubmission(...args));
    },
    *prepareSubmission(world, opts, lease, timing, publication, isCurrent) {
      const recording = prepareRenderFrame({
        world: renderWorldFor(internals),
        device: internals.device,
        frameId: internals.observationFrameId ?? renderSubmission(renderWorldFor(internals)).frame,
        rendererInternals: internals,
        isCurrent,
        timingCapture: timing,
      });
      // A Renderer's frame entry runs its Render World; a RenderSystem built
      // without one is its own private Render World's frame entry.
      if (internals.renderWorld !== undefined) return yield* recording;
      const renderWorld = renderWorldFor(internals);
      if (privateViews === undefined) {
        const views = new RenderViews(renderWorld);
        const source = new RenderViewFrameSource(internals);
        privateViews = { views, source };
        renderWorld.insertResource(RenderViewInput, viewSourceFixture(source));
        registerViewRecorderSystem(renderWorld, views, { internals });
      }
      // No composed view is declared: the primary view records the display.
      privateViews.source.stage([], [], world, opts, lease, publication);
      stageRenderScene(
        renderWorld,
        viewOwner,
        world,
        opts,
        lease,
        publication,
        activeRenderProfileSession(internals),
      );
      try {
        beginRenderFrame(renderWorld, ++privateFrame);
        throwViewFailure(renderWorld);
        return yield* recording;
      } finally {
        // A frame whose Extract/Prepare threw still runs its Commit and Cleanup.
        endRenderFrame(renderWorld);
      }
    },
  };
}
