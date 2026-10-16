import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { missingExecutionCapabilities } from './capabilities';
import {
  EXECUTION_WORKERS,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
  type ExecutionSelection,
  type ExecutionWorker,
  type ExecutionWorkerDecision,
  type ExecutionWorkersOptions,
} from './types';

const ENGINE_CAPABILITIES = ['worker', 'offscreenCanvas', 'workerWebGpu'] as const;
const REQUIRED: Record<ExecutionWorker, readonly ExecutionCapabilityName[]> = {
  engine: ENGINE_CAPABILITIES,
  render: ENGINE_CAPABILITIES,
  kernels: ['worker', 'crossOriginIsolated', 'sharedArrayBuffer', 'atomicsWait'],
};

export interface ExecutionSelectionInput {
  readonly workers?: ExecutionWorkersOptions;
  readonly capabilities: ExecutionCapabilities;
}

export function selectExecutionWorkers(
  input: ExecutionSelectionInput,
): Result<ExecutionSelection, AppErrorType> {
  const decisions = {} as Record<ExecutionWorker, ExecutionWorkerDecision>;
  for (const worker of EXECUTION_WORKERS) {
    const requested = input.workers?.[worker] ?? 'auto';
    const missingCapabilities = missingExecutionCapabilities(input.capabilities, REQUIRED[worker]);
    const reason =
      requested === false
        ? 'disabled'
        : worker !== 'engine' && !decisions.engine.enabled
          ? 'engine-disabled'
          : missingCapabilities.length > 0
            ? 'capability-unavailable'
            : 'enabled';
    if (
      requested === true &&
      (reason === 'engine-disabled' || reason === 'capability-unavailable')
    ) {
      return err(
        new AppError({
          code: 'app-execution-worker-unavailable',
          expected: APP_EXPECTED['app-execution-worker-unavailable'],
          hint: APP_ERROR_HINTS['app-execution-worker-unavailable'],
          detail: { worker, reason, missingCapabilities },
        }),
      );
    }
    decisions[worker] = {
      requested,
      enabled: reason === 'enabled',
      reason,
      missingCapabilities: reason === 'capability-unavailable' ? missingCapabilities : [],
    };
  }
  return ok(decisions);
}
