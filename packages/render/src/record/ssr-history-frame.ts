import { RhiError } from '@forgeax/engine-rhi';
import type { SsrSpatialAdmission } from '../ssr/admission';
import { type SsrHistoryResetReason, WATER_SSR_PARAMS_BYTES } from '../ssr/history';
import {
  fullSsrColorViewport,
  selectSsrSceneColorInput,
  writeSsrColorViewport,
} from '../ssr/scene-color-input';
import { WATER_SSR_DEFAULT_PROFILE, waterSsrTemporalEnabled } from '../ssr/water-profile';
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
  waterActive = false,
): boolean {
  if (stage.kind === 'failed') return false;
  if (
    stage.kind !== 'staged' ||
    admission.status !== 'admitted' ||
    frameState.ssrHistoryOwner === undefined
  )
    return true;
  for (const owner of [
    frameState.ssrHistoryOwner,
    waterActive &&
    waterSsrTemporalEnabled(temporalView.input.antialias, admission.config.waterTemporal)
      ? frameState.waterSsrHistoryOwner
      : undefined,
  ]) {
    if (owner === undefined) continue;
    const uploadHistoryOwnerParameters = () => {
      if (stage.cameraReset === undefined) {
        const resetReason = mapSsrHistoryResetReason(temporalView.resetReason);
        if (
          resetReason !== undefined &&
          !(owner.profile === 'single-layer-water' && resetReason === 'resize')
        )
          owner.reset(resetReason);
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
      values.setFloat32(4, owner.profile === 'single-layer-water' ? 0.875 : 0.9, true);
      values.setFloat32(8, admission.config.thickness, true);
      values.setFloat32(12, 0.5, true);
      // The shared successful-submit snapshot owns jitter and previous camera state.
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
    };
    if (!uploadHistoryOwnerParameters()) return false;
  }
  if (waterActive) {
    const owner = frameState.ssrHistoryOwner;
    const uploadWaterSsrParameters = (owner: NonNullable<RenderFrameState['ssrHistoryOwner']>) => {
      const waterParams = new Uint8Array(WATER_SSR_PARAMS_BYTES);
      const values = new DataView(waterParams.buffer);
      const viewport = fullSsrColorViewport(owner.resources.width, owner.resources.height);
      writeSsrColorViewport(
        values,
        0,
        frameState.waterSsrHistoryOwner?.candidate?.previousViewport ?? viewport,
      );
      const colorHistory = frameState.activeTemporalGpuState;
      const acceptedView = frameState.temporalView.accepted;
      const selected = selectSsrSceneColorInput({
        deviceGeneration: temporalView.input.deviceGeneration,
        currentPreExposure: 1,
        ...(colorHistory === undefined
          ? {}
          : {
              taa: {
                source: colorHistory,
                viewport: fullSsrColorViewport(colorHistory.width, colorHistory.height),
                preExposure: 1,
                deviceGeneration: acceptedView?.input.deviceGeneration ?? -1,
                valid:
                  temporalView.resetReason === undefined &&
                  colorHistory.valid &&
                  colorHistory.device === internals.device &&
                  colorHistory.width === temporalView.input.width &&
                  colorHistory.height === temporalView.input.height,
              },
            }),
      });
      writeSsrColorViewport(
        values,
        32,
        selected.kind === 'current' ? viewport : selected.input.viewport,
      );
      values.setFloat32(64, selected.kind === 'current' ? 0 : 1, true);
      values.setFloat32(68, selected.preExposureCorrection, true);
      values.setFloat32(72, WATER_SSR_DEFAULT_PROFILE.intensity, true);
      values.setFloat32(76, temporalView.temporalFrameIndex, true);
      values.setFloat32(80, WATER_SSR_DEFAULT_PROFILE.numSteps, true);
      values.setFloat32(84, WATER_SSR_DEFAULT_PROFILE.numRays, true);
      values.setFloat32(88, WATER_SSR_DEFAULT_PROFILE.roughnessScale, true);
      values.setFloat32(92, WATER_SSR_DEFAULT_PROFILE.quality, true);
      const waterBuffer = owner.getWaterInputParamsBuffer();
      const written = waterBuffer.ok
        ? internals.device.queue.writeBuffer(waterBuffer.value, 0, waterParams)
        : waterBuffer;
      if (!written.ok) {
        reportSsrHistoryFailure(internals, 'encode', written.error);
        return false;
      }
      return true;
    };
    if (!uploadWaterSsrParameters(owner)) return false;
  }
  return true;
}
