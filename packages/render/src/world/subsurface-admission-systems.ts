import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { CubeCaptureFrameInput } from '../record/frame';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import { subsurfaceTopology } from '../subsurface/demand';
import type { SubsurfaceDemand, SubsurfaceSelection } from '../subsurface/selection';
import { type ViewPassPlanQueue, ViewPassPlans } from './pass-plan-systems';
import { RenderQueue, renderSubmission, renderWorldFor } from './render-world';
import { readViewField, requireViewField } from './view-field';

/** RenderQueue: the view's subsurface diffusion topology per capture class. */
export const RENDER_SUBSURFACE_ADMISSION_SYSTEM = 'render-subsurface-admission';

/** What a view's subsurface admission reads; staged with its pass-plan input before the queue barrier. */
export interface SubsurfaceAdmissionInput {
  /** The view's visible renderables; a frame without any admits no diffusion unless captured. */
  readonly renderableCount: number;
  /** The scene projection's demands; undefined for hand-authored recorder inputs. */
  readonly projection: PersistentShadowCasterProjection['content']['subsurface'] | undefined;
  /** The demand of hand-authored recorder inputs, which have no Scene projection. */
  readonly manualDemand: SubsurfaceDemand | undefined;
  readonly profile: StandardProfile | undefined;
  readonly msaa: boolean;
  /** Whether this recording is a target-capture view rather than a display view. */
  readonly captureOnly: boolean;
  readonly device: RhiDevice;
}

/**
 * The captures a recording drew with. They settle after the queue barrier
 * (shared capture scheduling), so the system admits every class and the
 * recording picks the one it recorded.
 */
export type SubsurfaceCaptureClass = 'none' | 'consumers' | 'unsupported';

export type SubsurfaceTopology = ReturnType<typeof subsurfaceTopology>;

/** One class's admission; a non-`RhiError` cause is the recording's to rethrow. */
export type SubsurfaceCandidate = Result<SubsurfaceTopology, unknown>;

export type ViewSubsurfaceAdmissionOutcome = Readonly<
  Record<SubsurfaceCaptureClass, SubsurfaceCandidate>
>;

interface ViewSubsurfaceAdmissionState {
  frame: number;
  outcome: ViewSubsurfaceAdmissionOutcome;
}

/** A recording view's subsurface admission; written only by `render-subsurface-admission`. */
export const ViewSubsurfaceAdmission = defineComponent('ViewSubsurfaceAdmission', {
  state: 'unique<ViewSubsurfaceAdmission>',
});

