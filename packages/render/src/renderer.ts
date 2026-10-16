import { err, ok } from '@forgeax/engine-types';
import type { RenderError } from './errors/render.js';
import { FrameReceiptStaleError } from './errors/render.js';
import type {
  GpuPassTimingObservation,
  GpuPassTimingReason,
  GpuPassTimingRef,
} from './record/gpu-pass-timing/index.js';
import type {
  FrameObservationRequest,
  FrameReceipt,
  FrameReceiptObservation,
  RenderResult,
} from './render-contract.js';

/**
 * Internal Render producer callback; public callers receive only frozen facts.
 * The callback is receipt-bound and never exposes RHI handles or query state.
 */
export type GpuPassTimingObservationSource = () => Promise<GpuPassTimingObservation>;

/**
 * Receipt observation seam for the public `draw()` then `observe()` route.
 * `status`, `completeness`, and `latestKnownGood` are separate projections;
 * pass duration is not frame latency. Timing errors retain the closed code,
 * expected, hint, and detail fields so a caller can follow producer recovery.
 * See the bounded contract and fail-closed validator in the GPU pass timing
 * record and benchmark modules.
 */
export interface GpuPassTimingObservationStore {
  register(receipt: FrameReceipt, source?: GpuPassTimingObservationSource): void;
  observe(
    receipt: FrameReceipt,
    request: FrameObservationRequest,
  ): Promise<RenderResult<FrameReceiptObservation, RenderError>>;
  inspect(): {
    readonly status: GpuPassTimingObservation['status'];
    readonly completeness: 'complete' | 'partial' | 'unavailable' | 'failed';
    readonly latestKnownGood?: GpuPassTimingRef | undefined;
  };
}

/**
 * Preserve the receipt observation contract without constructing the timing
 * retention store when GPU timing was not opted in.
 */
export async function observeGpuPassTimingDisabled(
  receipt: FrameReceipt,
  request: FrameObservationRequest,
  currentDeviceGeneration: () => number,
): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
  const completed = await receipt.completed;
  if (!completed.ok) return completed;
  if (receipt.deviceGeneration !== currentDeviceGeneration()) {
    return err(
      new FrameReceiptStaleError({
        frameId: receipt.frameId,
        receiptGeneration: receipt.deviceGeneration,
        currentGeneration: currentDeviceGeneration(),
      }),
    );
  }
  const base = {
    frameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
    include: freeze([...request.include]),
  } as const;
  if (!request.include.includes('timings')) return ok(freeze(base));
  return ok(freeze({ ...base, timings: notEnabled }));
}

interface ReceiptRecord {
  readonly source: GpuPassTimingObservationSource;
}

interface ObservationStoreOptions {
  readonly retentionFrames: number;
  readonly currentDeviceGeneration: () => number;
}

const notEnabled: GpuPassTimingObservation = {
  status: 'unavailable',
  reason: {
    code: 'gpu-timing-not-enabled',
    expected: 'gpuPassTiming is enabled in RendererOptions',
    hint: 'set RendererOptions.gpuPassTiming to opt into bounded timing facts',
    detail: {},
  },
  capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
};

function failedObservation(
  error: GpuPassTimingReason,
  latestKnownGood?: GpuPassTimingRef,
): GpuPassTimingObservation {
  return {
    status: 'failed',
    error,
    ...(latestKnownGood === undefined ? {} : { latestKnownGood }),
  };
}

function retentionExpired(): GpuPassTimingObservation {
  return failedObservation({
    code: 'timing-retention-expired',
    expected: 'the requested receipt remains inside the bounded timing retention window',
    hint: 'observe a newer receipt before the retention window expires',
    detail: {},
  });
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return value;
}

/**
 * Keep receipt-bound observations in a bounded Render-owned retention ring.
 * This helper does not expose RHI handles, query objects, or a timing
 * controller; the public lifecycle remains `draw` then `observe`.
 * Omitting `timings` from the observation request does not materialize facts.
 */
export function createGpuPassTimingObservationStore(
  options: ObservationStoreOptions,
): GpuPassTimingObservationStore {
  const records = new Map<FrameReceipt, ReceiptRecord>();
  const order: FrameReceipt[] = [];
  const expired = new WeakSet<FrameReceipt>();
  let latestKnownGood: GpuPassTimingRef | undefined;
  let currentStatus: GpuPassTimingObservation['status'] = 'unavailable';
  let currentCompleteness: 'complete' | 'partial' | 'unavailable' | 'failed' = 'unavailable';

  const evict = (): void => {
    while (order.length > options.retentionFrames) {
      const old = order.shift();
      if (old === undefined) break;
      records.delete(old);
      expired.add(old);
    }
  };

  return {
    register(receipt, source): void {
      records.set(receipt, { source: source ?? (async () => notEnabled) });
      order.push(receipt);
      evict();
    },
    async observe(receipt, request): Promise<RenderResult<FrameReceiptObservation, RenderError>> {
      const record = records.get(receipt);
      if (record === undefined) {
        if (expired.has(receipt) && request.include.includes('timings')) {
          return ok(
            freeze({
              frameId: receipt.frameId,
              deviceGeneration: receipt.deviceGeneration,
              include: freeze([...request.include]),
              timings: retentionExpired(),
            }),
          );
        }
        return err(
          new FrameReceiptStaleError({
            frameId: receipt.frameId,
            receiptGeneration: receipt.deviceGeneration,
            currentGeneration: options.currentDeviceGeneration(),
          }),
        );
      }
      const completed = await receipt.completed;
      if (!completed.ok) return completed;
      if (receipt.deviceGeneration !== options.currentDeviceGeneration()) {
        return err(
          new FrameReceiptStaleError({
            frameId: receipt.frameId,
            receiptGeneration: receipt.deviceGeneration,
            currentGeneration: options.currentDeviceGeneration(),
          }),
        );
      }
      const base = {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        include: freeze([...request.include]),
      } as const;
      if (!request.include.includes('timings')) return ok(freeze(base));
      let timings: GpuPassTimingObservation;
      try {
        timings = await record.source();
      } catch (cause) {
        timings = failedObservation(
          {
            code: 'timestamp-readback-failed',
            expected: 'the Render-owned timing observation completes without throwing',
            hint: 'observe a later receipt and inspect latestKnownGood',
            detail: { frameId: receipt.frameId },
            cause: { message: cause instanceof Error ? cause.message : String(cause) },
          },
          latestKnownGood,
        );
      }
      currentStatus = timings.status;
      currentCompleteness = timings.status;
      if (timings.status === 'complete') {
        latestKnownGood = {
          frameId: timings.frame.frameId,
          deviceGeneration: timings.frame.deviceGeneration,
          graphGeneration: timings.frame.graphGeneration,
        };
      }
      return ok(freeze({ ...base, timings }));
    },
    inspect() {
      return freeze({
        status: currentStatus,
        completeness: currentCompleteness,
        latestKnownGood,
      });
    },
  };
}
