import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { hasShadowViewDemand } from '../record/frame-targets';
import type { RenderSystemInternals } from '../record/render-context';
import { shadowViewContains } from '../record/shadow-culling';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import { type FrameList, sparseRowsOf } from '../scene/frame-list';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import { RENDER_CASCADE_FIT_SYSTEM } from './light-systems';
import {
  shadowViewCasterChannels,
  ViewCascadeFit,
  type ViewLights,
  viewLightsOf,
} from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission } from './render-world';
import { readViewField, requireViewField } from './view-field';
import { RENDER_VIEW_FRAME_SYSTEM, ViewFrame, type ViewFrameState } from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

/** System names other Render World systems order against. */
export const RENDER_SHADOW_CASTERS_SYSTEM = 'render-shadow-casters';

/** What a view's shadow casters are projected from: its frame's retained caster rows. */
export interface ShadowCasterSource {
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly worldBoundsOf: PersistentShadowCasterProjection['worldBoundsOf'];
  readonly skinRows?: PersistentShadowCasterProjection['skinRows'];
  /**
   * The view records capture faces (cube, auxiliary, reflection probe or
   * Feature scene input). Cube, auxiliary and scene-input faces still fit
   * their cascades at record time, after RenderPrepare, so their shadow views
   * are unknown here and every caster stays admitted.
   */
  readonly capture: boolean;
}

/** Whether this view's frame records capture faces: cube, auxiliary, probe or Feature scene input. */
export function recordsCaptures(internals: RenderSystemInternals, frame: ExtractedFrame): boolean {
  return (
    frame.cubeCameras.length > 0 ||
    (frame.reflectionProbes?.length ?? 0) > 0 ||
    frame.auxiliaryCameras.length > 0 ||
    (recordContext(internals).featureSceneInputs?.work.length ?? 0) > 0
  );
}

/** The followed frame's caster source; undefined before the view has a caster projection. */
function shadowCasterSource(
  owner: ViewSettlementOwner,
  frame: ExtractedFrame,
): ShadowCasterSource | undefined {
  const projection = owner.scene.shadowCasterProjection();
  return projection === undefined
    ? undefined
    : {
        renderables: projection.renderables,
        worldBoundsOf: projection.worldBoundsOf,
        skinRows: projection.skinRows,
        capture: recordsCaptures(owner.internals, frame),
      };
}

/** This frame's captured caster query and its reusable demand-projection memo. */
interface ViewShadowCastersState {
  frame: number;
  /** Skin casters some shadow view of this frame may raster; reused across frames. */
  readonly skin: RenderableSnapshot[];
  source: ShadowCasterSource;
  lights: ViewLights;
  projected: boolean;
  owner: Pick<GpuDrawSelection, 'ownsAll'> | undefined;
  capture: boolean;
}

/** Every fitted view's caster query, captured by Prepare and memoized when demand resolves it. */
export const ViewShadowCasters = defineComponent('ViewShadowCasters', {
  state: 'unique<ViewShadowCasters>',
});

/**
 * Resolve this frame's CPU Skin casters under the demand consumer's current
 * GPU owner; undefined when the view has no shadow view demand.
 */
export function viewShadowCastersOf(
  world: World,
  entity: EntityHandle | undefined,
  owner?: Pick<GpuDrawSelection, 'ownsAll'>,
  capture = false,
): readonly RenderableSnapshot[] | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewShadowCasters)) return undefined;
  const state = world
    .resolveUniqueRef<ViewShadowCastersState>(
      requireViewField(world, entity, ViewShadowCasters, 'state'),
    )
    .unwrap();
  if (state.frame !== renderSubmission(world).frame) return undefined;
  if (!state.projected || state.owner !== owner || state.capture !== capture) {
    projectSkinShadowCasters(state.source, state.lights, state.skin, owner, capture);
    state.projected = true;
    state.owner = owner;
    state.capture = capture;
  }
  return state.skin;
}

/** Whether some shadow view of `lights` rasters `row`: its caster channels and frustum. */
function shadowViewsAdmit(
  row: RenderableSnapshot,
  lights: ViewLights,
  boundsOf: ShadowCasterSource['worldBoundsOf'],
): boolean {
  const channels = row.shadowChannels ?? 0xffffffff;
  for (const view of lights.shadowViews)
    if (
      (channels & (shadowViewCasterChannels(lights, view.identity) ?? 0xffffffff)) !== 0 &&
      shadowViewContains(row, view.planes, boundsOf)
    )
      return true;
  return false;
}

/**
 * Project the Skin rows any shadow view of `lights` may raster into `out`.
 * Only Skin casters are projected: they are the casters whose palettes
 * `render-skin-demand` composes before recording. A capture view, or a view
 * whose shadow views are not fitted yet, admits every caster.
 */
export function projectSkinShadowCasters(
  source: ShadowCasterSource,
  lights: ViewLights,
  out: RenderableSnapshot[],
  owner?: Pick<GpuDrawSelection, 'ownsAll'>,
  capture = false,
): void {
  out.length = 0;
  const every = capture || source.capture || lights.shadowViews.length === 0;
  const selected = every ? undefined : owner;
  const candidates = source.skinRows?.(selected) ?? sparseRowsOf(source.renderables, 'skin');
  for (const row of candidates)
    if (
      row.skinBinding !== undefined &&
      selected?.ownsAll(row) !== true &&
      row.shadowCaster !== false &&
      row.authorVisible !== false &&
      (every || shadowViewsAdmit(row, lights, source.worldBoundsOf))
    )
      out.push(row);
}

/**
 * Register `render-shadow-casters` (RenderPrepare, after `render-view-frame`
 * and `render-cascade-fit`): each view whose frame resolved and whose fitted
 * lights demand shadow views captures a query in {@link ViewShadowCasters}.
 * Prepare captures the retained caster query and
 * fitted lights without walking Skin rows. The demand consumer resolves it
 * under its current GPU owner in Queue, so a lost owner widens this same
 * frame before any CPU palette is composed.
 */
export function registerShadowCasterSystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_SHADOW_CASTERS_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM, RENDER_CASCADE_FIT_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewCascadeFit, ViewShadowCasters] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewShadowCastersState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const view = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (view.frame !== frame || view.mode === false || view.result?.ok !== true) return;
          const lights = viewLightsOf(world, entity);
          if (lights === undefined || !hasShadowViewDemand(lights)) return;
          const source = shadowCasterSource(
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            view.result.value,
          );
          if (source === undefined) return;
          const slot = readViewField(world, entity, ViewShadowCasters, 'state');
          const state =
            slot === undefined
              ? {
                  frame,
                  skin: [],
                  source,
                  lights,
                  projected: false,
                  owner: undefined,
                  capture: false,
                }
              : world.resolveUniqueRef<ViewShadowCastersState>(slot).unwrap();
          state.frame = frame;
          state.source = source;
          state.lights = lights;
          state.projected = false;
          if (slot === undefined) first.push({ entity: entity, state });
        });
        // A view's first projection attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewShadowCasters,
              data: { state: world.allocUniqueRef('ViewShadowCasters', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
