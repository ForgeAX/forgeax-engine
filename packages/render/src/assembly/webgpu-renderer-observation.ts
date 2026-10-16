import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import {
  type FrameReceiptStaleError,
  type RenderError,
  RendererContractFailureError,
  type RendererExpectedOperationError,
  RendererOperationError,
} from '../errors/render';
import type { LodOcclusionReceiptObservation } from '../inspection-types';
import { MAX_RECEIPT_OBSERVATION_BYTES } from '../observation-budget';
import { unavailableDrawObservation } from '../record/draw-observation';
import { getTextureIdentity } from '../record/frame-snapshot';
import type { GpuPassTimingObservation } from '../record/gpu-pass-timing/index.js';
import type { VolumeTimingObservation } from '../record/gpu-timing';
import type {
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  RendererOptions,
  RenderPipelineObservationCapture,
  RenderResult,
} from '../render-contract';
import { isFrameObservationDomain } from '../render-contract';
import {
  type createGpuPassTimingObservationStore,
  observeGpuPassTimingDisabled,
} from '../renderer.js';
import { type captureMaterialDraws, observeMaterialDraws } from './draw-observation';
import {
  cachedLodObservationMatchesCapture,
  type LodObservationCapture,
  type LodObservationCaptureValidity,
  lodObservationCaptureFailure,
  observeLodOcclusionCapture,
  unavailableLodObservation,
} from './lod-observation';
import type { createRenderTargetHost } from './render-target-host';
import type { RendererObservationCaptureOwner } from './webgpu-renderer-observation-owner';

