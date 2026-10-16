import type { JsonValue, ToolEvidenceKind, ToolRealm, ToolRuntimeError } from './types.js';

export function invalidArgsError(message: string, value: JsonValue): ToolRuntimeError {
  return {
    code: 'tool-invalid-args',
    expected: 'arguments accepted by the contribution argsSchema',
    hint: 'Read the descriptor schema and retry with typed arguments.',
    detail: { message, value },
  };
}

export function capabilityUnavailableError(capability: string, realm: ToolRealm): ToolRuntimeError {
  return {
    code: 'tool-capability-unavailable',
    expected: `capability ${capability} in realm ${realm}`,
    hint: 'Inspect the capability matrix and select an available realm or path.',
    detail: { capability, realm },
  };
}

export function snapshotStaleError(expectedDigest: string, actualDigest: string): ToolRuntimeError {
  return {
    code: 'tool-snapshot-stale',
    expected: 'the supplied snapshot to match the current authority',
    hint: 'Refresh the authority snapshot and retry the write.',
    detail: { expectedDigest, actualDigest },
  };
}

export function domainFailureError(
  code: string,
  expected = 'the producer operation to succeed',
  hint = 'Inspect detail and repair the owning producer before retrying.',
  payload?: JsonValue,
): ToolRuntimeError {
  return {
    code: 'tool-domain-failed',
    expected,
    hint,
    detail: { code, ...(payload === undefined ? {} : { payload }) },
  };
}

export function artifactIncompleteError(
  missing: readonly ToolEvidenceKind[],
  runId: string,
): ToolRuntimeError {
  return {
    code: 'tool-artifact-incomplete',
    expected: 'the requested evidence artifacts to be produced by their owners',
    hint: 'Request only supported evidence and inspect the artifact manifest before retrying.',
    detail: { missing: [...missing], runId },
  };
}

export function cancellationError(reason: string): ToolRuntimeError {
  return {
    code: 'tool-run-cancelled',
    expected: 'the tool run not to be cancelled',
    hint: 'Retry the command after resolving the cancellation source.',
    detail: { reason },
  };
}

export function timeoutError(deadlineMs: number): ToolRuntimeError {
  return {
    code: 'tool-run-timeout',
    expected: `the tool run to complete within ${deadlineMs}ms`,
    hint: 'Increase the deadline only when the operation is expected to be bounded.',
    detail: { deadlineMs },
  };
}

export function disconnectedError(transport: string): ToolRuntimeError {
  return {
    code: 'tool-run-disconnected',
    expected: 'the tool transport to remain connected',
    hint: 'Reconnect the transport and retry from the last serialized snapshot.',
    detail: { transport },
  };
}

export function terminalError(runId: string, outcome: 'succeeded' | 'failed'): ToolRuntimeError {
  return {
    code: 'tool-run-terminal',
    expected: 'a non-terminal ToolRun',
    hint: 'Use the existing terminal and do not attach another executor.',
    detail: { runId, outcome },
  };
}

export function cleanupError(runId: string, message: string): ToolRuntimeError {
  return {
    code: 'tool-cleanup-failed',
    expected: 'all ToolRun cleanup callbacks to complete',
    hint: 'Inspect the cleanup detail and release the owning resource.',
    detail: { runId, message },
  };
}

export function artifactManifestError(
  expected: string,
  hint: string,
  detail: { readonly reason: string; readonly runId?: string },
): ToolRuntimeError {
  return { code: 'tool-artifact-manifest-invalid', expected, hint, detail };
}
