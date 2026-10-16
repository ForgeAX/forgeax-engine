import type { PackageFetcher, PackageRequest, PackageResponse } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { traceAssetLoadPhase } from '../registry/load-trace.js';

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

/** Read one package resource in full through `body`, so a body reset is retried too. */
export async function readPackage<T>(
  fetcher: PackageFetcher,
  url: string,
  body: (response: PackageResponse) => Promise<T>,
  init?: PackageRequest,
): Promise<Result<T, PackageReadFailure>> {
  const trace = (phase: string) =>
    traceAssetLoadPhase(phase, {
      packageUrl: url,
      detail: { activeTransfers: pendingTransfers, queuedTransfers: transferWaiters.length },
    });
  trace('package.slot.wait');
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
    return await readPackageTransfer(fetcher, url, body, init);
  } finally {
    release();
    trace('package.transfer.complete');
  }
}

async function readPackageTransfer<T>(
  fetcher: PackageFetcher,
  url: string,
  body: (response: PackageResponse) => Promise<T>,
  init?: PackageRequest,
): Promise<Result<T, PackageReadFailure>> {
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
        const value = await body(response);
        traceAssetLoadPhase('package.body.complete', { packageUrl: url });
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

export const bytesOf = async (response: PackageResponse): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());
export const jsonOf = (response: PackageResponse): Promise<unknown> => response.json();
