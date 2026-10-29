import type { ExecutionReport } from '@forgeax/engine-app';

/** The runtime-verification verdict over one Host-owned execution report. */
export type ExecutionHealth = 'healthy' | 'faulted' | 'no-completed-frame';

/**
 * The single runtime-health predicate shared by `dev verify` and `project play`:
 * no fault, a running Engine, a healthy World without partial writes, a live
 * Render Worker when present, and at least one completed Engine frame.
 */
export function executionHealth(execution: ExecutionReport): ExecutionHealth {
  if (
    execution.fault !== null ||
    execution.engine.health !== 'running' ||
    execution.world.health !== 'healthy' ||
    execution.world.partialWrite ||
    (execution.render !== undefined && execution.render.state !== 'alive')
  ) {
    return 'faulted';
  }
  return execution.frame.completed < 1 ? 'no-completed-frame' : 'healthy';
}
