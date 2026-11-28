import { defineComponent, defineSystem, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RenderGraphPassExecution } from '@forgeax/engine-render-graph';
import { err } from '@forgeax/engine-rhi';
import {
  type CaptureGraphBatch,
  type CaptureGraphCompileInput,
  type CaptureGraphOutcome,
  captureGraphFailure,
  compileCaptureGraphBatch,
  retireCaptureGraphBatch,
} from '../record/frame-capture';
import { captureRecordingPasses, NativeCaptureRecording } from '../record/native-target-capture';
import type { RenderSystemInternals } from '../record/render-context';
import {
  RenderCaptureGraphCompileOrder,
  RenderCaptureGraphRetireOrder,
  RenderEncoderOpenOrder,
  RenderSubmissionRetireOrder,
} from '../system-order';
import { stageRecordedFeatureGraph } from './feature-systems';
import { awaitsRenderRecord } from './graph-systems';
import { renderFrameEncoder } from './record-systems';
import { viewCameraOf } from './render-views';
import { RenderCleanup, RenderRecord, renderSubmission, renderWorldFor } from './render-world';
import { retireAfterSubmission } from './submission-systems';
import { readViewState, requireViewField } from './view-field';
import { recordContext } from './view-record-context';

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
  input: CaptureGraphCompileInput | undefined;
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
      for (const pass of captureRecordingPasses(capture.recording)) {
        if (pass.kind === 'subgraph') continue;
        const old = previous?.passes[count];
        if (old?.name !== pass.name || old.kind !== pass.kind) sameVocabulary = false;
        count += 1;
      }
    for (const capture of outcome.value.probes)
      for (const pass of captureRecordingPasses(capture.recording)) {
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
    for (const pass of captureRecordingPasses(capture.recording))
      if (pass.kind !== 'subgraph')
        declarations.push(Object.freeze({ name: pass.name, kind: pass.kind }));
  for (const capture of outcome.value.probes)
    for (const pass of captureRecordingPasses(capture.recording))
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
  const state = readViewState<CaptureGraphsState>(world, entity, ViewCaptureGraphs);
  if (state === undefined) return undefined;
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

/** Stage actual capture work only; the compiler borrows the recording's admitted inputs. */
export function stageCaptureGraphCompile(input: CaptureGraphCompileInput): boolean {
  const { internals, cameraEntityKey } = input;
  const world = renderWorldFor(internals);
  const entity = internals.viewEntity;
  if (entity === undefined || !awaitsRenderRecord(world)) return false;
  const root = profileRoot(internals);
  const phaseProducer =
    root.profiler === undefined ? undefined : capturePassProducer(internals, cameraEntityKey);
  const state: CaptureGraphsState = {
    frame: renderSubmission(world).frame,
    input,
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
  const state = readViewState<CaptureGraphsState>(world, entity, ViewCaptureGraphs);
  if (state === undefined) return undefined;
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

/** Acknowledge the Feature plans each compiled capture face records, as a display graph does. */
function stageFaceFeatureReceipts(
  world: World,
  entity: EntityHandle,
  batch: CaptureGraphBatch,
): void {
  const submission = renderSubmission(world);
  for (const frame of batch.planar === undefined ? batch.cube : [...batch.cube, batch.planar]) {
    const feature = frame.work.feature;
    if (feature === undefined || frame.recording instanceof NativeCaptureRecording) continue;
    stageRecordedFeatureGraph(world, {
      kind: 'compiled',
      graph: frame.recording,
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
        queries: [{ write: [ViewCaptureGraphs] }],
        fn: (world, [rows]) => {
          if (renderFrameEncoder(world).kind !== 'open') return;
          const frame = renderSubmission(world).frame;

          rows.forEach((row) => {
            const entity = row.entity;

            const state = world
              .resolveUniqueRef<CaptureGraphsState>(
                requireViewField(world, entity, ViewCaptureGraphs, 'state'),
              )
              .unwrap();
            const input = state.input;
            if (state.frame !== frame || input === undefined || state.outcome !== undefined) return;
            state.input = undefined;
            try {
              const outcome = compileCaptureGraphBatch(input);
              state.outcome = outcome;
              if (outcome.ok) stageFaceFeatureReceipts(world, entity, outcome.value);
            } catch (cause) {
              if (state.outcome?.ok === true) retireCaptureGraphBatch(state.outcome.value);
              state.outcome = err(captureGraphFailure(cause));
            }
            if (state.outcome?.ok !== true) markCaptureGraphsIncomplete(input.internals);
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
            state.input = undefined;
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
