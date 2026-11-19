import { once } from 'node:events';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  type CompileOptions,
  type compileShader,
  createShaderProgramCompiler,
  prepareEngineShaderSource,
} from '@forgeax/engine-shader-compiler';
import { ok } from '@forgeax/engine-types';
import type { EngineShaderFile } from './load-engine-shader-entries.js';
import {
  type ShaderCompileDiagnostics,
  type ShaderCompileTiming,
  shaderCompileDiagnostics,
} from './shader-compile-diagnostics.js';

export type MaterialCompileJob = {
  readonly defines: Record<string, boolean> | undefined;
  readonly file: EngineShaderFile;
  readonly options: CompileOptions;
  /** Project source/imports only when a serial or Worker lane admits this job. */
  readonly prepare?: () => MaterialCompileJob;
};

export type MaterialCompileResult = Awaited<ReturnType<typeof compileShader>>;

/**
 * `compileShader` is pure but its naga/WASM call is synchronous after the
 * initial `ensureReady()` await. Promise concurrency therefore cannot use the
 * available build CPUs; a small worker pool keeps build-time production
 * bounded while leaving the runtime compiler single-threaded.
 */
const shaderCompilerModulePath = import.meta.resolve('@forgeax/engine-shader-compiler');
const SHADER_COMPILE_WORKER_SOURCE = `
const preparationPromise = import(${JSON.stringify(shaderCompilerModulePath)});
const compilerPromise = import(${JSON.stringify(shaderCompilerModulePath)})
  .then(({ createShaderProgramCompiler }) => createShaderProgramCompiler());
import('node:worker_threads').then(({ parentPort, workerData }) => {
  parentPort.on('message', async (message) => {
    if (message === null) {
      parentPort.close();
      return;
    }
    const startedAt = workerData.diagnostics ? performance.now() : 0;
    let compileStartedAt;
    const timing = () => workerData.diagnostics ? {
      preparationWallMs: (compileStartedAt ?? performance.now()) - startedAt,
      compileWallMs: compileStartedAt === undefined ? 0 : performance.now() - compileStartedAt,
    } : undefined;
    if (workerData.diagnostics) parentPort.postMessage({ id: message.id, phase: 'preparing' });
    try {
      const compileShader = await compilerPromise;
      const { prepareEngineShaderSource } = await preparationPromise;
      const prepared = prepareEngineShaderSource(message.file, message.options.imports ?? {}, workerData.fallbackImports, message.options.defines).unwrap();
      if (workerData.diagnostics) {
        compileStartedAt = performance.now();
        parentPort.postMessage({ id: message.id, phase: 'compiling', timing: timing() });
      }
      const result = await compileShader(prepared.source, { ...message.options, imports: prepared.imports });
      if (result.ok) {
        // The public result owns one WGSL body at two fields. Strings are copied by
        // value across isolates, so send it once and restore the alias in the parent.
        parentPort.postMessage({ id: message.id, ...(workerData.diagnostics ? { timing: timing() } : {}), result: { ok: true, value: {
          ...result.value, manifestEntry: { ...result.value.manifestEntry, wgsl: '' }
        } } });
        return;
      }
      const error = result.error;
      parentPort.postMessage({
        id: message.id,
        ...(workerData.diagnostics ? { timing: timing() } : {}),
        result: {
          ok: false,
          error: {
            code: error.code,
            expected: error.expected,
            hint: error.hint,
            message: error.message,
            lineNum: error.lineNum,
            linePos: error.linePos,
            detail: error.detail,
          },
        },
      });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        ...(workerData.diagnostics ? { timing: timing() } : {}),
        error: { message: error instanceof Error ? error.message : String(error), ...error },
      });
    }
  });
});
`;

interface ShaderCompileWorkerResponse {
  readonly id: number;
  readonly phase?: 'preparing' | 'compiling';
  readonly timing?: ShaderCompileTiming;
  readonly result?: MaterialCompileResult;
  readonly error?: { readonly message: string };
}

