import { Worker } from 'node:worker_threads';
import * as naga from '@forgeax/engine-naga';
import { compileShader, prepareEngineShaderSource } from '@forgeax/engine-shader-compiler';
import { afterEach, expect, it, vi } from 'vitest';
import {
  compileMaterialSources,
  type MaterialCompileJob,
} from '../engine-inputs/compile-material-sources.js';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries.js';

const previousWorkers = process.env.FORGEAX_SHADER_COMPILE_WORKERS;
afterEach(() => {
  if (previousWorkers === undefined) delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  else process.env.FORGEAX_SHADER_COMPILE_WORKERS = previousWorkers;
  vi.restoreAllMocks();
});

it('projects native results in roster order with a bounded admission window', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const projected: number[] = [];
  const original = Worker.prototype.emit;
  let firstDelivered = false;
  let laterCompletedFirst = false;
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const message = args[0] as { id?: number; result?: unknown } | undefined;
    if (event === 'message' && message?.result !== undefined) {
      if (message.id === 0) {
        setTimeout(() => {
          firstDelivered = true;
          original.call(this, event, ...args);
        }, 100);
        return true;
      }
      if (!firstDelivered) laterCompletedFirst = true;
    }
    return original.call(this, event, ...args);
  });
  const jobs: MaterialCompileJob[] = Array.from({ length: 12 }, (_, index) => ({
    defines: undefined,
    file: { id: `ordered-${index}`, source: '' },
    options: {},
    prepare: () => {
      expect(index).toBeLessThan(projected.length + 4);
      return {
        defines: undefined,
        options: {},
        file: {
          id: `ordered-${index}`,
          source: `@compute @workgroup_size(1) fn work_${index}() {}`,
        },
      };
    },
  }));
  const results = await compileMaterialSources(jobs, {}, (result, index) => {
    expect(result.ok).toBe(true);
    projected.push(index);
    return result.unwrap().wgsl.length;
  });
  expect(laterCompletedFirst).toBe(true);
  expect(projected).toEqual(Array.from({ length: 12 }, (_, index) => index));
  expect(results.every((length) => length > 0)).toBe(true);
});

it('closes projected compilation after a consumer throws and recovers on the next invocation', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const jobs = Array.from({ length: 12 }, (_, index) => ({
    defines: undefined,
    file: { id: `failure-${index}`, source: '@compute @workgroup_size(1) fn work() {}' },
    options: {},
  }));
  await expect(
    compileMaterialSources(jobs, {}, () => {
      throw Error('projection failure');
    }),
  ).rejects.toThrow('projection failure');
  expect((await compileMaterialSources(jobs.slice(0, 2), {})).every((result) => result.ok)).toBe(
    true,
  );
});

it.each([
  '1',
  '2',
])('prepares deferred source jobs only at compilation admission (%s workers)', async (workers) => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = workers;
  const prepared: number[] = [];
  const source = '@compute @workgroup_size(1) fn cs() {}';
  const jobs: MaterialCompileJob[] = [0, 1, 2].map((index) => ({
    defines: undefined,
    file: { id: `deferred-${index}`, source: 'invalid unprepared source' },
    options: { id: `deferred-${index}` },
    prepare: () => {
      prepared.push(index);
      return { defines: undefined, file: { id: `deferred-${index}`, source }, options: {} };
    },
  }));
  expect(prepared).toEqual([]);
  const results = await compileMaterialSources(jobs, {});
  expect(prepared).toEqual([0, 1, 2]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(results).toEqual(
    await compileMaterialSources(
      jobs.map(({ prepare: _prepare, ...job }) => ({
        ...job,
        file: { ...job.file, source },
        options: {},
      })),
      {},
    ),
  );
});

it('prepares Standard Surface inside real workers without changing compiled bytes or metadata', async () => {
  const engine = await loadEngineShaderEntries();
  const jobs: MaterialCompileJob[] = Array.from({ length: 32 }, (_, index) => index % 2 === 1).map(
    (vertexColor, index) => ({
      defines: { VERTEX_COLOR_AVAILABLE: vertexColor },
      file: engine.defaultStandardPbr,
      options: {
        id: `worker-standard-${index}`,
        imports: engine.imports,
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          PER_INSTANCE_REGION: false,
          SKINNING_DISABLED: true,
          VERTEX_COLOR_AVAILABLE: vertexColor,
        },
      },
    }),
  );
  const expected = await Promise.all(
    jobs.map(async (job) => {
      const prepared = prepareEngineShaderSource(
        job.file,
        engine.imports,
        engine.imports,
        job.options.defines,
      ).unwrap();
      return compileShader(prepared.source, { ...job.options, imports: prepared.imports });
    }),
  );
  for (const result of expected) expect(result.ok).toBe(true);
  const compose = vi.spyOn(naga, 'composeShader');
  const exits: number[] = [];
  const observed = new WeakSet<Worker>();
  const postMessage = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    if (!observed.has(this)) {
      observed.add(this);
      this.once('exit', (code) => exits.push(code));
    }
    return postMessage.apply(this, args);
  });
  for (const workers of ['1', '2', '16']) {
    compose.mockClear();
    exits.length = 0;
    process.env.FORGEAX_SHADER_COMPILE_WORKERS = workers;
    expect(await compileMaterialSources(jobs, engine.imports)).toEqual(expected);
    if (workers === '1') expect(compose).toHaveBeenCalledTimes(2);
    expect(exits).toEqual(Array.from({ length: workers === '1' ? 0 : Number(workers) }, () => 0));
  }
}, 60_000);

it('preserves preparation errors and recovers for later worker invocations', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const invalid = { id: 'broken', source: '#pragma material_slot surface' };
  await expect(
    compileMaterialSources(
      [
        { defines: undefined, file: invalid, options: { id: invalid.id } },
        { defines: undefined, file: invalid, options: { id: invalid.id } },
      ],
      {},
    ),
  ).rejects.toThrow('Standard Surface entry has no module identity: broken');
  const source = '@compute @workgroup_size(1) fn cs() {}';
  const jobs = [0, 1].map((index) => ({
    defines: undefined,
    file: { id: `valid-${index}`, source },
    options: { id: `valid-${index}` },
  }));
  const results = await compileMaterialSources(jobs, {});
  expect(results.every((result) => result.ok)).toBe(true);
});
