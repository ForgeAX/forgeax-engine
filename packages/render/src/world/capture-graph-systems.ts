import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { setDerivedComponent } from '@forgeax/engine-ecs/projection';
import { err } from '@forgeax/engine-rhi';
import {
  type CaptureGraphCompileInput,
  type CaptureGraphOutcome,
  captureGraphFailure,
  compileCaptureGraphBatch,
  retireCaptureGraphBatch,
} from '../record/frame-capture';
import type { RenderSystemInternals } from '../record/render-context';
import { ViewCaptureWork, viewCaptureWorkOf } from './capture-systems';
import { awaitsRenderRecord, RENDER_GRAPH_COMPILE_SYSTEM } from './graph-systems';
import { RENDER_ENCODER_OPEN_SYSTEM, renderFrameEncoder } from './record-systems';
import {
  ViewCaptureFits,
  ViewReflectionProbes,
  viewCaptureFitsOf,
  viewReflectionProbesOf,
} from './reflection-systems';
import { ViewRecorder } from './render-views';
import { RenderCleanup, RenderRecord, renderSubmission, renderWorldFor } from './render-world';
import { ViewStandardLighting, viewStandardLightingOf } from './standard-lighting-systems';
import { RENDER_SUBMISSION_RETIRE_SYSTEM, retireAfterSubmission } from './submission-systems';
import { EMPTY_VIEW_STATE_UPDATE, requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';
import { ViewTopologyInputs, viewTopologyOf } from './view-topology-systems';

export const RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM = 'render-capture-graph-compile';
export const RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM = 'render-capture-graph-retire';

interface CaptureGraphsState {
  frame: number;
  outcome: CaptureGraphOutcome | undefined;
  encoded: boolean;
  generation: number;
  queue: RenderSystemInternals['device']['queue'];
}

/** Compile request, outcome and lifetime of a view's current capture graphs. */
export const ViewCaptureGraphs = defineComponent('ViewCaptureGraphs', {
  state: 'unique<ViewCaptureGraphs>',
});

function stateOf(world: World, entity: EntityHandle | undefined): CaptureGraphsState | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewCaptureGraphs)) return undefined;
  const state = world
    .resolveUniqueRef<CaptureGraphsState>(
      requireViewField(world, entity, ViewCaptureGraphs, 'state'),
    )
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

/** Request capture compilation at the same barrier as the display graph; no prepared inputs are copied. */
export function stageCaptureGraphCompile(internals: RenderSystemInternals): boolean {
  const world = renderWorldFor(internals);
  const entity = internals.viewEntity;
  if (entity === undefined || !awaitsRenderRecord(world)) return false;
  const state: CaptureGraphsState = {
    frame: renderSubmission(world).frame,
    outcome: undefined,
    encoded: false,
    generation: recordContext(internals).deviceScope?.generation ?? 0,
    queue: internals.device.queue,
  };
  if (world.hasComponent(entity, ViewCaptureGraphs)) {
    const current = world
      .resolveUniqueRef<CaptureGraphsState>(
        requireViewField(world, entity, ViewCaptureGraphs, 'state'),
      )
      .unwrap();
    Object.assign(current, state);
  } else {
    world
      .addComponent(entity, {
        component: ViewCaptureGraphs,
        data: {
          state: world.allocUniqueRef('ViewCaptureGraphs', state),
        },
      })
      .unwrap();
  }
  return true;
}

/** Request the system-owned compile, or use the same compiler for a direct harness. */
export function prepareCaptureGraphs(
  input: CaptureGraphCompileInput,
): CaptureGraphOutcome | undefined {
  return stageCaptureGraphCompile(input.internals) ? undefined : compileCaptureGraphBatch(input);
}

/** Borrow the current compile result; Cleanup remains its sole lifetime owner. */
export function captureGraphOutcome(internals: RenderSystemInternals): CaptureGraphOutcome {
  return (
    stateOf(renderWorldFor(internals), internals.viewEntity)?.outcome ??
    err(captureGraphFailure('RenderRecord did not compile the requested capture graphs'))
  );
}

