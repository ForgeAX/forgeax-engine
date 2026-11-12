import type { World } from '@forgeax/engine-ecs';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { CommandBuffer, RhiCommandEncoder } from '@forgeax/engine-rhi';
import type { RecordedView } from '../assembly/frame-recording';
import type { RendererFrameStageResult } from '../assembly/renderer-frame-transaction';
import type { RendererOperationCause } from '../errors/render';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderPhase } from '../render-contract';
import { sharedFeatureGraphEncoded, sharedFeatureGraphStaged } from './feature-graph-systems';
import {
  RENDER_VIEW_GRAPH_ENCODE_SYSTEM,
  ViewGraphSeal,
  type ViewGraphSealState,
} from './graph-seal-systems';
import {
  closeFrameEncoder,
  RenderRecordInput,
  type RenderRecordInputState,
  renderFrameEncoder,
} from './record-systems';
import { ViewRecorder } from './render-views';
import { publishRenderSubmission, RenderRecord, renderSubmission } from './render-world';
import { surfaceUi } from './surface-ui';
import { encodeSurfaceUi, RENDER_SURFACE_UI_ENCODE_SYSTEM } from './surface-ui-systems';
import { readViewField, requireViewField } from './view-field';
import { ViewFrame, type ViewFrameState } from './view-frame-systems';
import { type ViewOutputOwner, ViewOutputOwnerKey, viewComposition } from './view-output-systems';
import { recordContext } from './view-record-context';
import { ViewRecordAttempt, type ViewRecordAttemptState } from './view-record-systems';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';

export const RENDER_COMPOSITE_ENCODE_SYSTEM = 'render-composite-encode';
export const RENDER_FRAME_SUBMIT_SYSTEM = 'render-frame-submit';
export interface FrameSubmitState {
  readonly frame: number;
  recordStarted: boolean;
  result: RendererFrameStageResult<void>;
  readonly failures: unknown[];
  captureReady: boolean;
  rejectionCause?: RendererOperationCause;
  composite: 'not-required' | 'pending' | 'encoded' | 'rejected';
}
const RenderFrameSubmit = Object.freeze({ name: 'RenderFrameSubmit' });
export function frameSubmitOutcome(world: World): FrameSubmitState {
  if (!world.hasResource(RenderFrameSubmit))
    return {
      frame: renderSubmission(world).frame,
      recordStarted: false,
      result: { ok: false, stage: 'execute' },
      failures: [],
      captureReady: true,
      composite: 'not-required',
    };
  return world.getResource<FrameSubmitState>(RenderFrameSubmit);
}
export function beginFrameSubmission(world: World): void {
  world.insertResource<FrameSubmitState>(RenderFrameSubmit, {
    frame: renderSubmission(world).frame,
    recordStarted: false,
    result: { ok: false, stage: 'execute' },
    failures: [],
    captureReady: true,
    composite: 'not-required',
  });
}
function collectFailure(state: FrameSubmitState, action: () => void): void {
  try {
    action();
  } catch (cause) {
    state.failures.push(cause);
  }
}
function profiled<T>(session: RecorderSession | undefined, phase: RenderPhase, action: () => T): T {
  let opened = false;
  try {
    opened = session?.beginPhase('render', phase).ok === true;
  } catch {}
  try {
    return action();
  } finally {
    if (opened) {
      try {
        session?.endPhase();
      } catch {}
    }
  }
}
function encodeComposite(
  world: World,
  input: RenderRecordInputState,
  encoder: RhiCommandEncoder,
): boolean {
  const internals = input.rendererInternals;
  if (internals === undefined || !world.hasResource(ViewOutputOwnerKey)) return false;
  const plan = viewComposition(world);
  const owner = world.getResource<ViewOutputOwner>(ViewOutputOwnerKey);
  for (const view of plan.recorded) {
    if (view.target === undefined || view.output === undefined) continue;
    const target = internals.getRenderTargetPhysical?.(view.target);
    if (target === undefined) return false;
    const { width, height, texture } = view.output;
    const picture = {
      texture,
      viewport: { x: 0, y: 0, width, height, renderWidth: width, renderHeight: height },
    };
    if (!view.composite.encode(encoder, [picture], target.texture, target.descriptor)) return false;
  }
  if (internals.context === null) return false;
  const output = internals.presentationOutput ?? internals.context.getCurrentTexture().unwrap();
  if (!owner.compositor.encode(encoder, plan.pictures, output)) return false;
  recordContext(internals).encodeRenderTargetReadbacks?.(encoder);
  return true;
}

