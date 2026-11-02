import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  graphFacts,
  type LodObservationCapture,
  type LodObservationViewCapture,
} from '../assembly/lod-observation';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import { selectCameraRoles } from '../render-system-extract';
import {
  cameraAttachmentId,
  RenderView,
  type RenderViewFrameSource,
  RenderViewInput,
  type RenderViews,
  ViewRecorder,
  ViewSubmission,
  viewAccepted,
} from './render-views';
import { RenderCommit, renderSubmission } from './render-world';
import { type ViewRecorderState, viewComposition } from './view-output-systems';
import { recordContext } from './view-record-context';
import type { ViewSettlementOwner } from './view-settlement';

/** RenderCommit: publish the accepted frame's LOD observation roster. */
export const RENDER_LOD_OBSERVATION_SYSTEM = 'render-lod-observation';

/** Why the frame's observation roster could not be built; data, never a throw. */
export type LodObservationFailureCode = 'camera-roster-unavailable' | 'view-state-unavailable';

/**
 * The Renderer's latest LOD observation. `capture` is the roster of the last
 * frame whose submission and views were accepted; a rejected frame leaves it
 * untouched, so a receipt of that frame reads as not captured. `failure`
 * records the last frame whose roster could not be built.
 */
export interface LodObservationState {
  capture: LodObservationCapture | undefined;
  failure: { readonly code: LodObservationFailureCode; readonly frame: number } | undefined;
}

/** World resource key of the Renderer's {@link LodObservationState}. */
export const LodObservationKey = Object.freeze({ name: 'LodObservation' });

export function lodObservationOf(world: World): LodObservationState {
  return world.getResource<LodObservationState>(LodObservationKey);
}

function captureLeases(
  leases: readonly RenderReadLease[] | undefined,
): LodObservationCapture['leases'] {
  return Object.freeze(
    (leases ?? []).map((lease) =>
      Object.freeze({ lease, worldIdentity: lease.worldIdentity, generation: lease.generation }),
    ),
  );
}

function viewObservation(
  view: ViewRecorderState,
  facts: { readonly attachment: string; readonly viewGeneration: number },
): LodObservationViewCapture {
  const rendered = view.rendered;
  const inspection = rendered ? view.owner.lod.cell : undefined;
  const graph = graphFacts(view.owner);
  return Object.freeze({
    viewKey: view.key,
    entityKey: view.camera,
    eye: view.eye,
    attachmentId: inspection?.view.attachmentId ?? (facts.attachment || 'none'),
    viewGeneration: facts.viewGeneration,
    graphGeneration: graph.generation,
    graphIncarnation: graph.incarnation,
    state: rendered ? ('rendered' as const) : ('held' as const),
    owner: view.owner,
    viewRef: view,
    primary: false,
    inspection,
  });
}

/** The primary system's single rendered view, matched to its inspected camera. */
function primaryObservationViews(
  owner: ViewSettlementOwner,
  cameras: readonly CameraSnapshot[],
  world: World | undefined,
  worlds: readonly World[],
): readonly LodObservationViewCapture[] {
  const primaryInspection = owner.lod.cell;
  const graph = graphFacts(owner);
  const camera =
    cameras.find((candidate) => candidate.entityKey === primaryInspection?.view.cameraEntity) ??
    cameras[0];
  const entityKey = camera?.entityKey ?? primaryInspection?.view.cameraEntity;
  if (entityKey === undefined) return [];
  const attachmentId =
    primaryInspection?.view.attachmentId ??
    (camera === undefined ? world?.identity : cameraAttachmentId(camera, world, worlds)) ??
    'none';
  return [
    Object.freeze({
      viewKey: 'primary',
      entityKey,
      eye: undefined,
      attachmentId,
      viewGeneration: camera?.historyVersion ?? primaryInspection?.view.viewGeneration ?? 0,
      graphGeneration: graph.generation,
      graphIncarnation: graph.incarnation,
      state: 'rendered',
      owner,
      viewRef: undefined,
      primary: true,
      inspection: primaryInspection,
    }),
  ];
}

/** What the observation system reads besides the Render World. */
export interface LodObservationHost {
  readonly internals: Pick<
    RenderSystemInternals,
    'observationFrameId' | 'deviceScope' | 'viewOwner'
  >;
}

function observedViews(
  world: World,
  views: RenderViews,
  host: LodObservationHost,
  source: RenderViewFrameSource,
): readonly LodObservationViewCapture[] | LodObservationFailureCode {
  const composition = viewComposition(world);
  if (composition.active) {
    const observed: LodObservationViewCapture[] = [];
    for (const view of composition.recorded) {
      // A held view records no picture, so only the frame's acceptance gates it.
      if (view.capture !== undefined || (view.rendered && !viewAccepted(world, view.entity)))
        continue;
      observed.push(viewObservation(view, world.get(view.entity, RenderView).unwrap()));
    }
    return observed;
  }
  // The primary system owns the display when no composed view is declared.
  if (!viewAccepted(world, views.primary)) return [];
  let cameras: readonly CameraSnapshot[] = [];
  if (source.publication !== undefined) cameras = source.publication.frame.cameras;
  else if (source.world !== undefined) {
    try {
      cameras = selectCameraRoles(source.world, source.opts.cameraEntityKey).display;
    } catch {
      return 'camera-roster-unavailable';
    }
  }
  const owner = host.internals.viewOwner;
  if (owner === undefined) return 'view-state-unavailable';
  return primaryObservationViews(owner, cameras, source.world, source.worlds);
}

/**
 * Register `render-lod-observation` (RenderCommit): once the frame's
 * `RenderSubmission` is accepted, record the roster of views whose own attempt
 * was accepted (`viewAccepted`; a held view has none) as the Renderer's latest LOD observation. It
 * replaces the imperative post-submit roster capture; a frame the queue took
 * but the submission did not accept observes nothing. The system never throws.
 */
export function registerLodObservationSystem(
  world: World,
  views: RenderViews,
  host: LodObservationHost,
): void {
  const state: LodObservationState = { capture: undefined, failure: undefined };
  world.insertResource<LodObservationState>(LodObservationKey, state);
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_LOD_OBSERVATION_SYSTEM,
      queries: [{ read: [RenderView, ViewRecorder, ViewSubmission] }],
      fn: (world) => {
        const { accepted, frame } = renderSubmission(world);
        if (!accepted || !world.hasResource(RenderViewInput)) return;
        const source = world.getResource<RenderViewFrameSource>(RenderViewInput);
        let observed: ReturnType<typeof observedViews>;
        try {
          observed = observedViews(world, views, host, source);
        } catch {
          observed = 'view-state-unavailable';
        }
        if (typeof observed === 'string') {
          state.failure = { code: observed, frame };
          return;
        }
        state.failure = undefined;
        state.capture = Object.freeze({
          frameId: host.internals.observationFrameId ?? 0,
          deviceGeneration: recordContext(host.internals).deviceScope.generation,
          views: Object.freeze([...observed]),
          leases: captureLeases(source.leases),
        });
      },
    })
    .unwrap();
}
