import type { FrameReceipt } from '@forgeax/engine-render';
import type { RhiBackendInstrumentation } from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import type {
  CaptureFrameOptions,
  EncodedTape,
  RecorderAttachment,
  RhiDebugError,
  TapeArtifact,
} from '@forgeax/engine-rhi-debug';
import { createRhiDebugError } from '@forgeax/engine-rhi-debug';
import {
  type BrowserArtifactRef,
  type BrowserCaptureError,
  type BrowserCaptureOptions,
  uploadTape,
} from '@forgeax/engine-rhi-debug/browser';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { FrameLoopHandle } from './frame-loop';

/** A captured `.rhitape`: streamable chunks, lazy `digest` and `bytes`. */
export interface RhiTapeArtifactRef extends TapeArtifact {
  readonly kind: 'rhi-tape';
  readonly submittedFrame:
    | {
        readonly status: 'complete';
        readonly receipt: FrameReceipt;
        readonly captureGeneration: number;
      }
    | RhiRemoteCaptureCompletion;
}

/** Clone-safe facts for a receipt observed inside the Render Worker. */
export type RhiRemoteCaptureCompletion =
  | {
      readonly status: 'remote-complete';
      readonly receipt: {
        readonly frameId: number;
        readonly deviceGeneration: number;
        readonly graphGeneration?: number;
      };
      readonly captureGeneration: number;
      readonly gpuPassTiming?: import('@forgeax/engine-render').GpuPassTimingObservation;
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'frame-unavailable'
        | 'multiple-submits'
        | 'capture-invalidated'
        | 'submit-failed';
    };

export interface RhiCapture {
  captureFrame(options?: CaptureFrameOptions): Promise<Result<RhiTapeArtifactRef, RhiDebugError>>;
  /** Resumable chunked upload to the RHI-debug dev transport. */
  upload(
    artifact: RhiTapeArtifactRef,
    options?: BrowserCaptureOptions,
  ): Promise<Result<BrowserArtifactRef, BrowserCaptureError>>;
}

export function uploadRhiTape(
  artifact: RhiTapeArtifactRef,
  options: BrowserCaptureOptions = {},
): Promise<Result<BrowserArtifactRef, BrowserCaptureError>> {
  return uploadTape(artifact, options);
}

type CaptureResult = Result<EncodedTape, RhiDebugError>;
type CaptureFrameDriver = Pick<FrameLoopHandle, 'getState' | 'pause' | 'resume' | 'stepFrame'> & {
  readonly subscribeSubmitted?: (listener: (receipt: FrameReceipt) => void) => () => void;
};

const captureDrivers = new WeakMap<RhiCapture, CaptureFrameDriver>();

export function createRhiCapture(attachment: RecorderAttachment): RhiCapture {
  let activeCapture: Promise<Result<RhiTapeArtifactRef, RhiDebugError>> | undefined;
  const capture: RhiCapture = {
    upload: uploadRhiTape,
    captureFrame(options) {
      const driver = captureDrivers.get(capture);
      if (driver === undefined) return captureAttachment(attachment, options);
      if (activeCapture !== undefined) {
        return Promise.resolve(
          err(
            createRhiDebugError('capture-busy', {
              stage: 'capture',
              cause: 'another App capture transaction is active',
            }),
          ),
        );
      }
      const request = captureWithAppFrame(attachment, driver, options);
      activeCapture = request;
      void request.then(
        () => {
          if (activeCapture === request) activeCapture = undefined;
        },
        () => {
          if (activeCapture === request) activeCapture = undefined;
        },
      );
      return request;
    },
  };
  return capture;
}

/** Bind the App-owned frame authority to its host capture capability. */
export function bindRhiCaptureFrameDriver(capture: RhiCapture, driver: CaptureFrameDriver): void {
  captureDrivers.set(capture, driver);
}

/** Borrow the App submission boundary for browser-local surface snapshots. */
export function subscribeRhiCaptureSubmitted(
  capture: RhiCapture,
  listener: () => void,
): () => void {
  const driver = captureDrivers.get(capture);
  if (driver?.subscribeSubmitted === undefined)
    throw new Error('RHI capture has no App submission observer');
  return driver.subscribeSubmitted(listener);
}

