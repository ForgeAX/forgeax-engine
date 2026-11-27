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

function observeWorkerJobs(cancelAt?: number) {
  const threads = new Map<number, number>();
  const completed = new Set<number>();
  const exits: number[] = [];
  const observed = new WeakSet<Worker>();
  const lastPosted = new WeakMap<Worker, number>();
  const postMessage = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    if (!observed.has(this)) {
      observed.add(this);
      this.once('exit', (code) => exits.push(code));
      this.on('message', (result: { readonly id: number; readonly phase?: string }) => {
        if (result.phase === undefined) completed.add(result.id);
      });
    }
    const previous = lastPosted.get(this);
    if (previous !== undefined) expect(completed.has(previous)).toBe(true);

    const message = args[0];
    if (message !== null && typeof message === 'object' && typeof message.id === 'number') {
      expect(threads.has(message.id)).toBe(false);
      lastPosted.set(this, message.id);
      threads.set(message.id, this.threadId);
      if (message.id === cancelAt) {
        void this.terminate();
        return;
      }
    }
    return postMessage.apply(this, args);
  });
  return { threads, completed, exits };
}

function neighboringJobs(): MaterialCompileJob[] {
  const source = `#import test::value::{value}
@group(0) @binding(0) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1) fn main() { output[0] = value(); }`;
  return Array.from({ length: 12 }, (_, index) => ({
    defines: { UNUSED_FORMAT_SELECTOR: index % 2 === 0 },
    file: { id: `neighbor-${index}`, source },
    options: {
      id: `neighbor-${index}`,
      defines: { UNUSED_FORMAT_SELECTOR: index % 2 === 0 },
      imports: {
        'test::value': `#define_import_path test::value
fn value() -> u32 { return ${index < 4 ? '7u' : '((3u * 19u + 7u) / 2u)'}; }`,
      },
      ...(index === 9 ? { dynamicOffsets: [{ group: 0, binding: 0 }] } : {}),
      computeEntry: index === 11 ? 'missing' : 'main',
    },
  }));
}

it('preserves ordered compiler results while preparing one active job per worker', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const jobs = neighboringJobs();
  const expected = await Promise.all(
    jobs.map((job) => compileShader(job.file.source, job.options)),
  );
  expect(expected.slice(0, 11).every((result) => result.ok)).toBe(true);
  expect(expected[11]?.ok).toBe(false);
  const observed = observeWorkerJobs();
  const prepared: number[] = [];
  const results = await compileMaterialSources(
    jobs.map((job, index) => ({
      ...job,
      prepare: () => {
        expect(prepared.length - observed.completed.size).toBeLessThan(2);
        prepared.push(index);
        return job;
      },
    })),
    {},
  );
  expect(results.slice(0, 11)).toEqual(expected.slice(0, 11));
  expect(results[11]).toMatchObject({
    ok: false,
    error: { code: 'shader-compile-failed', message: 'expected one compute entry named missing' },
  });
  expect(results[8]).not.toEqual(results[9]);
  expect(new Set(observed.threads.values()).size).toBe(2);
  expect(observed.threads.get(0)).not.toBe(observed.threads.get(1));
  expect(prepared).toEqual(Array.from({ length: jobs.length }, (_, index) => index));
  expect(observed.completed.size).toBe(jobs.length);
  expect(observed.exits).toEqual([0, 0]);
}, 30_000);

it('drains in-flight work before preserving a lazy preparation failure', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const observed = observeWorkerJobs();
  const prepared: number[] = [];
  const jobs = neighboringJobs().map((job, index) => ({
    ...job,
    prepare: () => {
      prepared.push(index);
      if (index === 1) throw new Error('lazy preparation rejected neighbor-1');
      return job;
    },
  }));
  await expect(compileMaterialSources(jobs, {})).rejects.toThrow(
    'lazy preparation rejected neighbor-1',
  );
  expect(prepared).toEqual([0, 1]);
  expect([...observed.completed]).toEqual([0]);
  expect(observed.exits).toEqual([0, 0]);
});

it('drains surviving in-flight work after worker cancellation and can start another batch', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const observed = observeWorkerJobs(0);
  await expect(compileMaterialSources(neighboringJobs(), {})).rejects.toThrow(
    'shader compile worker exited before returning job 0',
  );
  expect(observed.completed.has(0)).toBe(false);
  expect(observed.completed.has(1)).toBe(true);
  expect(observed.exits).toHaveLength(2);
  vi.restoreAllMocks();
  const results = await compileMaterialSources(neighboringJobs().slice(0, 2), {});
  expect(results.every((result) => result.ok)).toBe(true);
});
