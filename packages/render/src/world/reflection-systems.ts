import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { CaptureFace, CaptureFitKey } from '../capture/faces';
import type { SelectedEnvironmentFrame } from '../environment/frame';
import type { SsrDependenciesInspection } from '../inspection-types';
import type { ReflectionProbeRecordState } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import { projectSsrDependencies, resolveSsrAdmissionGeneration } from '../ssr/admission';
import type { RenderTarget } from '../targets/contracts';
import { resetTemporalHistory } from '../temporal/frame';
import { RENDER_CAPTURE_SCHEDULE_SYSTEM, viewCaptureWorkOf } from './capture-systems';
import { RENDER_CASCADE_FIT_SYSTEM } from './light-systems';
import {
  pinAtmosphereSun,
  renderLightsOf,
  ViewCascadeFit,
  type ViewLights,
  viewLightsOf,
} from './render-lights';
import { RenderReflectionProbe, renderProbesOf } from './render-probes';
import { ViewRecorder } from './render-views';
import { RenderCleanup, RenderExtract, RenderPrepare, renderSubmission } from './render-world';
import { RENDER_SCENE_SYSTEM, RenderProbeInput, type RenderProbeSource } from './scene-systems';
import { readViewField, requireViewField } from './view-field';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  type StagedViewInputs,
  stagedViewInputs,
  ViewFrame,
  type ViewFrameState,
} from './view-frame-systems';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const RENDER_REFLECTION_PROBES_SYSTEM = 'render-reflection-probes';
export const RENDER_REFLECTION_PROBE_ROSTER_SYSTEM = 'render-reflection-probe-roster';
export const VIEW_REFLECTION_PROBES_SYSTEM = 'view-reflection-probes';
export const RENDER_CAPTURE_FIT_SYSTEM = 'render-capture-fit';
export const VIEW_REFLECTION_PROBES_SETTLE_SYSTEM = 'view-reflection-probes-settle';

/**
 * Why `view-reflection-probes` could not prepare a view: its frame inputs were
 * unreadable, `render-cascade-fit` fitted it no lights, the probe owner
 * failed to prepare its table and capture work, or its SSR dependencies could
 * not be resolved against the prepared fallback.
 */
export type ViewReflectionProbesFailureCode =
  | 'view-inputs-unavailable'
  | 'lights-unavailable'
  | 'probe-prepare-failed'
  | 'ssr-dependencies-failed';

/** A view's prepared reflection probes and SSR dependencies. */
export interface ViewReflectionProbesValue {
  readonly probes: ReflectionProbeRecordState;
  /** The SSR dependencies this view admitted after its probe fallback was prepared. */
  readonly ssr: SsrDependenciesInspection;
}

/** A view's prepared probes, or the closed code and structured cause its recording rethrows. */
export type ViewReflectionProbesOutcome =
  | { readonly ok: true; readonly value: ViewReflectionProbesValue }
  | {
      readonly ok: false;
      readonly code: ViewReflectionProbesFailureCode;
      readonly cause: unknown;
    };

interface ViewReflectionProbesState {
  frame: number;
  outcome: ViewReflectionProbesOutcome;
  /** The recording took the probe state; its submission settles the capture tickets. */
  consumed: boolean;
}

/** A recording view's RenderPrepare probe state; written only by `view-reflection-probes`. */
export const ViewReflectionProbes = defineComponent('ViewReflectionProbes', {
  state: 'unique<ViewReflectionProbes>',
});

/** One retained hand-driven fit: its cascade views follow the view entity. */
interface CaptureFit {
  readonly key: object;
  /** The probe index or face target the fit lives and dies with. */
  readonly owner: number | RenderTarget;
}

/** The Sun a capture generation pinned: undefined while its lights stay live. */
interface CapturePin {
  generation: number | undefined;
  frozen: ViewLights | undefined;
}