async function captureAttachment(
  attachment: RecorderAttachment,
  options: CaptureFrameOptions | undefined,
): Promise<Result<RhiTapeArtifactRef, RhiDebugError>> {
  const result = await attachment.captureFrame(options);
  if (!result.ok) return result;
  return ok(toArtifact(result.value));
}

async function captureWithAppFrame(
  attachment: RecorderAttachment,
  driver: CaptureFrameDriver,
  options: CaptureFrameOptions | undefined,
): Promise<Result<RhiTapeArtifactRef, RhiDebugError>> {
  const state = driver.getState();
  if (state !== 'running' && state !== 'paused') {
    return err(
      createRhiDebugError('capture-unavailable', {
        stage: 'capture',
        cause: `App capture requires a running or paused frame loop, received '${state}'`,
      }),
    );
  }
  if (options?.signal?.aborted) return captureAttachment(attachment, options);

  const resumeAfter = state === 'running';
  if (resumeAfter) {
    const paused = driver.pause();
    if (!paused.ok) {
      return err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture could not pause the frame loop: ${describeFailure(paused.error)}`,
        }),
      );
    }
  }

  const controller = new AbortController();
  const abortFromUser = (): void => controller.abort();
  options?.signal?.addEventListener('abort', abortFromUser, { once: true });
  let captureResult: Promise<CaptureResult>;
  try {
    captureResult = attachment.captureFrame({
      ...(options ?? {}),
      signal: controller.signal,
    });
  } catch (cause: unknown) {
    options?.signal?.removeEventListener('abort', abortFromUser);
    if (resumeAfter && driver.getState() === 'paused') driver.resume();
    return err(
      createRhiDebugError('capture-unavailable', {
        stage: 'capture',
        cause: `App capture could not arm the recorder: ${describeFailure(cause)}`,
      }),
    );
  }

  const captureGeneration = attachment.captureGeneration;
  const receipts: FrameReceipt[] = [];
  let unsubscribe: (() => void) | undefined;
  let result: CaptureResult | undefined;
  let transactionError: RhiDebugError | undefined;
  let resumedForCapture = false;
  try {
    const snapshot = await attachment.frameBoundary();
    const recording = snapshot.ok && attachment.isRecordingCapture(captureGeneration);
    if (recording)
      unsubscribe = driver.subscribeSubmitted?.((receipt) => {
        if (attachment.captureGeneration === captureGeneration && receipts.length < 2)
          receipts.push(receipt);
      });
    if (!recording) {
      result = await captureResult;
    } else if (options?.signal?.aborted) {
      controller.abort();
      result = await captureResult;
    } else if (resumeAfter) {
      // A running App must contribute its next ordinary frame to the tape.
      // `stepFrame(0)` would execute an artificial zero-delta update, which
      // may skip FixedUpdate/VFX work and makes the capture unrepresentative.
      // resume() resets the loop clock, so the next credit-admitted rAF owns
      // the normal measured delta and its existing frame-boundary callback
      // finalizes this one-frame capture.
      const resumed = driver.resume();
      if (!resumed.ok) {
        transactionError = createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture could not resume the frame loop: ${describeFailure(resumed.error)}`,
        });
        controller.abort();
        result = await captureResult;
      } else {
        resumedForCapture = true;
        result = await captureResult;
      }
    } else {
      const stepped = driver.stepFrame(0);
      if (!stepped.ok) {
        transactionError = createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture frame failed: ${describeFailure(stepped.error)}`,
        });
        controller.abort();
        result = await captureResult;
      } else {
        result = await captureResult;
      }
    }
  } catch (cause: unknown) {
    transactionError = createRhiDebugError('capture-unavailable', {
      stage: 'capture',
      cause: `App capture transaction failed: ${describeFailure(cause)}`,
    });
    controller.abort();
    result = await captureResult;
  } finally {
    unsubscribe?.();
    options?.signal?.removeEventListener('abort', abortFromUser);
    if (resumeAfter && !resumedForCapture && driver.getState() === 'paused') {
      const resumed = driver.resume();
      if (!resumed.ok && transactionError === undefined) {
        transactionError = createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture could not resume the frame loop: ${describeFailure(resumed.error)}`,
        });
      }
    }
  }

  if (transactionError !== undefined) return err(transactionError);
  if (result === undefined) result = await captureResult;
  if (!result.ok) return result;
  let submittedFrame: RhiTapeArtifactRef['submittedFrame'];
  const receipt = receipts[0];
  if (receipts.length > 1)
    submittedFrame = Object.freeze({ status: 'unavailable', reason: 'multiple-submits' });
  else if (receipt === undefined)
    submittedFrame = Object.freeze({ status: 'unavailable', reason: 'frame-unavailable' });
  else {
    const completed = await receipt.completed;
    submittedFrame = !completed.ok
      ? Object.freeze({ status: 'unavailable', reason: 'submit-failed' })
      : attachment.captureGeneration !== captureGeneration || options?.signal?.aborted
        ? Object.freeze({ status: 'unavailable', reason: 'capture-invalidated' })
        : Object.freeze({ status: 'complete', receipt, captureGeneration });
  }
  return ok(toArtifact(result.value, submittedFrame));
}

