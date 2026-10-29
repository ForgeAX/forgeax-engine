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

type DrawObservation = ReturnType<typeof observeMaterialDraws>;

function requestsTargetReadback(request: FrameObservationRequest): boolean {
  return (
    (request.targetReadbacks?.length ?? 0) > 0 || (request.framebufferSnapshots?.length ?? 0) > 0
  );
}

/** Pass timings ride along a frame-data observation only when explicitly requested. */
function attachesPassTimings(
  request: FrameObservationRequest,
  context: RendererReceiptObservationContext,
  includesFrameData: boolean,
): boolean {
  return (
    includesFrameData &&
    context.gpuPassTimingOptions !== undefined &&
    request.include.includes('timings')
  );
}

async function observeAttachedPassTimings(
  receipt: FrameReceipt,
  request: FrameObservationRequest,
  context: RendererReceiptObservationContext,
): Promise<RenderResult<GpuPassTimingObservation | undefined, RenderError>> {
  const timingResult =
    context.timingObservationStore === undefined
      ? await observeGpuPassTimingDisabled(receipt, request, () => context.currentGeneration())
      : await context.timingObservationStore.observe(receipt, request);
  if (!timingResult.ok) return timingResult;
  return ok(timingResult.value.timings);
}

/** A timing-enabled request without frame data, LOD or draws needs only the timing owner. */
function isTimingOnlyRequest(
  context: RendererReceiptObservationContext,
  includesFrameData: boolean,
  includesLodOcclusion: boolean,
  includesDraws: boolean,
): boolean {
  return (
    context.gpuPassTimingOptions !== undefined &&
    !includesFrameData &&
    !includesLodOcclusion &&
    !includesDraws
  );
}

function observeTimingOnly(
  receipt: FrameReceipt,
  request: FrameObservationRequest,
  context: RendererReceiptObservationContext,
): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
  return context.timingObservationStore === undefined
    ? context.observeTiming(receipt, request, () => context.currentGeneration())
    : context.timingObservationStore.observe(receipt, request);
}

/** Read and project the receipt-bound color domains armed before draw. */
async function observeReceiptColorDomains(
  receipt: FrameReceipt,
  requestedDomains: readonly RenderPipelineObservationCapture['domain'][],
  context: RendererReceiptObservationContext,
): Promise<RenderResult<NonNullable<FrameReceiptObservation['observations']>, RenderError>> {
  if (new Set(requestedDomains).size !== requestedDomains.length) {
    return err(
      new RendererContractFailureError(
        'observe',
        'each receipt-bound color domain may be requested only once',
      ),
    );
  }
  const { receiptObservationCaptures, receiptObservationBuffers, destroyedObservationBuffers } =
    context.observationOwner;
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
  const staleAfterReadback = context.staleObservationReceipt(receipt);
  if (staleAfterReadback !== undefined) return err(staleAfterReadback);
  return projectReceiptColorObservations(
    receipt,
    capturesResult.value,
    requestedDomains,
    context.backendKind(),
  );
}

/**
 * A cached LOD observation stays valid only while its capture still matches;
 * otherwise it degrades to an unavailable observation keeping its views.
 */
function revalidateLodObservation(
  state: RendererReceiptLodCaptureState,
  receipt: FrameReceipt,
  observation: LodOcclusionReceiptObservation,
  context: RendererReceiptObservationContext,
): LodOcclusionReceiptObservation {
  const validity = context.lodObservationValidity(state, receipt);
  const failure = lodObservationCaptureFailure(state.capture, validity);
  if (failure !== undefined) return unavailableLodObservation(failure, observation.views);
  if (!cachedLodObservationMatchesCapture(state.capture, observation))
    return unavailableLodObservation('lod-readback-unavailable', observation.views);
  return observation;
}

