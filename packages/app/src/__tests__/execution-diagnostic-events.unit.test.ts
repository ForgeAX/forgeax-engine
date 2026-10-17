import { afterEach, expect, it, vi } from 'vitest';
import { emitExecutionDiagnostic, executionDiagnosticSink } from '../execution/diagnostic-events';

afterEach(() => vi.unstubAllGlobals());

it('leaves the existing profiler flag and disabled execution sink inert', () => {
  const emit = vi.fn();
  vi.stubGlobal('__forgeaxFramePhaseDiagnostics', { enabled: true });
  expect(executionDiagnosticSink()).toBeUndefined();
  const execution = {
    enabled: false,
    get emit() {
      throw new Error('disabled callback read');
    },
  };
  vi.stubGlobal('__forgeaxFramePhaseDiagnostics', { enabled: true, execution });
  expect(executionDiagnosticSink()).toBeUndefined();
  vi.stubGlobal('__forgeaxFramePhaseDiagnostics', {
    enabled: false,
    execution: { enabled: true, emit, failures: 0 },
  });
  const sink = executionDiagnosticSink();
  expect(sink).toBeDefined();
  expect(emit).not.toHaveBeenCalled();
});

it('retains bounded diagnostic failures without changing the completion owner', () => {
  const execution = {
    enabled: true,
    emit: () => {
      throw new Error('diagnostic failure');
    },
    failures: 0,
  };
  vi.stubGlobal('__forgeaxFramePhaseDiagnostics', { execution });
  const event = {
    event: 'render-previous-prefix-passed',
    worldIdentity: 'world-a',
    frameId: 11,
    deviceGeneration: 7,
    source: 'source-a',
    epoch: 3,
    revision: 9,
  } as const;
  emitExecutionDiagnostic(execution, event);
  expect(execution.failures).toBe(1);
  execution.failures = Number.MAX_SAFE_INTEGER;
  emitExecutionDiagnostic(execution, event);
  expect(execution.failures).toBe(Number.MAX_SAFE_INTEGER);
  Object.freeze(execution);
  expect(() => emitExecutionDiagnostic(execution, event)).not.toThrow();
});