function publishPhysicalSubmission(
  world: World,
  input: RenderRecordInputState,
  works: readonly RecordedView[],
  state: FrameSubmitState,
  owner: RenderSystemInternals | undefined,
): boolean {
  state.result = { ok: true, value: undefined };
  state.captureReady = works.every((view) => view.presentation !== 'pending');
  const queue = input.device.queue;
  const completion = queue.onSubmittedWorkDone();
  // Every observer sees this physical fence even if a sibling observer throws.
  for (const view of works)
    if (view.onSubmittedWork !== undefined)
      collectFailure(state, () => view.onSubmittedWork?.(completion));
  if (owner !== undefined) {
    owner.gpuPassTimingSubmittedWork = completion;
    owner.submittedPassNames = Object.freeze([...(owner.framePassNames ?? [])]);
    collectFailure(state, () => owner.gpuPassTimingCapture?.markSubmitted(completion));
  }
  publishRenderSubmission(world, {
    accepted:
      input.isCurrent?.() !== false &&
      works.every((view) => view.isCurrent?.() !== false) &&
      (!sharedFeatureGraphStaged(world) || sharedFeatureGraphEncoded(world)),
    completion,
    creditCompletion: queue.onSubmittedWorkDoneUnheld?.(),
    generation: input.generation ?? owner?.deviceScope.generation ?? 0,
  });
  return true;
}

/** Physical submission kernel. All owners receive the same queue fence before any settlement. */
export function submitEncodedFrame(
  world: World,
  input: RenderRecordInputState,
  works: readonly RecordedView[],
  state: FrameSubmitState,
): boolean {
  const open = renderFrameEncoder(world);
  if (open.kind !== 'open' || (works.length === 0 && input.shared !== true)) return false;
  const owner = input.rendererInternals;
  const work: RecordedView | undefined =
    input.shared === true && owner !== undefined
      ? {
          beforeSubmit: owner.beforeSubmit,
          reportError: (error) => owner.errorRegistry.fire(error),
        }
      : works.at(-1);
  if (work === undefined) return false;
  let session: RecorderSession | undefined;
  try {
    session = owner?.profiler?.activeSession();
  } catch {}
  let textureMips: ReturnType<RenderSystemInternals['gpuStore']['prepareTextureMips']> | undefined;
  let canvasMips:
    | ReturnType<NonNullable<RenderSystemInternals['dynamicTextureStore']>['prepareMipmaps']>
    | undefined;
  let morph: import('../device/morph-geometry').MorphGeometryWork | undefined;
  try {
    state.result = { ok: false, stage: 'finish' };
    const commands = profiled(session, 'submission/finish', () => {
      textureMips = owner?.gpuStore?.prepareTextureMips();
      if (textureMips !== undefined && !textureMips.ok) {
        work.reportError(textureMips.error);
        return undefined;
      }
      morph = owner?.gpuStore?.morphGeometry.prepare(input.device, work.reportError);
      canvasMips = owner?.dynamicTextureStore?.prepareMipmaps(input.device);
      if (canvasMips !== undefined && !canvasMips.ok) {
        work.reportError(canvasMips.error);
        return undefined;
      }
      const capture = owner?.gpuPassTimingCapture;
      if (capture !== undefined) {
        const tail = capture.encodeTail(open.encoder, owner?.observationGraphGeneration);
        if (!tail.ok) capture.abort({ code: tail.error.code });
      }
      const finished = open.encoder.finish();
      if (!finished.ok) {
        work.reportError(finished.error);
        return undefined;
      }
      return finished.value;
    });
    if (commands === undefined) return false;
    state.result = { ok: false, stage: 'submit' };
    const submitted = profiled(session, 'submission/submit', () => {
      const injected = work.beforeSubmit?.(input.device);
      if (injected !== undefined) {
        state.rejectionCause = injected;
        work.reportError(injected);
        return false;
      }
      const frameCurrent = input.isCurrent?.() !== false;
      const stale = works.find((view) => view.isCurrent?.() === false);
      if (!frameCurrent || stale !== undefined) {
        state.rejectionCause = {
          code: 'frame-generation-stale',
          expected: 'the encoded frame inputs remain current until queue submission',
          hint: 'reprepare the rejected frame with current input owners',
          detail: { frameCurrent },
        };
        try {
          state.rejectionCause = stale?.rejectionCause?.() ?? state.rejectionCause;
        } catch {
          // Diagnostics cannot replace the original submission rejection.
        }
        return false;
      }
      const buffers: CommandBuffer[] = [];
      const mipBuffer = textureMips?.ok ? textureMips.value?.buffer : undefined;
      if (mipBuffer !== undefined) buffers.push(mipBuffer);
      if (canvasMips?.ok) buffers.push(canvasMips.value.buffer);
      if (morph !== undefined) buffers.push(morph.buffer);
      buffers.push(commands);
      const accepted = input.device.queue.submit(buffers);
      if (!accepted.ok) {
        state.rejectionCause = accepted.error;
        work.reportError(accepted.error);
        return false;
      }
      return publishPhysicalSubmission(world, input, works, state, owner);
    });
    if (!submitted) return false;
    return true;
  } catch (cause) {
    state.failures.push(cause);
    return state.result.ok;
  } finally {
    collectFailure(state, () => {
      if (textureMips?.ok) textureMips.value?.complete(state.result.ok);
    });
    collectFailure(state, () => {
      if (canvasMips?.ok) canvasMips.value.complete(state.result.ok);
    });
    collectFailure(state, () => morph?.complete(state.result.ok));
    if (!renderSubmission(world).accepted)
      collectFailure(state, () =>
        owner?.gpuPassTimingCapture?.abort({
          code: state.result.ok ? 'scene-input-pending' : state.result.stage,
        }),
      );
    closeFrameEncoder(world);
  }
}