/** The view's admission written this renderer frame; undefined when the system did not run for it. */
export function viewSubsurfaceAdmissionOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewSubsurfaceAdmissionOutcome | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewSubsurfaceAdmission))
    return undefined;
  const state = world
    .resolveUniqueRef<ViewSubsurfaceAdmissionState>(
      requireViewField(world, entity, ViewSubsurfaceAdmission, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** The subsurface admission input of a recording; staged for the view or read by a direct recorder. */
export function subsurfaceAdmissionInput(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: Pick<CameraSnapshot, 'antialias'>,
  renderableCount: number,
  projection: PersistentShadowCasterProjection | undefined,
  manual: SubsurfaceSelection | undefined,
  captureOnly: boolean,
): SubsurfaceAdmissionInput {
  return {
    renderableCount,
    projection: projection?.content.subsurface,
    manualDemand: manual?.demand,
    profile: frameState.cameraStandardProfile ?? internals.standardProfile,
    msaa: camera.antialias === 'msaa',
    captureOnly,
    device: internals.device,
  };
}

function demandFor(
  input: SubsurfaceAdmissionInput,
  capture: SubsurfaceCaptureClass,
): SubsurfaceDemand {
  const unsupported = capture === 'unsupported';
  if (!unsupported && input.renderableCount === 0) return 0;
  const projection = input.projection;
  if (projection === undefined) return input.manualDemand ?? 0;
  if (unsupported) return projection.source;
  // Capture admission includes off-screen surfaces from the validation superset.
  return capture === 'consumers' ? projection.authorVisible : projection.admitted;
}

function admitCapture(
  input: SubsurfaceAdmissionInput,
  capture: SubsurfaceCaptureClass,
): SubsurfaceCandidate {
  try {
    return ok(
      subsurfaceTopology(
        demandFor(input, capture),
        input.profile,
        input.device,
        capture === 'unsupported' || input.msaa,
      ),
    );
  } catch (cause) {
    return err(cause);
  }
}

/** Admit one view's diffusion lane for every capture class; never throws. */
export function admitViewSubsurface(
  input: SubsurfaceAdmissionInput,
): ViewSubsurfaceAdmissionOutcome {
  return {
    none: admitCapture(input, 'none'),
    consumers: admitCapture(input, 'consumers'),
    unsupported: admitCapture(input, 'unsupported'),
  };
}

/** The capture class a recording drew with, from its settled cube-capture input. */
export function subsurfaceCaptureClass(
  cubeCapture: CubeCaptureFrameInput | undefined,
  captureOnly: boolean,
): SubsurfaceCaptureClass {
  if (
    captureOnly ||
    (cubeCapture?.state.work.length ?? 0) > 0 ||
    cubeCapture?.reflectionProbes?.graph.work.some((work) => work.rawCaptureFace !== undefined) ===
      true ||
    cubeCapture?.state.planar?.current() !== undefined
  )
    return 'unsupported';
  return cubeCapture?.subsurfaceDemand === undefined ? 'none' : 'consumers';
}

/**
 * The diffusion topology this recording draws with. A rejected admission is
 * the recording's to report: an `RhiError` is returned, any other cause
 * rethrows inside its record recovery. A direct recorder outside a Render
 * World view admits its own input with the same function.
 */
export function consumeViewSubsurface(
  internals: RenderSystemInternals,
  cubeCapture: CubeCaptureFrameInput | undefined,
  captureOnly: boolean,
  direct: () => SubsurfaceAdmissionInput,
): Result<SubsurfaceTopology, RhiError> {
  const capture = subsurfaceCaptureClass(cubeCapture, captureOnly);
  let candidate: SubsurfaceCandidate;
  if (internals.viewEntity === undefined) candidate = admitCapture(direct(), capture);
  else {
    const outcome = viewSubsurfaceAdmissionOf(renderWorldFor(internals), internals.viewEntity);
    if (outcome === undefined)
      throw new Error(`${RENDER_SUBSURFACE_ADMISSION_SYSTEM} did not admit the recorded view`);
    candidate = outcome[capture];
  }
  if (candidate.ok) return candidate;
  if (candidate.error instanceof RhiError) return err(candidate.error);
  throw candidate.error;
}

/**
 * Register `render-subsurface-admission` (RenderQueue): each staged view
 * admits its diffusion lane per capture class and stores a frame-stamped
 * outcome. A rejection is stored as data, never thrown.
 */
export function registerSubsurfaceAdmissionSystem(world: World): void {
  world
    .addSystem(RenderQueue, {
      commands: 'none',
      name: RENDER_SUBSURFACE_ADMISSION_SYSTEM,
      queries: [{ read: [ViewPassPlans], optional: [ViewSubsurfaceAdmission] }],
      fn: (world, [views]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewSubsurfaceAdmissionState }[] = [];

        views.forEach((row) => {
          const entity = row.entity;

          const input = world
            .resolveUniqueRef<ViewPassPlanQueue>(
              requireViewField(world, entity, ViewPassPlans, 'state'),
            )
            .unwrap().staged;
          if (input === undefined) return;
          const stored = readViewField(world, entity, ViewSubsurfaceAdmission, 'state');
          const previous =
            stored === undefined
              ? undefined
              : world.resolveUniqueRef<ViewSubsurfaceAdmissionState>(stored).unwrap();
          if (previous?.frame === frame) return;
          const outcome = admitViewSubsurface(input.subsurface);
          if (previous === undefined) {
            first.push({ entity: entity, state: { frame, outcome } });
            return;
          }
          previous.frame = frame;
          previous.outcome = outcome;
        });
        // A view's first admission attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewSubsurfaceAdmission,
              data: { state: world.allocUniqueRef('ViewSubsurfaceAdmission', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
}
