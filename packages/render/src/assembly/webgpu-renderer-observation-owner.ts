import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-rhi';
import { type RenderError, RendererContractFailureError } from '../errors/render';
import type {
  FrameReceipt,
  RenderPipelineObservationCapture,
  RenderPipelineObservationCaptureOwner,
  RenderResult,
} from '../render-contract';
import { disposeObservationCaptureSet } from './webgpu-renderer-observation';

export type ObservationCaptureRead = () => Promise<
  RenderResult<
    readonly {
      readonly capture: RenderPipelineObservationCapture;
      readonly bytes: Uint8Array;
    }[],
    RenderError
  >
>;

export interface RendererObservationCaptureOwner {
  readonly observationCaptureOwner: RenderPipelineObservationCaptureOwner;
  readonly stats: {
    allocationCount: number;
    liveCount: number;
    peakLiveCount: number;
    mapCount: number;
    readbackCount: number;
    liveByteLength: number;
  };
  expectedGraphGeneration: number | undefined;
  readonly receiptObservationCaptures: Map<FrameReceipt, ObservationCaptureRead>;
  readonly receiptObservationBuffers: Map<
    FrameReceipt,
    readonly RenderPipelineObservationCapture[]
  >;
  readonly destroyedObservationBuffers: WeakSet<Buffer>;
  readonly observationBufferCleanupFailures: WeakMap<Buffer, RendererContractFailureError>;
  readonly failedObservationCaptures: Map<Buffer, RenderPipelineObservationCapture>;
  readonly disposeObservationCaptures: (
    captures: readonly RenderPipelineObservationCapture[],
  ) => RendererContractFailureError | undefined;
  readonly disposeOwnedObservationCaptures: (
    captures: readonly RenderPipelineObservationCapture[],
  ) => RendererContractFailureError | undefined;
  readonly readObservationCapture: (
    capture: RenderPipelineObservationCapture,
  ) => Promise<RenderResult<Uint8Array, RenderError>>;
  readonly disposeReceiptObservationCaptures: () => RendererContractFailureError | undefined;
}