function runShaderCompileWorkerJob(
  worker: Worker,
  id: number,
  job: MaterialCompileJob,
  diagnostics?: ShaderCompileDiagnostics,
): Promise<MaterialCompileResult> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ShaderCompileWorkerResponse): void => {
      if (message.id !== id) return;
      if (message.phase !== undefined) {
        diagnostics?.phase(id, message.phase, message.timing?.preparationWallMs);
        return;
      }
      cleanup();
      diagnostics?.complete(id, message.timing);
      if (message.error !== undefined) {
        reject(Object.assign(new Error(message.error.message), message.error));
        return;
      }
      if (message.result === undefined) {
        reject(new Error('shader compile worker returned no result'));
        return;
      }
      resolve(message.result);
    };
    const onError = (error: Error): void => {
      cleanup();
      diagnostics?.complete(id);
      reject(error);
    };
    const onExit = (code: number): void => {
      cleanup();
      diagnostics?.complete(id);
      reject(new Error(`shader compile worker exited before returning job ${id}: ${code}`));
    };
    const cleanup = (): void => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    worker.addListener('message', onMessage);
    worker.addListener('error', onError);
    worker.addListener('exit', onExit);
    worker.postMessage({ id, file: job.file, options: job.options });
  });
}

/** Each worker holds its own naga/WASM instance; beyond this, memory outgrows the gain. */
const MAX_SHADER_COMPILE_WORKERS = 16;

