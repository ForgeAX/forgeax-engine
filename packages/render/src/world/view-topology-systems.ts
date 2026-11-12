import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RenderResourceScope } from '../publication/resource-scope';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import {
  planViewTopology,
  type ViewTopology,
  type ViewTopologyFailureCode,
  type ViewTopologyOutcome,
} from '../record/view-topology';
import { viewLightsOf } from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderPrepare, renderSubmission, renderWorldFor } from './render-world';
import {
  RENDER_STANDARD_LIGHTING_SYSTEM,
  viewStandardLightingOf,
} from './standard-lighting-systems';
import { readViewField, requireViewField } from './view-field';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
} from './view-frame-systems';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export type { ViewTopology, ViewTopologyFailureCode, ViewTopologyOutcome };

/*
 * Per-view graph-topology inputs. `render-view-topology` (RenderPrepare) is
 * the only owner of a Render World view's shadow map size, terrain receivers,
 * cloud shadow projection, analytic fog activity and volumetric fog
 * projection. It stores a frame-stamped outcome; a failed step is data with a
 * closed code, never a thrown system error. Recording and graph compile read
 * the stored topology.
 */

export const RENDER_VIEW_TOPOLOGY_SYSTEM = 'render-view-topology';

/** Plan the staged view's topology inputs; never throws. */
function prepareViewTopology(
  world: World,
  entity: EntityHandle,
  view: ViewFrameState,
  owner: ViewSettlementOwner,
): ViewTopologyOutcome {
  let staged: ReturnType<typeof stagedViewInputs>;
  try {
    staged = stagedViewInputs(world, view);
  } catch (cause) {
    return { kind: 'failed', code: 'view-not-staged', cause };
  }
  const { frame, mode, cameras, scopes, composition } = staged;
  const lights = viewLightsOf(world, entity);
  if (lights === undefined)
    return {
      kind: 'failed',
      code: 'view-not-staged',
      cause: new Error('A view plans topology after render-cascade-fit'),
    };
  const { internals } = owner;
  // Display media (volumes, cloud layers) never enter a capture view's raw scene.
  const displayMedia = mode !== 'capture' && recordContext(internals).captureView === undefined;
  return planViewTopology({
    internals,
    frameState: owner.frameState,
    world: scopes[composition.owners.resourceOwner] as RenderResourceScope,
    worlds: scopes,
    // No Camera records the internal fallback snapshot, as recording does.
    camera: cameras[0] ?? makeZeroCameraFallbackSnapshot(),
    lights,
    sourceRenderables:
      owner.scene.shadowCasterProjection()?.renderables ??
      (cameras.length === 0 ? [] : frame.renderables),
    volumetricFog: displayMedia ? frame.volumetricFog : undefined,
    cloudLayer: displayMedia ? frame.cloudLayer : undefined,
    analyticFog: frame.environment?.fog,
  });
}

interface ViewTopologyState {
  frame: number;
  outcome: ViewTopologyOutcome;
}

/** A recording view's RenderPrepare topology; written only by `render-view-topology`. */
export const ViewTopologyInputs = defineComponent('ViewTopologyInputs', {
  state: 'unique<ViewTopologyInputs>',
});

/** The view's topology planned this renderer frame; undefined when the system did not run for it. */
export function viewTopologyOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewTopologyOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewTopologyInputs)) return undefined;
  const state = world
    .resolveUniqueRef<ViewTopologyState>(
      requireViewField(world, entity, ViewTopologyInputs, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/**
 * The topology this recording compiles and draws with. A Render World view
 * takes what `render-view-topology` planned and rethrows a stored failure
 * inside its own record recovery; a direct recorder outside a Render World
 * view plans through the same `planViewTopology` owner.
 */
export function consumeViewTopology(
  internals: RenderSystemInternals,
  direct: () => ViewTopologyOutcome,
): ViewTopology {
  const outcome =
    internals.viewEntity === undefined
      ? direct()
      : viewTopologyOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome === undefined)
    throw new Error(`${RENDER_VIEW_TOPOLOGY_SYSTEM} did not plan the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  return outcome.topology;
}

/**
 * Register `render-view-topology` (RenderPrepare): each staged view whose
 * frame resolved and whose Standard lighting was admitted plans its topology
 * inputs. A failure is stored with its closed code; the view's recording
 * rethrows it.
 */
export function registerViewTopologySystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_VIEW_TOPOLOGY_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM, RENDER_STANDARD_LIGHTING_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame], optional: [ViewTopologyInputs] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewTopologyState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame || staged.result?.ok !== true) return;
          if (viewStandardLightingOf(world, entity)?.kind !== 'prepared') return;
          const outcome = prepareViewTopology(
            world,
            entity,
            staged,
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
          );
          const stored = readViewField(world, entity, ViewTopologyInputs, 'state');
          if (stored === undefined) {
            first.push({ entity: entity, state: { frame, outcome } });
            return;
          }
          const state = world.resolveUniqueRef<ViewTopologyState>(stored).unwrap();
          state.frame = frame;
          state.outcome = outcome;
        });
        // A view's first topology attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewTopologyInputs,
              data: { state: world.allocUniqueRef('ViewTopologyInputs', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