export function createRendererObservationCaptureOwner(
  fireError: (error: RendererContractFailureError) => void,
): RendererObservationCaptureOwner {
  const stats = {
    allocationCount: 0,
    liveCount: 0,
    peakLiveCount: 0,
    mapCount: 0,
    readbackCount: 0,
    liveByteLength: 0,
  };
  const capturesByFrame = new Map<number, RenderPipelineObservationCapture[]>();
  const observationCaptureOwner = {
    register(capture: RenderPipelineObservationCapture): void {
      const captures = capturesByFrame.get(capture.frameNumber) ?? [];
      captures.push(capture);
      capturesByFrame.set(capture.frameNumber, captures);
      stats.allocationCount += 1;
      stats.liveCount += 1;
      stats.peakLiveCount = Math.max(stats.peakLiveCount, stats.liveCount);
      stats.liveByteLength += capture.bytesPerRow * capture.height;
    },
    consume(frameNumber: number): readonly RenderPipelineObservationCapture[] {
      const captures = capturesByFrame.get(frameNumber) ?? [];
      capturesByFrame.delete(frameNumber);
      return Object.freeze(captures);
    },
    drain(): readonly RenderPipelineObservationCapture[] {
      const captures = [...capturesByFrame.values()].flat();
      capturesByFrame.clear();
      return Object.freeze(captures);
    },
  };
  const destroyedObservationBuffers = new WeakSet<Buffer>();
  const observationBufferCleanupFailures = new WeakMap<Buffer, RendererContractFailureError>();
  const failedObservationCaptures = new Map<Buffer, RenderPipelineObservationCapture>();
  const disposeObservationCaptures = (
    captures: readonly RenderPipelineObservationCapture[],
  ): RendererContractFailureError | undefined => {
    const wasDestroyed = new Set(
      captures
        .filter((capture) => destroyedObservationBuffers.has(capture.buffer))
        .map((capture) => capture.buffer),
    );
    const result = disposeObservationCaptureSet(
      captures,
      destroyedObservationBuffers,
      observationBufferCleanupFailures,
      fireError,
    );
    for (const capture of captures) {
      if (!wasDestroyed.has(capture.buffer) && destroyedObservationBuffers.has(capture.buffer)) {
        stats.liveCount = Math.max(0, stats.liveCount - 1);
        stats.liveByteLength = Math.max(
          0,
          stats.liveByteLength - capture.bytesPerRow * capture.height,
        );
      }
    }
    return result;
  };
  const disposeOwnedObservationCaptures = (
    captures: readonly RenderPipelineObservationCapture[],
  ): RendererContractFailureError | undefined => {
    const failure = disposeObservationCaptures(captures);
    if (failure !== undefined) {
      for (const capture of captures) {
        if (!destroyedObservationBuffers.has(capture.buffer)) {
          failedObservationCaptures.set(capture.buffer, capture);
        }
      }
    }
    return failure;
  };
  const readObservationCapture = async (
    capture: RenderPipelineObservationCapture,
  ): Promise<RenderResult<Uint8Array, RenderError>> => {
    try {
      if (typeof capture.buffer.mapAsync !== 'function') {
        const cleanupFailure = disposeObservationCaptures([capture]);
        return err(
          cleanupFailure ??
            new RendererContractFailureError(
              'observe',
              `the ${capture.domain} receipt-bound readback backend has no mapAsync capability`,
            ),
        );
      }
      stats.mapCount += 1;
      const mapped = await capture.buffer.mapAsync(1);
      if (!mapped.ok) {
        const cleanupFailure = disposeObservationCaptures([capture]);
        return err(
          cleanupFailure ??
            new RendererContractFailureError(
              'observe',
              `mapping ${capture.domain} receipt-bound readback failed: ${mapped.error.code}`,
            ),
        );
      }
      const range = mapped.value.getMappedRange();
      if (!range.ok) {
        mapped.value.unmap();
        const cleanupFailure = disposeObservationCaptures([capture]);
        return err(
          cleanupFailure ??
            new RendererContractFailureError(
              'observe',
              `reading ${capture.domain} receipt-bound readback failed: ${range.error.code}`,
            ),
        );
      }
      const bytes = new Uint8Array(range.value.slice(0));
      mapped.value.unmap();
      stats.readbackCount += 1;
      const cleanupFailure = disposeObservationCaptures([capture]);
      if (cleanupFailure !== undefined) return err(cleanupFailure);
      return ok(bytes);
    } catch (cause) {
      const cleanupFailure = disposeObservationCaptures([capture]);
      return err(
        cleanupFailure ??
          new RendererContractFailureError(
            'observe',
            `reading ${capture.domain} receipt-bound readback threw: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          ),
      );
    }
  };
  const receiptObservationCaptures = new Map<FrameReceipt, ObservationCaptureRead>();
  const receiptObservationBuffers = new Map<
    FrameReceipt,
    readonly RenderPipelineObservationCapture[]
  >();
  const owner: RendererObservationCaptureOwner = {
    observationCaptureOwner,
    stats,
    expectedGraphGeneration: undefined,
    receiptObservationCaptures,
    receiptObservationBuffers,
    destroyedObservationBuffers,
    observationBufferCleanupFailures,
    failedObservationCaptures,
    disposeObservationCaptures,
    disposeOwnedObservationCaptures,
    readObservationCapture,
    disposeReceiptObservationCaptures: () => {
      let firstFailure: RendererContractFailureError | undefined;
      for (const [receipt, captures] of receiptObservationBuffers) {
        const failure = disposeObservationCaptures(captures);
        firstFailure ??= failure;
        if (captures.every((capture) => destroyedObservationBuffers.has(capture.buffer))) {
          receiptObservationBuffers.delete(receipt);
        }
      }
      receiptObservationCaptures.clear();
      const retryCaptures = [...failedObservationCaptures.values()];
      const retryFailure = disposeObservationCaptures(retryCaptures);
      firstFailure ??= retryFailure;
      for (const capture of retryCaptures) {
        if (destroyedObservationBuffers.has(capture.buffer)) {
          failedObservationCaptures.delete(capture.buffer);
        }
      }
      const ownedFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
      firstFailure ??= ownedFailure;
      return firstFailure;
    },
  };
  return owner;
}
