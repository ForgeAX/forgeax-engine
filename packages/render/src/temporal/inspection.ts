import type { Antialias } from '../components/camera';
import { createTemporalCoverage } from './coverage';
import type { TemporalGpuState } from './gpu';
import type { TemporalHistory } from './history';
import type { TemporalView } from './view';

export interface TemporalResourceInspection {
  readonly active: number;
  readonly candidate: number;
  readonly retiring: number;
  readonly activeBytes: number;
  readonly candidateBytes: number;
  readonly retiringBytes: number;
}

export interface TemporalInspection {
  readonly mode: Antialias;
  /** Compatibility projection for temporal carriers; derived from this snapshot. */
  readonly status: 'off' | 'first-frame' | 'stable' | 'reset' | 'aborted';
  readonly historyAttempt: 'none' | 'active' | 'committed' | 'aborted';
  readonly epoch: number;
  readonly viewIdentity: string;
  readonly historyValid: boolean;
  readonly resetReason: string | undefined;
  readonly frameIndex: number;
  readonly historyBytes: number;
  readonly coverage: { readonly width: number; readonly height: number };
  readonly deviceGeneration: number;
  readonly resources: TemporalResourceInspection;
}

function gpuBytes(state: TemporalGpuState | undefined): number {
  if (state === undefined) return 0;
  const taaBytes = createTemporalCoverage(state.width, state.height).bytes;
  // The cloud owner adds six rgba16float surfaces (8 bytes per pixel) only
  // when the candidate was admitted with cloud history demand. This is derived
  // from the live state shape rather than reported as a fixed cloud estimate.
  const cloudBytes = state.cloudHistoryEnabled ? state.width * state.height * 6 * 8 : 0;
  return taaBytes + cloudBytes;
}

function gpuResources(state: TemporalGpuState | undefined): number {
  return state?.childScope.resourceDelta() ?? 0;
}

export function inspectTemporal(
  view: TemporalView | undefined,
  history: TemporalHistory | undefined,
  options: {
    readonly active?: TemporalGpuState;
    readonly candidate?: TemporalGpuState;
    readonly retiring?: readonly TemporalGpuState[];
    readonly deviceGeneration?: number;
  } = {},
): TemporalInspection {
  const snapshot = history?.snapshot();
  const mode = view?.input.antialias ?? 'none';
  const taa = mode === 'taa';
  const active = taa ? options.active : undefined;
  const candidate = taa ? options.candidate : undefined;
  const retiring = taa ? (options.retiring ?? []) : [];
  const historyBytes = active === undefined ? (snapshot?.coverage.bytes ?? 0) : gpuBytes(active);
  const coverage = snapshot?.coverage ?? {
    width: active?.width ?? candidate?.width ?? 0,
    height: active?.height ?? candidate?.height ?? 0,
  };
  const retiringCount = retiring.reduce((count, state) => count + gpuResources(state), 0);
  const retiringBytes = retiring.reduce((bytes, state) => bytes + gpuBytes(state), 0);
  const status =
    mode !== 'taa'
      ? 'off'
      : view?.resetReason !== undefined && view.resetReason !== 'first-frame'
        ? 'reset'
        : view?.historyValid === true || snapshot?.historyValid === true
          ? 'stable'
          : 'first-frame';
  const historyAttempt =
    mode !== 'taa'
      ? 'none'
      : (active?.valid ?? snapshot?.historyValid ?? false)
        ? 'committed'
        : 'active';
  return Object.freeze({
    mode,
    status,
    historyAttempt,
    epoch: view?.input.frameIndex ?? snapshot?.frameIndex ?? 0,
    viewIdentity: view?.input.viewIdentity ?? 'camera:default',
    historyValid: active?.valid ?? snapshot?.historyValid ?? false,
    resetReason: view?.resetReason ?? snapshot?.resetReason,
    frameIndex: view?.temporalFrameIndex ?? snapshot?.frameIndex ?? 0,
    historyBytes,
    coverage: Object.freeze({ width: coverage.width, height: coverage.height }),
    deviceGeneration:
      options.deviceGeneration ?? active?.scope.generation ?? candidate?.scope.generation ?? 0,
    resources: Object.freeze({
      active: gpuResources(active),
      candidate: gpuResources(candidate),
      retiring: retiringCount,
      activeBytes: gpuBytes(active),
      candidateBytes: gpuBytes(candidate),
      retiringBytes,
    }),
  });
}
