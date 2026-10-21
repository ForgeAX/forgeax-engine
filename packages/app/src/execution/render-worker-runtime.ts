import {
  type FrameReceipt,
  type GpuPassTimingObservation,
  querySubmittedTerrainHeight,
  type Renderer,
  type RendererOperationError,
  type RenderFeature,
  type RenderPublication,
  type RenderPublicationIdentity,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { createFullscreenRenderFeature } from '@forgeax/engine-render/authoring';
import { fullscreenRenderFeatureDeclaration } from '@forgeax/engine-render/internal';
import { createRhiDebugError, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import {
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
  type RhiRemoteCaptureCompletion,
} from '../internal/rhi-capture';
import { attachWorkerRhiRecorder } from '../internal/worker-rhi-capture';
import { prepareBootstrapEntry } from './bootstrap-entry';
import { emitExecutionDiagnostic, executionDiagnosticSink } from './diagnostic-events';
import type { SerializedRenderError } from './protocol';
import { ownReceivedPublicationMaterials } from './received-publication-materials';
import { RenderMeshResidency } from './render-mesh-residency';
import type {
  CompletedMeshConsumption,
  RenderWorkerInput,
  RenderWorkerOutput,
} from './render-worker-protocol';
import { createRenderWorkerTaskTurns, yieldRenderWorkerTaskTurn } from './render-worker-task-turn';
import { readRendererInspection, rendererInspectionFailure } from './renderer-inspection';
import { applyRendererOrderDiagnostic } from './renderer-order-diagnostic';
import type { ExecutionDiagnosticsOptions } from './types';
import { serializableDetail, workerError } from './worker-error';

const scope = globalThis as unknown as {
  postMessage(message: RenderWorkerOutput, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<RenderWorkerInput>) => void) | null;
  close(): void;
};
let renderer: Renderer | undefined;
let meshResidency: RenderMeshResidency | undefined;
let publicationIdentity: RenderPublicationIdentity | undefined;
let inspectionWorldIdentity: string | undefined;
let unsubscribeRenderer: (() => void) | undefined;
let readyAnnounced = false;
let canvas: OffscreenCanvas | undefined;
let geometryLane: ExecutionDiagnosticsOptions['geometryLane'];
let busy = false;
// Includes CPU preparation, queued successors, and unretired GPU receipts.
// Host, Source publisher and this receiver share the same finite capacity.
let framesInFlight = 0;
// This is phase information for those credits, not another queue.
let unretiredReceipts = 0;
let renderTaskYield: ExecutionDiagnosticsOptions['renderTaskYield'] = 'none';
let renderPipelineCapacity: 2 | 3 | 4 = 2;
const featureTaskTurns = createRenderWorkerTaskTurns();
let activePreparationAbort: AbortController | undefined;
let failed = false;
let shuttingDown = false;
let initializing: Promise<void> | undefined;
let completing: Promise<void> = Promise.resolve();
let attachment: RecorderAttachment | undefined;
let capture: RhiCapture | undefined;
let captureBoundary: ReturnType<RecorderAttachment['frameBoundary']> | undefined;
interface CaptureDrawTransaction {
  readonly recordingGenerations: number[];
}
interface WorkerCaptureRequest {
  readonly controller: AbortController;
  readonly frame: Promise<RhiRemoteCaptureCompletion>;
  readonly resolveFrame: (frame: RhiRemoteCaptureCompletion) => void;
  captureGeneration: number | undefined;
  draw: CaptureDrawTransaction | undefined;
  boundaryCount: number;
  settled: boolean;
}
let activeCaptureDraw: CaptureDrawTransaction | undefined;
let gpuPassTimingEnabled = false;
const terrainReceipts = new Map<number, FrameReceipt>();
const captureRequests = new Map<number, WorkerCaptureRequest>();
let synchronizeFeatures: (features: RenderPublication['features']) => Promise<void> =
  async () => {};
type DrawMessage = Extract<RenderWorkerInput, { kind: 'draw' }>;
let geometryRequest:
  | (Extract<RenderWorkerInput, { kind: 'geometry-observe-next' }> & {
      cancelled: boolean;
      started: boolean;
    })
  | undefined;

function closeVideoFrames(message: DrawMessage): void {
  for (const row of message.publication.videoFrames) row.frame.close();
  for (const row of message.publication.canvasFrames ?? []) row.frame?.close();
}

function unavailableCaptureFrame(
  reason: Extract<RhiRemoteCaptureCompletion, { status: 'unavailable' }>['reason'],
): RhiRemoteCaptureCompletion {
  return { status: 'unavailable', reason };
}

function settleCaptureRequest(
  request: WorkerCaptureRequest,
  frame: RhiRemoteCaptureCompletion,
): void {
  if (request.settled) return;
  request.settled = true;
  request.resolveFrame(frame);
}

function invalidateCaptureRequests(): void {
  for (const request of captureRequests.values()) {
    request.controller.abort();
    settleCaptureRequest(request, unavailableCaptureFrame('capture-invalidated'));
  }
}

function captureTimingForReceipt(
  timingResult: Awaited<ReturnType<Renderer['observe']>> | undefined,
): GpuPassTimingObservation | undefined {
  const timing = timingResult?.ok === true ? timingResult.value.timings : undefined;
  if (timing?.status !== 'failed') return timing;
  // A failed observation may carry latestKnownGood from an older receipt.
  // Preserve the failure and its reason without transporting that stale frame.
  return { status: 'failed', error: timing.error };
}

function settleCaptureDraw(
  draw: CaptureDrawTransaction | undefined,
  receipt: FrameReceipt,
  timingResult: Awaited<ReturnType<Renderer['observe']>> | undefined,
): void {
  if (draw === undefined) return;
  for (const request of captureRequests.values()) {
    if (request.settled || request.draw !== draw) continue;
    const captureGeneration = request.captureGeneration;
    if (
      request.controller.signal.aborted ||
      captureGeneration === undefined ||
      attachment?.captureGeneration !== captureGeneration
    ) {
      settleCaptureRequest(request, unavailableCaptureFrame('capture-invalidated'));
      continue;
    }
    if (request.boundaryCount !== 1) {
      settleCaptureRequest(request, unavailableCaptureFrame('multiple-submits'));
      continue;
    }
    if (
      draw.recordingGenerations.filter((generation) => generation === captureGeneration).length !==
      1
    ) {
      settleCaptureRequest(request, unavailableCaptureFrame('multiple-submits'));
      continue;
    }
    const gpuPassTiming = captureTimingForReceipt(timingResult);
    settleCaptureRequest(request, {
      status: 'remote-complete',
      receipt: {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: receipt.graphGeneration }),
      },
      captureGeneration,
      ...(gpuPassTiming === undefined ? {} : { gpuPassTiming }),
    });
  }
}

