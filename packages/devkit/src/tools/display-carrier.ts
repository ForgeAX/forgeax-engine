import type { Frame, Page } from 'playwright';

/** Identity owned by the Engine run service and echoed by a borrowed carrier. */
export interface BrowserCarrierRunIdentity {
  readonly serviceId: string;
  readonly runId: string;
}

/** Stable identity returned by a display carrier; never infer it from URL/page order. */
export interface BrowserCarrierTarget {
  readonly leaseId: string;
  readonly targetId: string;
  readonly kind: string;
  /** Stable DOM id of the exact carrier surface allocated for this lease. */
  readonly surfaceId: string;
  readonly run: BrowserCarrierRunIdentity;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly gpu: 'auto' | 'hardware' | 'software';
}

export interface BrowserCarrierRequest
  extends Pick<BrowserCarrierTarget, 'run' | 'generation' | 'gpu' | 'width' | 'height'> {
  readonly headless: boolean;
  readonly url: string;
}

export interface BrowserCarrierFallback {
  readonly carrier: 'private-browser';
  readonly fallbackReason: string;
  readonly message?: string;
}

export interface BrowserCarrierLeaseSelection {
  readonly carrier: 'borrowed';
  readonly target: BrowserCarrierTarget;
  /** Release only this borrowed page; never close the carrier host. */
  readonly release: (reason?: string) => Promise<void>;
}

export type BrowserCarrierSelection = BrowserCarrierFallback | BrowserCarrierLeaseSelection;

/**
 * The browser document that owns a carrier lease is not necessarily the
 * Engine execution realm. A display host can keep its outer document stable and give
 * a run one exact child Frame; the Frame is then the only realm that DevKit
 * navigates or observes for that run.
 */
export type BrowserExecutionTarget =
  | {
      readonly kind: 'page';
      readonly ownerPage: Page;
      readonly realm: Page;
    }
  | {
      readonly kind: 'frame';
      readonly ownerPage: Page;
      readonly realm: Frame;
      /** Exact outer iframe selector used to make a hidden target capturable. */
      readonly surfaceSelector: string;
    };

/** Exact browser attachment returned by the owning browser implementation. */
export interface BrowserCarrierAttachment {
  /** Stable outer page owned by the embedding browser/display host. */
  readonly page: Page;
  readonly target: BrowserCarrierTarget;
  /** Exact realm that Engine navigates, observes, and captures for this run. */
  readonly execution: BrowserExecutionTarget;
  readonly close: (reason?: string) => Promise<void>;
}

export interface BrowserCarrierAcquireOptions {
  readonly signal?: AbortSignal;
  /** Reason passed to the carrier when attachment fails after allocation. */
  readonly releaseReason?: string;
}

export interface BrowserCarrierAcquireResult {
  readonly attachment?: BrowserCarrierAttachment;
  readonly fallbackReason?: string;
}

/**
 * Engine-owned seam for an already-open display host.
 *
 * An existing browser-page owner provides this contract from its own package;
 * DevKit owns navigation, observations, capture, and run-service lifetime after
 * `attach` succeeds. The seam neither launches a display host nor selects a
 * browser connection transport.
 */
