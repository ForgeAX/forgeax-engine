import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { DirectionalLight } from '../components/directional-light';
import type { LightRoster } from '../render-system-extract';
import {
  type CascadeFit,
  type CascadeHistory,
  createViewRecord,
  RenderLight,
  RenderPointShadow,
  renderLightsOf,
  ViewCascadeFit,
  ViewCascadeHistory,
  type ViewRecord,
} from './render-lights';
import {
  RenderView,
  ViewCamera,
  type ViewCameraState,
  type ViewHistory,
  ViewRecorder,
  ViewSubmission,
} from './render-views';
import {
  RenderCleanup,
  RenderCommit,
  RenderExtract,
  RenderPrepare,
  renderSubmission,
} from './render-world';
import { RENDER_SCENE_SYSTEM, RenderLightInput } from './scene-systems';
import { RENDER_RECORD_COMMIT_SYSTEM } from './submission-systems';
import { readViewField, requireViewField } from './view-field';
import {
  ownerOf,
  RENDER_SHADOW_COMMIT_SYSTEM,
  RENDER_SHADOW_DISCARD_SYSTEM,
  registerViewCommit,
  type ViewSettlementOwner,
} from './view-settlement';

/** System names other Render World systems order against. */
export const RENDER_LIGHTS_SYSTEM = 'render-lights';
export const RENDER_SHADOW_VIEWS_SYSTEM = 'render-shadow-views';
export const RENDER_CASCADE_FIT_SYSTEM = 'render-cascade-fit';
export const RENDER_CASCADE_HISTORY_SYSTEM = 'render-cascade-history';

/**
 * A submitted attempt promotes its staged shadow raster ledger, depth layers,
 * cascade cadence and directional cache. The cache takes over the staged mesh
 * lease only when it replaces the accepted one.
 */
function commitShadow({ frameState }: ViewSettlementOwner): void {
  const staged = frameState.shadowCandidate;
  if (staged === undefined) return;
  frameState.shadowRaster.commit();
  frameState.shadowDepthLayers?._commit();
  frameState.directionalCascadeCadence = staged.cadence;
  const cache = staged.cache;
  if (cache === undefined) return;
  const previous = frameState.directionalShadowCache;
  const next =
    cache.miss !== undefined
      ? frameState.directionalShadowCacheRecorded
        ? cache.next
        : null
      : (cache.next ?? previous);
  if (next === previous) return;
  frameState.directionalShadowCache = next;
  if (next !== null) frameState.shadowCandidate = { ...staged, lease: undefined };
  previous?.meshReads.release();
}

/** Whatever candidate remains is released: the lease, and depth rasters whose submit failed. */
function discardShadow({ frameState }: ViewSettlementOwner): void {
  frameState.shadowCandidate?.lease?.reads.release();
  frameState.shadowCandidate = undefined;
  frameState.shadowDepthLayers?._abort();
}

/** Fallback normal bias of a cascade fit without an authored one. */

/**
 * Register the light systems of a Render World:
 * - `render-lights` (RenderExtract, after `render-scene`) adopts the frame's
 *   {@link RenderLightInput} roster into one `RenderLight` entity per light;
 * - `render-shadow-views` (RenderPrepare) refits the point face and spot
 *   `ShadowView` entities of the lights whose rows changed;
 * - `render-cascade-fit` (RenderPrepare, after `render-shadow-views`) fits
 *   each enabled view entity's directional cascades from its resolved
 *   {@link ViewCamera} and submitted {@link ViewCascadeHistory} into its
 *   {@link ViewCascadeFit}, the lights its recording reads. The shared
 *   capture view fits against fresh cascades (it retains no history). Probe
 *   faces fit in `render-capture-fit` (reflection-systems); a capture's cube,
 *   auxiliary and scene-input faces still fit at record time, because the
 *   capture scheduler and Feature batch produce them after RenderPrepare;
 * - `render-cascade-history` (RenderCommit) advances a view's history to the
 *   cascades its accepted scene submission of this frame rasterized.
 */