/** Actual capture encoding, rather than a requested or compiled graph, pins retirement to submission. */
export function markCaptureGraphsEncoded(internals: RenderSystemInternals): void {
  const state = stateOf(renderWorldFor(internals), internals.viewEntity);
  if (state?.outcome?.ok === true) state.encoded = true;
}

function compileViewCaptures(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
): CaptureGraphOutcome {
  const lighting = viewStandardLightingOf(world, entity);
  if (
    lighting?.kind !== 'prepared' ||
    !lighting.lighting.ok ||
    lighting.fence.pipelineState === null
  )
    return err(captureGraphFailure({ system: 'render-standard-lighting', outcome: lighting }));
  const topology = viewTopologyOf(world, entity);
  if (topology?.kind !== 'planned')
    return err(captureGraphFailure({ system: 'render-view-topology', outcome: topology }));
  const captures = viewCaptureWorkOf(world, entity);
  if (captures?.kind !== 'prepared')
    return err(captureGraphFailure({ system: 'render-capture-schedule', outcome: captures }));
  const fits = viewCaptureFitsOf(world, entity);
  if (fits === undefined) return err(captureGraphFailure({ system: 'render-capture-fit' }));
  const reflection = viewReflectionProbesOf(world, entity);
  if (reflection?.ok !== true)
    return err(captureGraphFailure({ system: 'view-reflection-probes', outcome: reflection }));
  const { value } = captures;
  return compileCaptureGraphBatch({
    internals: owner.internals,
    frameState: owner.frameState,
    pipelineState: lighting.fence.pipelineState,
    capture: {
      ...value,
      scheduledWork: value.cube,
      state: owner.captures,
      fits,
      reflectionProbes: reflection.value.probes,
    },
    work: value.faces.map((face) => face.work),
    shadowMapSize: topology.topology.shadowMapSize,
    terrainReceivers: topology.topology.terrainReceivers,
  });
}

export function registerCaptureGraphSystems(world: World): void {
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM,
      after: [RENDER_ENCODER_OPEN_SYSTEM],
      before: [RENDER_GRAPH_COMPILE_SYSTEM],
      queries: [
        {
          write: [ViewCaptureGraphs],
          read: [ViewRecorder],
          optional: [
            ViewStandardLighting,
            ViewTopologyInputs,
            ViewCaptureWork,
            ViewCaptureFits,
            ViewReflectionProbes,
          ],
        },
      ],
      fn: (world, [rows]) => {
        if (renderFrameEncoder(world).kind !== 'open') return;
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          setDerivedComponent(world, entity, ViewCaptureGraphs, EMPTY_VIEW_STATE_UPDATE).unwrap();
          const state = world
            .resolveUniqueRef<CaptureGraphsState>(
              requireViewField(world, entity, ViewCaptureGraphs, 'state'),
            )
            .unwrap();
          if (state.frame !== frame || state.outcome !== undefined) return;
          try {
            state.outcome = compileViewCaptures(
              world,
              entity,
              ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            );
          } catch (cause) {
            state.outcome = err(captureGraphFailure(cause));
          }
        });
      },
    })
    .unwrap();
  world
    .addSystem(RenderCleanup, {
      commands: 'none',
      name: RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM,
      before: [RENDER_SUBMISSION_RETIRE_SYSTEM],
      queries: [{ write: [ViewCaptureGraphs] }],
      fn: (world, [rows]) => {
        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<CaptureGraphsState>(
              requireViewField(world, entity, ViewCaptureGraphs, 'state'),
            )
            .unwrap();
          const outcome = state.outcome;
          state.outcome = undefined;
          if (outcome?.ok !== true) return;
          if (!state.encoded) retireCaptureGraphBatch(outcome.value);
          else
            retireAfterSubmission(world, {
              generation: state.generation,
              queue: state.queue,
              release: () => retireCaptureGraphBatch(outcome.value),
            });
        });
      },
    })
    .unwrap();
}
