import type { PackageFetcher, PackageRequest, PackageResponse } from '@forgeax/engine-types';
import {
  addLoadWork,
  err,
  loadTimelineNow,
  ok,
  type Result,
  recordLoadTimeline,
} from '@forgeax/engine-types';
import { traceAssetLoadPhase } from '../registry/load-trace.js';
import { readDocumentJson } from './retained-pack-json.js';

// Public gateways drop idempotent package GETs, including HTTP/2 streams reset
// mid-body. Every catalog, Pack, artifact, and loader-binary read shares this
// bounded recovery: interrupted transfers (fetch's TypeError) and transient
// statuses retry after these delays, bypassing a possibly poisoned HTTP cache.
// Aborts, permanent statuses, and fetcher-specific failures surface at once.
const RETRY_DELAYS_MS = [250, 750] as const;
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export type { PackageFetcher } from '@forgeax/engine-types';

// Recursive asset graphs can start thousands of artifact reads together.
// Hold a slot through body consumption, rather than just response headers.
const MAX_PENDING_TRANSFERS = 32;
let pendingTransfers = 0;
const transferWaiters: Array<() => void> = [];

function releaseTransfer(): void {
  const next = transferWaiters.shift();
  if (next === undefined) pendingTransfers--;
  else next();
}

async function transferSlot(signal?: AbortSignal | null): Promise<(() => void) | undefined> {
  if (signal?.aborted) return undefined;
  if (pendingTransfers < MAX_PENDING_TRANSFERS) {
    pendingTransfers++;
    return releaseTransfer;
  }
  return new Promise((resolve) => {
    const ready = () => {
      signal?.removeEventListener('abort', aborted);
      resolve(releaseTransfer);
    };
    const aborted = () => {
      const index = transferWaiters.indexOf(ready);
      if (index >= 0) transferWaiters.splice(index, 1);
      signal?.removeEventListener('abort', aborted);
      resolve(undefined);
    };
    transferWaiters.push(ready);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export interface PackageReadFailure {
  /** Last observation, e.g. `HTTP 404` or `TypeError: network error`. */
  readonly observed: string;
  readonly attempts: number;
  /** The transfer completed but `body` rejected its content (e.g. invalid JSON). */
  readonly malformed: boolean;
}

function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Load progress item: the file name of a package URL. */
function itemName(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  return path.slice(path.lastIndexOf('/') + 1) || url;
}

/** Transfer size announced by response headers (compressed size when encoded). */
interface TransferSize {
  bytes: number;
}

/**
 * Read one package resource in full through `body`, so a body reset is retried
 * too. Each read is one unit of `downloads` load work, sized by Content-Length.
 */
export async function readPackage<T>(
  fetcher: PackageFetcher,
  url: string,
  body: (response: PackageResponse) => Promise<T>,
  init?: PackageRequest,
): Promise<Result<T, PackageReadFailure>> {
  addLoadWork('downloads', { total: 1, item: itemName(url) });
  const size: TransferSize = { bytes: 0 };
  try {
    return await readAdmittedPackage(fetcher, url, body, init, size);
  } finally {
    addLoadWork('downloads', { done: 1, bytes: size.bytes });
  }
}

async function readAdmittedPackage<T>(
  fetcher: PackageFetcher,
  url: string,
  body: (response: PackageResponse) => Promise<T>,
  init: PackageRequest | undefined,
  size: TransferSize,
): Promise<Result<T, PackageReadFailure>> {
  const trace = (phase: string) =>
    traceAssetLoadPhase(phase, {
      packageUrl: url,
      detail: { activeTransfers: pendingTransfers, queuedTransfers: transferWaiters.length },
    });
  trace('package.slot.wait');
  const requested = loadTimelineNow();
  const release = await transferSlot(init?.signal);
  if (release === undefined) {
    trace('package.transfer.complete');
    return err({ observed: 'AbortError: aborted', attempts: 0, malformed: false });
  }
  trace('package.slot.admitted');
  try {
    if (init?.signal?.aborted) {
      return err({ observed: 'AbortError: aborted', attempts: 0, malformed: false });
    }
    return await readPackageTransfer(fetcher, url, body, init, size, requested);
  } finally {
    release();
    trace('package.transfer.complete');
  }
}

async function readPackageTransfer<T>(
  fetcher: PackageFetcher,
  url: string,
  body: (response: PackageResponse) => Promise<T>,
  init: PackageRequest | undefined,
  size: TransferSize,
  requested: number,
): Promise<Result<T, PackageReadFailure>> {
  const admitted = loadTimelineNow();
  for (let attempt = 1; ; attempt++) {
    let observed: string;
    let retryable: boolean;
    let malformed = false;
    let response: PackageResponse | undefined;
    try {
      response = await (attempt === 1
        ? init === undefined
          ? fetcher(url)
          : fetcher(url, init)
        : fetcher(url, { cache: 'reload', ...init }));
      traceAssetLoadPhase('package.headers.complete', { packageUrl: url });
      if (response.ok) {
        announceSize(response, size);
        const value = await body(response);
        traceAssetLoadPhase('package.body.complete', { packageUrl: url });
        recordPackageFetch(url, requested, admitted, attempt, value, response);
        return ok(value);
      }
      observed = `HTTP ${response.status}`;
      retryable = TRANSIENT_STATUS.has(response.status);
    } catch (cause) {
      observed = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      retryable = cause instanceof TypeError;
      malformed = response?.ok === true && !retryable;
    }
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (!retryable || delay === undefined || init?.signal?.aborted) {
      return err({ observed, attempts: attempt, malformed });
    }
    if (response !== undefined && !response.bodyUsed) {
      try {
        await response.body?.cancel();
      } catch {
        // The retry below remains authoritative.
      }
    }
    await pause(delay, init?.signal);
    if (init?.signal?.aborted) return err({ observed, attempts: attempt, malformed });
  }
}

function announceSize(response: PackageResponse, size: TransferSize): void {
  const length = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (size.bytes > 0 || !Number.isFinite(length) || length <= 0) return;
  size.bytes = length;
  addLoadWork('downloads', { totalBytes: length });
}
/**
 * Load timeline span from transfer-slot admission to body completion. `bytes`
 * is the decoded body length of binary reads; `contentLength` is the response
 * header (the transfer size when the server compresses), when present.
 */
function recordPackageFetch(
  url: string,
  requested: number,
  admitted: number,
  attempts: number,
  value: unknown,
  response: PackageResponse,
): void {
  let contentLength = Number.NaN;
  try {
    // Native and test fetchers may omit headers; diagnostics never fail a completed read.
    contentLength = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  } catch {}
  recordLoadTimeline(
    'fetch',
    url,
    admitted,
    loadTimelineNow(),
    ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? value.byteLength : undefined,
    {
      queuedMs: admitted - requested,
      attempts,
      ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    },
  );
}

export const bytesOf = async (response: PackageResponse): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());
export const jsonOf = (response: PackageResponse): Promise<unknown> => readDocumentJson(response);
