import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MaterialCompileJob } from '../engine-inputs/compile-material-sources.js';

const fixture = vi.hoisted(() => ({
  compile: vi.fn(),
  pending: [] as (() => void)[],
  workers: [] as { listenerCount(event: string): number; threadId: number }[],
  workerFlags: [] as (boolean | undefined)[],
  workerFailure: undefined as Error | undefined,
}));

vi.mock('@forgeax/engine-shader-compiler', () => ({
  createShaderProgramCompiler: () => fixture.compile,
}));
vi.mock('../engine-inputs/prepare-engine-shader-source.js', () => ({
  lowerEngineSurfaceEntry: (file: { source: string }) => ({ source: file.source, imports: {} }),
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      threadId = 1;
      constructor(_source: string, options: { workerData: { diagnostics?: boolean } }) {
        super();
        fixture.workers.push(this);
        fixture.workerFlags.push(options.workerData.diagnostics);
      }
      postMessage(message: { id: number } | null) {
        if (message === null) {
          this.threadId = -1;
          this.emit('exit', 0);
          return;
        }
        this.emit('message', { id: message.id, phase: 'compiling' });
        fixture.pending.push(() => {
          if (fixture.workerFailure !== undefined && message.id === 0)
            this.emit('error', fixture.workerFailure);
          else
            this.emit('message', {
              id: message.id,
              result: result(message.id),
              timing: { preparationWallMs: 3, compileWallMs: 5 },
            });
        });
      }
    },
  };
});

function result(id: number) {
  return { ok: true, value: { id, wgsl: `private-source-${id}`, manifestEntry: { wgsl: '' } } };
}

function jobs(): MaterialCompileJob[] {
  return [0, 1].map((id) => ({
    file: { id: 'source-family', source: `private-source-${id}` },
    defines: undefined,
    options: {},
  }));
}

beforeEach(() => {
  fixture.pending = [];
  fixture.workers = [];
  fixture.workerFlags = [];
  fixture.workerFailure = undefined;
  fixture.compile.mockReset();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('keeps disabled sequential compilation order and result bodies unchanged', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', undefined);
  fixture.compile.mockImplementation(async (source: string) => result(Number(source.slice(-1))));
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  const compiled = await compileMaterialSources(jobs(), {});
  expect(fixture.compile).toHaveBeenCalledTimes(2);
  expect(compiled.map((row) => row.ok && row.value.wgsl)).toEqual([
    'private-source-0',
    'private-source-1',
  ]);
  expect(output).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('phase messages do not settle worker jobs and final replies remove listeners and timers', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '2');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  const pending = compileMaterialSources(jobs(), {});
  expect(fixture.pending).toHaveLength(2);
  expect(fixture.workerFlags).toEqual([true, true]);
  expect(fixture.workers.every((worker) => worker.listenerCount('message') === 1)).toBe(true);
  fixture.pending[1]?.();
  fixture.pending[0]?.();
  const compiled = await pending;
  expect(compiled.map((row) => row.ok && row.value.wgsl)).toEqual([
    'private-source-0',
    'private-source-1',
  ]);
  expect(fixture.workers.every((worker) => worker.threadId === -1)).toBe(true);
  expect(
    fixture.workers.every((worker) =>
      ['message', 'error', 'exit'].every((event) => worker.listenerCount(event) === 0),
    ),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(output.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(
    'private-source',
  );
});

it('retains the original worker failure after peers settle and closes diagnostics', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '2');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fixture.workerFailure = new Error('original worker failure');
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  const pending = compileMaterialSources(jobs(), {});
  const rejected = expect(pending).rejects.toBe(fixture.workerFailure);
  fixture.pending[0]?.();
  fixture.pending[1]?.();
  await rejected;
  expect(fixture.workers.every((worker) => worker.threadId === -1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(output.mock.calls.at(-1)?.[0]).toContain('"event":"error"');
});

it('retains preparation errors and releases the timer even when the diagnostic sink rejects', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    throw new Error('diagnostic output unavailable');
  });
  const original = new Error('original preparation error');
  const input = jobs();
  const first = input[0];
  if (first === undefined) throw new Error('Missing first fixture job');
  input[0] = {
    ...first,
    prepare: () => {
      throw original;
    },
  };
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  await expect(compileMaterialSources(input, {})).rejects.toBe(original);
  expect(fixture.compile).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a returned compiler error without turning the ordered batch into a rejection', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const failure = { ok: false, error: { code: 'fixture-compile-error' } };
  fixture.compile.mockResolvedValueOnce(failure).mockResolvedValueOnce(result(1));
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  const compiled = await compileMaterialSources(jobs(), {});
  expect(compiled[0]).toBe(failure);
  expect(fixture.compile).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(output.mock.calls.at(-1)?.[0]).toContain('"event":"error"');
});

it('disables unavailable initialization observations without changing compilation', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  vi.spyOn(process, 'cpuUsage').mockImplementation(() => {
    throw new Error('process CPU sampling unavailable');
  });
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fixture.compile.mockResolvedValue(result(0));
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  expect(await compileMaterialSources(jobs(), {})).toHaveLength(2);
  expect(fixture.compile).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(output).toHaveBeenCalledTimes(1);
  expect(output.mock.calls[0]?.[0]).toContain('"event":"unavailable"');
});

it.each([
  'cpu',
  'memory',
])('retains compiler results and timer cleanup when %s sampling throws', async (kind) => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  vi.stubEnv('FORGEAX_SHADER_COMPILE_DIAGNOSTICS', '1');
  if (kind === 'cpu') {
    vi.spyOn(process, 'cpuUsage')
      .mockReturnValueOnce({ user: 0, system: 0 })
      .mockImplementation(() => {
        throw new Error('CPU sampling unavailable after initialization');
      });
  } else {
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('memory sampling unavailable');
    });
  }
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fixture.compile.mockResolvedValue(result(0));
  const { compileMaterialSources } = await import('../engine-inputs/compile-material-sources.js');
  expect(await compileMaterialSources(jobs(), {})).toHaveLength(2);
  expect(fixture.compile).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(output).toHaveBeenCalledTimes(1);
  expect(output.mock.calls[0]?.[0]).toContain('"event":"unavailable"');
});
