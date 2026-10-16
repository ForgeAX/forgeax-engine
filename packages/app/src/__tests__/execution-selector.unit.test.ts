import { describe, expect, it } from 'vitest';
import { type ExecutionWorkersOptions, selectExecutionWorkers } from '../index';
import { executionFacts, workerSelection } from './execution-fixtures';

describe('composable worker selection', () => {
  it('defaults to render plus kernel workers together', () => {
    const selected = selectExecutionWorkers({ capabilities: executionFacts() }).unwrap();
    expect(
      Object.values(selected).map((decision) => [decision.requested, decision.enabled]),
    ).toEqual([
      ['auto', true],
      ['auto', true],
      ['auto', true],
    ]);
  });
  it.each([false, true])('composes render=%s with either kernel setting', (render) => {
    for (const kernels of [false, true]) {
      const selected = workerSelection({ render, kernels });
      expect(selected.engine.enabled).toBe(true);
      expect(selected.render.enabled).toBe(render);
      expect(selected.kernels.enabled).toBe(kernels);
    }
  });
  it('losing isolation disables only kernels, preserving independent rendering', () => {
    const selected = selectExecutionWorkers({
      capabilities: executionFacts(['crossOriginIsolated']),
    }).unwrap();
    expect(selected.render.enabled).toBe(true);
    expect(selected.kernels).toEqual({
      requested: 'auto',
      enabled: false,
      reason: 'capability-unavailable',
      missingCapabilities: ['crossOriginIsolated'],
    });
  });
  it('falls back to the host when the worker renderer cannot be created', () => {
    const selected = selectExecutionWorkers({
      capabilities: executionFacts(['workerWebGpu']),
    }).unwrap();
    expect(selected.engine.reason).toBe('capability-unavailable');
    expect(selected.render.reason).toBe('engine-disabled');
    expect(selected.kernels.reason).toBe('engine-disabled');
  });
  it('explicit host execution also disables automatic dependents', () => {
    const selected = workerSelection({ engine: false });
    expect(Object.values(selected).every((decision) => !decision.enabled)).toBe(true);
    expect(selected.engine.reason).toBe('disabled');
  });
  it.each([
    'render',
    'kernels',
  ] as const)('rejects an explicit %s dependency on a disabled engine', (worker) => {
    const result = selectExecutionWorkers({
      workers: { engine: false, [worker]: true } as ExecutionWorkersOptions,
      capabilities: executionFacts(),
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'app-execution-worker-unavailable')
      throw new Error('expected worker refusal');
    expect(result.error.detail).toEqual({
      worker,
      reason: 'engine-disabled',
      missingCapabilities: [],
    });
  });
  it('never silently downgrades an explicitly required kernel pool', () => {
    const result = selectExecutionWorkers({
      workers: { kernels: true },
      capabilities: executionFacts(['sharedArrayBuffer']),
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'app-execution-worker-unavailable')
      throw new Error('expected worker refusal');
    expect(result.error.detail).toEqual({
      worker: 'kernels',
      reason: 'capability-unavailable',
      missingCapabilities: ['sharedArrayBuffer'],
    });
  });
});
