import type { SsrAdmissionIdentity } from '@forgeax/engine-render';
import {
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
  type ExecutionWorkersOptions,
  selectExecutionWorkers,
} from '../index';

// Transport fixtures are caller PODs, not source/build provenance evidence.
export const ssrIdentityFixture: SsrAdmissionIdentity = {
  sourceHead: 'fixture-source-head',
  sourceTree: 'fixture-source-tree',
  lockSha256: 'fixture-lock',
  buildSha256: 'fixture-build',
};
export function executionFacts(
  missing: readonly ExecutionCapabilityName[] = [],
): ExecutionCapabilities {
  return Object.fromEntries(
    EXECUTION_CAPABILITY_NAMES.map((name) => [
      name,
      {
        available: !missing.includes(name),
        reason: missing.includes(name) ? 'fixture missing' : 'fixture observed',
      },
    ]),
  ) as unknown as ExecutionCapabilities;
}
export function workerSelection(workers: ExecutionWorkersOptions = {}) {
  return selectExecutionWorkers({ workers, capabilities: executionFacts() }).unwrap();
}