function describeFailure(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'object' && cause !== null && 'hint' in cause) {
    const hint = (cause as { hint?: unknown }).hint;
    if (typeof hint === 'string') return hint;
  }
  return String(cause);
}

export function createRhiInstrumentation(
  attachment: RecorderAttachment,
): RhiBackendInstrumentation {
  return {
    resolvePipelineReference(device, pipeline) {
      return attachment.readPipelineReference(device, pipeline, attachment.captureGeneration);
    },
    isCaptureGenerationCurrent(generation) {
      return attachment.captureGeneration === generation;
    },
    resolveSurfaceDevice(device) {
      // The recorder owns backend selection: native raw identity or Null's
      // recorded factories. Do not unwrap its resolved device a second time.
      const resolved = attachment.backend.unwrapDeviceForSurface(device);
      if (resolved.ok) return resolved;
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'the recorder can resolve the wrapped surface device',
          hint: resolved.error.hint,
        }),
      );
    },
    onFrameBoundary() {
      void attachment.frameBoundary();
    },
    onDeviceLost() {
      attachment.deviceLost();
    },
  };
}

/**
 * Keep the recorder and an explicitly injected host capability on one
 * instrumentation seam. The recorder must retain surface-device resolution,
 * frame-boundary, and loss notification ownership, while fixture/host hooks
 * such as submit fault injection and device-loss projection must survive the
 * debug wrapper as well.
 */
export function mergeRhiInstrumentation(
  recorder: RhiBackendInstrumentation,
  host: RhiBackendInstrumentation | undefined,
): RhiBackendInstrumentation {
  if (host === undefined) return recorder;
  const onFrameBoundary =
    recorder.onFrameBoundary === undefined && host.onFrameBoundary === undefined
      ? undefined
      : () => {
          recorder.onFrameBoundary?.();
          host.onFrameBoundary?.();
        };
  const onDeviceLost =
    recorder.onDeviceLost === undefined && host.onDeviceLost === undefined
      ? undefined
      : () => {
          recorder.onDeviceLost?.();
          host.onDeviceLost?.();
        };
  return {
    ...recorder,
    ...(host.beforeSubmit === undefined ? {} : { beforeSubmit: host.beforeSubmit }),
    ...(host.deviceLost === undefined ? {} : { deviceLost: host.deviceLost }),
    ...(onFrameBoundary === undefined ? {} : { onFrameBoundary }),
    ...(onDeviceLost === undefined ? {} : { onDeviceLost }),
    // The recorder's resolver selects its backend's surface device. A host resolver
    // is retained only when no recorder resolver exists; replacing the recorder
    // resolver would make the debug attachment unable to configure the surface.
    ...(recorder.resolveSurfaceDevice !== undefined || host.resolveSurfaceDevice === undefined
      ? {}
      : { resolveSurfaceDevice: host.resolveSurfaceDevice }),
  };
}

export function toArtifact(
  tape: TapeArtifact,
  submittedFrame: RhiTapeArtifactRef['submittedFrame'] = Object.freeze({
    status: 'unavailable',
    reason: 'frame-unavailable',
  }),
): RhiTapeArtifactRef {
  return {
    kind: 'rhi-tape',
    submittedFrame,
    byteLength: tape.byteLength,
    get digest() {
      return tape.digest;
    },
    get bytes() {
      return tape.bytes;
    },
    chunks: (chunkBytes) => tape.chunks(chunkBytes),
  };
}