interface ViewCaptureFitsState {
  frame: number;
  /** This frame's face work (probe or `CaptureFace`) and the lights fitted for it. */
  fits: Map<object, ViewLights>;
  /** One retained fit per `CaptureFitKey`, so a steady face keeps its matrices. */
  keys: Map<string, CaptureFit>;
  /** One generation pin per probe index and per cube target. */
  pins: Map<number | RenderTarget, CapturePin>;
}

/** A recording view's capture-face lights; written only by `render-capture-fit`. */
export const ViewCaptureFits = defineComponent('ViewCaptureFits', {
  state: 'unique<ViewCaptureFits>',
});

/** The lights `render-capture-fit` fitted this frame for a view's face work, if any. */
export function viewCaptureFitsOf(
  world: World,
  entity: EntityHandle | undefined,
): ReadonlyMap<object, ViewLights> | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewCaptureFits)) return undefined;
  const state = world
    .resolveUniqueRef<ViewCaptureFitsState>(
      requireViewField(world, entity, ViewCaptureFits, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state.fits : undefined;
}

interface PendingCaptureFit {
  readonly entity: EntityHandle;
  readonly lights: ViewLights;
  /** Absent when the view's probes failed to prepare: only its non-probe faces fit. */
  readonly probes: ReflectionProbeRecordState | undefined;
  readonly faces: readonly CaptureFace[];
  readonly environment: SelectedEnvironmentFrame | undefined;
}

const targetIds = new WeakMap<object, number>();
let nextTargetId = 0;
function targetId(target: RenderTarget): number {
  let id = targetIds.get(target);
  if (id === undefined) {
    id = ++nextTargetId;
    targetIds.set(target, id);
  }
  return id;
}

/** The retained-fit identity of a key. */
function fitKeyId(key: CaptureFitKey): string {
  switch (key.kind) {
    case 'probe':
      return `probe:${key.probeIndex}`;
    case 'cube':
      return `cube:${targetId(key.target)}:${key.layer}`;
    case 'planar':
      return `planar:${targetId(key.target)}`;
    case 'auxiliary':
      return `auxiliary:${targetId(key.target)}:${key.layer}`;
    case 'scene-input':
      return `scene-input:${key.featureIdentity}:${targetId(key.target)}`;
  }
}

/**
 * The roster a face fits against. A probe pins the Sun its capture generation
 * started under, a cube target pins it per candidate generation, and
 * planar/auxiliary faces pin the current Sun; a scene input fits the live lights.
 */
function faceRoster(
  state: ViewCaptureFitsState,
  item: PendingCaptureFit,
  key: CaptureFitKey,
  generation: number | undefined,
  environment: SelectedEnvironmentFrame | undefined,
): ViewLights {
  const sun = environment?.source.kind === 'atmosphere' ? environment.sun : undefined;
  if (key.kind === 'scene-input') return item.lights;
  if (key.kind !== 'probe' && key.kind !== 'cube')
    return environment?.source.kind === 'atmosphere'
      ? pinAtmosphereSun(item.lights, sun)
      : item.lights;
  const owner: number | RenderTarget = key.kind === 'probe' ? key.probeIndex : key.target;
  let pin = state.pins.get(owner);
  if (pin === undefined) {
    pin = { generation: undefined, frozen: undefined };
    state.pins.set(owner, pin);
  }
  if (pin.generation !== generation) {
    pin.generation = generation;
    pin.frozen =
      environment?.source.kind === 'atmosphere' ? pinAtmosphereSun(item.lights, sun) : undefined;
  }
  return pin.frozen ?? item.lights;
}

/**
 * Fit every capture face of a view: its probe faces and the non-probe faces
 * `render-capture-schedule` built. A fit whose probe left the table, or whose
 * target has no face this frame, releases its cascade views.
 */
function fitCaptureFaces(
  owner: ReturnType<typeof renderLightsOf>,
  state: ViewCaptureFitsState,
  item: PendingCaptureFit,
): void {
  const liveProbes = new Set(item.probes?.table.rows.map((row) => row.index));
  const liveTargets = new Set<RenderTarget>(item.faces.map((face) => face.key.target));
  const live = (faceOwner: number | RenderTarget): boolean =>
    typeof faceOwner === 'number' ? liveProbes.has(faceOwner) : liveTargets.has(faceOwner);
  for (const [id, fit] of state.keys) {
    if (live(fit.owner)) continue;
    owner.releaseView(fit.key);
    state.keys.delete(id);
  }
  for (const pinOwner of state.pins.keys()) if (!live(pinOwner)) state.pins.delete(pinOwner);
  const fit = (
    work: object,
    key: CaptureFitKey,
    camera: CameraSnapshot,
    generation: number | undefined,
    environment: SelectedEnvironmentFrame | undefined,
  ): void => {
    const id = fitKeyId(key);
    let retained = state.keys.get(id);
    if (retained === undefined) {
      retained = { key: {}, owner: key.kind === 'probe' ? key.probeIndex : key.target };
      state.keys.set(id, retained);
    }
    state.fits.set(
      work,
      owner.viewLights(
        retained.key,
        faceRoster(state, item, key, generation, environment),
        { camera },
        item.entity,
      ),
    );
  };
  for (const work of item.probes?.graph.work ?? []) {
    if (work.rawCaptureFace === undefined || work.faceCamera === undefined) continue;
    fit(
      work,
      { kind: 'probe', probeIndex: work.probeIndex },
      work.faceCamera,
      work.captureGeneration ?? 0,
      work.atmosphere?.environment ?? item.environment,
    );
  }
  for (const { key, work } of item.faces)
    fit(work, key, work.faceCamera, work.candidateGeneration, item.environment);
}

function stateOf(world: World, entity: EntityHandle | undefined) {
  if (entity === undefined || !world.hasComponent(entity, ViewReflectionProbes)) return undefined;
  const state = world
    .resolveUniqueRef<ViewReflectionProbesState>(
      requireViewField(world, entity, ViewReflectionProbes, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

/** The view's probe state prepared this renderer frame; undefined when the system did not run for it. */
export function viewReflectionProbesOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewReflectionProbesOutcome | undefined {
  return stateOf(world, entity)?.outcome;
}

/**
 * The recording takes its view's probe state: a failure rethrows inside the
 * recording's recovery, and from here the recording's submission settles the
 * capture tickets.
 */
export function consumeViewReflectionProbes(
  world: World,
  entity: EntityHandle | undefined,
): ViewReflectionProbesValue {
  const state = stateOf(world, entity);
  if (state === undefined)
    throw new Error('A view records only the reflection probes view-reflection-probes prepared');
  state.consumed = true;
  if (!state.outcome.ok) throw state.outcome.cause;
  return state.outcome.value;
}

/**
 * The view's SSR dependency projection: its camera's request against the
 * probe owner's reflection fallback, the active device's format receipt and
 * the accepted temporal history. Read-only; inspection uses it as is.
 */
export function resolveViewSsrDependencies(
  owner: ViewSettlementOwner,
  requested: boolean,
): SsrDependenciesInspection {
  const accepted = owner.frameState.temporalView.accepted;
  return projectSsrDependencies({
    requested,
    identity: owner.internals.ssrIdentity,
    reflectionFallback: owner.reflectionProbes.pipelineFallbackReceipt(),
    format: owner.ssrFormats.get(owner.internals.device),
    temporal:
      accepted === undefined
        ? undefined
        : { successfulSubmit: true, generation: accepted.input.deviceGeneration },
  });
}

/**
 * Prepare the view's probe table from its camera, culled lights and the
 * scene's probe projection, then admit its SSR dependencies. A committed
 * fallback generation change resets accumulated history. Never throws.
 */
function prepareViewReflectionProbes(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  staged: ViewFrameState,
): ViewReflectionProbesOutcome {
  let inputs: StagedViewInputs;
  try {
    inputs = stagedViewInputs(world, staged);
  } catch (cause) {
    return { ok: false, code: 'view-inputs-unavailable', cause };
  }
  const lights = viewLightsOf(world, entity);
  if (lights === undefined)
    return {
      ok: false,
      code: 'lights-unavailable',
      cause: new Error('A view prepares probes after render-cascade-fit'),
    };
  const { frame, cameras, resourceWorld } = inputs;
  const { frameState, scene } = owner;
  const roster = renderProbesOf(world).roster;
  const facts = roster.facts;
  let probes: ReflectionProbeRecordState;
  try {
    scene.projectReflectionProbes(roster);
    probes = owner.reflectionProbes.prepare(
      facts,
      scene.reflectionProbeProjection().selected,
      cameras[0],
      frameState.frameNumber,
      frame.skylight,
      facts.some((probe) => probe.updateIntent === 'on-change')
        ? JSON.stringify([
            scene.reflectionCaptureRevision(),
            lights.directional,
            lights.point,
            lights.spot,
            lights.rect,
            frame.skylight,
            frame.skybox,
            frame.environment?.environmentSignature,
          ])
        : '',
      frame.skybox,
      frame.environment as SelectedEnvironmentFrame | undefined,
      resourceWorld,
    );
  } catch (cause) {
    return { ok: false, code: 'probe-prepare-failed', cause };
  }
  let ssr: SsrDependenciesInspection;
  try {
    // Fresh spatial SSR needs no previous temporal submission; a fallback
    // generation change resets the accumulated history before recording.
    frameState.ssrRequested = cameras[0]?.screenSpaceReflection !== undefined;
    ssr = resolveViewSsrDependencies(owner, frameState.ssrRequested);
    const reset = resolveSsrAdmissionGeneration(
      frameState.ssrFallbackGeneration,
      ssr.reflectionFallback?.projectionGeneration,
    );
    if (reset.changed) {
      resetTemporalHistory(frameState, 'signature-change');
      frameState.ssrHistoryOwner?.reset('reflection-generation');
    }
    frameState.ssrFallbackGeneration = reset.generation;
  } catch (cause) {
    // The prepared capture work retires unsubmitted with the failed view.
    void probes.completeSubmission(false, undefined, undefined, false);
    return { ok: false, code: 'ssr-dependencies-failed', cause };
  }
  return { ok: true, value: { probes, ssr } };
}

/**
 * Register `view-reflection-probes` (RenderPrepare): each staged view whose
 * frame resolved prepares its reflection probes from its camera, its
 * `render-cascade-fit` lights and the shared scene's probe projection, and
 * admits its SSR dependencies. A view without a GPU scene (the
 * reflection-fallback lane) prepares from the CPU projection alone. A failure
 * is stored with its closed code, never thrown. `view-reflection-probes-settle`
 * (RenderCleanup) releases the capture tickets of state no recording took.
 * `render-capture-fit` (RenderPrepare, after `view-reflection-probes` and
 * `render-capture-schedule`) fits the cascades of every probe, cube, planar,
 * auxiliary and scene-input face work against its face camera into
 * {@link ViewCaptureFits}; the recording reads them via `viewCaptureFitsOf`.
 */
export function registerReflectionProbeSystems(world: World): void {
  const probes = renderProbesOf(world);
  world
    .addSystem(RenderExtract, {
      commands: 'none',
      name: RENDER_REFLECTION_PROBES_SYSTEM,
      queries: [],
      after: [RENDER_SCENE_SYSTEM],
      fn: (world) => probes.adopt(world.getResource<RenderProbeSource>(RenderProbeInput).facts),
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_REFLECTION_PROBE_ROSTER_SYSTEM,
      queries: [{ read: [RenderReflectionProbe] }],
      fn: (_world, [rows]) => void probes.rebuild(rows),
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: VIEW_REFLECTION_PROBES_SYSTEM,
      after: [
        RENDER_VIEW_FRAME_SYSTEM,
        RENDER_CASCADE_FIT_SYSTEM,
        RENDER_REFLECTION_PROBE_ROSTER_SYSTEM,
      ],
      // The cascade fit is read through `viewLightsOf`; an unfitted view has none.
      queries: [
        { read: [ViewRecorder, ViewFrame], optional: [ViewReflectionProbes, ViewCascadeFit] },
      ],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        const first: { entity: EntityHandle; state: ViewReflectionProbesState }[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame || staged.result?.ok !== true) return;
          const outcome = prepareViewReflectionProbes(
            world,
            entity,
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            staged,
          );
          const stored = readViewField(world, entity, ViewReflectionProbes, 'state');
          if (stored === undefined) {
            first.push({ entity: entity, state: { frame, outcome, consumed: false } });
            return;
          }
          const state = world.resolveUniqueRef<ViewReflectionProbesState>(stored).unwrap();
          state.frame = frame;
          state.outcome = outcome;
          state.consumed = false;
        });
        // A view's first probe state attaches its component after the iteration.
        for (const { entity, state } of first)
          world
            .addComponent(entity, {
              component: ViewReflectionProbes,
              data: { state: world.allocUniqueRef('ViewReflectionProbes', state) },
            })
            .unwrap();
      },
    })
    .unwrap();
  const owner = renderLightsOf(world);
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_CAPTURE_FIT_SYSTEM,
      after: [VIEW_REFLECTION_PROBES_SYSTEM, RENDER_CAPTURE_SCHEDULE_SYSTEM],
      queries: [{ read: [ViewFrame], optional: [ViewCaptureFits] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;
        // Fitting spawns cascade view entities, which invalidates the query:
        // the iteration only collects, the fits and attachments follow it.
        const pending: (PendingCaptureFit & { state: ViewCaptureFitsState | undefined })[] = [];

        rows.forEach((row) => {
          const entity = row.entity;

          const probes = viewReflectionProbesOf(world, entity);
          const captures = viewCaptureWorkOf(world, entity);
          const lights = viewLightsOf(world, entity);
          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          const stored = readViewField(world, entity, ViewCaptureFits, 'state');
          const state =
            stored === undefined
              ? undefined
              : world.resolveUniqueRef<ViewCaptureFitsState>(stored).unwrap();
          if (lights === undefined || staged.result?.ok !== true) {
            if (state !== undefined) {
              state.frame = -1;
              state.fits.clear();
            }
            return;
          }
          pending.push({
            entity: entity,
            state,
            lights,
            probes: probes?.ok === true ? probes.value.probes : undefined,
            faces: captures?.kind === 'prepared' ? captures.value.faces : [],
            environment: staged.result.value.environment as SelectedEnvironmentFrame | undefined,
          });
        });
        for (const item of pending) {
          const state = item.state ?? {
            frame,
            fits: new Map(),
            keys: new Map(),
            pins: new Map(),
          };
          state.frame = frame;
          state.fits.clear();
          fitCaptureFaces(owner, state, item);
          if (item.state === undefined)
            world
              .addComponent(item.entity, {
                component: ViewCaptureFits,
                data: { state: world.allocUniqueRef('ViewCaptureFits', state) },
              })
              .unwrap();
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: VIEW_REFLECTION_PROBES_SETTLE_SYSTEM,
      queries: [{ read: [ViewReflectionProbes] }],
      fn: (world, [rows]) => {
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<ViewReflectionProbesState>(
              requireViewField(world, entity, ViewReflectionProbes, 'state'),
            )
            .unwrap();
          if (state.frame !== frame || state.consumed || !state.outcome.ok) return;
          state.consumed = true;
          // Unrecorded capture work retires unsubmitted; no fallback was requested.
          void state.outcome.value.probes.completeSubmission(false, undefined, undefined, false);
        });
      },
    })
    .unwrap();
}
