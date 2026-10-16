import { err, ok, type Result, RhiError, type RhiQueue } from '@forgeax/engine-rhi';
import { toShared } from '@forgeax/engine-types';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import {
  createAutoExposureGpuResources,
  retireAutoExposureGpuResources,
  writeAutoExposureParameters,
} from './auto-exposure/gpu';
import {
  commitAutoExposureSubmission,
  createAutoExposureState,
  resetAutoExposureState,
} from './auto-exposure/state';
import { prepareStandardLutGpu, retireStandardLutGpuResources } from './lut-gpu';
import {
  commitStandardLutCandidate,
  prepareStandardLutCandidate,
  recordStandardLutFailure,
  resetStandardLutState,
} from './lut-state';

/*
 * The Standard output transaction: auto-exposure and LUT candidates (GPU
 * resources and CPU inspection state) are staged here, promoted by
 * `commitStandardOutputSubmission` after an accepted submit, and discarded by
 * the failure paths below. No other module writes the pending fields.
 */

/** Ordinary frames and detached recovery graphs prepare the same output resources. */
export function prepareStandardOutputResources(
  state: RenderFrameState,
  internals: RenderSystemInternals,
  camera: CameraSnapshot | undefined,
  world: RenderResourceScope,
): Result<void, RhiError> {
  const output = camera?.output;
  if (output?.exposure.kind === 'auto') {
    const pending = state.pendingAutoExposureGpuResources;
    if (pending !== undefined && pending.device !== internals.device) {
      retireAutoExposureGpuResources(pending);
      state.pendingAutoExposureGpuResources = undefined;
    }
    if (
      state.autoExposureGpuResources?.device !== internals.device &&
      state.pendingAutoExposureGpuResources?.device !== internals.device
    ) {
      const resources = createAutoExposureGpuResources(
        internals.device,
        state.compiledFrameGraphGeneration,
      );
      if (!resources.ok) {
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'auto-exposure GPU resources are prepared before graph build',
            hint: 'inspect the device capability and retry the current camera generation',
            detail: {
              error: { code: 'auto-exposure-prepare-failed', message: String(resources.error) },
            },
          }),
        );
      }
      state.pendingAutoExposureGpuResources = resources.value;
    }
  } else {
    if (state.pendingAutoExposureGpuResources !== undefined)
      retireAutoExposureGpuResources(state.pendingAutoExposureGpuResources);
    if (state.autoExposureGpuResources !== undefined)
      retireAutoExposureGpuResources(state.autoExposureGpuResources);
    state.pendingAutoExposureGpuResources = undefined;
    state.autoExposureGpuResources = undefined;
  }
  if (output !== undefined && output.colorLutStrength > 0) {
    const lut = prepareStandardLutGpu({
      world,
      handle: toShared<'TextureAsset'>(output.colorLut),
      strength: output.colorLutStrength,
      assets: internals.assets,
      gpuStore: internals.gpuStore,
      device: internals.device,
    });
    if (!lut.ok) {
      state.standardLutState = recordStandardLutFailure(state.standardLutState, lut.error);
      state.pendingStandardLutGpuResources = undefined;
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'the authored LUT resolves, is resident, and binds on the live device',
          hint: 'inspect the LUT asset GUID and live capability before retrying',
          detail: {
            error: {
              code: lut.error.code,
              message: `${lut.error.expected}; ${lut.error.hint}; ${JSON.stringify(lut.error.detail)}`,
            },
          },
        }),
      );
    }
    const accepted = state.standardLutGpuResources;
    if (
      accepted?.sourceKey !== lut.value.sourceKey ||
      accepted.texture !== lut.value.texture ||
      accepted.strength !== lut.value.strength
    ) {
      state.pendingStandardLutGpuResources = lut.value;
    }
  } else {
    state.pendingStandardLutGpuResources = undefined;
    state.standardLutGpuResources = undefined;
  }
  return ok(undefined);
}