function failCaptureDraw(draw: CaptureDrawTransaction | undefined): void {
  if (draw === undefined) return;
  for (const request of captureRequests.values()) {
    if (request.settled || request.draw !== draw) continue;
    settleCaptureRequest(
      request,
      unavailableCaptureFrame(
        request.controller.signal.aborted ||
          request.captureGeneration === undefined ||
          attachment?.captureGeneration !== request.captureGeneration
          ? 'capture-invalidated'
          : 'submit-failed',
      ),
    );
  }
}

function trackRecordingBoundary(captureGeneration: number): void {
  const draw = activeCaptureDraw;
  draw?.recordingGenerations.push(captureGeneration);
  for (const request of captureRequests.values()) {
    if (request.settled || request.captureGeneration !== captureGeneration) continue;
    if (request.controller.signal.aborted) {
      settleCaptureRequest(request, unavailableCaptureFrame('capture-invalidated'));
      continue;
    }
    request.boundaryCount += 1;
    if (request.boundaryCount > 1) {
      settleCaptureRequest(request, unavailableCaptureFrame('multiple-submits'));
      continue;
    }
    if (draw === undefined) {
      settleCaptureRequest(request, unavailableCaptureFrame('frame-unavailable'));
      continue;
    }
    request.draw = draw;
  }
}