/** Foreign LOD readback failures become one structured device-operation error. */
function lodReadbackOperationError(
  cause: unknown,
  receipt: FrameReceipt,
): RendererExpectedOperationError {
  if (cause instanceof RendererOperationError) return cause;
  const detail =
    cause instanceof Error
      ? { code: cause.name, expected: cause.message, hint: 'inspect the Render LOD readback owner' }
      : { code: 'unknown', expected: String(cause), hint: 'inspect the Render LOD readback owner' };
  return new RendererOperationError('device-operation-failed', {
    operation: 'complete-frame',
    frameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
    cause: detail,
  });
}

/**
 * The receipt's LOD occlusion when it is already decided: superseded, latched
 * failure, or a revalidated cached observation. `undefined` means this
 * receipt's readback is still pending. The readback also publishes Surface GPU
 * draw membership for ordinary observations, so it runs for every request.
 */
function settledReceiptLodOcclusion(
  receipt: FrameReceipt,
  state: RendererReceiptLodCaptureState | undefined,
  context: RendererReceiptObservationContext,
): RenderResult<LodOcclusionReceiptObservation, RenderError> | undefined {
  if (state?.receipt !== receipt || context.latestReceipt() !== receipt)
    return ok(unavailableLodObservation('superseded'));
  if (state.error !== undefined) return err(state.error);
  if (state.observation === undefined) return undefined;
  const observation = revalidateLodObservation(state, receipt, state.observation, context);
  state.observation = observation;
  return ok(observation);
}

/** Await (once) the receipt's pending LOD readback, latching its observation or failure. */
async function awaitReceiptLodReadback(
  receipt: FrameReceipt,
  state: RendererReceiptLodCaptureState | undefined,
  context: RendererReceiptObservationContext,
): Promise<RenderResult<LodOcclusionReceiptObservation, RenderError>> {
  if (state === undefined) return ok(unavailableLodObservation('superseded'));
  state.promise ??= observeLodOcclusionCapture(
    receipt,
    state.capture,
    context.lodObservationValidity(state, receipt),
  );
  try {
    const observation = await state.promise;
    state.observation = observation;
    return ok(observation);
  } catch (cause) {
    const error = lodReadbackOperationError(cause, receipt);
    state.error = error;
    return err(error);
  }
}

/** Target readbacks and framebuffer snapshots requested for this receipt. */
async function observeReceiptReadbacks(
  receipt: FrameReceipt,
  request: FrameObservationRequest,
  renderTargetHost: RendererReceiptObservationContext['renderTargetHost'],
): Promise<
  RenderResult<
    Pick<FrameReceiptObservation, 'targetReadbacks' | 'framebufferSnapshots'>,
    RenderError
  >
> {
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
  return ok({
    ...(targetReadbacks === undefined
      ? {}
      : { targetReadbacks: Object.freeze(targetReadbacks.value) }),
    ...(request.framebufferSnapshots === undefined
      ? {}
      : { framebufferSnapshots: snapshots.value }),
  });
}

function receiptVolumeTimings(
  receipt: FrameReceipt,
  receiptTimings: RendererReceiptObservationContext['receiptTimings'],
): Promise<VolumeTimingObservation> {
  return (
    receiptTimings.get(receipt) ??
    Promise.resolve<VolumeTimingObservation>({
      status: 'unavailable',
      reason: 'timestamp capture was not requested for this frame',
    })
  );
}

/** Draw membership for the latest capture of this receipt. */
function observeReceiptDraws(
  receipt: FrameReceipt,
  context: RendererReceiptObservationContext,
): DrawObservation {
  const latest = context.latestLodObservation();
  const current = latest?.receipt === receipt ? latest : undefined;
  return observeMaterialDraws(
    current?.capture,
    current?.draws,
    context.lodObservationValidity(
      latest ?? { receipt, capture: undefined, draws: undefined },
      receipt,
    ),
    context.isCaptureGenerationCurrent(),
  );
}

/**
 * Final LOD and draw metadata after the timing observation: a still-current
 * capture revalidates its LOD observation, and draws plus LOD share one
 * metadata budget rather than two independent allowances.
 */
