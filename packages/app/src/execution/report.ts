import type { AudioState } from '@forgeax/engine-audio';
import { EXECUTION_REPORT_SCHEMA_VERSION } from './schema';
import type {
  ExecutionCapabilities,
  ExecutionFrameInspection,
  ExecutionReport,
  ExecutionSelection,
} from './types';

export function createExecutionFrameInspection(): ExecutionFrameInspection {
  return {
    submitted: 0,
    completed: 0,
    inFlight: 0,
    highWater: 0,
    throttledTicks: 0,
  };
}

export function executionAudioReport(state?: AudioState): ExecutionReport['audio'] {
  const error = state?.lastError ?? null;
  return {
    owner: 'host',
    ...(state?.cache ? { cache: state.cache } : {}),
    ...(state?.preparation ? { preparation: state.preparation } : {}),
    ...(state?.music ? { music: state.music } : {}),
    ...(state?.streaming ? { streaming: state.streaming } : {}),
    contextState: state?.contextState ?? 'suspended',
    activeSourceCount: state?.activeSourceCount ?? 0,
    lastError:
      error === null
        ? null
        : {
            code: error.code,
            expected: error.expected,
            hint: error.hint,
            detail: error.detail,
          },
  };
}

export function createExecutionReport(
  capabilities: ExecutionCapabilities,
  workers: ExecutionSelection,
): ExecutionReport {
  return {
    schemaVersion: EXECUTION_REPORT_SCHEMA_VERSION,
    workers,
    capabilities,
    engine: {
      realm: workers.engine.enabled ? 'worker' : 'host',
      health: 'idle',
    },
    world: {
      identity: null,
      health: 'healthy',
      partialWrite: false,
      retryable: true,
    },
    kernelDispatch: {
      eligible: false,
      usedShared: false,
      reason: 'no-eligible-kernel',
      dispatched: 0,
      completed: 0,
    },
    frame: createExecutionFrameInspection(),
    performance: {
      hostFrameMs: null,
      engineUpdateMs: null,
      kernelWaitMs: null,
      hostAudioMs: null,
    },
    audio: executionAudioReport(),
    fault: null,
  };
}