/** Drop lost-device handles without destroying them; retain only reset CPU/LKG facts. */
export function resetStandardOutputForDeviceLoss(
  state: RenderFrameState,
  deviceEpoch: number,
): void {
  if (state.autoExposureState !== undefined) {
    state.autoExposureState = resetAutoExposureState(state.autoExposureState, 'device-lost', {
      targetGeneration: state.autoExposureState.targetGeneration + 1,
      deviceEpoch,
    });
  }
  state.standardLutState = resetStandardLutState(state.standardLutState, 'device-recovered', {
    targetGeneration: state.standardLutState.targetGeneration + 1,
    deviceEpoch,
  });
  discardStandardOutputStates(state);
  state.pendingAutoExposureGpuResources = undefined;
  state.autoExposureGpuResources = undefined;
  state.pendingStandardLutGpuResources = undefined;
  state.standardLutGpuResources = undefined;
}

/**
 * Stage the detached auto/LUT facts beside the GPU candidates already owned
 * by RenderFrameState. `commitStandardOutputSubmission` promotes both records
 * only after the single finish/submit transaction succeeds; no side registry or
 * compile callback can publish a value early.
 */
export function stageStandardOutputStates(
  frameState: RenderFrameState,
  internals: RenderSystemInternals,
  camera: CameraSnapshot | undefined,
  deltaTime: number,
): void {
  discardStandardOutputStates(frameState);
  const output = camera?.output;
  if (output === undefined) return;

  const publicFrameId =
    (internals as RenderSystemInternals & { readonly observationFrameId?: number })
      .observationFrameId ?? frameState.frameNumber;
  const targetGeneration = Math.max(1, camera?.historyVersion ?? 0);
  const deviceEpoch = internals.deviceScope.generation;

  if (
    output.exposure.kind === 'auto' &&
    (frameState.pendingAutoExposureGpuResources !== undefined ||
      frameState.autoExposureGpuResources !== undefined)
  ) {
    let state = frameState.autoExposureState;
    if (state === undefined || state.fallback !== output.exposure.fallback) {
      const created = createAutoExposureState({
        fallback: output.exposure.fallback,
        targetGeneration,
        deviceEpoch,
        frameId: publicFrameId,
      });
      if (!created.ok) {
        internals.errorRegistry.fire(created.error);
        return;
      }
      state = created.value;
    } else if (state.targetGeneration !== targetGeneration || state.deviceEpoch !== deviceEpoch) {
      state = resetAutoExposureState(state, 'camera-change', {
        targetGeneration,
        deviceEpoch,
      });
    }
    const resources =
      frameState.pendingAutoExposureGpuResources ?? frameState.autoExposureGpuResources;
    if (resources !== undefined) {
      const parameterWrite = writeAutoExposureParameters(resources, {
        compensationEv: output.exposure.compensationEv,
        rangeMinEv: output.exposure.rangeEv[0],
        rangeMaxEv: output.exposure.rangeEv[1],
        upRate: output.exposure.rates[0],
        downRate: output.exposure.rates[1],
        deltaTime,
        fallback: output.exposure.fallback,
        generation: state.targetGeneration,
      });
      if (!parameterWrite.ok) {
        internals.errorRegistry.fire(parameterWrite.error as RhiError);
        return;
      }
    }
    // The GPU adapt pass owns the numeric candidate. CPU staging carries
    // only the generation/transaction facts needed for submit publication.
    frameState.pendingAutoExposureState = Object.freeze({
      state,
      generation: state.targetGeneration,
      deviceEpoch: state.deviceEpoch,
      frameId: publicFrameId,
    });
  }

  let lutState = frameState.standardLutState;
  if (lutState.targetGeneration !== targetGeneration || lutState.deviceEpoch !== deviceEpoch) {
    lutState = resetStandardLutState(lutState, 'device-recovered', {
      targetGeneration,
      deviceEpoch,
    });
    frameState.standardLutState = lutState;
  }
  const wantsLut = output.colorLutStrength > 0 && output.colorLut > 0;
  const lutResources =
    frameState.pendingStandardLutGpuResources ?? frameState.standardLutGpuResources;
  if (wantsLut && lutResources !== undefined) {
    const prepared = prepareStandardLutCandidate(lutState, {
      // sourceKey is the Catalog-owned identity returned by the same
      // preparation that built the live LUT bind group; numeric handles do
      // not cross the inspection boundary.
      resident: lutResources.sourceKey,
      sourceKey: lutResources.sourceKey,
      generation: lutState.targetGeneration,
      deviceEpoch: lutState.deviceEpoch,
      frameId: publicFrameId,
    });
    if (prepared.ok) {
      frameState.pendingStandardLutState = Object.freeze({
        state: lutState,
        candidate: prepared.value,
        remove: false,
        targetGeneration,
        deviceEpoch,
      });
    }
  } else if (!wantsLut && lutState.resident !== null) {
    frameState.pendingStandardLutState = Object.freeze({
      state: lutState,
      remove: true,
      targetGeneration,
      deviceEpoch,
    });
  }
}