function receiptLodAndDraws(
  receipt: FrameReceipt,
  context: RendererReceiptObservationContext,
  lodCaptureState: RendererReceiptLodCaptureState | undefined,
  requestedLodOcclusion: LodOcclusionReceiptObservation | undefined,
  includesDraws: boolean,
): Pick<FrameReceiptObservation, 'lodOcclusion' | 'draws'> {
  let lodOcclusion = requestedLodOcclusion;
  if (lodOcclusion !== undefined && lodCaptureState?.receipt === receipt) {
    lodOcclusion = revalidateLodObservation(lodCaptureState, receipt, lodOcclusion, context);
    lodCaptureState.observation = lodOcclusion;
  }
  if (!includesDraws) return lodOcclusion === undefined ? {} : { lodOcclusion };
  const draws = observeReceiptDraws(receipt, context);
  if (
    new TextEncoder().encode(JSON.stringify({ draws, lodOcclusion })).byteLength <=
    MAX_RECEIPT_OBSERVATION_BYTES
  )
    return lodOcclusion === undefined ? { draws } : { lodOcclusion, draws };
  const tooLarge = unavailableDrawObservation('snapshot-too-large');
  return lodOcclusion === undefined
    ? { draws: tooLarge }
    : { lodOcclusion: unavailableLodObservation('snapshot-too-large'), draws: tooLarge };
}

/** Observe one issued receipt, rechecking its live owners after asynchronous work. */
export async function observeRendererReceipt(
  receipt: FrameReceipt,
  request: FrameObservationRequest,
  context: RendererReceiptObservationContext,
): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
  const { staleObservationReceipt } = context;
  const stale = staleObservationReceipt(receipt);
  if (stale !== undefined) return err(stale);
  const requestedDomains = (request.include as readonly string[]).filter(isFrameObservationDomain);
  const includesLodOcclusion = request.include.includes('lod-occlusion');
  const includesDraws = request.include.includes('draws');
  const includesFrameData = requestedDomains.length > 0 || requestsTargetReadback(request);
  let timings: GpuPassTimingObservation | undefined;
  if (attachesPassTimings(request, context, includesFrameData)) {
    const attached = await observeAttachedPassTimings(receipt, request, context);
    if (!attached.ok) return attached;
    timings = attached.value;
  }
  if (isTimingOnlyRequest(context, includesFrameData, includesLodOcclusion, includesDraws))
    return observeTimingOnly(receipt, request, context);
  const completed = await receipt.completed;
  if (!completed.ok) return completed;
  const staleAfterCompletion = staleObservationReceipt(receipt);
  if (staleAfterCompletion !== undefined) return err(staleAfterCompletion);
  let observations: FrameReceiptObservation['observations'];
  if (requestedDomains.length > 0) {
    const projected = await observeReceiptColorDomains(receipt, requestedDomains, context);
    if (!projected.ok) return projected;
    observations = projected.value;
  }
  const lodCaptureState = context.latestLodObservation();
  const lod =
    settledReceiptLodOcclusion(receipt, lodCaptureState, context) ??
    (await awaitReceiptLodReadback(receipt, lodCaptureState, context));
  if (!lod.ok) return lod;
  const readbacks = await observeReceiptReadbacks(receipt, request, context.renderTargetHost);
  if (!readbacks.ok) return readbacks;
  const volumeTimings = request.include.includes('timings')
    ? await receiptVolumeTimings(receipt, context.receiptTimings)
    : undefined;
  const observation = await context.observeTiming(receipt, request, () =>
    context.currentGeneration(),
  );
  if (!observation.ok) return observation;
  const staleAfterObservation = staleObservationReceipt(receipt);
  if (staleAfterObservation !== undefined) return err(staleAfterObservation);
  return ok(
    Object.freeze({
      ...observation.value,
      ...readbacks.value,
      ...(timings === undefined ? {} : { timings }),
      ...(volumeTimings === undefined ? {} : { volumeTimings }),
      ...receiptLodAndDraws(
        receipt,
        context,
        lodCaptureState,
        includesLodOcclusion ? lod.value : undefined,
        includesDraws,
      ),
      ...(observations === undefined ? {} : { observations }),
    }),
  );
}
