import type { AudioState } from '@forgeax/engine-audio';
import type { World } from '@forgeax/engine-ecs';
import { err } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';
import { executionAudioReport, executionWorldReport } from './report';
import type { ExecutionControl, ExecutionEngineHealth, ExecutionReport } from './types';
import { serializableDetail } from './worker-error';

export function cloneExecutionReport(report: ExecutionReport): ExecutionReport {
  return structuredClone(report);
}

export interface LocalExecutionControl extends ExecutionControl {
  setEngineHealth(health: ExecutionEngineHealth): void;
}

export interface LocalExecutionReportProviders {
  readonly audio?: () => AudioState;
  readonly world?: () => World['execution'];
  readonly frame?: () => ExecutionReport['frame'];
}

export function createLocalExecutionControl(
  initial: ExecutionReport,
  providers: LocalExecutionReportProviders = {},
): LocalExecutionControl {
  let current = cloneExecutionReport(initial);
  return {
    setEngineHealth: (health) => {
      current = { ...current, engine: { ...current.engine, health } };
    },
    report: () => {
      // Sample the World's sealed execution state once so integrity, guidance
      // and the first cause describe the same owner state, even inside onError.
      const world = providers.world?.();
      const fault = world?.fault;
      return cloneExecutionReport({
        ...current,
        engine: fault == null ? current.engine : { ...current.engine, health: 'faulted' },
        world: world === undefined ? current.world : executionWorldReport(world),
        fault:
          world === undefined
            ? current.fault
            : fault == null
              ? null
              : {
                  source: 'world',
                  code: fault.code,
                  expected: 'World remains healthy through update',
                  hint: 'rebuild the poisoned World explicitly',
                  detail: serializableDetail(fault),
                  partialWrite: fault.partialWrite,
                  retryable: fault.retryable,
                },
        frame: providers.frame?.() ?? current.frame,
        audio: executionAudioReport(providers.audio?.()),
      });
    },
    rebuild: async () =>
      err(
        new AppError({
          code: 'app-execution-rebuild-failed',
          expected: APP_EXPECTED['app-execution-rebuild-failed'],
          hint: APP_ERROR_HINTS['app-execution-rebuild-failed'],
          detail: {
            worldIdentity: current.world.identity,
            cause: new Error('This local assembly has no bootstrap module.'),
          },
        }),
      ),
  };
}