/** Promote every staged candidate after the frame's queue submit is accepted. */
export function commitStandardOutputSubmission(state: RenderFrameState, queue: RhiQueue): void {
  const pendingAuto = state.pendingAutoExposureGpuResources;
  if (pendingAuto !== undefined) {
    const previousAuto = state.autoExposureGpuResources;
    state.autoExposureGpuResources = pendingAuto;
    state.pendingAutoExposureGpuResources = undefined;
    if (previousAuto !== undefined && previousAuto !== pendingAuto) {
      queue
        .onSubmittedWorkDone()
        .then(() => retireAutoExposureGpuResources(previousAuto))
        .catch(() => undefined);
    }
  }
  const pendingAutoState = state.pendingAutoExposureState;
  if (pendingAutoState !== undefined) {
    state.autoExposureState = commitAutoExposureSubmission(
      pendingAutoState.state,
      pendingAutoState,
    );
    state.pendingAutoExposureState = undefined;
  }
  const pendingLut = state.pendingStandardLutGpuResources;
  if (pendingLut !== undefined) {
    const previousLut = state.standardLutGpuResources;
    state.standardLutGpuResources = pendingLut;
    state.pendingStandardLutGpuResources = undefined;
    if (previousLut !== undefined && previousLut !== pendingLut) {
      retireStandardLutGpuResources(previousLut);
    }
  }
  const pendingLutState = state.pendingStandardLutState;
  if (pendingLutState !== undefined) {
    state.standardLutState =
      pendingLutState.remove || pendingLutState.candidate === undefined
        ? resetStandardLutState(pendingLutState.state, 'resource-removed', {
            targetGeneration: pendingLutState.targetGeneration,
            deviceEpoch: pendingLutState.deviceEpoch,
          })
        : commitStandardLutCandidate(pendingLutState.state, pendingLutState.candidate);
    state.pendingStandardLutState = undefined;
  }
}

/** Drop the staged CPU inspection candidates; accepted state is untouched. */
export function discardStandardOutputStates(state: RenderFrameState): void {
  state.pendingAutoExposureState = undefined;
  state.pendingStandardLutState = undefined;
}

/** Retire staged GPU candidates that never reached an accepted submit. */
export function retirePendingStandardOutputGpu(state: RenderFrameState): void {
  if (state.pendingAutoExposureGpuResources !== undefined) {
    retireAutoExposureGpuResources(state.pendingAutoExposureGpuResources);
    state.pendingAutoExposureGpuResources = undefined;
  }
  if (state.pendingStandardLutGpuResources !== undefined) {
    retireStandardLutGpuResources(state.pendingStandardLutGpuResources);
    state.pendingStandardLutGpuResources = undefined;
  }
}

/** Renderer disposal: retire staged and accepted resources and drop auto-exposure state. */
export function disposeStandardOutput(state: RenderFrameState): void {
  retirePendingStandardOutputGpu(state);
  if (state.autoExposureGpuResources !== undefined) {
    retireAutoExposureGpuResources(state.autoExposureGpuResources);
    state.autoExposureGpuResources = undefined;
  }
  state.autoExposureState = undefined;
  discardStandardOutputStates(state);
  state.standardLutGpuResources = undefined;
}
