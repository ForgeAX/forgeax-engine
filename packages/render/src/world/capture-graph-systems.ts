import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { markDerivedComponentChanged } from '@forgeax/engine-ecs/projection';
import {
  compiledRenderGraphPassDeclarations,
  type RenderGraphPassExecution,
} from '@forgeax/engine-render-graph';
import { err } from '@forgeax/engine-rhi';
import {
  type CaptureGraphBatch,
  type CaptureGraphCompileInput,
  type CaptureGraphOutcome,
  captureGraphFailure,
  compileCaptureGraphBatch,
  retireCaptureGraphBatch,
} from '../record/frame-capture';
import type { RenderSystemInternals } from '../record/render-context';
import {
  RenderCaptureGraphCompileOrder,
  RenderCaptureGraphRetireOrder,
  RenderEncoderOpenOrder,
  RenderGraphCompileOrder,
  RenderSubmissionRetireOrder,
} from '../system-order';
import { ViewCaptureWork, viewCaptureWorkOf } from './capture-systems';
import { stageRecordedFeatureGraph } from './feature-systems';
import { awaitsRenderRecord } from './graph-systems';
import { renderFrameEncoder } from './record-systems';
import {
  ViewCaptureFits,
  ViewReflectionProbes,
  viewCaptureFitsOf,
  viewReflectionProbesOf,
} from './reflection-systems';
import { ViewRecorder, viewCameraOf } from './render-views';
import { RenderCleanup, RenderRecord, renderSubmission, renderWorldFor } from './render-world';
import { ViewStandardLighting, viewStandardLightingOf } from './standard-lighting-systems';
import { retireAfterSubmission } from './submission-systems';
import { requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';
import { ViewTopologyInputs, viewTopologyOf } from './view-topology-systems';

export const RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM = 'render-capture-graph-compile';
export const RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM = 'render-capture-graph-retire';

interface CapturePassProducer {
  readonly deviceGeneration: number;
  readonly viewEntity: EntityHandle | undefined;
  readonly cameraEntityKey: number | undefined;
  readonly viewOwner: RenderSystemInternals['viewOwner'];
}

interface CapturePassManifest {
  readonly producer: CapturePassProducer;
  readonly passes: readonly Pick<RenderGraphPassExecution, 'name' | 'kind'>[];
}

interface CaptureGraphsState {
  frame: number;
  outcome: CaptureGraphOutcome | undefined;
  /** Producer identity captured with the current admission, when Profiler is configured. */
  phaseProducer: CapturePassProducer | undefined;
  /** Last successful immutable phase vocabulary for this same producer identity. */
  phaseManifest: CapturePassManifest | undefined;
  encoded: boolean;
  generation: number;
  queue: RenderSystemInternals['device']['queue'];
}

function profileRoot(internals: RenderSystemInternals): RenderSystemInternals {
  return internals.viewContext?.root ?? internals;
}

function capturePassProducer(
  internals: RenderSystemInternals,
  cameraEntityKey?: number,
): CapturePassProducer {
  const world = renderWorldFor(profileRoot(internals));
  const viewEntity = internals.viewEntity;
  return Object.freeze({
    deviceGeneration: recordContext(internals).deviceScope?.generation ?? 0,
    viewEntity,
    viewOwner: internals.viewOwner,
    cameraEntityKey:
      cameraEntityKey ??
      internals.viewContext?.camera ??
      (viewEntity === undefined ? undefined : viewCameraOf(world, viewEntity)?.camera?.entityKey),
  });
}

function sameCapturePassProducer(left: CapturePassProducer, right: CapturePassProducer): boolean {
  return (
    left.deviceGeneration === right.deviceGeneration &&
    left.viewEntity === right.viewEntity &&
    left.cameraEntityKey === right.cameraEntityKey &&
    left.viewOwner === right.viewOwner
  );
}

function capturePassManifest(
  outcome: CaptureGraphOutcome,
  producer: CapturePassProducer,
  previous: CapturePassManifest | undefined,
): CapturePassManifest | undefined {
  if (!outcome.ok) return undefined;
  let count = 0;
  let sameVocabulary =
    previous !== undefined && sameCapturePassProducer(previous.producer, producer);
  const compareCapturePassVocabulary = (outcome: Extract<CaptureGraphOutcome, { ok: true }>) => {
    for (const capture of outcome.value.cube)
      for (const pass of compiledRenderGraphPassDeclarations(capture.graph)) {
        if (pass.kind === 'subgraph') continue;
        const old = previous?.passes[count];
        if (old?.name !== pass.name || old.kind !== pass.kind) sameVocabulary = false;
        count += 1;
      }
    for (const capture of outcome.value.probes)
      for (const pass of compiledRenderGraphPassDeclarations(capture.graph)) {
        if (pass.kind === 'subgraph') continue;
        const old = previous?.passes[count];
        if (old?.name !== pass.name || old.kind !== pass.kind) sameVocabulary = false;
        count += 1;
      }
  };
  compareCapturePassVocabulary(outcome);
  if (count === 0) return undefined;
  if (sameVocabulary && previous?.passes.length === count) return previous;
  const declarations: Pick<RenderGraphPassExecution, 'name' | 'kind'>[] = [];
  for (const capture of outcome.value.cube)
    for (const pass of compiledRenderGraphPassDeclarations(capture.graph))
      if (pass.kind !== 'subgraph')
        declarations.push(Object.freeze({ name: pass.name, kind: pass.kind }));
  for (const capture of outcome.value.probes)
    for (const pass of compiledRenderGraphPassDeclarations(capture.graph))
      if (pass.kind !== 'subgraph')
        declarations.push(Object.freeze({ name: pass.name, kind: pass.kind }));
  return Object.freeze({
    producer,
    passes: Object.freeze(declarations),
  });
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
export function stageCaptureGraphCompile(
  internals: RenderSystemInternals,
  cameraEntityKey?: number,
): boolean {
  const world = renderWorldFor(internals);
  const entity = internals.viewEntity;
  if (entity === undefined || !awaitsRenderRecord(world)) return false;
  const root = profileRoot(internals);
  const phaseProducer =
    root.profiler === undefined ? undefined : capturePassProducer(internals, cameraEntityKey);
  const state: CaptureGraphsState = {
    frame: renderSubmission(world).frame,
    outcome: undefined,
    phaseProducer,
    phaseManifest: undefined,
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
    const phaseManifest =
      phaseProducer !== undefined &&
      current.phaseManifest !== undefined &&
      sameCapturePassProducer(current.phaseManifest.producer, phaseProducer)
        ? current.phaseManifest
        : undefined;
    Object.assign(current, state);
    current.phaseManifest = phaseManifest;
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
  return stageCaptureGraphCompile(input.internals, input.cameraEntityKey)
    ? undefined
    : compileCaptureGraphBatch(input);
}

/** Borrow the current compile result; Cleanup remains its sole lifetime owner. */
export function captureGraphOutcome(internals: RenderSystemInternals): CaptureGraphOutcome {
  return (
    stateOf(renderWorldFor(internals), internals.viewEntity)?.outcome ??
    err(captureGraphFailure('RenderRecord did not compile the requested capture graphs'))
  );
}

/** Last successful pass vocabulary, only while its immutable producer identity still matches. */
export function captureGraphPassPhaseManifest(
  internals: RenderSystemInternals,
  cameraEntityKey?: number,
): CapturePassManifest | undefined {
  const root = profileRoot(internals);
  if (root.profiler === undefined) return undefined;
  const world = renderWorldFor(internals);
  const entity = internals.viewEntity;
  if (entity === undefined || !world.hasComponent(entity, ViewCaptureGraphs)) return undefined;
  const state = world
    .resolveUniqueRef<CaptureGraphsState>(
      requireViewField(world, entity, ViewCaptureGraphs, 'state'),
    )
    .unwrap();
  const manifest = state.phaseManifest;
  if (manifest === undefined) return undefined;
  return sameCapturePassProducer(manifest.producer, capturePassProducer(internals, cameraEntityKey))
    ? manifest
    : undefined;
}

/** Actual capture encoding, rather than a requested or compiled graph, pins retirement to submission. */
export function markCaptureGraphsEncoded(internals: RenderSystemInternals): void {
  const state = stateOf(renderWorldFor(internals), internals.viewEntity);
  if (state?.outcome?.ok === true) state.encoded = true;
}

/** A capture graph compile/encode failure leaves the per-receipt join incomplete. */
export function markCaptureGraphsIncomplete(internals: RenderSystemInternals): void {
  const root = profileRoot(internals);
  if (root.renderPassCpuIdentityCapture !== undefined)
    root.renderPassCpuIdentityCapture.complete = false;
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
  const compiled = compileCaptureGraphBatch({
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
  if (compiled.ok) stageFaceFeatureReceipts(world, entity, compiled.value);
  return compiled;
}

/** Acknowledge the Feature plans each compiled capture face records, as a display graph does. */
function stageFaceFeatureReceipts(
  world: World,
  entity: EntityHandle,
  batch: CaptureGraphBatch,
): void {
  const submission = renderSubmission(world);
  for (const frame of batch.planar === undefined ? batch.cube : [...batch.cube, batch.planar]) {
    const feature = frame.work.feature;
    if (feature === undefined) continue;
    stageRecordedFeatureGraph(world, {
      kind: 'compiled',
      graph: frame.graph,
      frame: submission.frame,
      generation: submission.generation,
      view: entity,
      plans: feature.plans,
    });
  }
}

export function registerCaptureGraphSystems(world: World): void {
  world
    .addSystem(
      RenderRecord,
      defineSystem({
        sets: [RenderCaptureGraphCompileOrder],
        commands: 'none',
        name: RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM,
        after: [RenderEncoderOpenOrder],
        before: [RenderGraphCompileOrder],
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

            markDerivedComponentChanged(world, entity, ViewCaptureGraphs).unwrap();
            const state = world
              .resolveUniqueRef<CaptureGraphsState>(
                requireViewField(world, entity, ViewCaptureGraphs, 'state'),
              )
              .unwrap();
            if (state.frame !== frame || state.outcome !== undefined) return;
            const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
            try {
              state.outcome = compileViewCaptures(world, entity, owner);
            } catch (cause) {
              state.outcome = err(captureGraphFailure(cause));
            }
            if (state.outcome?.ok !== true) markCaptureGraphsIncomplete(owner.internals);
          });
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      RenderCleanup,
      defineSystem({
        sets: [RenderCaptureGraphRetireOrder],
        commands: 'none',
        name: RENDER_CAPTURE_GRAPH_RETIRE_SYSTEM,
        before: [RenderSubmissionRetireOrder],
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
            if (outcome?.ok === true && state.phaseProducer !== undefined) {
              const nextManifest = capturePassManifest(
                outcome,
                state.phaseProducer,
                state.phaseManifest,
              );
              if (nextManifest !== undefined) {
                state.phaseManifest = nextManifest;
              }
            }
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
      }),
    )
    .unwrap();
}
