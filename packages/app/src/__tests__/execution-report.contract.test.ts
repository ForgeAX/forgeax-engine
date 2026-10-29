import { describe, expect, it } from 'vitest';
import {
  createExecutionReport,
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  isExecutionReport,
  selectExecutionWorkers,
} from '../index';

function capabilities(available = true): ExecutionCapabilities {
  return Object.fromEntries(
    EXECUTION_CAPABILITY_NAMES.map((name) => [
      name,
      { available, reason: available ? 'observed' : 'missing' },
    ]),
  ) as unknown as ExecutionCapabilities;
}

describe('ExecutionReport contract', () => {
  it('is the closed requested/actual/capability/health/performance/fault snapshot', () => {
    const selection = selectExecutionWorkers({
      capabilities: capabilities(),
    }).unwrap();
    const report = createExecutionReport(capabilities(), selection);
    expect(report.workers.render.enabled).toBe(true);
    expect(report.workers.kernels.enabled).toBe(true);
    expect(report.capabilities.worker.available).toBe(true);
    expect(report.engine.health).toBe('idle');
    expect(report.world.health).toBe('healthy');
    expect(report.kernelDispatch.reason).toBe('no-eligible-kernel');
    expect(report.frame).toEqual({
      submitted: 0,
      completed: 0,
      inFlight: 0,
      highWater: 0,
      throttledTicks: 0,
    });
    expect(report.performance.kernelWaitMs).toBeNull();
    expect(report.audio).toEqual({
      owner: 'host',
      contextState: 'unavailable',
      activeSourceCount: null,
      lastError: null,
    });
    expect(report.fault).toBeNull();
    expect(isExecutionReport(report)).toBe(true);
  });

  it('accepts Host preparation receipts and rejects fabricated availability', () => {
    const report = createExecutionReport(
      capabilities(),
      selectExecutionWorkers({ capabilities: capabilities() }).unwrap(),
    );
    expect(
      isExecutionReport({
        ...report,
        audio: {
          ...report.audio,
          preparation: { requestId: 'prepare-1', status: 'ready', sourceCount: 1 },
        },
      }),
    ).toBe(true);
    expect(isExecutionReport({ ...report, audio: { ...report.audio, activeSourceCount: 0 } })).toBe(
      false,
    );
    expect(
      isExecutionReport({ ...report, audio: { ...report.audio, contextState: 'running' } }),
    ).toBe(false);
  });

  it('rejects unknown audio errors and undeclared preparation failure fields', () => {
    const report = createExecutionReport(
      capabilities(),
      selectExecutionWorkers({ capabilities: capabilities() }).unwrap(),
    );
    const failure = {
      code: 'decode-failed',
      expected: 'decodable bytes',
      hint: 'repair the clip',
      detail: { code: 'decode-failed', reason: 'invalid bytes' },
    };
    const preparation = {
      requestId: 'failed-prepare',
      status: 'rejected',
      sourceCount: 1,
      failure,
    };
    expect(isExecutionReport({ ...report, audio: { ...report.audio, preparation } })).toBe(true);
    expect(
      isExecutionReport({
        ...report,
        audio: {
          ...report.audio,
          preparation: { ...preparation, failure: { ...failure, undeclared: true } },
        },
      }),
    ).toBe(false);
    expect(
      isExecutionReport({
        ...report,
        audio: { ...report.audio, lastError: { ...failure, code: 'unknown-code' } },
      }),
    ).toBe(false);
  });

  it('rejects missing and extra schema fields', () => {
    const report = createExecutionReport(
      capabilities(false),
      selectExecutionWorkers({ capabilities: capabilities(false) }).unwrap(),
    );
    const { world: _world, ...missing } = report;
    expect(isExecutionReport(missing)).toBe(false);
    expect(isExecutionReport({ ...report, workerId: 1 })).toBe(false);
  });

  it('accepts bounded Host streaming counters and rejects malformed observations', () => {
    const report = createExecutionReport(
      capabilities(),
      selectExecutionWorkers({ capabilities: capabilities() }).unwrap(),
    );
    const streaming = {
      encodedBytes: 0,
      pcmBytes: 384000,
      pendingBytes: 1000,
      pendingReads: 1,
      underruns: 0,
    };
    const observed = { ...report, audio: { ...report.audio, streaming } };
    expect(isExecutionReport(observed)).toBe(true);
    expect(
      isExecutionReport({
        ...observed,
        audio: { ...observed.audio, streaming: { ...streaming, pendingReads: -1 } },
      }),
    ).toBe(false);
    expect(
      isExecutionReport({
        ...observed,
        audio: { ...observed.audio, streaming: { ...streaming, retained: 1 } },
      }),
    ).toBe(false);
  });

  it('reports actual Render Worker transport capabilities and storage limits', () => {
    const report = createExecutionReport(
      capabilities(),
      selectExecutionWorkers({ capabilities: capabilities() }).unwrap(),
    );
    const render = {
      epoch: 1,
      state: 'alive' as const,
      submittedFrame: 2,
      completedFrame: 1,
      capabilities: { backendKind: 'webgpu' as const, compute: true, storageBuffer: true },
      limits: { maxStorageBuffersPerShaderStage: 8 },
    };

    expect(isExecutionReport({ ...report, render })).toBe(true);
    expect(
      isExecutionReport({
        ...report,
        render: { ...render, capabilities: { storageBuffer: true } },
      }),
    ).toBe(false);
    expect(
      isExecutionReport({
        ...report,
        render: { ...render, limits: { maxStorageBuffersPerShaderStage: -1 } },
      }),
    ).toBe(false);
    expect(isExecutionReport({ ...report, render: { ...render, limits: undefined } })).toBe(false);
  });

  it('rejects frame counters that break the submitted/completed invariant', () => {
    const report = createExecutionReport(
      capabilities(false),
      selectExecutionWorkers({ capabilities: capabilities(false) }).unwrap(),
    );
    expect(
      isExecutionReport({
        ...report,
        frame: { ...report.frame, inFlight: 1 },
      }),
    ).toBe(false);
    expect(
      isExecutionReport({
        ...report,
        frame: { ...report.frame, completed: 1 },
      }),
    ).toBe(false);
  });
});
