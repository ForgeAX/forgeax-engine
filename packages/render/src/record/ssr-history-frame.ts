import { RhiError } from '@forgeax/engine-rhi';
import type { SsrSpatialAdmission } from '../ssr/admission';
import type { SsrHistoryResetReason } from '../ssr/history';
import type { TemporalFrameStage } from '../temporal/frame-coordinator';
import type { TemporalView } from '../temporal/view';
import type { ViewSsrHistoryStageOutcome } from '../world/history-admission-systems';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

function ssrRuntimeError(
  cause: unknown,
): RhiError | { code: string; message: string; name?: string } {
  if (cause instanceof RhiError) return cause;
  if (cause instanceof Error)
    return { code: 'ssr-history-failure', message: cause.message, name: cause.name };
  return { code: 'ssr-history-failure', message: String(cause) };
}

export function reportSsrHistoryFailure(
  internals: RenderSystemInternals,
  stage: TemporalFrameStage,
  cause: unknown,
): void {
  internals.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: `SSR history ${stage} succeeds before queue submission`,
      hint: 'inspect the SSR history owner failure and retry the next frame',
      detail: { error: ssrRuntimeError(cause) },
    }),
  );
}

export function mapSsrHistoryResetReason(
  reason: TemporalView['resetReason'],
): SsrHistoryResetReason | undefined {
  switch (reason) {
    case 'first-frame':
      return 'first-enable';
    case 'resize':
      return 'resize';
    case 'camera-cut':
    case 'view-switch':
      return 'camera-cut';
    case 'history-version':
      return 'history-version';
    case 'environment-change':
    case 'fog-change':
      return 'reflection-generation';
    case 'time-discontinuity':
      return 'camera-cut';
    case 'device-recover':
      return 'device-recovery';
    case 'submit-failure':
    case undefined:
      return undefined;
  }
}

/**
 * Begin the SSR history frame of an admitted view and upload its temporal
 * parameters. `render-ssr-history-stage` already allocated the owner and
 * applied the camera reset; the temporal view only exists in recording, so its
 * reset, the candidate and the jitter payload stay here. Commit and abort
 * belong to `render-post-commit` / `render-post-cleanup`. False when the
 * stage failed (already reported) or the candidate could not be built.
 */
export function beginSsrHistoryFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  admission: SsrSpatialAdmission,
  stage: ViewSsrHistoryStageOutcome,
  temporalView: TemporalView,
): boolean {
  if (stage.kind === 'failed') return false;
  const owner = frameState.ssrHistoryOwner;
  if (stage.kind !== 'staged' || admission.status !== 'admitted' || owner === undefined)
    return true;
  if (stage.cameraReset === undefined) {
    const resetReason = mapSsrHistoryResetReason(temporalView.resetReason);
    if (resetReason !== undefined) owner.reset(resetReason);
  }

  const started = owner.beginFrame({
    current: temporalView,
    previous: frameState.temporalView.accepted,
  });
  if (!started.ok) {
    reportSsrHistoryFailure(internals, 'build', started.error);
    return false;
  }
  const candidate = started.value;
  const payload =
    frameState.ssrTemporalParamsPayload?.byteLength === 32
      ? frameState.ssrTemporalParamsPayload
      : new Uint8Array(32);
  payload.fill(0);
  const values = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  values.setUint32(0, candidate.historyValid ? 1 : 0, true);
  values.setFloat32(4, 0.9, true);
  values.setFloat32(8, admission.config.thickness, true);
  values.setFloat32(12, 0.5, true);
  // Reuse the shared successful-submit snapshot; SSR owns no jitter sequence
  // or independently advancing previous-camera state.
  const previousJitter = frameState.temporalView.accepted?.currentJitterUv;
  values.setFloat32(16, temporalView.currentJitterUv?.[0] ?? 0, true);
  values.setFloat32(20, temporalView.currentJitterUv?.[1] ?? 0, true);
  values.setFloat32(24, previousJitter?.[0] ?? 0, true);
  values.setFloat32(28, previousJitter?.[1] ?? 0, true);
  const written = internals.device.queue.writeBuffer(owner.resources.paramsBuffer, 0, payload);
  if (!written.ok) {
    owner.abortFrame(candidate, 'encode');
    reportSsrHistoryFailure(internals, 'encode', written.error);
    return false;
  }
  frameState.ssrTemporalParamsPayload = payload;
  return true;
}
