import type { RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { assembleTape, type EncodedTape } from './assemble';
import { createRecorderProxy, type RecordableBackend, type RecorderBackend } from './proxy';
import { ResourceRegistry } from './resource-registry';
import { snapshotFrame } from './snapshot';

export interface CaptureFrameOptions {
  readonly snapshotTimeoutMs?: number;
  readonly byteBudget?: number;
  readonly signal?: AbortSignal;
  /**
   * Seed scope. Resources whose snapshot payload exceeds `maxResourceBytes`
   * are created unseeded on replay and marked `seed: 'omitted'` in the tape.
   */
  readonly seed?: { readonly maxResourceBytes?: number };
}

export interface RecorderOptions {
  readonly snapshotTimeoutMs?: number;
  readonly byteBudget?: number;
}

export interface RecorderAttachment {
  readonly backend: RecorderBackend;
  /** Existing request generation; loss and a new capture invalidate old references. */
  readonly captureGeneration: number;
  isRecordingCapture(generation: number): boolean;
  readPipelineReference(
    device: RhiDevice,
    pipeline: RenderPipeline,
    generation: number,
  ): { readonly captureGeneration: number; readonly handleId: string } | undefined;
  captureFrame(options?: CaptureFrameOptions): Promise<Result<EncodedTape, RhiDebugError>>;
  /** Capture 1–8 consecutive frames on the same recorder and seed boundary. */
  captureFrames?(
    frames: number,
    options?: CaptureFrameOptions,
  ): Promise<Result<EncodedTape, RhiDebugError>>;
  frameBoundary(): Promise<Result<void, RhiDebugError>>;
  deviceLost(): void;
  dispose(): Promise<Result<void, RhiDebugError>>;
}

type Phase = 'idle' | 'armed' | 'snapshotting' | 'recording' | 'disposed';

export function attachRecorder(
  backend: RecordableBackend,
  options: RecorderOptions = {},
): Result<RecorderAttachment, RhiDebugError> {
  const proxy = createRecorderProxy(backend);
  const registry = new ResourceRegistry(proxy.recorder);
  let phase: Phase = 'idle';
  let generation = 0;
  let active:
    | {
        readonly generation: number;
        readonly frames: number;
        readonly options: CaptureFrameOptions;
        readonly resolve: (result: Result<EncodedTape, RhiDebugError>) => void;
        readonly signal?: AbortSignal;
        abortListener?: () => void;
      }
    | undefined;

  const fail = <T>(
    code: 'capture-unavailable' | 'capture-busy',
    cause: string,
  ): Result<T, RhiDebugError> => err(createRhiDebugError(code, { stage: 'capture', cause }));

  const settle = (result: Result<EncodedTape, RhiDebugError>): void => {
    const request = active;
    if (request === undefined) return;
    active = undefined;
    if (!result.ok) generation += 1;
    request.signal?.removeEventListener('abort', request.abortListener ?? (() => {}));
    if (!result.ok && proxy.recorder.getState() === 'error') proxy.recorder.disposeError();
    phase = phase === 'disposed' ? 'disposed' : 'idle';
    request.resolve(result);
  };

  const abort = (): void => {
    if (active === undefined) return;
    proxy.recorder.transitionToError();
    settle(fail('capture-unavailable', 'capture request was aborted'));
  };

  const capture = (
    frames: number,
    captureOptions: CaptureFrameOptions = {},
  ): Promise<Result<EncodedTape, RhiDebugError>> => {
    if (!Number.isInteger(frames) || frames < 1 || frames > 8)
      return Promise.resolve(
        fail('capture-unavailable', 'capture frames must be an integer from 1 to 8'),
      );
    if (phase === 'disposed')
      return Promise.resolve(fail('capture-unavailable', 'recorder is disposed'));
    if (active !== undefined)
      return Promise.resolve(fail('capture-busy', 'another capture is active'));
    const signal = captureOptions.signal;
    if (signal?.aborted)
      return Promise.resolve(fail('capture-unavailable', 'capture request was aborted'));
    phase = 'armed';
    generation += 1;
    return new Promise<Result<EncodedTape, RhiDebugError>>((resolve) => {
      const request = {
        generation,
        frames,
        options: captureOptions,
        resolve,
        ...(signal === undefined ? {} : { signal }),
      } as {
        readonly generation: number;
        readonly frames: number;
        readonly options: CaptureFrameOptions;
        readonly resolve: (result: Result<EncodedTape, RhiDebugError>) => void;
        readonly signal?: AbortSignal;
        abortListener?: () => void;
      };
      request.abortListener = abort;
      active = request;
      signal?.addEventListener('abort', abort, { once: true });
    });
  };

  const attachment: RecorderAttachment = {
    backend: proxy.backend,
    get captureGeneration() {
      return generation;
    },
    isRecordingCapture(expected) {
      return phase === 'recording' && active?.generation === expected && generation === expected;
    },
    readPipelineReference(device, pipeline, expected) {
      if (!attachment.isRecordingCapture(expected)) return undefined;
      const handleId = proxy.recorder.lookupPipeline(device, pipeline as object);
      return handleId === undefined
        ? undefined
        : Object.freeze({ captureGeneration: expected, handleId });
    },
    captureFrame: (captureOptions) => capture(1, captureOptions),
    captureFrames: capture,
    async frameBoundary() {
      if (phase === 'disposed' || active === undefined) return ok(undefined);
      const request = active;
      if (request.generation !== generation) return ok(undefined);
      if (phase === 'armed') {
        // Requests may arrive between frames. Start recording only at this
        // snapshot boundary; work preceding it belongs to the previous frame.
        const arm = proxy.recorder.arm(request.frames);
        if (!arm.ok) {
          const error = createRhiDebugError('capture-busy', {
            stage: 'capture',
            cause: arm.error.hint,
          });
          settle(err(error));
          return err(error);
        }
        phase = 'snapshotting';
        const result = await snapshotFrame(proxy.recorder, registry, {
          snapshotTimeoutMs:
            request.options.snapshotTimeoutMs ?? options.snapshotTimeoutMs ?? 30_000,
          byteBudget: request.options.byteBudget ?? options.byteBudget ?? Number.MAX_SAFE_INTEGER,
          maxResourceBytes: request.options.seed?.maxResourceBytes ?? Number.POSITIVE_INFINITY,
        });
        // Abort/disposal/device loss may have settled this request while GPU
        // readback was pending. Its completion cannot alter a newer capture.
        if (active !== request || request.generation !== generation) return ok(undefined);
        if (!result.ok) {
          proxy.recorder.transitionToError();
          settle(err(result.error));
          return err(result.error);
        }
        phase = 'recording';
        return ok(undefined);
      }
      if (phase !== 'recording') return ok(undefined);
      proxy.recorder.onFrameEnd();
      if (proxy.recorder.getState() !== 'idle') return ok(undefined);
      const result = assembleTape(proxy.recorder);
      proxy.recorder.releaseTape();
      settle(result);
      return result.ok ? ok(undefined) : err(result.error);
    },
    deviceLost() {
      generation += 1;
      registry.clearGeneration();
      if (active !== undefined) {
        phase = 'idle';
        settle(fail('capture-unavailable', 'device loss invalidated the active generation'));
      } else if (phase !== 'disposed') {
        phase = 'idle';
      }
    },
    async dispose() {
      if (phase === 'disposed') return ok(undefined);
      if (active !== undefined) {
        proxy.recorder.transitionToError();
        settle(fail('capture-unavailable', 'recorder was disposed during capture'));
      }
      proxy.recorder.disposeError();
      generation += 1;
      phase = 'disposed';
      return ok(undefined);
    },
  };
  return ok(attachment);
}

export type { CreateShaderModuleFn, CreateShaderModuleImmediateFn } from '../recorder';
export { type EncodedTape, type TapeArtifact, tapeArtifact } from './assemble';
export type { RecordableBackend, RecorderBackend } from './proxy';