export function compileMaterialSources(
  jobs: readonly MaterialCompileJob[],
  fallbackImports: Readonly<Record<string, string>>,
): Promise<MaterialCompileResult[]>;
export function compileMaterialSources<T>(
  jobs: readonly MaterialCompileJob[],
  fallbackImports: Readonly<Record<string, string>>,
  project: (result: MaterialCompileResult, index: number) => T,
): Promise<T[]>;
export async function compileMaterialSources<T>(
  jobs: readonly MaterialCompileJob[],
  fallbackImports: Readonly<Record<string, string>>,
  project?: (result: MaterialCompileResult, index: number) => T,
): Promise<Array<T | MaterialCompileResult>> {
  const diagnostics = shaderCompileDiagnostics(jobs[0]?.file.id ?? '<empty>', jobs.length);
  let outcome: 'end' | 'error' = 'error';
  let failedCompilation = false;
  try {
    const requestedWorkers = Number.parseInt(process.env.FORGEAX_SHADER_COMPILE_WORKERS ?? '', 10);
    const workerCount = Math.min(
      jobs.length,
      MAX_SHADER_COMPILE_WORKERS,
      Number.isFinite(requestedWorkers) && requestedWorkers > 0
        ? requestedWorkers
        : Math.max(1, availableParallelism() - 1),
    );
    // Only this roster owns the table; equal programs share their immutable body
    // while every variant retains independently mutable metadata and result order.
    // Whole WGSL Map keys can acquire a second internalized string in V8. Use
    // the existing short content hash as a bucket and compare complete bytes:
    // the legacy 32-bit identity is not an integrity or equality proof.
    const sources = new Map<string, string[]>();
    const retain = (result: MaterialCompileResult): MaterialCompileResult => {
      if (!result.ok) return result;
      const value = result.value;
      const hash = value.manifestEntry.hash;
      let bucket = sources.get(hash);
      if (bucket === undefined) {
        bucket = [];
        sources.set(hash, bucket);
      }
      let source = bucket.find((held) => held === value.wgsl);
      if (source === undefined) {
        source = value.wgsl;
        bucket.push(source);
      }
      return ok({
        ...value,
        wgsl: source,
        manifestEntry: { ...value.manifestEntry, wgsl: source },
      });
    };
    if (workerCount <= 1) {
      const compileShader = createShaderProgramCompiler();
      const results: Array<T | MaterialCompileResult> = [];
      for (const [index, descriptor] of jobs.entries()) {
        diagnostics?.start(index);
        const startedAt = diagnostics === undefined ? 0 : performance.now();
        const job = descriptor.prepare?.() ?? descriptor;
        const prepared = prepareEngineShaderSource(
          job.file,
          job.options.imports ?? {},
          fallbackImports,
          job.options.defines,
        ).unwrap();
        diagnostics?.prepared(index, performance.now() - startedAt);
        diagnostics?.phase(index, 'compiling');
        const compileStartedAt = diagnostics === undefined ? 0 : performance.now();
        const result = await compileShader(prepared.source, {
          ...job.options,
          imports: prepared.imports,
        });
        diagnostics?.complete(index, {
          preparationWallMs: 0,
          compileWallMs: performance.now() - compileStartedAt,
        });
        failedCompilation ||= !result.ok;
        results.push(project === undefined ? retain(result) : project(result, index));
      }
      outcome = failedCompilation ? 'error' : 'end';
      return results;
    }

    const workers = Array.from(
      { length: workerCount },
      () =>
        new Worker(SHADER_COMPILE_WORKER_SOURCE, {
          eval: true,
          workerData: {
            fallbackImports,
            ...(diagnostics === undefined ? {} : { diagnostics: true }),
          },
        } as never),
    );
    const results: Array<{ value: T | MaterialCompileResult } | undefined> = Array.from(
      { length: jobs.length },
      () => undefined,
    );
    const ready = new Map<number, MaterialCompileResult>();
    const waiting = new Set<() => void>();
    let nextJob = 0;
    let nextProjection = 0;
    let failed = false;
    const wake = () => {
      for (const resolve of waiting) resolve();
      waiting.clear();
    };
    const complete = (index: number, result: MaterialCompileResult) => {
      failedCompilation ||= !result.ok;
      if (project === undefined) {
        results[index] = { value: retain(result) };
        return;
      }
      // A small ordered window bounds complete native bodies even when one
      // variant compiles slowly. Publication table indices remain deterministic.
      ready.set(index, result);
      while (ready.has(nextProjection)) {
        const result = ready.get(nextProjection) as MaterialCompileResult;
        ready.delete(nextProjection);
        const value = result.ok
          ? ok({
              ...result.value,
              manifestEntry: { ...result.value.manifestEntry, wgsl: result.value.wgsl },
            })
          : result;
        results[nextProjection] = { value: project(value, nextProjection) };
        nextProjection++;
      }
      wake();
    };
    const tasks = workers.map(async (worker) => {
      try {
        while (!failed && nextJob < jobs.length) {
          while (!failed && project !== undefined && nextJob >= nextProjection + workerCount * 2)
            await new Promise<void>((resolve) => waiting.add(resolve));
          if (failed || nextJob >= jobs.length) break;
          const jobIndex = nextJob++;
          const descriptor = jobs[jobIndex] as MaterialCompileJob;
          diagnostics?.start(jobIndex);
          const startedAt = diagnostics === undefined ? 0 : performance.now();
          const job = descriptor.prepare?.() ?? descriptor;
          diagnostics?.prepared(jobIndex, performance.now() - startedAt);
          complete(jobIndex, await runShaderCompileWorkerJob(worker, jobIndex, job, diagnostics));
        }
      } catch (error) {
        failed = true;
        wake();
        throw error;
      }
    });
    const settled = await Promise.allSettled(tasks);
    // All jobs have settled before ports close, so native/WASM teardown is not
    // interrupted. Keep the original job failure ahead of any shutdown failure.
    const closed = await Promise.allSettled(
      workers.map(async (worker) => {
        if (worker.threadId === -1) return;
        const exited = once(worker, 'exit');
        worker.postMessage(null);
        const [code] = await exited;
        if (code !== 0) throw new Error(`shader compile worker shutdown failed: ${code}`);
      }),
    );
    const rejected = [...settled, ...closed].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected !== undefined) throw rejected.reason;
    const projected = results.map((result, index) => {
      if (result === undefined) throw new Error(`shader compile worker missed job ${index}`);
      return result.value;
    });
    outcome = failedCompilation ? 'error' : 'end';
    return projected;
  } finally {
    diagnostics?.finish(outcome);
  }
}