function pendingViewWork(
  owner: ViewSettlementOwner,
  attempt: ViewRecordAttemptState,
): RecordedView {
  const { internals } = owner;
  const generation = attempt.generation;
  return {
    presentation: 'pending',
    isCurrent: () => recordContext(internals).deviceScope.generation === generation,
    beforeSubmit: internals.beforeSubmit,
    reportError: (error) => internals.errorRegistry.fire(error),
  };
}

type ViewSubmitWork =
  | { readonly kind: 'ready'; readonly work: RecordedView }
  | { readonly kind: 'held' | 'rejected' };

/** Admit only this view's prepared barrier or actual encoded product to the shared submit. */
function selectViewWork(
  world: World,
  owner: ViewSettlementOwner,
  attempt: ViewRecordAttemptState,
  seal: ViewGraphSealState | undefined,
  state: FrameSubmitState,
): ViewSubmitWork {
  const preparation = attempt.preparation;
  if (preparation?.kind === 'failed') {
    if (!preparation.reported) state.failures.push(preparation.cause);
    return { kind: 'rejected' };
  }
  if (preparation?.kind === 'rejected' || preparation === undefined) return { kind: 'rejected' };
  if (preparation.kind === 'held') return { kind: 'held' };
  if (preparation.kind === 'pending' || seal?.encoding?.kind === 'pending')
    return { kind: 'ready', work: pendingViewWork(owner, attempt) };
  if (seal?.frame === renderSubmission(world).frame && seal.encoding?.kind === 'encoded') {
    const encoded = seal.encoding.value;
    return {
      kind: 'ready',
      work: encoded.kind === 'capture' ? encoded.work : encoded.encoded.work,
    };
  }
  if (seal?.encoding?.kind === 'failed') state.failures.push(seal.encoding.cause);
  else if (seal?.outcome?.kind === 'failed') state.failures.push(seal.outcome.error);
  return { kind: 'rejected' };
}

/** Shared kernel for the Record system and explicit low-level submission fixtures. */
export function encodeFramePresentation(
  world: World,
  input: RenderRecordInputState,
  encoder: RhiCommandEncoder,
  sceneOutputEncoded: boolean,
): void {
  let session: RecorderSession | undefined;
  try {
    session = input.rendererInternals?.profiler?.activeSession();
  } catch {}
  profiled(session, 'submission/presentation', () =>
    encodeSurfaceUi(world, input.rendererInternals, input.frameId, encoder, sceneOutputEncoded),
  );
}

/** A preparation barrier has not initialized the surface behind its UI. */
function hasEncodedSurfaceView(world: World, frame: number): boolean {
  for (const view of viewComposition(world).recorded) {
    if (view.target !== undefined) continue;
    const slot = readViewField(world, view.entity, ViewGraphSeal, 'state');
    if (slot === undefined) continue;
    const seal = world.resolveUniqueRef<ViewGraphSealState>(slot).unwrap();
    if (
      seal.frame === frame &&
      seal.encoding?.kind === 'encoded' &&
      seal.encoding.value.kind === 'display'
    )
      return true;
  }
  return false;
}

/** All required presentation products must exist before the physical submit owner runs. */
function frameOutputsReady(
  world: World,
  input: RenderRecordInputState,
  state: FrameSubmitState,
): boolean {
  if (state.composite === 'pending') return true;
  if (input.composite === true && state.composite !== 'encoded') return false;
  const ui = surfaceUi(world);
  return ui === undefined || ui.encodedFrame === input.frameId;
}

