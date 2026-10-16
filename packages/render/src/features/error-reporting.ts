import type { RenderError } from '../errors/render';

/**
 * Recoverable feature preparation failures are still useful diagnostics, but
 * they are not new failures on every render tick. Keep the reporting policy
 * independent from the frame orchestration so it can be exercised without a
 * renderer or device.
 */
export const PENDING_RENDER_FEATURE_ERROR_REPORT_INTERVAL_FRAMES = 60;

export interface PendingRenderFeatureErrorReport {
  readonly frame: number;
  readonly fingerprint: string;
}

export function shouldReportPendingRenderFeatureError(
  lastReportedFrame: Map<string, PendingRenderFeatureErrorReport>,
  key: string,
  frameNumber: number,
  fingerprint = '',
  intervalFrames = PENDING_RENDER_FEATURE_ERROR_REPORT_INTERVAL_FRAMES,
): boolean {
  const lastReported = lastReportedFrame.get(key);
  if (
    lastReported !== undefined &&
    lastReported.fingerprint === fingerprint &&
    frameNumber - lastReported.frame < intervalFrames
  )
    return false;
  lastReportedFrame.set(key, { frame: frameNumber, fingerprint });
  return true;
}

export function reportPendingRenderFeatureErrors(
  errors: readonly RenderError[],
  frameNumber: number,
  lastReportedFrame: Map<string, PendingRenderFeatureErrorReport>,
  errorRegistry: { fire(error: RenderError): void },
): void {
  for (const error of errors) {
    if (!isPendingRenderFeaturePreparation(error)) {
      errorRegistry.fire(error);
      continue;
    }
    // A missing prepared resource during its normal asynchronous warm-up is
    // an expected candidate state. Keep that path silent; other next-frame
    // failures still receive first/periodic reporting.
    if (isSilentRenderFeatureWarmup(error)) continue;
    const key = pendingRenderFeatureErrorKey(error);
    const cause = error.code === 'render-feature-stage-failed' ? error.detail.cause : undefined;
    const causeText =
      cause instanceof Error
        ? `${cause.name}\0${cause.message}`
        : typeof cause === 'string'
          ? cause
          : '';
    const fingerprint = `${error.expected}\0${error.hint}\0${causeText}`;
    // Retain one record per owner, not one record per changing cause string.
    if (shouldReportPendingRenderFeatureError(lastReportedFrame, key, frameNumber, fingerprint)) {
      errorRegistry.fire(error);
    }
  }
}

function isPendingRenderFeaturePreparation(error: RenderError): boolean {
  if (!('detail' in error)) return false;
  switch (error.code) {
    case 'render-feature-stage-failed':
    case 'render-feature-preparation-failed':
    case 'render-feature-prepared-state-mismatch':
    case 'render-feature-draw-recording-failed':
      return error.detail.recovery === 'next-frame';
    default:
      return false;
  }
}

function isSilentRenderFeatureWarmup(error: RenderError): boolean {
  return (
    error.code === 'render-feature-preparation-failed' &&
    error.detail.reason.startsWith('rhi-not-available:')
  );
}

function pendingRenderFeatureErrorKey(error: RenderError): string {
  const detail = 'detail' in error ? error.detail : undefined;
  const featureIdentity =
    detail !== undefined &&
    'featureIdentity' in detail &&
    typeof detail.featureIdentity === 'string'
      ? detail.featureIdentity
      : '';
  const order =
    detail !== undefined && 'order' in detail && typeof detail.order === 'number'
      ? detail.order
      : -1;
  return `${error.code}\0${featureIdentity}\0${order}`;
}