function inspectRendererDiagnostics():
  | Extract<RenderWorkerOutput, { kind: 'failed' }>['renderer']
  | undefined {
  if (renderer === undefined) return undefined;
  try {
    const inspection = renderer.inspect();
    return {
      state: inspection.state,
      frameId: inspection.frame.frameId,
      capabilities: {
        backendKind: inspection.capabilities.backendKind,
        compute: inspection.capabilities.compute,
        storageBuffer: inspection.capabilities.storageBuffer,
      },
      ...(inspection.limits === undefined ? {} : { limits: inspection.limits }),
    };
  } catch (cause) {
    return {
      inspectionError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function fail(message: RenderWorkerInput, cause: unknown): void {
  if (failed) return;
  failed = true;
  activePreparationAbort?.abort();
  invalidateCaptureRequests();
  terrainReceipts.clear();
  const rendererFacts = inspectRendererDiagnostics();
  const operationError = cause as
    | RendererOperationError<'device-operation-failed'>
    | RendererOperationError<'frame-submit-rejected'>
    | undefined;
  scope.postMessage({
    kind: 'failed',
    error: workerError(cause),
    ...(rendererFacts === undefined ? {} : { renderer: rendererFacts }),
    stage: message.kind,
    ...(message.kind === 'draw'
      ? {
          publication: {
            source: message.publication.source,
            epoch: message.publication.epoch,
            revision: message.publication.revision,
            frameId: message.frameId,
          },
        }
      : {}),
    // Native destroy can fence a receipt before renderer health changes.
    recoverable:
      (operationError?.code === 'frame-submit-rejected' &&
        operationError.detail?.accepted === false) ||
      renderer?.state() === 'device-lost' ||
      (operationError?.code === 'device-operation-failed' &&
        operationError.detail?.operation === 'complete-frame' &&
        ['device-lost', 'disposed', 'stale-generation'].some(
          (code) => code === operationError.detail.cause?.code,
        )),
  });
}

function traceCompletion(
  event: 'render-own-composite-continuation' | 'render-previous-prefix-passed',
  message: DrawMessage,
  receipt: FrameReceipt,
): void {
  const sink = executionDiagnosticSink();
  if (sink === undefined) return;
  emitExecutionDiagnostic(sink, {
    event,
    worldIdentity: message.worldIdentity,
    frameId: message.frameId,
    deviceGeneration: receipt.deviceGeneration,
    source: message.publication.source,
    epoch: message.publication.epoch,
    revision: message.publication.revision,
  });
}

async function completeFrame(
  message: DrawMessage,
  frameRenderer: Renderer,
  receipt: FrameReceipt,
  previous: Promise<void>,
  snapshotBoundary?: Promise<unknown>,
  meshConsumption?: CompletedMeshConsumption,
  captureDraw?: CaptureDrawTransaction,
): Promise<void> {
  try {
    // Observe this receipt immediately, before the next draw changes frame state.
    const observedTiming = gpuPassTimingEnabled
      ? frameRenderer.observe(receipt, { include: ['timings'] })
      : undefined;
    const completion = receipt.completed.then((result) => {
      if (!result.ok) {
        // Preserve the target receipt failure before worker teardown invalidates
        // any other capture requests.
        failCaptureDraw(captureDraw);
        throw result.error;
      }
    });
    const [, timingResult] = await Promise.all([completion, observedTiming, snapshotBoundary]);
    settleCaptureDraw(captureDraw, receipt, timingResult);
    traceCompletion('render-own-composite-continuation', message, receipt);
    // Composite receipts/readbacks can finish out of order. The publisher and
    // Host advance only the contiguous completed prefix, never a newer frame.
    await previous;
    traceCompletion('render-previous-prefix-passed', message, receipt);
    if (failed) return;
    const gpuPassTiming = timingResult?.ok === true ? timingResult.value.timings : undefined;
    const buffers = renderPublicationTransfers(message.publication);
    scope.postMessage(
      {
        kind: 'completed',
        revision: message.publication.revision,
        buffers,
        ...(gpuPassTiming === undefined ? {} : { gpuPassTiming }),
        ...(meshConsumption === undefined ? {} : { meshConsumption }),
        frame: {
          kind: 'frame-complete',
          worldIdentity: message.worldIdentity,
          frameId: message.frameId,
          deviceGeneration: receipt.deviceGeneration,
          ...(receipt.shadowWorkload === undefined
            ? {}
            : { shadowWorkload: receipt.shadowWorkload }),
          ...(receipt.graphGeneration === undefined
            ? {}
            : { graphGeneration: receipt.graphGeneration }),
          ...(receipt.barrelDistortion === undefined
            ? {}
            : { barrelDistortion: receipt.barrelDistortion }),
          presentation: receipt.presentation,
          ...(receipt.presentation !== 'pending' || receipt.presentationPendingReason === undefined
            ? {}
            : { presentationPendingReason: receipt.presentationPendingReason }),
          engineUpdateMs: 0,
          kernelWaitMs: 0,
        },
      },
      meshConsumption?.bindings.buffer instanceof ArrayBuffer
        ? [...buffers, meshConsumption.bindings.buffer]
        : buffers,
    );
  } catch (cause) {
    // A failed successor must stop admission even while an older receipt waits.
    fail(message, cause);
  } finally {
    // Observation failure cannot let disposal outrun this frame or its predecessor.
    await Promise.allSettled([previous, receipt.completed]);
    closeVideoFrames(message);
    unretiredReceipts--;
    framesInFlight--;
  }
}

async function receive(message: RenderWorkerInput): Promise<void> {
  if (message.kind === 'geometry-observe-cancel') {
    if (geometryRequest?.requestId === message.requestId) {
      geometryRequest.cancelled = true;
      if (!geometryRequest.started) geometryRequest = undefined;
    }
    return;
  }
  if (message.kind === 'geometry-observe-next') {
    if (
      geometryRequest !== undefined ||
      renderer === undefined ||
      publicationIdentity?.source !== message.identity.source ||
      publicationIdentity.epoch !== message.identity.epoch ||
      inspectionWorldIdentity !== message.worldIdentity
    ) {
      scope.postMessage({
        kind: 'geometry-observation-result',
        requestId: message.requestId,
        identity: message.identity,
        worldIdentity: message.worldIdentity,
        result: rendererInspectionFailure(
          geometryRequest === undefined ? 'not-ready' : 'request-limit',
        ),
      });
    } else geometryRequest = { ...message, cancelled: false, started: false };
    return;
  }
  if (message.kind === 'dispose') {
    terrainReceipts.clear();
    shuttingDown = true;
    activePreparationAbort?.abort();
    invalidateCaptureRequests();
    try {
      await initializing;
      await drawing;
      await completing;
      let cleanupFailure: unknown;
      try {
        await meshResidency?.dispose();
      } catch (cause) {
        cleanupFailure = cause;
      }
      try {
        const disposed = await renderer?.dispose();
        if (disposed?.ok === false) throw disposed.error;
      } catch (cause) {
        cleanupFailure ??= cause;
      }
      try {
        await attachment?.dispose();
      } catch (cause) {
        cleanupFailure ??= cause;
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
      scope.postMessage({ kind: 'disposed' });
    } catch (cause) {
      scope.postMessage({ kind: 'disposed', error: serializableDetail(cause) });
    } finally {
      unsubscribeRenderer?.();
      unsubscribeRenderer = undefined;
      featureTaskTurns.dispose();
      scope.close();
    }
    return;
  }
  if (message.kind === 'mesh-prepare' || message.kind === 'mesh-release') {
    try {
      await initializing;
      // A suspended recording owns its extracted mesh/binding references.
      // Keep resource controls behind that same serial draw drain.
      if (renderTaskYield === 'features') await drawing;
      if (failed || shuttingDown) return;
      if (meshResidency === undefined) throw new Error('Render mesh receiver is not ready');
      await meshResidency.receive(message);
    } catch (cause) {
      fail(message, cause);
    }
    return;
  }
  if (message.kind === 'inspect') {
    const current = publicationIdentity;
    const matched =
      current !== undefined &&
      current.source === message.identity.source &&
      current.epoch === message.identity.epoch &&
      inspectionWorldIdentity === message.worldIdentity;
    const result = !matched
      ? rendererInspectionFailure('stale-session')
      : failed || shuttingDown || !readyAnnounced
        ? rendererInspectionFailure('not-ready')
        : readRendererInspection(renderer, undefined, message);
    try {
      scope.postMessage({
        kind: 'inspect-result',
        requestId: message.requestId,
        identity: message.identity,
        worldIdentity: message.worldIdentity,
        result,
      });
    } catch (cause) {
      // One failure delivery; observation cannot change draw admission.
      try {
        scope.postMessage({
          kind: 'inspect-result',
          requestId: message.requestId,
          identity: message.identity,
          worldIdentity: message.worldIdentity,
          result: rendererInspectionFailure('transport', cause),
        });
      } catch {
        // No delivery is possible; caller still fails at its unchanged read deadline.
        console.error('Renderer inspection failure response was not delivered');
      }
    }
    return;
  }
  if (failed || shuttingDown) {
    if (message.kind === 'draw') {
      closeVideoFrames(message);
      framesInFlight--;
    }
    return;
  }
  let completionOwnsFrame = false;
  try {
    if (message.kind === 'terrain-height') {
      const receipt = terrainReceipts.get(message.frameId);
      const result =
        receipt === undefined
          ? {
              ok: false as const,
              error: {
                code: 'terrain-query-unavailable' as const,
                expected: 'a retained exact submitted frame from this Worker generation',
                hint: 'query a recent frame in the current Render Worker session',
                detail: { field: 'frameId', actual: message.frameId },
              },
            }
          : await querySubmittedTerrainHeight(receipt, message.request);
      scope.postMessage({ kind: 'terrain-height-result', requestId: message.requestId, result });
      return;
    }
    if (message.kind === 'bounds') {
      scope.postMessage({
        kind: 'bounds-result',
        requestId: message.requestId,
        bounds:
          publicationIdentity === undefined
            ? undefined
            : renderer?.bounds(publicationIdentity, message.entity),
      });
      return;
    }
    if (message.kind === 'capture-cancel') {
      const request = captureRequests.get(message.requestId);
      if (request !== undefined) {
        request.controller.abort();
        settleCaptureRequest(request, unavailableCaptureFrame('capture-invalidated'));
      }
      return;
    }
    if (message.kind === 'capture') {
      if (capture === undefined) {
        scope.postMessage({
          kind: 'capture-result',
          requestId: message.requestId,
          result: {
            ok: false,
            error: createRhiDebugError('capture-unavailable', {
              stage: 'capture',
              cause: 'Render Worker recorder is disabled',
            }),
          },
        });
        return;
      }
      const controller = new AbortController();
      let resolveFrame!: (frame: RhiRemoteCaptureCompletion) => void;
      const request: WorkerCaptureRequest = {
        controller,
        frame: new Promise((resolve) => {
          resolveFrame = resolve;
        }),
        resolveFrame: (frame) => resolveFrame(frame),
        captureGeneration: undefined,
        draw: undefined,
        boundaryCount: 0,
        settled: false,
      };
      captureRequests.set(message.requestId, request);
      const previousGeneration = attachment?.captureGeneration;
      const captureResult = capture.captureFrame({ ...message.options, signal: controller.signal });
      const currentGeneration = attachment?.captureGeneration;
      request.captureGeneration =
        currentGeneration !== undefined && currentGeneration !== previousGeneration
          ? currentGeneration
          : undefined;
      const result = await captureResult;
      if (!result.ok) {
        captureRequests.delete(message.requestId);
        scope.postMessage({
          kind: 'capture-result',
          requestId: message.requestId,
          result: { ok: false, error: result.error },
        });
        return;
      }
      if (request.boundaryCount === 0)
        settleCaptureRequest(request, unavailableCaptureFrame('frame-unavailable'));
      const submittedFrame = await request.frame;
      captureRequests.delete(message.requestId);
      const bytes = transferable(result.value.bytes);
      scope.postMessage(
        {
          kind: 'capture-result',
          requestId: message.requestId,
          result: { ok: true, value: { kind: 'rhi-tape', bytes, submittedFrame } },
        },
        [bytes.buffer],
      );
      return;
    }
    if (message.kind === 'init') {
      if (renderer !== undefined || busy) throw new Error('Duplicate Render Worker initialization');
      busy = true;
      canvas = message.canvas;
      geometryLane = message.geometryLane;
      renderTaskYield = message.renderTaskYield ?? 'none';
      renderPipelineCapacity =
        message.renderPipelineCapacity === 4 ? 4 : message.renderPipelineCapacity === 3 ? 3 : 2;
      gpuPassTimingEnabled = message.gpuPassTiming !== undefined;
      const prepared = await prepareBootstrapEntry(message.bootstrapUrl, message.bootstrapData);
      if (!prepared.ok) throw prepared.error;
      if (message.rhiCapture === true) {
        attachment = await attachWorkerRhiRecorder();
        capture = createRhiCapture(attachment);
      }
      const constructed = await constructRuntimeRendererHost(
        canvas,
        {
          ...(attachment === undefined
            ? {}
            : {
                rhi: attachment.backend.rhi,
                rhiInstrumentation: {
                  ...createRhiInstrumentation(attachment),
                  onFrameBoundary: () => {
                    const recorder = attachment;
                    if (recorder === undefined) return;
                    const captureGeneration = recorder.captureGeneration;
                    if (recorder.isRecordingCapture(captureGeneration))
                      trackRecordingBoundary(captureGeneration);
                    captureBoundary = recorder.frameBoundary();
                  },
                },
              }),
          publicationSource: message.identity,
          ...(message.shadowWorkload === true ? { shadowWorkload: true } : {}),
          ...(message.gpuPassTiming === undefined ? {} : { gpuPassTiming: message.gpuPassTiming }),
          ...(message.pipelineLibrary === undefined
            ? {}
            : { pipelineLibrary: message.pipelineLibrary }),
          ...(message.outputColorSpace === undefined
            ? {}
            : { outputColorSpace: message.outputColorSpace }),
          ...(message.dynamicGeometryMeshBudgetBytes === undefined
            ? {}
            : { dynamicGeometryMeshBudgetBytes: message.dynamicGeometryMeshBudgetBytes }),
          ...(prepared.value.features === undefined ? {} : { features: prepared.value.features }),
          ...(prepared.value.ssrIdentity === undefined
            ? {}
            : { ssrIdentity: prepared.value.ssrIdentity }),
        },
        {
          ...(message.shaderManifestUrl === undefined
            ? {}
            : { shaderManifestUrl: message.shaderManifestUrl }),
          ...(message.build === undefined ? {} : { build: message.build }),
        },
      );
      if (!constructed.ok) throw constructed.error;
      renderer = constructed.value.renderer;
      publicationIdentity = message.identity;
      meshResidency = new RenderMeshResidency(renderer, message.identity, (message) =>
        scope.postMessage(message),
      );
      inspectionWorldIdentity = message.worldIdentity;
      unsubscribeRenderer = renderer.subscribe((event) => {
        if (event.kind !== 'error' || shuttingDown || failed) return;
        let error: SerializedRenderError | undefined;
        let detailSerialized = false;
        try {
          error = {
            code: event.error.code,
            expected: event.error.expected,
            hint: event.error.hint,
            detail: undefined,
          };
          error = {
            ...error,
            detail: 'detail' in event.error ? serializableDetail(event.error.detail) : undefined,
          };
          detailSerialized = true;
          const detail = error.detail;
          const deviceLostLifecycle =
            readyAnnounced &&
            error.code === 'device-operation-failed' &&
            typeof detail === 'object' &&
            detail !== null &&
            'operation' in detail &&
            detail.operation === 'renderer-event' &&
            'cause' in detail &&
            typeof detail.cause === 'object' &&
            detail.cause !== null &&
            'code' in detail.cause &&
            detail.cause.code === 'device-lost' &&
            renderer?.state() === 'device-lost';
          if (!readyAnnounced || deviceLostLifecycle) {
            fail(message, error);
            return;
          }
          const rendererFacts = inspectRendererDiagnostics();
          scope.postMessage({
            kind: 'renderer-error',
            identity: message.identity,
            error,
            ...(rendererFacts === undefined ? {} : { renderer: rendererFacts }),
          });
        } catch (cause) {
          const bridgeError = {
            code: 'render-error-forwarding-failed',
            expected: 'Render Worker delivers the public Renderer error',
            hint: 'inspect the error transport cause',
            detail: { rendererError: error, detailSerialized, cause: workerError(cause) },
          };
          if (!failed) {
            fail(message, bridgeError);
            return;
          }
          // Initialization fail() latched before its first post threw.
          // Attempt the terminal bridge message once, without resetting admission.
          scope.postMessage({
            kind: 'failed',
            error: bridgeError,
            stage: message.kind,
            recoverable: false,
          });
        }
      });
      await prepared.value.configureRenderer?.(renderer);
      applyRendererOrderDiagnostic(
        renderer,
        message.gbufferBatchOrderDiagnostic,
        message.featureReadOnlyDepthBatchDiagnostic,
      );
      if (failed || shuttingDown) return;
      const declared = new Map<string, RenderFeature<unknown>>(
        (prepared.value.features ?? []).map((feature) => [feature.identity, feature]),
      );
      const active = new Set(declared.keys());
      synchronizeFeatures = async (rows) => {
        const identities = new Set(rows.map((row) => row.identity));
        for (const row of rows) {
          if (row.fullscreen === undefined) continue;
          if (row.fullscreen.identity !== row.identity)
            throw new Error('Conflicting published fullscreen RenderFeature identity');
          const previous = declared.get(row.identity);
          if (previous !== undefined) {
            const declaration = fullscreenRenderFeatureDeclaration(previous);
            if (declaration === undefined)
              throw new Error('Conflicting published fullscreen RenderFeature declaration');
            if (JSON.stringify(declaration) === JSON.stringify(row.fullscreen)) continue;
            if (active.has(row.identity)) {
              const removed = await constructed.value.featureHost.uninstallRenderFeature(previous);
              if (!removed.ok) throw removed.error;
              active.delete(row.identity);
            }
          }
          declared.set(row.identity, createFullscreenRenderFeature(row.fullscreen));
        }
        for (const feature of declared.values()) {
          if (identities.has(feature.identity) === active.has(feature.identity)) continue;
          const result = identities.has(feature.identity)
            ? await constructed.value.featureHost.installRenderFeature(feature)
            : await constructed.value.featureHost.uninstallRenderFeature(feature);
          if (!result.ok) throw result.error;
          if (identities.has(feature.identity)) active.add(feature.identity);
          else active.delete(feature.identity);
        }
      };
      busy = false;
      const inspection = renderer.inspect();
      if (failed || shuttingDown) return;
      scope.postMessage({
        kind: 'ready',
        deviceGeneration: inspection.frame.deviceGeneration,
        capabilities: inspection.capabilities,
        ...(inspection.limits === undefined ? {} : { limits: inspection.limits }),
      });
      readyAnnounced = true;
      return;
    }
    if (renderer === undefined || canvas === undefined || busy)
      throw new Error('Render Worker has no publication credit');
    busy = true;
    if (message.width > 0 && message.height > 0) {
      if (canvas.width !== message.width) canvas.width = message.width;
      if (canvas.height !== message.height) canvas.height = message.height;
    }
    await synchronizeFeatures(message.publication.features);
    if (failed || shuttingDown) return;
    // Keep this draw in the same serial drain and retain its publication
    // credit. A real older receipt may complete during this single task turn,
    // letting its existing completion/ACK wake the Engine Worker before the
    // next synchronous Renderer.draw task occupies this Worker. Never wait for
    // that receipt: an unfinished GPU must not serialize CPU preparation.
    if (renderTaskYield === 'completion' && unretiredReceipts > 0) {
      await yieldRenderWorkerTaskTurn();
      if (failed || shuttingDown) return;
    }
    const features: { identity: string; feedback: unknown }[] = [];
    const geometry = geometryRequest;
    if (geometry?.cancelled) geometryRequest = undefined;
    else if (geometry !== undefined) geometry.started = true;
    const geometrySourceMatches =
      geometry !== undefined &&
      message.worldIdentity === geometry.worldIdentity &&
      message.worldIdentity === inspectionWorldIdentity;
    const input: import('@forgeax/engine-render').PublishedRenderFrameInput = {
      publication: ownReceivedPublicationMaterials(message.publication),
      ...(geometry !== undefined && !geometry.cancelled && geometrySourceMatches
        ? {
            geometryObservation: true as const,
            geometryObservationSourceWorldIdentity: message.worldIdentity,
          }
        : {}),
      ...(geometryLane === undefined ? {} : { geometryLane }),
      onFeatureSourceSubmitted: (identity, feedback) => features.push({ identity, feedback }),
    };
    let draw: ReturnType<Renderer['draw']>;
    const captureDraw = attachment === undefined ? undefined : { recordingGenerations: [] };
    const previousCaptureDraw = activeCaptureDraw;
    activeCaptureDraw = captureDraw;
    try {
      if (renderTaskYield === 'features') {
        if (renderer.drawScheduled === undefined)
          throw new Error('Renderer has no cooperative preparation entry');
        const abort = new AbortController();
        activePreparationAbort = abort;
        try {
          draw = await renderer.drawScheduled(input, {
            signal: abort.signal,
            isCurrent: () => !failed && !shuttingDown,
            checkpoint: () =>
              unretiredReceipts > 0 ? featureTaskTurns.yield() : Promise.resolve(),
          });
        } finally {
          if (activePreparationAbort === abort) activePreparationAbort = undefined;
        }
      } else draw = renderer.draw(input);
    } finally {
      if (activeCaptureDraw === captureDraw) activeCaptureDraw = previousCaptureDraw;
    }
    if (!draw.ok) {
      if (failed || shuttingDown) return;
      failCaptureDraw(captureDraw);
      throw draw.error;
    }
    const receipt = draw.value;
    const meshConsumption =
      Number.isSafeInteger(message.sourceFixedStep) && message.sourceFixedStep >= 0
        ? meshResidency?.consumed(receipt, message.sourceFixedStep)
        : undefined;
    terrainReceipts.set(message.frameId, receipt);
    while (terrainReceipts.size > 8) {
      const oldest = terrainReceipts.keys().next().value;
      if (oldest === undefined) break;
      terrainReceipts.delete(oldest);
    }
    const snapshotBoundary = captureBoundary;
    captureBoundary = undefined;
    completionOwnsFrame = true;
    unretiredReceipts++;
    completing = completeFrame(
      message,
      renderer,
      receipt,
      completing,
      snapshotBoundary,
      meshConsumption,
      captureDraw,
    );
    if (failed) return;
    scope.postMessage({
      kind: 'submitted',
      revision: message.publication.revision,
      features,
      frame: {
        kind: 'frame-submitted',
        worldIdentity: message.worldIdentity,
        frameId: message.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.shadowWorkload === undefined ? {} : { shadowWorkload: receipt.shadowWorkload }),
        ...(receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: receipt.graphGeneration }),
        ...(receipt.barrelDistortion === undefined
          ? {}
          : { barrelDistortion: receipt.barrelDistortion }),
      },
    });
    // Keep the source's submitted-before-completed order and existing credits,
    // while freezing GPU resources until the frame-header snapshot is complete.
    if (snapshotBoundary !== undefined) await snapshotBoundary;
    if (geometry !== undefined && !geometry.cancelled) {
      // Intrusive one-shot observation holds only this diagnostic draw turn. Normal frames never wait.
      let result: import('./types').ExecutionGeometryObservationResult;
      try {
        const observed = geometrySourceMatches
          ? await renderer.observeGeometry?.(receipt)
          : undefined;
        result = !geometrySourceMatches
          ? rendererInspectionFailure('stale-session')
          : observed === undefined
            ? rendererInspectionFailure('inspection', 'geometry observation unsupported')
            : { ok: true, value: observed };
      } catch (error) {
        result = rendererInspectionFailure('inspection', error);
      }
      if (!geometry.cancelled)
        scope.postMessage({
          kind: 'geometry-observation-result',
          requestId: geometry.requestId,
          identity: geometry.identity,
          worldIdentity: geometry.worldIdentity,
          result,
        });
      if (geometryRequest === geometry) geometryRequest = undefined;
    }
  } catch (cause) {
    fail(message, cause);
  } finally {
    if (message.kind === 'draw') {
      busy = false;
      if (!completionOwnsFrame) {
        closeVideoFrames(message);
        framesInFlight--;
      }
    }
  }
}
let drawing: Promise<void> | undefined;
const queued: DrawMessage[] = [];
scope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === 'inspect') {
    void receive(message);
    return;
  }
  if (shuttingDown || failed) {
    if (message.kind === 'draw') closeVideoFrames(message);
    // Disposal still drains the failed worker's submitted GPU work.
    if (message.kind === 'dispose' && !shuttingDown) void receive(message);
    return;
  }
  if (message.kind === 'init') {
    initializing = receive(message);
    return;
  }
  if (message.kind !== 'draw') {
    void receive(message);
    return;
  }
  if (framesInFlight >= renderPipelineCapacity) {
    fail(message, new Error('Render Worker has no publication credit'));
    closeVideoFrames(message);
    return;
  }
  framesInFlight++;
  if (drawing !== undefined) {
    queued.push(message);
    return;
  }
  const drain = async (first: DrawMessage): Promise<void> => {
    await receive(first);
    while (queued.length > 0) {
      const next = queued.shift();
      if (next !== undefined) await receive(next);
    }
    drawing = undefined;
  };
  drawing = drain(message);
};

function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? (bytes as Uint8Array<ArrayBuffer>)
    : bytes.slice();
}