export function registerFrameSubmitSystems(world: World): void {
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_COMPOSITE_ENCODE_SYSTEM,
      after: [RENDER_VIEW_GRAPH_ENCODE_SYSTEM],
      queries: [{ read: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        const state = frameSubmitOutcome(world);
        if (!world.hasResource(RenderRecordInput)) return;
        const input = world.getResource<RenderRecordInputState>(RenderRecordInput);
        if (input.composite !== true) return;
        const frame = renderSubmission(world).frame;
        for (const row of rows) {
          const seal = world
            .resolveUniqueRef<ViewGraphSealState>(
              requireViewField(world, row.entity, ViewGraphSeal, 'state'),
            )
            .unwrap();
          if (seal.frame === frame && seal.encoding?.kind === 'pending') {
            state.composite = 'pending';
            return;
          }
        }
        const encoder = renderFrameEncoder(world);
        if (encoder.kind !== 'open') {
          state.composite = 'rejected';
          return;
        }
        try {
          state.composite = encodeComposite(world, input, encoder.encoder) ? 'encoded' : 'rejected';
        } catch (cause) {
          state.composite = 'rejected';
          state.failures.push(cause);
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_SURFACE_UI_ENCODE_SYSTEM,
      after: [RENDER_COMPOSITE_ENCODE_SYSTEM],
      queries: [],
      fn: (world) => {
        if (!world.hasResource(RenderRecordInput)) return;
        const input = world.getResource<RenderRecordInputState>(RenderRecordInput);
        const encoder = renderFrameEncoder(world);
        if (encoder.kind !== 'open') return;
        const state = frameSubmitOutcome(world);
        if (state.composite === 'pending') return;
        try {
          const sceneOutputEncoded =
            state.composite === 'encoded' ||
            (renderSubmission(world).open && hasEncodedSurfaceView(world, input.frameId));
          encodeFramePresentation(world, input, encoder.encoder, sceneOutputEncoded);
        } catch (cause) {
          state.failures.push(cause);
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: RENDER_FRAME_SUBMIT_SYSTEM,
      after: [RENDER_SURFACE_UI_ENCODE_SYSTEM],
      queries: [{ read: [ViewRecordAttempt, ViewFrame, ViewRecorder], optional: [ViewGraphSeal] }],
      fn: (world, [rows]) => {
        if (!world.hasResource(RenderRecordInput)) return;
        const input = world.getResource<RenderRecordInputState>(RenderRecordInput);
        // Bare graph fixtures do not stage a renderer submission. They own their explicit harness.
        if (input.rendererInternals === undefined) return;
        const state = frameSubmitOutcome(world);
        if (!frameOutputsReady(world, input, state)) return;
        // Presentation-only frames do not open a scene frame. Retained view attempts
        // belong to the previous scene frame and cannot participate in this submit.
        if (!renderSubmission(world).open) {
          submitEncodedFrame(world, input, [], state);
          return;
        }
        const works: RecordedView[] = [];
        const frame = renderSubmission(world).frame;

        for (const row of rows) {
          const entity = row.entity;

          const attempt = world
            .resolveUniqueRef<ViewRecordAttemptState>(
              requireViewField(world, entity, ViewRecordAttempt, 'state'),
            )
            .unwrap();
          const staged = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (staged.frame !== frame) continue;
          if (attempt.frame !== frame) return;
          const slot = readViewField(world, entity, ViewGraphSeal, 'state');
          const seal =
            slot === undefined
              ? undefined
              : world.resolveUniqueRef<ViewGraphSealState>(slot).unwrap();
          const selected = selectViewWork(
            world,
            ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state')),
            attempt,
            seal,
            state,
          );
          if (selected.kind === 'rejected') return;
          if (selected.kind === 'ready') works.push(selected.work);
        }
        submitEncodedFrame(world, input, works, state);
      },
    })
    .unwrap();
  world
    .addSystem(RenderRecord, {
      commands: 'none',
      name: 'render-frame-submit-report',
      after: ['render-view-record-settle'],
      queries: [],
      fn: (world) => {
        if (!world.hasResource(RenderRecordInput)) return;
        const input = world.getResource<RenderRecordInputState>(RenderRecordInput);
        const encoder = renderFrameEncoder(world);
        // Per-view settlement discarded candidate outputs before any error observer inspects them.
        if (encoder.kind === 'failed') input.rendererInternals?.errorRegistry.fire(encoder.error);
      },
    })
    .unwrap();
}
