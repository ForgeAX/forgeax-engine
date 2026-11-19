import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import { rendererInspectionFailure } from './renderer-inspection';
import type { ExecutionHdrObservationResult } from './types';

/** Read the armed `linear-hdr` copy of one submitted receipt into detached bytes. */
export async function observeLinearHdr(
  renderer: Pick<Renderer, 'observe'>,
  receipt: FrameReceipt,
): Promise<ExecutionHdrObservationResult> {
  const observed = await renderer.observe(receipt, { include: ['linear-hdr'] });
  if (!observed.ok) return rendererInspectionFailure('inspection', observed.error);
  const domain = observed.value.observations?.find((entry) => entry.domain === 'linear-hdr');
  if (domain === undefined)
    return rendererInspectionFailure('inspection', 'linear-hdr observation missing');
  const { width, height, bytesPerRow, format } = domain.metadata;
  return {
    ok: true,
    value: {
      frameId: receipt.frameId,
      width,
      height,
      bytesPerRow,
      format,
      bytes: domain.bytes,
      ...(receipt.barrelDistortion === undefined
        ? {}
        : { barrelDistortion: receipt.barrelDistortion }),
    },
  };
}

/** Arm the Renderer for one `linear-hdr` copy; a failure is the request's final result. */
export function armLinearHdr(
  renderer: Pick<Renderer, 'requestObservation'>,
): ExecutionHdrObservationResult | undefined {
  const armed = renderer.requestObservation?.(['linear-hdr']);
  if (armed === undefined)
    return rendererInspectionFailure('inspection', 'linear-hdr observation unsupported');
  return armed.ok ? undefined : rendererInspectionFailure('inspection', armed.error);
}

/**
 * One-shot `linear-hdr` request for a Renderer owned by the same realm as its
 * frame loop. The loop calls `beforeDraw` before each draw and `submitted`
 * with each accepted receipt; ordinary frames pay one undefined check.
 */
export interface LocalHdrFrameObserver {
  request(options?: { readonly signal?: AbortSignal }): Promise<ExecutionHdrObservationResult>;
  beforeDraw(renderer: Pick<Renderer, 'requestObservation'>): void;
  submitted(renderer: Pick<Renderer, 'observe'>, receipt: FrameReceipt): void;
  /** Settle a pending request when its renderer or World ends. */
  close(): void;
}

const LOCAL_HDR_TIMEOUT_MS = 30_000;

export function createLocalHdrFrameObserver(): LocalHdrFrameObserver {
  let pending: { armed: boolean; finish(result: ExecutionHdrObservationResult): void } | undefined;
  return {
    request(options = {}) {
      if (options.signal?.aborted) return Promise.resolve(rendererInspectionFailure('cancelled'));
      if (pending !== undefined) return Promise.resolve(rendererInspectionFailure('request-limit'));
      return new Promise((resolve) => {
        const request = {
          armed: false,
          finish(result: ExecutionHdrObservationResult) {
            if (pending === request) pending = undefined;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', cancel);
            resolve(result);
          },
        };
        const cancel = () => request.finish(rendererInspectionFailure('cancelled'));
        const timer = setTimeout(
          () => request.finish(rendererInspectionFailure('timeout')),
          LOCAL_HDR_TIMEOUT_MS,
        );
        options.signal?.addEventListener('abort', cancel, { once: true });
        pending = request;
      });
    },
    beforeDraw(renderer) {
      if (pending === undefined || pending.armed) return;
      const failure = armLinearHdr(renderer);
      if (failure !== undefined) pending.finish(failure);
      else pending.armed = true;
    },
    submitted(renderer, receipt) {
      const request = pending;
      if (request === undefined || !request.armed) return;
      // Detach now: the next frame may arm a new request while this one reads back.
      pending = undefined;
      observeLinearHdr(renderer, receipt).then(
        (result) => request.finish(result),
        (cause: unknown) => request.finish(rendererInspectionFailure('inspection', cause)),
      );
    },
    close() {
      pending?.finish(rendererInspectionFailure('session-ended'));
    },
  };
}
