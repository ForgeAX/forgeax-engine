import { afterEach, expect, it, vi } from 'vitest';
import { shaderCompileDiagnostics } from '../engine-inputs/shader-compile-diagnostics.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('does not allocate a progress timer or sample the process when disabled', () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', undefined);
  const interval = vi.spyOn(globalThis, 'setInterval');
  const cpu = vi.spyOn(process, 'cpuUsage');
  const memory = vi.spyOn(process, 'memoryUsage');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(shaderCompileDiagnostics('family', 2)).toBeUndefined();
  expect(interval).not.toHaveBeenCalled();
  expect(cpu).not.toHaveBeenCalled();
  expect(memory).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it('reports bounded phase facts every thirty seconds and closes exactly once', () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  vi.useFakeTimers();
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const interval = vi.spyOn(globalThis, 'setInterval');
  const diagnostics = shaderCompileDiagnostics('material-family', 2);
  const handle = interval.mock.results[0]?.value as ReturnType<typeof setInterval>;
  expect(handle.hasRef()).toBe(false);
  expect(diagnostics).toBeDefined();
  diagnostics?.start(0);
  diagnostics?.prepared(0, 4);
  diagnostics?.phase(0, 'compiling', 7);
  vi.advanceTimersByTime(29_999);
  expect(output).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(output).toHaveBeenCalledTimes(2);
  const progress = JSON.parse(String(output.mock.calls[1]?.[0]).split('] ')[1] ?? '{}');
  expect(progress).toMatchObject({
    event: 'progress',
    family: 'material-family',
    total: 2,
    submitted: 1,
    completed: 0,
    active: [{ id: 0, phase: 'compiling', preparationWallMs: 11 }],
    processCpuScope: 'entire-process-including-workers',
    heapUsedBytes: expect.any(Number),
    rssBytes: expect.any(Number),
  });
  diagnostics?.complete(0, { preparationWallMs: 7, compileWallMs: 25 });
  diagnostics?.finish('end');
  diagnostics?.finish('error');
  vi.advanceTimersByTime(90_000);
  expect(output).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(JSON.parse(String(output.mock.calls[2]?.[0]).split('] ')[1] ?? '{}')).toMatchObject({
    event: 'end',
    completed: 1,
    active: [],
    preparationWallMs: 11,
    compileWallMs: 25,
  });
});