export interface BrowserCarrierAdapter {
  readonly select: (
    request: BrowserCarrierRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<BrowserCarrierSelection>;
  readonly attach: (
    selection: BrowserCarrierLeaseSelection,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<BrowserCarrierAttachment>;
}

export function assertBrowserCarrierTarget(target: BrowserCarrierTarget): BrowserCarrierTarget {
  if (
    target === null ||
    typeof target !== 'object' ||
    typeof target.leaseId !== 'string' ||
    target.leaseId.length === 0 ||
    typeof target.targetId !== 'string' ||
    target.targetId.length === 0 ||
    typeof target.kind !== 'string' ||
    target.kind.length === 0 ||
    typeof target.surfaceId !== 'string' ||
    !/^[_A-Za-z][_A-Za-z0-9-]*$/.test(target.surfaceId)
  )
    throw new TypeError('browser carrier target identity and surfaceId must be valid');
  if (
    target.run === null ||
    typeof target.run !== 'object' ||
    typeof target.run.serviceId !== 'string' ||
    target.run.serviceId.length === 0 ||
    typeof target.run.runId !== 'string' ||
    target.run.runId.length === 0
  )
    throw new TypeError('browser carrier run identity must be non-empty');
  if (!Number.isSafeInteger(target.generation) || target.generation < 0)
    throw new TypeError('browser carrier target generation must be non-negative');
  if (!Number.isSafeInteger(target.width) || target.width <= 0)
    throw new TypeError('browser carrier target width must be positive');
  if (!Number.isSafeInteger(target.height) || target.height <= 0)
    throw new TypeError('browser carrier target height must be positive');
  if (target.gpu !== 'auto' && target.gpu !== 'hardware' && target.gpu !== 'software')
    throw new TypeError('browser carrier target GPU mode is invalid');
  return target;
}

/**
 * Verify that an attachment still refers to the page selected for this run.
 * Presentation dimensions or the observed GPU mode may differ, but the lease,
 * target, run, and generation are immutable identity fields.
 */
export function assertBrowserCarrierTargetMatch(
  expected: BrowserCarrierTarget,
  actual: BrowserCarrierTarget,
): BrowserCarrierTarget {
  assertBrowserCarrierTarget(expected);
  assertBrowserCarrierTarget(actual);
  if (
    expected.leaseId !== actual.leaseId ||
    expected.targetId !== actual.targetId ||
    expected.kind !== actual.kind ||
    expected.surfaceId !== actual.surfaceId ||
    expected.run.serviceId !== actual.run.serviceId ||
    expected.run.runId !== actual.run.runId ||
    expected.generation !== actual.generation
  ) {
    throw new TypeError('browser carrier attachment target does not match its selection');
  }
  return actual;
}

/** Verify that the selected target is bound to the requesting service run. */
export function assertBrowserCarrierTargetForRequest(
  request: BrowserCarrierRequest,
  target: BrowserCarrierTarget,
): BrowserCarrierTarget {
  assertBrowserCarrierTarget(target);
  if (
    request.run.serviceId !== target.run.serviceId ||
    request.run.runId !== target.run.runId ||
    request.generation !== target.generation
  ) {
    throw new TypeError('browser carrier target does not match the requesting run generation');
  }
  if (
    (request.gpu === 'hardware' && target.gpu !== 'hardware') ||
    (request.gpu === 'software' && target.gpu !== 'software')
  ) {
    throw new TypeError('browser carrier target does not satisfy the requested GPU mode');
  }
  return target;
}

function hasExecutionMethods(value: unknown): value is Page | Frame {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'goto') === 'function' &&
    typeof Reflect.get(value, 'evaluate') === 'function' &&
    typeof Reflect.get(value, 'locator') === 'function' &&
    typeof Reflect.get(value, 'waitForFunction') === 'function' &&
    typeof Reflect.get(value, 'waitForTimeout') === 'function'
  );
}

/** Validate the complete owner/realm attachment before Engine starts a run. */
export function assertBrowserCarrierAttachment(
  attachment: BrowserCarrierAttachment,
): BrowserCarrierAttachment {
  if (attachment === null || typeof attachment !== 'object') {
    throw new TypeError('browser carrier attachment must be an object');
  }
  if (!hasExecutionMethods(attachment.page) || typeof attachment.close !== 'function') {
    throw new TypeError('browser carrier attachment owner page or close handle is invalid');
  }
  const execution = attachment.execution;
  if (execution === null || typeof execution !== 'object') {
    throw new TypeError('browser carrier attachment execution realm is required');
  }
  if (execution.ownerPage !== attachment.page || !hasExecutionMethods(execution.realm)) {
    throw new TypeError('browser carrier execution realm is not owned by its attachment page');
  }
  if (execution.kind === 'page') {
    if (execution.realm !== attachment.page) {
      throw new TypeError('browser carrier page execution must use its owner page');
    }
  } else if (execution.kind === 'frame') {
    if (typeof execution.realm.page !== 'function' || execution.realm.page() !== attachment.page) {
      throw new TypeError('browser carrier frame execution must belong to its owner page');
    }
    if (!/^#[A-Za-z_][A-Za-z0-9_-]*$/.test(execution.surfaceSelector)) {
      throw new TypeError('browser carrier frame surfaceSelector must be a stable id selector');
    }
    if (execution.surfaceSelector !== `#${attachment.target.surfaceId}`) {
      throw new TypeError(
        'browser carrier frame surfaceSelector does not match its target surfaceId',
      );
    }
  } else {
    throw new TypeError('browser carrier execution kind is invalid');
  }
  return attachment;
}

