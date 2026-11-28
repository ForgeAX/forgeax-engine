import { cloudHistoryExtent } from '../cloud/reconstruction/history';
import { type Antialias, isTemporalAntialias } from '../components/camera';
import { ssrColorExtent } from '../ssr/scene-color-input';
import { TSR_ANALYSIS_HISTORY_BYTES_PER_PIXEL } from '../tsr/layout';
import {
  TSR_RESURRECTION_GUIDE_BYTES,
  TSR_RESURRECTION_OUTPUT_BYTES,
  TSR_RESURRECTION_SLOTS,
} from '../tsr/resurrection';
import { createTemporalCoverage } from './coverage';
import type { TemporalGpuState } from './gpu';
import type { TemporalHistory } from './history';
import type { TemporalAttemptState } from './taa-history-store';
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
  readonly historyAttempt: TemporalAttemptState;
  readonly epoch: number;
  readonly viewIdentity: string;
  readonly historyValid: boolean;
  readonly resetReason: string | undefined;
  readonly frameIndex: number;
  readonly historyBytes: number;
  readonly coverage: { readonly width: number; readonly height: number };
  readonly deviceGeneration: number;
  readonly resources: TemporalResourceInspection;
  readonly tsr?: {
    readonly historyScale: 1;
    readonly layout: 'fp16-guide-fp16-moire-separate-support';
    readonly analysisCapacity: { readonly width: number; readonly height: number };
    readonly committedInput: { readonly width: number; readonly height: number };
    readonly analysisValid: boolean;
  };
}

function gpuBytes(state: TemporalGpuState | undefined): number {
  if (state === undefined) return 0;
  const ssrExtent = ssrColorExtent(state);
  const taaBytes =
    state.mode === 'scene-color'
      ? ssrExtent.width * ssrExtent.height * 16
      : state.tsr === undefined
        ? createTemporalCoverage(state.width, state.height).bytes
        : 40 * state.width * state.height +
          TSR_ANALYSIS_HISTORY_BYTES_PER_PIXEL * state.tsr.width * state.tsr.height +
          TSR_RESURRECTION_SLOTS *
            (TSR_RESURRECTION_GUIDE_BYTES * state.tsr.width * state.tsr.height +
              TSR_RESURRECTION_OUTPUT_BYTES * state.width * state.height);
  const extent = cloudHistoryExtent(state.width, state.height);
  // Two half-resolution slots, each with far/near transport and depth.
  const transportBytes = state.cloudHistoryFormat === 'rgba32float' ? 16 : 8;
  const cloudBytes = state.cloudHistoryEnabled
    ? extent.width *
      extent.height *
      2 *
      (2 * transportBytes + (state.cloudHistoryDepthFormat === 'rgba16float' ? 8 : 16))
    : 0;
  return taaBytes + cloudBytes;
}

function gpuResources(state: TemporalGpuState | undefined): number {
  return state?.childScope.resourceDelta() ?? 0;
}

function inspectTsr(
  active: TemporalGpuState | undefined,
  view: TemporalView | undefined,
): Pick<TemporalInspection, 'tsr'> {
  if (active?.tsr === undefined) return {};
  return {
    tsr: Object.freeze({
      historyScale: 1 as const,
      layout: 'fp16-guide-fp16-moire-separate-support' as const,
      analysisCapacity: Object.freeze({ width: active.tsr.width, height: active.tsr.height }),
      committedInput: Object.freeze({
        width: active.tsr.inputWidth,
        height: active.tsr.inputHeight,
      }),
      analysisValid:
        active.valid &&
        active.tsr.inputWidth === view?.input.internalWidth &&
        active.tsr.inputHeight === view?.input.internalHeight,
    }),
  };
}

function historyExtent(
  coverage: { readonly width: number; readonly height: number } | undefined,
  active: TemporalGpuState | undefined,
  candidate: TemporalGpuState | undefined,
) {
  return (
    coverage ?? {
      width: active?.width ?? candidate?.width ?? 0,
      height: active?.height ?? candidate?.height ?? 0,
    }
  );
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
  const taa = isTemporalAntialias(mode);
  const active = options.active;
  const candidate = options.candidate;
  const retiring = options.retiring ?? [];
  const historyBytes = active === undefined ? (snapshot?.coverage.bytes ?? 0) : gpuBytes(active);
  const coverage = historyExtent(snapshot?.coverage, active, candidate);
  const retiringCount = retiring.reduce((count, state) => count + gpuResources(state), 0);
  const retiringBytes = retiring.reduce((bytes, state) => bytes + gpuBytes(state), 0);
  const status = !taa
    ? 'off'
    : view?.resetReason !== undefined && view.resetReason !== 'first-frame'
      ? 'reset'
      : view?.historyValid === true || snapshot?.historyValid === true
        ? 'stable'
        : 'first-frame';
  const historyAttempt = !taa
    ? 'none'
    : (active?.valid ?? snapshot?.historyValid ?? false)
      ? 'committed'
      : 'active';
  return Object.freeze({
    mode,
    ...(mode !== 'tsr' ? {} : inspectTsr(active, view)),
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