/** Dispose receipt-bound readback buffers while retaining failed ownership. */
export function disposeObservationCaptureSet(
  captures: readonly RenderPipelineObservationCapture[],
  destroyed: WeakSet<Buffer>,
  failures: WeakMap<Buffer, RendererContractFailureError>,
  fire: (failure: RendererContractFailureError) => void,
): RendererContractFailureError | undefined {
  let firstFailure: RendererContractFailureError | undefined;
  for (const capture of captures) {
    if (destroyed.has(capture.buffer)) continue;
    const previousFailure = failures.get(capture.buffer);
    try {
      const result = capture.device.destroyBuffer(capture.buffer);
      if (result.ok) {
        destroyed.add(capture.buffer);
        failures.delete(capture.buffer);
        continue;
      }
      const failure = new RendererContractFailureError(
        'observe',
        `destroying ${capture.domain} receipt-bound readback failed: ${result.error.code}`,
      );
      failures.set(capture.buffer, failure);
      if (previousFailure === undefined) fire(failure);
      firstFailure ??= failure;
    } catch (cause) {
      const failure = new RendererContractFailureError(
        'observe',
        `destroying ${capture.domain} receipt-bound readback threw: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      failures.set(capture.buffer, failure);
      if (previousFailure === undefined) fire(failure);
      firstFailure ??= failure;
    }
  }
  return firstFailure;
}

/** Validate and project color readbacks against the submitted frame identity. */
export function projectReceiptColorObservations(
  receipt: FrameReceipt,
  captures: readonly {
    readonly capture: RenderPipelineObservationCapture;
    readonly bytes: Uint8Array;
  }[],
  requestedDomains: readonly RenderPipelineObservationCapture['domain'][],
  backendId: FrameReceipt['backendId'],
): RenderResult<
  NonNullable<FrameReceiptObservation['observations']>,
  RendererContractFailureError
> {
  const graphGenerations = new Set(captures.map(({ capture }) => capture.graphGeneration));
  if (
    captures.some(
      ({ capture }) =>
        capture.frameNumber !== receipt.frameId ||
        capture.deviceGeneration !== receipt.deviceGeneration ||
        capture.backendId !== backendId ||
        (receipt.graphGeneration !== undefined &&
          capture.graphGeneration !== receipt.graphGeneration),
    ) ||
    graphGenerations.size !== 1
  ) {
    return err(
      new RendererContractFailureError(
        'observe',
        'receipt-bound color-domain captures crossed frame, device, backend, or graph identity',
      ),
    );
  }
  const byDomain = new Map(
    captures.map(({ capture, bytes }) => [capture.domain, { capture, bytes }]),
  );
  if (
    byDomain.size !== captures.length ||
    requestedDomains.some((domain) => !byDomain.has(domain))
  ) {
    return err(
      new RendererContractFailureError(
        'observe',
        'receipt-bound color-domain captures must contain one source per requested domain',
      ),
    );
  }
  const read: NonNullable<FrameReceiptObservation['observations']>[number][] = [];
  for (const domain of requestedDomains) {
    const resolved = byDomain.get(domain);
    if (resolved === undefined) continue;
    const { capture, bytes } = resolved;
    const observation = {
      bytes,
      metadata: {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        ...(receipt.backendId === undefined ? {} : { backendId: receipt.backendId }),
        format: capture.format,
        graphGeneration: capture.graphGeneration,
        textureIdentity: getTextureIdentity(capture.texture),
        readbackIdentity: getTextureIdentity(
          capture.buffer as unknown as import('@forgeax/engine-rhi').Texture,
        ),
        width: capture.width,
        height: capture.height,
        bytesPerRow: capture.bytesPerRow,
        footprint: { resourceCount: 1, bindGroupCount: 0 },
      },
    };
    if (domain === 'visible-surface') {
      const records = capture.surfaceRecords;
      if (records === undefined)
        return err(
          new RendererContractFailureError(
            'observe',
            'visible-surface capture is missing its same-frame records',
          ),
        );
      read.push({ ...observation, domain, records: records.slice() });
    } else if (domain === 'final-display') {
      read.push({ ...observation, domain, colorSpace: capture.colorSpace ?? 'srgb' });
    } else {
      read.push({ ...observation, domain });
    }
  }
  return ok(Object.freeze(read));
}

export interface RendererReceiptLodCaptureState {
  readonly receipt: FrameReceipt;
  readonly capture: LodObservationCapture | undefined;
  readonly draws: ReturnType<typeof captureMaterialDraws>;
  promise?: Promise<LodOcclusionReceiptObservation>;
  observation?: LodOcclusionReceiptObservation;
  error?: RendererExpectedOperationError;
}

interface RendererReceiptObservationContext {
  readonly staleObservationReceipt: (receipt: FrameReceipt) => FrameReceiptStaleError | undefined;
  readonly gpuPassTimingOptions: RendererOptions['gpuPassTiming'];
  readonly timingObservationStore:
    | ReturnType<typeof createGpuPassTimingObservationStore>
    | undefined;
  readonly observeTiming: typeof observeGpuPassTimingDisabled;
  readonly currentGeneration: () => number;
  readonly backendKind: () => RhiDevice['caps']['backendKind'];
  readonly observationOwner: RendererObservationCaptureOwner;
  readonly latestLodObservation: () => RendererReceiptLodCaptureState | undefined;
  readonly latestReceipt: () => FrameReceipt | undefined;
  readonly lodObservationValidity: (
    state: RendererReceiptLodCaptureState,
    receipt: FrameReceipt,
  ) => LodObservationCaptureValidity;
  readonly renderTargetHost: ReturnType<typeof createRenderTargetHost>;
  readonly receiptTimings: WeakMap<FrameReceipt, Promise<VolumeTimingObservation>>;
  readonly isCaptureGenerationCurrent: () => ((generation: number) => boolean) | undefined;
}

/** Observe one issued receipt, rechecking its live owners after asynchronous work. */
export async function observeRendererReceipt(
  receipt: FrameReceipt,
  request: FrameObservationRequest,
  context: RendererReceiptObservationContext,
): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
  const {
    staleObservationReceipt,
    gpuPassTimingOptions,
    timingObservationStore,
    observeTiming,
    lodObservationValidity,
    renderTargetHost,
    receiptTimings,
  } = context;
  const { receiptObservationCaptures, receiptObservationBuffers, destroyedObservationBuffers } =
    context.observationOwner;
  const stale = staleObservationReceipt(receipt);
  if (stale !== undefined) return err(stale);
  const includesDomain = (request.include as readonly string[]).some(isFrameObservationDomain);
  const includesLodOcclusion = request.include.includes('lod-occlusion');
  const includesDraws = request.include.includes('draws');
  const includesReadback =
    (request.targetReadbacks?.length ?? 0) > 0 || (request.framebufferSnapshots?.length ?? 0) > 0;
  let timingObservation: GpuPassTimingObservation | undefined;
  if (
    (includesDomain || includesReadback) &&
    gpuPassTimingOptions !== undefined &&
    request.include.includes('timings')
  ) {
    const timingResult =
      timingObservationStore === undefined
        ? await observeGpuPassTimingDisabled(receipt, request, () => context.currentGeneration())
        : await timingObservationStore.observe(receipt, request);
    if (!timingResult.ok) return timingResult;
    timingObservation = timingResult.value.timings;
  }
  if (
    gpuPassTimingOptions !== undefined &&
    !includesDomain &&
    !includesReadback &&
    !includesLodOcclusion &&
    !includesDraws
  ) {
    return timingObservationStore === undefined
      ? observeTiming(receipt, request, () => context.currentGeneration())
      : timingObservationStore.observe(receipt, request);
  }
  const completed = await receipt.completed;
  if (!completed.ok) return completed;
  const staleAfterCompletion = staleObservationReceipt(receipt);
  if (staleAfterCompletion !== undefined) return err(staleAfterCompletion);
  const requestedDomains = (request.include as readonly string[]).filter(isFrameObservationDomain);
  let observations: FrameReceiptObservation['observations'];
  if (requestedDomains.length > 0) {
    if (new Set(requestedDomains).size !== requestedDomains.length) {
      return err(
        new RendererContractFailureError(
          'observe',
          'each receipt-bound color domain may be requested only once',
        ),
      );
    }
    const readCaptures = receiptObservationCaptures.get(receipt);
    receiptObservationCaptures.delete(receipt);
    if (readCaptures === undefined) {
      return err(
        new RendererContractFailureError(
          'observe',
          'receipt-bound color-domain observations were not explicitly armed before draw, are stale, duplicated, or unavailable',
        ),
      );
    }
    const capturesResult = await readCaptures();
    const receiptCaptures = receiptObservationBuffers.get(receipt);
    if (receiptCaptures?.every((capture) => destroyedObservationBuffers.has(capture.buffer))) {
      receiptObservationBuffers.delete(receipt);
    }
    if (!capturesResult.ok) return capturesResult;
    const staleAfterReadback = staleObservationReceipt(receipt);
    if (staleAfterReadback !== undefined) return err(staleAfterReadback);
    const projected = projectReceiptColorObservations(
      receipt,
      capturesResult.value,
      requestedDomains,
      context.backendKind(),
    );
    if (!projected.ok) return projected;
    observations = projected.value;
  }
  let lodOcclusion: LodOcclusionReceiptObservation | undefined;
  let lodCaptureState: RendererReceiptLodCaptureState | undefined;
  {
    // This readback also publishes Surface GPU draw membership for ordinary observations.
    const captureState = context.latestLodObservation();
    lodCaptureState = captureState;
    if (captureState?.receipt !== receipt || context.latestReceipt() !== receipt) {
      lodOcclusion = unavailableLodObservation('superseded');
    } else if (captureState.error !== undefined) {
      return err(captureState.error);
    } else if (captureState.observation !== undefined) {
      const validity = lodObservationValidity(captureState, receipt);
      const failure = lodObservationCaptureFailure(captureState.capture, validity);
      if (failure !== undefined) {
        lodOcclusion = unavailableLodObservation(failure, captureState.observation.views);
      } else if (
        !cachedLodObservationMatchesCapture(captureState.capture, captureState.observation)
      ) {
        lodOcclusion = unavailableLodObservation(
          'lod-readback-unavailable',
          captureState.observation.views,
        );
      } else {
        lodOcclusion = captureState.observation;
      }
      captureState.observation = lodOcclusion;
    } else {
      captureState.promise ??= observeLodOcclusionCapture(
        receipt,
        captureState.capture,
        lodObservationValidity(captureState, receipt),
      );
      try {
        lodOcclusion = await captureState.promise;
        captureState.observation = lodOcclusion;
      } catch (cause) {
        if (cause instanceof RendererOperationError) {
          captureState.error = cause;
          return err(cause);
        }
        const detail =
          cause instanceof Error
            ? {
                code: cause.name,
                expected: cause.message,
                hint: 'inspect the Render LOD readback owner',
              }
            : {
                code: 'unknown',
                expected: String(cause),
                hint: 'inspect the Render LOD readback owner',
              };
        const error = new RendererOperationError('device-operation-failed', {
          operation: 'complete-frame',
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          cause: detail,
        });
        captureState.error = error;
        return err(error);
      }
    }
  }
  if (!includesLodOcclusion) lodOcclusion = undefined;
  const targetReadbacks =
    request.targetReadbacks === undefined || request.targetReadbacks.length === 0
      ? undefined
      : await renderTargetHost.observeTargetReadbacks(receipt, request.targetReadbacks);
  if (targetReadbacks !== undefined && !targetReadbacks.ok) return targetReadbacks;
  const snapshots = await renderTargetHost.observeFramebufferSnapshots(
    receipt,
    request.framebufferSnapshots ?? [],
  );
  if (!snapshots.ok) return snapshots;
  const volumeTimings = request.include.includes('timings')
    ? await (receiptTimings.get(receipt) ??
        Promise.resolve<VolumeTimingObservation>({
          status: 'unavailable',
          reason: 'timestamp capture was not requested for this frame',
        }))
    : undefined;
  const observation = await observeTiming(receipt, request, () => context.currentGeneration());
  if (!observation.ok) return observation;
  const staleAfterObservation = staleObservationReceipt(receipt);
  if (staleAfterObservation !== undefined) return err(staleAfterObservation);
  if (
    includesLodOcclusion &&
    lodCaptureState !== undefined &&
    lodCaptureState.receipt === receipt &&
    lodOcclusion !== undefined
  ) {
    const validity = lodObservationValidity(lodCaptureState, receipt);
    const failure = lodObservationCaptureFailure(lodCaptureState.capture, validity);
    if (failure !== undefined) {
      lodOcclusion = unavailableLodObservation(failure, lodOcclusion.views);
    } else if (!cachedLodObservationMatchesCapture(lodCaptureState.capture, lodOcclusion)) {
      lodOcclusion = unavailableLodObservation('lod-readback-unavailable', lodOcclusion.views);
    }
    lodCaptureState.observation = lodOcclusion;
  }
  const latestLodObservation = context.latestLodObservation();
  let draws = includesDraws
    ? observeMaterialDraws(
        latestLodObservation?.receipt === receipt ? latestLodObservation.capture : undefined,
        latestLodObservation?.receipt === receipt ? latestLodObservation.draws : undefined,
        lodObservationValidity(
          latestLodObservation ?? { receipt, capture: undefined, draws: undefined },
          receipt,
        ),
        context.isCaptureGenerationCurrent(),
      )
    : undefined;
  // Draws and LOD share one metadata budget, not two independent allowances.
  if (
    draws !== undefined &&
    new TextEncoder().encode(JSON.stringify({ draws, lodOcclusion })).byteLength >
      MAX_RECEIPT_OBSERVATION_BYTES
  ) {
    draws = unavailableDrawObservation('snapshot-too-large');
    if (lodOcclusion !== undefined) lodOcclusion = unavailableLodObservation('snapshot-too-large');
  }
  return ok(
    Object.freeze({
      ...observation.value,
      ...(targetReadbacks === undefined
        ? {}
        : { targetReadbacks: Object.freeze(targetReadbacks.value) }),
      ...(request.framebufferSnapshots === undefined
        ? {}
        : { framebufferSnapshots: snapshots.value }),
      ...(timingObservation === undefined ? {} : { timings: timingObservation }),
      ...(volumeTimings === undefined ? {} : { volumeTimings }),
      ...(lodOcclusion === undefined ? {} : { lodOcclusion }),
      ...(draws === undefined ? {} : { draws }),
      ...(observations === undefined ? {} : { observations }),
    }),
  );
}
