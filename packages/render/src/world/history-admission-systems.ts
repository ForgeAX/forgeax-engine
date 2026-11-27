import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { isTemporalAntialias } from '../components/camera';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot, VolumetricFogFrameContext } from '../render-contract';
import type { ExtractedVolumetricFog } from '../render-system-extract';
import { RenderHistoryAdmissionOrder, RenderSsrAdmissionOrder } from '../system-order';
import { volumetricFogSamplingLane } from '../volume/component';
import { resolveVolumeTemporalReset, type VolumeTemporalSignature } from '../volume/temporal';
import { type PassPlanInput, type ViewPassPlanQueue, ViewPassPlans } from './pass-plan-systems';
import { type ViewLights, viewLightsOf } from './render-lights';
import { ViewRecorder } from './render-views';
import { RenderQueue, renderSubmission, renderWorldFor } from './render-world';
import { viewSsrAdmissionOf } from './ssr-admission-systems';
import { readViewField, readViewState, requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { ownerOf } from './view-settlement';
import { viewTopologyOf } from './view-topology-systems';

/*
 * Cross-frame history admission of a view. `render-history-admission`
 * (RenderQueue) decides from committed history and this frame's prepared
 * inputs whether the volumetric fog and SSR histories continue. Recording
 * consumes the decision; it keeps only what needs the compiled graph or the
 * GPU (accepted-graph identity, write slot, uploads, SSR owner allocation).
 * History itself advances only in RenderCommit for an accepted submission.
 */

/** RenderQueue: the view's volumetric fog history admission. */
export const RENDER_HISTORY_ADMISSION_SYSTEM = 'render-history-admission';

/** Whether a view's volume history continues, decided before its graph compiles. */
export interface VolumeHistoryAdmission {
  readonly signature: VolumeTemporalSignature;
  /** The accepted slot this frame reads if it reuses the accepted graph; null resets. */
  readonly readSlot: 0 | 1 | null;
  /** World seconds since the accepted history; 0 unless both times exist. */
  readonly elapsedSeconds: number;
}

/** Closed reasons a view has no history admission. */
export type HistoryAdmissionFailureCode =
  | 'topology-unavailable'
  | 'ssr-admission-unavailable'
  | 'fog-signature-failed';

/**
 * One view's `render-history-admission` outcome. `admitted`: the fog history
 * decision (undefined without an available graph volume). `unavailable`: an
 * input system planned nothing for the view.
 * `failed`: the fog signature could not be computed; recording rethrows `cause`.
 */
export type ViewHistoryAdmissionOutcome =
  | {
      readonly kind: 'admitted';
      readonly fog: VolumeHistoryAdmission | undefined;
    }
  | {
      readonly kind: 'unavailable';
      readonly code: 'topology-unavailable' | 'ssr-admission-unavailable';
    }
  | { readonly kind: 'failed'; readonly code: 'fog-signature-failed'; readonly cause: unknown };

interface ViewHistoryAdmissionState {
  frame: number;
  outcome: ViewHistoryAdmissionOutcome;
}

/** A recording view's history admission; written only by `render-history-admission`. */
export const ViewHistoryAdmission = defineComponent('ViewHistoryAdmission', {
  state: 'unique<ViewHistoryAdmission>',
});

/** The view's admission written this renderer frame; undefined when the system did not run for it. */
export function viewHistoryAdmissionOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewHistoryAdmissionOutcome | undefined {
  const state = readViewState<ViewHistoryAdmissionState>(world, entity, ViewHistoryAdmission);
  if (state === undefined) return undefined;
  return state.frame === renderSubmission(world).frame ? state.outcome : undefined;
}

/** The admission this recording reads; a stored failure rethrows inside its record recovery. */
export function consumeViewHistoryAdmission(
  internals: RenderSystemInternals,
): Extract<ViewHistoryAdmissionOutcome, { kind: 'admitted' }> {
  // A direct recorder (no view entity) has no history to admit: no fog volume, no SSR reset.
  if (internals.viewEntity === undefined) return { kind: 'admitted', fog: undefined };
  const outcome = viewHistoryAdmissionOf(renderWorldFor(internals), internals.viewEntity);
  if (outcome === undefined)
    throw new Error(`${RENDER_HISTORY_ADMISSION_SYSTEM} did not admit the recorded view`);
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind === 'unavailable')
    throw new Error(`${RENDER_HISTORY_ADMISSION_SYSTEM}: ${outcome.code}`);
  return outcome;
}

function volumeRevision(values: readonly number[]): number {
  let hash = 2166136261;
  for (const value of values) {
    const quantized = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0;
    hash = Math.imul(hash ^ quantized, 16777619) >>> 0;
  }
  return hash;
}

