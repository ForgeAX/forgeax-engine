import type { World } from '@forgeax/engine-ecs';
import type { ProfileFrameToken } from '@forgeax/engine-profiler';
import { type Buffer, err, ok, textureReadbackLayout } from '@forgeax/engine-rhi';
import { textureFormatBlock } from '@forgeax/engine-types';
import {
  FrameReceiptStaleError,
  type RenderError,
  RendererContractFailureError,
  RendererOperationError,
} from '../errors/render';
import { activeRenderProfileSession } from '../record/profile-session';
import type {
  FeatureTextureReadbackDeclaration,
  FrameObservationDomain,
  FrameReceipt,
  RenderPipelineObservationCapture,
  RenderPipelineObservationCaptureOwner,
  RenderResult,
} from '../render-contract';
import type { WebGPURendererInternals } from './webgpu-renderer-contract';
import { disposeObservationCaptureSet } from './webgpu-renderer-observation';

export function beginObservationFrame(
  internals: WebGPURendererInternals,
  renderWorld: World,
  observationFrameId: number,
  deviceGeneration: number,
  pendingObservationDomains: readonly FrameObservationDomain[] | undefined,
  profileFrame: ProfileFrameToken | undefined,
): void {
  internals.observationFrameId = observationFrameId;
  internals.observationGraphGeneration = undefined;
  internals.observationCaptureDomains = pendingObservationDomains;
  internals.gpuPassTimingDeviceGeneration = deviceGeneration;
  const profileSession = activeRenderProfileSession(
    undefined,
    renderWorld,
    internals.options?.profiler,
  );
  internals.renderPassCpuIdentityCapture =
    profileFrame !== undefined &&
    profileSession?.captureId === profileFrame.captureId &&
    profileSession.detail !== 'owner'
      ? { entries: [], instrumentationAccepted: false, complete: true }
      : undefined;
}

export function submittedFramePresentation(
  uiOnlyFrame: boolean,
  cameraViews: {
    readonly presentation: FrameReceipt['presentation'];
    readonly presentationPendingReason: FrameReceipt['presentationPendingReason'];
  },
) {
  const presentation = uiOnlyFrame ? ('pending' as const) : cameraViews.presentation;
  const presentationPendingReason =
    presentation === 'ready'
      ? undefined
      : uiOnlyFrame
        ? Object.freeze({ code: 'ui-only' as const })
        : cameraViews.presentationPendingReason;
  return { presentation, presentationPendingReason };
}

export type ObservationCaptureRead = () => Promise<
  RenderResult<
    Readonly<{
      captures: readonly {
        readonly capture: RenderPipelineObservationCapture;
        readonly bytes: Uint8Array;
      }[];
      graphGenerations: readonly number[];
    }>,
    RenderError
  >
>;

interface ReceiptObservationBuffers {
  readonly captures: readonly RenderPipelineObservationCapture[];
  retire(): void;
}

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
  readonly receiptObservationCaptures: WeakMap<FrameReceipt, ObservationCaptureRead>;
  readonly receiptObservationBuffers: Map<FrameReceipt, ReceiptObservationBuffers>;
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
  readonly registerReceiptReads: (
    receipt: FrameReceipt,
    captureFrame: Readonly<{
      captures: readonly RenderPipelineObservationCapture[];
      graphGenerations: readonly number[];
    }>,
  ) => ObservationCaptureRead;
  readonly disposeReceiptObservationCaptures: () => RendererContractFailureError | undefined;
  readonly discardFrame: (
    frameNumber: number | undefined,
  ) => readonly RenderPipelineObservationCapture[];
}