export function registerLightSystems(world: World): void {
  const owner = renderLightsOf(world);
  world
    .addSystem(RenderExtract, {
      commands: 'none',
      name: RENDER_LIGHTS_SYSTEM,
      queries: [],
      after: [RENDER_SCENE_SYSTEM],
      fn: (world) => {
        const roster = world.getResource<{ roster: LightRoster | undefined }>(
          RenderLightInput,
        ).roster;
        if (roster !== undefined) owner.adopt(roster);
      },
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_SHADOW_VIEWS_SYSTEM,
      queries: [
        { read: [RenderLight], changed: [RenderLight] },
        { read: [RenderPointShadow], changed: [RenderPointShadow] },
      ],
      // RenderPrepare follows RenderExtract, so `render-lights` adopted this frame's roster.
      fn: (_world, [lights, shadows]) => owner.fitShadowViews(lights, shadows),
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_CASCADE_FIT_SYSTEM,
      queries: [
        {
          read: [RenderView, ViewCamera],
          optional: [ViewCascadeFit, ViewCascadeHistory],
        },
      ],
      // Each fit's lights carry the point face and spot views refitted first.
      after: [RENDER_SHADOW_VIEWS_SYSTEM],
      fn: (world, [views]) => {
        const roster = owner.roster;
        const normalBias =
          roster.normalBias ?? (DirectionalLight.fields.normalBias.default as number);
        // Fitting and retiring spawn or despawn cascade view entities, which
        // invalidates the view query: the iteration only reads, the
        // structural work follows it.
        const retired: ViewRecord[] = [];
        const fits: { record: ViewRecord; fit: CascadeFit }[] = [];
        const unfitted: EntityHandle[] = [];

        views.forEach((row) => {
          const entity = row.entity;

          const fit = readViewField(world, entity, ViewCascadeFit, 'fit');
          const record =
            fit === undefined ? undefined : world.resolveUniqueRef<ViewRecord>(fit).unwrap();
          const history = readViewField(world, entity, ViewCascadeHistory, 'history');
          if (!requireViewField(world, entity, RenderView, 'enabled')) {
            if (record !== undefined) retired.push(record);
            if (history !== undefined)
              world.resolveUniqueRef<CascadeHistory>(history).unwrap().lightViewProj = undefined;
            return;
          }
          // The shared capture view records only captures, against fresh cascades.
          const fresh =
            requireViewField(world, entity, RenderView, 'primary') &&
            requireViewField(world, entity, RenderView, 'capture');
          if (fresh && history !== undefined)
            world.resolveUniqueRef<CascadeHistory>(history).unwrap().lightViewProj = undefined;
          if (record === undefined || history === undefined) {
            unfitted.push(entity);
            return;
          }
          const camera = world
            .resolveUniqueRef<ViewCameraState>(requireViewField(world, entity, ViewCamera, 'state'))
            .unwrap().camera;
          fits.push({
            record,
            fit: {
              camera,
              retained: fresh
                ? undefined
                : world.resolveUniqueRef<CascadeHistory>(history).unwrap().lightViewProj,
              normalBias,
            },
          });
        });
        for (const record of retired) owner.retireFit(record);
        for (const { record, fit } of fits) owner.fitView(record, roster, fit);
        // A view's first fit attaches its components after the iteration.
        for (const entity of unfitted) {
          const record = createViewRecord(entity);
          world
            .addComponent(entity, {
              component: ViewCascadeFit,
              data: { fit: world.allocUniqueRef('ViewCascadeFit', record) },
            })
            .unwrap();
          const history: CascadeHistory = { lightViewProj: undefined };
          world
            .addComponent(entity, {
              component: ViewCascadeHistory,
              data: { history: world.allocUniqueRef('CascadeHistory', history) },
            })
            .unwrap();
          const state = world
            .resolveUniqueRef<ViewCameraState>(requireViewField(world, entity, ViewCamera, 'state'))
            .unwrap();
          owner.fitView(record, roster, { camera: state.camera, normalBias });
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_CASCADE_HISTORY_SYSTEM,
      queries: [
        {
          read: [RenderView, ViewSubmission, ViewCascadeFit, ViewCascadeHistory],
          optional: [ViewRecorder],
        },
      ],
      // Only an accepted scene submission of this frame rasterized the fitted
      // cascades; a rejected, held or stale view keeps its history.
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;

        views.forEach((row) => {
          const entity = row.entity;

          if (
            requireViewField(world, entity, RenderView, 'primary') &&
            requireViewField(world, entity, RenderView, 'capture')
          )
            return;

          if (
            !requireViewField(world, entity, ViewSubmission, 'accepted') ||
            requireViewField(world, entity, ViewSubmission, 'attempt') !== frame ||
            !requireViewField(world, entity, ViewSubmission, 'scene')
          )
            return;
          const recorder = readViewField(world, entity, ViewRecorder, 'state');
          if (
            !requireViewField(world, entity, RenderView, 'primary') &&
            recorder !== undefined &&
            !world.resolveUniqueRef<ViewHistory>(recorder).unwrap().rendered
          )
            return;
          const record = world
            .resolveUniqueRef<ViewRecord>(requireViewField(world, entity, ViewCascadeFit, 'fit'))
            .unwrap();
          world
            .resolveUniqueRef<CascadeHistory>(
              requireViewField(world, entity, ViewCascadeHistory, 'history'),
            )
            .unwrap().lightViewProj = record.cascades?.lightViewProj;
        });
      },
    })
    .unwrap();
}

/**
 * Register the shadow commit and discard systems on every Render World: any
 * recording view stages a shadow candidate, not only the scene owner's.
 */
export function registerShadowSettlement(world: World): void {
  registerViewCommit(
    world,
    RENDER_SHADOW_COMMIT_SYSTEM,
    commitShadow,
    RENDER_RECORD_COMMIT_SYSTEM,
    'scene',
  );
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_SHADOW_DISCARD_SYSTEM,
      queries: [{ read: [ViewRecorder] }],
      fn: (world, [views]) => {
        views.forEach((row) => {
          const entity = row.entity;
          discardShadow(ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')));
        });
      },
    })
    .unwrap();
}