/**
 * Bind the capture surface to the exact execution frame. The carrier must
 * provide the iframe selector it allocated; a valid selector pointing at a
 * workspace or another iframe is still rejected when its content frame is
 * not the execution realm.
 */
export async function assertBrowserCarrierSurface(
  attachment: BrowserCarrierAttachment,
): Promise<void> {
  const execution = attachment.execution;
  if (execution.kind !== 'frame') return;
  const locator = attachment.page.locator(execution.surfaceSelector);
  if ((await locator.count()) !== 1) {
    throw new TypeError('browser carrier frame surface must resolve to exactly one element');
  }
  const handle = await locator.elementHandle();
  if (handle === null) throw new TypeError('browser carrier frame surface element is unavailable');
  try {
    const identity = await handle.evaluate((element) => ({
      tagName: element.tagName,
      id: element.id,
    }));
    if (identity.tagName !== 'IFRAME') {
      throw new TypeError('browser carrier frame surface must be an iframe');
    }
    if (identity.id !== attachment.target.surfaceId) {
      throw new TypeError('browser carrier frame surface identity does not match its target');
    }
    if ((await handle.contentFrame()) !== execution.realm) {
      throw new TypeError('browser carrier frame surface does not own its execution realm');
    }
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

function throwIfBrowserCarrierAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason !== undefined) throw reason;
  const error = new Error('The browser carrier request was aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Select and attach one exact display page, or return the carrier's explicit
 * private-browser fallback. This is the single browser-owner seam shared by
 * persistent DevKit runs and one-shot browser tools.
 */
export async function acquireBrowserCarrierPage(
  carrier: BrowserCarrierAdapter,
  request: BrowserCarrierRequest,
  options: BrowserCarrierAcquireOptions = {},
): Promise<BrowserCarrierAcquireResult> {
  const releaseReason = options.releaseReason ?? 'engine-carrier-attach-failed';
  throwIfBrowserCarrierAborted(options.signal);
  const selection = await carrier.select(request, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (options.signal?.aborted) {
    if (selection.carrier === 'borrowed')
      await selection.release(releaseReason).catch(() => undefined);
    throwIfBrowserCarrierAborted(options.signal);
  }
  if (selection.carrier === 'private-browser') return { fallbackReason: selection.fallbackReason };
  let attachmentClosed = false;
  let attached: BrowserCarrierAttachment | undefined;
  try {
    assertBrowserCarrierTargetForRequest(request, selection.target);
    attached = assertBrowserCarrierAttachment(
      await carrier.attach(selection, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
    if (options.signal?.aborted) {
      try {
        await attached.close(releaseReason);
        attachmentClosed = true;
      } catch {
        // The selection release below is the best remaining cleanup if the
        // attachment arrived after cancellation but could not close itself.
      }
      throwIfBrowserCarrierAborted(options.signal);
    }
    assertBrowserCarrierTargetMatch(selection.target, attached.target);
    await assertBrowserCarrierSurface(attached);
    return { attachment: attached };
  } catch (error) {
    if (attached !== undefined && !attachmentClosed) {
      try {
        await attached.close(releaseReason);
        attachmentClosed = true;
      } catch {
        // Release below remains the best cleanup when the attachment owner
        // cannot close its exact surface.
      }
    }
    if (!attachmentClosed) await selection.release(releaseReason).catch(() => undefined);
    throw error;
  }
}