export function createRendererObservationCaptureOwner(
  fireError: (error: RendererContractFailureError) => void,
  featureTextureReadbackBudgetBytes?: number,
): RendererObservationCaptureOwner {
  const stats = {
    allocationCount: 0,
    liveCount: 0,
    peakLiveCount: 0,
    mapCount: 0,
    readbackCount: 0,
    liveByteLength: 0,
  };
  const capturesByFrame = new Map<
    number,
    {
      captures: RenderPipelineObservationCapture[];
      graphGenerations: Set<number>;
    }
  >();
  const featureTextureReservations = new Map<
    number,
    {
      readonly byteLength: number;
      readonly declarations: ReadonlyMap<string, FeatureTextureReadbackDeclaration>;
      readonly claimed: Set<string>;
      retained: boolean;
      observationComplete: boolean;
      settled: boolean;
    }
  >();
  let reservedFeatureTextureBytes = 0;
  const featureTextureReadbackBudgetExceeded = (
    frameNumber: number,
    requestedBytes: number,
    reservedBytes: number,
    budgetBytes: number,
    reason: string,
  ) =>
    err(
      new RendererOperationError('device-operation-failed', {
        operation: 'draw',
        frameId: frameNumber,
        cause: {
          code: 'feature-texture-readback-budget-exceeded',
          expected:
            'the complete source-frame feature-texture readback roster fits the explicit profile budget',
          hint: 'increase the host profile budget or reduce the authored capture workload; Render does not omit or downsample declared stages',
          detail: { frameNumber, requestedBytes, reservedBytes, budgetBytes, reason },
        },
      }),
    );
  const settleFeatureTextureReadbacks = (frameNumber: number): void => {
    const reservation = featureTextureReservations.get(frameNumber);
    if (reservation === undefined || reservation.settled) return;
    reservation.settled = true;
    reservedFeatureTextureBytes = Math.max(0, reservedFeatureTextureBytes - reservation.byteLength);
    featureTextureReservations.delete(frameNumber);
  };
  const declarationKey = (
    declaration: Pick<
      FeatureTextureReadbackDeclaration,
      'featureIdentity' | 'viewIdentity' | 'name'
    >,
  ) =>
    `${declaration.featureIdentity}\u0000${declaration.viewIdentity ?? 'frame'}\u0000${declaration.name}`;
  const frameCaptures = (frameNumber: number) => {
    const frame = capturesByFrame.get(frameNumber) ?? {
      captures: [],
      graphGenerations: new Set<number>(),
    };
    capturesByFrame.set(frameNumber, frame);
    return frame;
  };
  const observationCaptureOwner = {
    register(capture: RenderPipelineObservationCapture): void {
      frameCaptures(capture.frameNumber).captures.push(capture);
      stats.allocationCount += 1;
      stats.liveCount += 1;
      stats.peakLiveCount = Math.max(stats.peakLiveCount, stats.liveCount);
      stats.liveByteLength += capture.bytesPerRow * capture.height;
    },
    preflightFeatureTextureReadbacks(
      frameNumber: number,
      declarations: readonly FeatureTextureReadbackDeclaration[],
    ) {
      // Empty rosters are free and remain valid for basic renderer startup. A
      // non-empty roster must reserve its complete allocation before the
      // graph creates any readback buffers; silently skipping the cap here
      // turns concurrent captures into an unbounded allocation path.
      if (featureTextureReadbackBudgetBytes === undefined) {
        if (declarations.length === 0) return ok(undefined);
        return featureTextureReadbackBudgetExceeded(
          frameNumber,
          declarations.reduce((sum, row) => sum + row.byteLength, 0),
          reservedFeatureTextureBytes,
          0,
          'missing-profile-budget',
        );
      }
      if (
        !Number.isSafeInteger(featureTextureReadbackBudgetBytes) ||
        featureTextureReadbackBudgetBytes < 0
      )
        return featureTextureReadbackBudgetExceeded(
          frameNumber,
          0,
          reservedFeatureTextureBytes,
          0,
          'invalid-profile-budget',
        );
      if (!Number.isSafeInteger(frameNumber) || frameNumber < 0)
        return featureTextureReadbackBudgetExceeded(
          frameNumber,
          0,
          reservedFeatureTextureBytes,
          featureTextureReadbackBudgetBytes,
          'invalid-frame-identity',
        );
      const normalized = new Map<string, FeatureTextureReadbackDeclaration>();
      let requestedBytes = 0;
      const normalizeReadbackDeclarations = (featureTextureReadbackBudgetBytes: number) => {
        for (const declaration of declarations) {
          const key = declarationKey(declaration);
          const layout = textureReadbackLayout(
            declaration.width,
            declaration.height,
            textureFormatBlock(declaration.format),
          );
          if (
            declaration.featureIdentity.length === 0 ||
            (declaration.viewIdentity !== undefined &&
              (typeof declaration.viewIdentity !== 'string' ||
                declaration.viewIdentity.length === 0)) ||
            declaration.name.length === 0 ||
            declaration.targetName.length === 0 ||
            declaration.width <= 0 ||
            declaration.height <= 0 ||
            declaration.bytesPerRow !== layout.bytesPerRow ||
            declaration.byteLength !== layout.byteLength
          )
            return featureTextureReadbackBudgetExceeded(
              frameNumber,
              declaration.byteLength,
              reservedFeatureTextureBytes,
              featureTextureReadbackBudgetBytes,
              'invalid-declaration-layout',
            );
          const admitReadbackDeclaration = (
            declaration: FeatureTextureReadbackDeclaration,
            key: string,
          ) => {
            const previous = normalized.get(key);
            if (
              previous !== undefined &&
              (previous.targetName !== declaration.targetName ||
                previous.viewIdentity !== declaration.viewIdentity ||
                previous.format !== declaration.format ||
                previous.width !== declaration.width ||
                previous.height !== declaration.height ||
                previous.bytesPerRow !== declaration.bytesPerRow ||
                previous.byteLength !== declaration.byteLength)
            )
              return featureTextureReadbackBudgetExceeded(
                frameNumber,
                declaration.byteLength,
                reservedFeatureTextureBytes,
                featureTextureReadbackBudgetBytes,
                'conflicting-declarations',
              );
            if (previous === undefined) {
              requestedBytes += declaration.byteLength;
              normalized.set(key, declaration);
            }
            return undefined;
          };
          const failure = admitReadbackDeclaration(declaration, key);
          if (failure !== undefined) return failure;
        }
        return undefined;
      };
      const declarationFailure = normalizeReadbackDeclarations(featureTextureReadbackBudgetBytes);
      if (declarationFailure !== undefined) return declarationFailure;
      if (!Number.isSafeInteger(requestedBytes))
        return featureTextureReadbackBudgetExceeded(
          frameNumber,
          requestedBytes,
          reservedFeatureTextureBytes,
          featureTextureReadbackBudgetBytes,
          'byte-count-overflow',
        );
      const existing = featureTextureReservations.get(frameNumber);
      if (existing !== undefined) {
        const same =
          existing.byteLength === requestedBytes &&
          existing.declarations.size === normalized.size &&
          [...normalized].every(([key, row]) => {
            const old = existing.declarations.get(key);
            return (
              old !== undefined &&
              old.targetName === row.targetName &&
              old.viewIdentity === row.viewIdentity &&
              old.format === row.format &&
              old.width === row.width &&
              old.height === row.height &&
              old.bytesPerRow === row.bytesPerRow &&
              old.byteLength === row.byteLength
            );
          });
        return same
          ? ok(undefined)
          : featureTextureReadbackBudgetExceeded(
              frameNumber,
              requestedBytes,
              reservedFeatureTextureBytes,
              featureTextureReadbackBudgetBytes,
              'source-frame-roster-changed-after-reservation',
            );
      }
      if (requestedBytes > featureTextureReadbackBudgetBytes - reservedFeatureTextureBytes)
        return featureTextureReadbackBudgetExceeded(
          frameNumber,
          requestedBytes,
          reservedFeatureTextureBytes,
          featureTextureReadbackBudgetBytes,
          'aggregate-profile-cap',
        );
      featureTextureReservations.set(frameNumber, {
        byteLength: requestedBytes,
        declarations: normalized,
        claimed: new Set(),
        retained: false,
        observationComplete: false,
        settled: false,
      });
      reservedFeatureTextureBytes += requestedBytes;
      return ok(undefined);
    },
    claimFeatureTextureReadback(
      frameNumber: number,
      declaration: FeatureTextureReadbackDeclaration,
    ) {
      if (featureTextureReadbackBudgetBytes === undefined) return ok(undefined);
      const reservation = featureTextureReservations.get(frameNumber);
      const key = declarationKey(declaration);
      const expected = reservation?.declarations.get(key);
      if (
        reservation === undefined ||
        expected === undefined ||
        expected.targetName !== declaration.targetName ||
        expected.viewIdentity !== declaration.viewIdentity ||
        expected.format !== declaration.format ||
        expected.width !== declaration.width ||
        expected.height !== declaration.height ||
        expected.bytesPerRow !== declaration.bytesPerRow ||
        expected.byteLength !== declaration.byteLength ||
        reservation.claimed.has(key)
      )
        return featureTextureReadbackBudgetExceeded(
          frameNumber,
          declaration.byteLength,
          reservedFeatureTextureBytes,
          featureTextureReadbackBudgetBytes,
          reservation === undefined
            ? 'allocation-without-preflight'
            : 'allocation-not-in-roster-or-duplicate',
        );
      reservation.claimed.add(key);
      return ok(undefined);
    },
    retainFeatureTextureReadbacks(frameNumber: number) {
      const reservation = featureTextureReservations.get(frameNumber);
      if (reservation === undefined || reservation.settled) return undefined;
      reservation.retained = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reservation.retained = false;
        if (reservation.observationComplete) settleFeatureTextureReadbacks(frameNumber);
      };
    },
    settleFeatureTextureReadbacks,
    completeFeatureTextureReadbackObservation(frameNumber: number) {
      const reservation = featureTextureReservations.get(frameNumber);
      if (reservation === undefined || reservation.settled) return;
      reservation.observationComplete = true;
      if (!reservation.retained) settleFeatureTextureReadbacks(frameNumber);
    },
    recordGraph(frameNumber: number, graphGeneration: number): void {
      frameCaptures(frameNumber).graphGenerations.add(graphGeneration);
    },
    consume(frameNumber: number) {
      const frame = capturesByFrame.get(frameNumber);
      capturesByFrame.delete(frameNumber);
      return Object.freeze({
        captures: Object.freeze(frame?.captures ?? []),
        graphGenerations: Object.freeze([...(frame?.graphGenerations ?? [])]),
      });
    },
    discardFrame(frameNumber: number | undefined) {
      if (frameNumber === undefined) return Object.freeze([]);
      const frame = capturesByFrame.get(frameNumber);
      capturesByFrame.delete(frameNumber);
      settleFeatureTextureReadbacks(frameNumber);
      return Object.freeze(frame?.captures ?? []);
    },
    drain(): readonly RenderPipelineObservationCapture[] {
      const captures = [...capturesByFrame.values()].flatMap((frame) => frame.captures);
      capturesByFrame.clear();
      for (const frameNumber of featureTextureReservations.keys())
        settleFeatureTextureReadbacks(frameNumber);
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
    retired?: () => FrameReceiptStaleError | undefined,
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
      const stale = retired?.();
      if (stale !== undefined) {
        if (mapped.ok && mapped.value.mapState === 'mapped') mapped.value.unmap();
        return err(stale);
      }
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
      const stale = retired?.();
      if (stale !== undefined) return err(stale);
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
  const receiptObservationCaptures = new WeakMap<FrameReceipt, ObservationCaptureRead>();
  const receiptObservationBuffers = new Map<FrameReceipt, ReceiptObservationBuffers>();
  const registerReceiptReads: RendererObservationCaptureOwner['registerReceiptReads'] = (
    receipt,
    { captures, graphGenerations },
  ) => {
    let retired: FrameReceiptStaleError | undefined;
    let settle: ((value: Awaited<ReturnType<ObservationCaptureRead>>) => void) | undefined;
    const performRead: ObservationCaptureRead = async () => {
      let unreadExplicitCapture = false;
      try {
        const completion = await receipt.completed;
        if (retired !== undefined) return err(retired);
        if (!completion.ok) {
          const failure = disposeOwnedObservationCaptures(captures);
          return failure === undefined ? completion : err(failure);
        }
        const read = [];
        for (const capture of captures) {
          const bytes = await readObservationCapture(capture, () => retired);
          if (retired !== undefined) return err(retired);
          if (!bytes.ok) {
            const failure = disposeOwnedObservationCaptures(captures);
            return failure === undefined ? bytes : err(failure);
          }
          read.push({ capture, bytes: bytes.value });
        }
        unreadExplicitCapture = captures.some((capture) => capture.featureTexture === undefined);
        return ok({ captures: read, graphGenerations });
      } finally {
        // Failed cleanup remains owned by failedObservationCaptures. Completed
        // automatic feature receipts release their roots. Explicit captures
        // retain bounded admission credit until the receipt is observed.
        if (!unreadExplicitCapture) receiptObservationBuffers.delete(receipt);
        observationCaptureOwner.completeFeatureTextureReadbackObservation(receipt.frameId);
      }
    };
    let pendingRead: ReturnType<ObservationCaptureRead> | undefined;
    const read: ObservationCaptureRead = () =>
      (pendingRead ??= new Promise((resolve, reject) => {
        if (retired !== undefined) {
          resolve(err(retired));
          return;
        }
        settle = resolve;
        void performRead()
          .then(resolve, reject)
          .finally(() => {
            settle = undefined;
          });
      }));
    receiptObservationBuffers.set(receipt, {
      captures,
      retire() {
        retired ??= new FrameReceiptStaleError({
          frameId: receipt.frameId,
          receiptGeneration: receipt.deviceGeneration,
          currentGeneration: receipt.deviceGeneration,
        });
        settle?.(err(retired));
        settle = undefined;
      },
    });
    receiptObservationCaptures.set(receipt, read);
    return read;
  };
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
    registerReceiptReads,
    disposeReceiptObservationCaptures: () => {
      let firstFailure: RendererContractFailureError | undefined;
      for (const [receipt, { captures, retire }] of receiptObservationBuffers) {
        retire();
        const failure = disposeObservationCaptures(captures);
        firstFailure ??= failure;
        if (captures.every((capture) => destroyedObservationBuffers.has(capture.buffer))) {
          receiptObservationBuffers.delete(receipt);
        }
      }
      const retryCaptures = [...failedObservationCaptures.values()];
      const retryFailure = disposeObservationCaptures(retryCaptures);
      firstFailure ??= retryFailure;
      for (const capture of retryCaptures) {
        if (destroyedObservationBuffers.has(capture.buffer)) {
          failedObservationCaptures.delete(capture.buffer);
        }
      }
      const ownedFailure = disposeOwnedObservationCaptures(observationCaptureOwner.drain());
      for (const frameNumber of featureTextureReservations.keys())
        settleFeatureTextureReadbacks(frameNumber);
      firstFailure ??= ownedFailure;
      return firstFailure;
    },
    discardFrame: observationCaptureOwner.discardFrame,
  };
  return owner;
}
