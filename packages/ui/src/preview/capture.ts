import type { UiInstance } from '../asset.js';
import type { UiError, UiResult } from '../errors.js';
import { uiError } from '../errors.js';
import type { UiPreviewSession } from './session.js';

/** Fixed browser viewport used as part of deterministic capture evidence. */
export interface UiPreviewViewport {
  readonly width: number;
  readonly height: number;
}

/** Browser failures that invalidate a capture even when the DOM is visible. */
export interface UiPreviewCaptureFailures {
  readonly console: readonly string[];
  readonly page: readonly string[];
  readonly request: readonly string[];
}

/** All gates that must be true before an adapter may produce PNG bytes. */
export interface UiPreviewCaptureReadiness {
  readonly viewport: boolean;
  readonly deviceScale: boolean;
  readonly fonts: boolean;
  readonly resources: boolean;
  readonly scenario: boolean;
  readonly clock: boolean;
  readonly failures: UiPreviewCaptureFailures;
}

/** The animation time frozen by the browser adapter for this capture. */
export interface UiPreviewClock {
  readonly timeMs: number;
}

export type UiPreviewCaptureClockResult =
  | UiResult<UiPreviewClock>
  | { readonly ok: false; readonly error: unknown };

/** Browser capability seam; the engine does not depend on Playwright types. */
export interface UiPreviewCaptureAdapter {
  readonly viewport: UiPreviewViewport;
  readonly deviceScaleFactor: number;
  readonly readiness: () => UiPreviewCaptureReadiness | Promise<UiPreviewCaptureReadiness>;
  readonly freezeClock: () => UiPreviewCaptureClockResult | Promise<UiPreviewCaptureClockResult>;
  readonly screenshot: () =>
    | Uint8Array
    | ArrayBuffer
    | Blob
    | UiResult<Uint8Array>
    | Promise<Uint8Array | ArrayBuffer | Blob | UiResult<Uint8Array>>;
}

/** Serializable behavior evidence paired atomically with one PNG. */
export interface UiPreviewCaptureEvidence {
  readonly viewport: UiPreviewViewport;
  readonly deviceScaleFactor: number;
  readonly clock: UiPreviewClock;
  readonly scenario: { readonly ready: boolean };
  readonly parts: readonly string[];
  readonly dom: {
    readonly hostCount: number;
    readonly html: string;
    readonly focused: boolean;
  };
  readonly resources: {
    readonly fonts: boolean;
    readonly images: number;
    readonly failures: readonly string[];
  };
  readonly lifecycle: {
    readonly state: UiPreviewSession['state'];
    readonly disposed: boolean;
  };
}

/** Successful capture payload. A failed result never contains `png`. */
export interface UiPreviewCapture {
  readonly png: Uint8Array;
  readonly evidence: UiPreviewCaptureEvidence;
}

function notReady(unmet: readonly string[]): UiResult<never> {
  const result = uiError('capture-not-ready', `capture readiness is unmet: ${unmet.join(', ')}`);
  if (result.ok) return result;
  return {
    ok: false,
    error: {
      ...result.error,
      detail: { message: result.error.detail.message, unmet },
    } as Extract<UiError, { code: 'capture-not-ready' }>,
  };
}

function captureFailure(stage: string, message: string): UiResult<never> {
  const result = uiError('capture-failed', message);
  if (result.ok) return result;
  return {
    ok: false,
    error: {
      ...result.error,
      detail: { message, stage },
    } as Extract<UiError, { code: 'capture-failed' }>,
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function screenshotBytes(
  screenshot: UiPreviewCaptureAdapter['screenshot'],
): Promise<UiResult<Uint8Array>> {
  try {
    const value = await screenshot();
    if (value instanceof Uint8Array) return { ok: true, value };
    if (value instanceof ArrayBuffer) return { ok: true, value: new Uint8Array(value) };
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return { ok: true, value: new Uint8Array(await value.arrayBuffer()) };
    }
    if (typeof value === 'object' && value !== null && 'ok' in value) {
      if (!value.ok) return captureFailure('screenshot', errorMessage(value.error));
      return value.value instanceof Uint8Array
        ? { ok: true, value: value.value }
        : captureFailure('screenshot', 'screenshot result was not a Uint8Array');
    }
    return captureFailure('screenshot', 'screenshot result was not binary data');
  } catch (cause) {
    return captureFailure('screenshot', errorMessage(cause));
  }
}

function collectEvidence(
  instance: UiInstance,
  session: UiPreviewSession,
  adapter: UiPreviewCaptureAdapter,
  clock: UiPreviewClock,
  readiness: UiPreviewCaptureReadiness,
): UiPreviewCaptureEvidence {
  const shadow = instance.host.shadowRoot;
  const parts = shadow
    ? [...shadow.querySelectorAll<HTMLElement>('[data-ui-part]')]
        .map((part) => part.dataset.uiPart)
        .filter((part): part is string => Boolean(part))
    : [];
  const parent = instance.host.parentElement;
  const hostCount = parent?.querySelectorAll('[data-ui-asset]').length ?? 0;
  const images = shadow ? [...shadow.querySelectorAll('img')].length : 0;
  const focused = shadow?.activeElement !== null && shadow?.activeElement !== undefined;
  return {
    viewport: adapter.viewport,
    deviceScaleFactor: adapter.deviceScaleFactor,
    clock,
    scenario: { ready: readiness.scenario },
    parts,
    dom: {
      hostCount,
      html: shadow?.innerHTML ?? '',
      focused,
    },
    resources: {
      fonts: readiness.fonts,
      images,
      failures: [...readiness.failures.request, ...readiness.failures.page],
    },
    lifecycle: { state: session.state, disposed: session.state === 'disposed' },
  };
}

/** Capture a mounted preview only after every readiness and failure gate passes. */
export async function captureUiPreview(
  session: UiPreviewSession,
  adapter: UiPreviewCaptureAdapter,
): Promise<UiResult<UiPreviewCapture>> {
  const instance = session.instance;
  if (session.state !== 'mounted' || !instance) return notReady(['session']);

  let readiness: UiPreviewCaptureReadiness;
  try {
    readiness = await adapter.readiness();
  } catch (cause) {
    return notReady([`readiness:${errorMessage(cause)}`]);
  }
  let clock: UiPreviewClock;
  try {
    const frozen = await adapter.freezeClock();
    if (!frozen.ok) return notReady(['clock']);
    clock = frozen.value;
  } catch {
    return notReady(['clock']);
  }
  const unmet: string[] = [];
  if (!readiness.viewport) unmet.push('viewport');
  if (!readiness.deviceScale) unmet.push('deviceScale');
  if (!readiness.fonts) unmet.push('fonts');
  if (!readiness.resources) unmet.push('resources');
  if (!readiness.scenario) unmet.push('scenario');
  if (!readiness.clock) unmet.push('clock');
  if (readiness.failures.console.length > 0) unmet.push('console');
  if (readiness.failures.page.length > 0) unmet.push('page');
  if (readiness.failures.request.length > 0) unmet.push('request');
  if (unmet.length > 0) return notReady(unmet);
  const png = await screenshotBytes(adapter.screenshot);
  if (!png.ok) return png;
  return {
    ok: true,
    value: {
      png: png.value,
      evidence: collectEvidence(instance, session, adapter, clock, readiness),
    },
  };
}