function cameraRevisionOf(camera: CameraSnapshot): number {
  return volumeRevision([
    ...camera.world,
    camera.fov,
    camera.aspect,
    ...(camera.projectionOffset ?? [0, 0]),
    camera.near,
    camera.far,
    camera.orthoLeft,
    camera.orthoRight,
    camera.orthoBottom,
    camera.orthoTop,
  ]);
}

function fogRevisionOf(fog: ExtractedVolumetricFog): number {
  const authored = fog.fog;
  if (authored === undefined) return 0;
  return volumeRevision([
    ...authored.bounds.min,
    ...authored.bounds.max,
    ...authored.extinction,
    ...authored.albedo,
    ...authored.emission,
    authored.anisotropy,
    authored.maxDistance,
    volumetricFogSamplingLane(authored.sampling),
    ...Array.from(`${fog.guid}:${fog.digest}`, (char) => char.charCodeAt(0)),
  ]);
}

function pointRevisionValues(point: ViewLights['point'][number] | undefined): number[] {
  if (point === undefined) return [];
  return [
    ...point.position,
    ...point.color,
    point.intensity,
    point.invRangeSquared,
    point.decay ?? 2,
    point.shadowAtlasLayer ?? -1,
    point.shadowNear ?? 0,
    point.shadowFar ?? 0,
  ];
}

function spotRevisionValues(spot: ViewLights['spot'][number] | undefined): number[] {
  if (spot === undefined) return [];
  return [
    ...spot.position,
    ...spot.direction,
    ...spot.color,
    spot.intensity,
    spot.invRangeSquared,
    spot.decay ?? 2,
    spot.cosInner,
    spot.cosOuter,
    spot.depthBias ?? 0.005,
    spot.normalBias ?? 0.05,
    spot.pcfKernelSize ?? 3,
    spot.shadowAtlasTile,
    Number(spot.projectorHandle ?? 0),
    spot.projectorGeneration ?? 0,
    spot.projectorRevision ?? 0,
    ...(spot.lightViewProj === undefined ? [] : [...spot.lightViewProj]),
  ];
}

function lightRevisionOf(fog: ExtractedVolumetricFog, lights: ViewLights): number {
  const spotEntity =
    fog.spotLightEntity ?? (fog.lightKind === 'spot' ? fog.lightEntity : undefined);
  const pointEntity =
    fog.pointLightEntity ?? (fog.lightKind === 'point' ? fog.lightEntity : undefined);
  const spot =
    spotEntity === undefined ? undefined : lights.spot.find((s) => s.entity === spotEntity);
  const point =
    pointEntity === undefined ? undefined : lights.point.find((p) => p.entity === pointEntity);
  if (spot !== undefined || point !== undefined)
    return volumeRevision([...pointRevisionValues(point), ...spotRevisionValues(spot)]);
  const directional = lights.directional;
  if (
    fog.lightKind !== 'directional' ||
    directional === undefined ||
    directional.entity !== fog.lightEntity
  )
    return 0;
  return volumeRevision([
    ...directional.direction,
    ...directional.color,
    directional.intensity,
    ...(lights.cascades?.lightViewProj?.flatMap((matrix) => [...matrix]) ?? []),
  ]);
}

/** The temporal signature of one available volume and its additional members. */
export function volumeTemporalSignature(
  fog: ExtractedVolumetricFog,
  prepared: VolumetricFogFrameContext,
  camera: CameraSnapshot,
  lights: ViewLights,
  width: number,
  height: number,
): VolumeTemporalSignature {
  let fogRevision = fogRevisionOf(fog);
  let lightRevision = lightRevisionOf(fog, lights);
  for (const [index, member] of (fog.additional ?? []).entries()) {
    const signature = volumeTemporalSignature(
      member,
      { ...prepared, densityGeneration: prepared.additional?.[index]?.densityGeneration ?? 0 },
      camera,
      lights,
      width,
      height,
    );
    fogRevision = volumeRevision([fogRevision, signature.fogRevision, signature.densityGeneration]);
    lightRevision = volumeRevision([lightRevision, signature.lightRevision]);
  }
  return {
    cameraRevision: cameraRevisionOf(camera),
    fogRevision,
    lightRevision,
    densityGeneration: prepared.densityGeneration,
    width,
    height,
    ...(fog.worldTimeSeconds === undefined ? {} : { worldTimeSeconds: fog.worldTimeSeconds }),
    ...(fog.lightKind === undefined ? {} : { lightKind: fog.lightKind }),
    ...(fog.lightEntity === undefined ? {} : { lightEntity: fog.lightEntity }),
    ...(fog.pointLightEntity === undefined ? {} : { pointLightEntity: fog.pointLightEntity }),
    ...(fog.spotLightEntity === undefined ? {} : { spotLightEntity: fog.spotLightEntity }),
    ...(fog.projector === undefined ? {} : { projector: fog.projector }),
    lightShadowRevision: lightRevision,
  };
}

