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
      contextState: 'suspended',
      activeSourceCount: 0,
      lastError: null,
    });
    expect(report.fault).toBeNull();
    expect(isExecutionReport(report)).toBe(true);
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