/**
 * Admit one volume's history against the committed signature and slot. The
 * accepted-graph identity is the recording's own guard: it reads `readSlot`
 * only when it reuses `frameState.volumetricFogHistoryGraph`.
 */
export function admitVolumeHistory(
  frameState: RenderFrameState,
  fog: ExtractedVolumetricFog,
  prepared: VolumetricFogFrameContext,
  camera: CameraSnapshot,
  lights: ViewLights,
  width: number,
  height: number,
): VolumeHistoryAdmission {
  const signature = volumeTemporalSignature(fog, prepared, camera, lights, width, height);
  const acceptedSlot = frameState.volumetricFogHistorySlot;
  const previous = frameState.volumetricFogHistorySignature;
  let readSlot: 0 | 1 | null = null;
  if (acceptedSlot !== null && previous !== null) {
    const previousResetReason = frameState.temporalFrameTransaction.accepted()?.resetReason;
    const reprojection =
      previousResetReason === 'out-of-screen' || previousResetReason === 'depth-discontinuity'
        ? previousResetReason
        : undefined;
    const reset = resolveVolumeTemporalReset(previous, signature, {
      taaEnabled: isTemporalAntialias(camera.antialias),
      ...(reprojection === undefined ? {} : { reprojection }),
    }).reset;
    if (!reset) readSlot = acceptedSlot;
  }
  const previousTime = previous?.worldTimeSeconds;
  const currentTime = signature.worldTimeSeconds;
  return {
    signature,
    readSlot,
    elapsedSeconds:
      previousTime === undefined || currentTime === undefined
        ? 0
        : Math.max(0, currentTime - previousTime),
  };
}

/** Admit one staged view's histories; never throws. */
function admitViewHistory(
  world: World,
  entity: EntityHandle,
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  input: PassPlanInput,
): ViewHistoryAdmissionOutcome {
  const topology = viewTopologyOf(world, entity);
  if (topology?.kind !== 'planned') return { kind: 'unavailable', code: 'topology-unavailable' };
  if (viewSsrAdmissionOf(world, entity)?.kind !== 'resolved')
    return { kind: 'unavailable', code: 'ssr-admission-unavailable' };
  const { camera } = input.ssr;
  const { graphFog, baseContext } = topology.topology.volume;
  const lights = viewLightsOf(world, entity);
  let fog: VolumeHistoryAdmission | undefined;
  if (graphFog?.status === 'available' && baseContext !== undefined && lights !== undefined) {
    try {
      fog = admitVolumeHistory(
        frameState,
        graphFog,
        baseContext,
        camera,
        lights,
        (recordContext(internals).viewOutput?.width ?? recordContext(internals).canvas.width) | 0,
        (recordContext(internals).viewOutput?.height ?? recordContext(internals).canvas.height) | 0,
      );
    } catch (cause) {
      return { kind: 'failed', code: 'fog-signature-failed', cause };
    }
  }
  return { kind: 'admitted', fog };
}

/**
 * Register `render-history-admission` (RenderQueue, after
 * `render-ssr-admission`): each staged view admits its volumetric fog history
 * from committed state and stores a frame-stamped outcome. Failures are stored.
 */
export function registerHistoryAdmissionSystem(world: World): void {
  const systemToken1 = defineSystem({
    sets: [RenderHistoryAdmissionOrder],
    commands: 'none',
    name: RENDER_HISTORY_ADMISSION_SYSTEM,
    after: [RenderSsrAdmissionOrder],
    queries: [{ read: [ViewRecorder, ViewPassPlans], optional: [ViewHistoryAdmission] }],
    fn: (world, [views]) => {
      const frame = renderSubmission(world).frame;
      const first: { entity: EntityHandle; state: ViewHistoryAdmissionState }[] = [];

      views.forEach((row) => {
        const entity = row.entity;

        const input = world
          .resolveUniqueRef<ViewPassPlanQueue>(
            requireViewField(world, entity, ViewPassPlans, 'state'),
          )
          .unwrap().staged;
        if (input === undefined) return;
        const stored = readViewField(world, entity, ViewHistoryAdmission, 'state');
        const previous =
          stored === undefined
            ? undefined
            : world.resolveUniqueRef<ViewHistoryAdmissionState>(stored).unwrap();
        if (previous?.frame === frame) return;
        const { frameState, internals } = ownerOf(
          world,
          requireViewField(world, entity, ViewRecorder, 'state'),
        );
        const outcome = admitViewHistory(world, entity, frameState, internals, input);
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
            component: ViewHistoryAdmission,
            data: { state: world.allocUniqueRef('ViewHistoryAdmission', state) },
          })
          .unwrap();
    },
  });
  world.addSystem(RenderQueue, systemToken1).unwrap();
}
