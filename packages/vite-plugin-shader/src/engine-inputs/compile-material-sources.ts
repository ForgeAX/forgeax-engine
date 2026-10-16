import { once } from 'node:events';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  type CompileOptions,
  type compileShader,
  createShaderProgramCompiler,
} from '@forgeax/engine-shader-compiler';
import type { EngineShaderFile } from './load-engine-shader-entries.js';
import { lowerEngineSurfaceEntry } from './prepare-engine-shader-source.js';

export type MaterialCompileJob = {
  readonly defines: Record<string, boolean> | undefined;
  readonly file: EngineShaderFile;
  readonly options: CompileOptions;
};

export type MaterialCompileResult = Awaited<ReturnType<typeof compileShader>>;

/**
 * `compileShader` is pure but its naga/WASM call is synchronous after the
 * initial `ensureReady()` await. Promise concurrency therefore cannot use the
 * available build CPUs; a small worker pool keeps build-time production
 * bounded while leaving the runtime compiler single-threaded.
 */
const shaderCompilerModulePath = import.meta.resolve('@forgeax/engine-shader-compiler');
const preparationModulePath = new URL(
  'prepare-engine-shader-source.mjs',
  import.meta.resolve('@forgeax/engine-vite-plugin-shader'),
).href;
const SHADER_COMPILE_WORKER_SOURCE = `
const preparationPromise = import(${JSON.stringify(preparationModulePath)});
const compilerPromise = import(${JSON.stringify(shaderCompilerModulePath)})
  .then(({ createShaderProgramCompiler }) => createShaderProgramCompiler());
import('node:worker_threads').then(({ parentPort, workerData }) => {
  parentPort.on('message', async (message) => {
    if (message === null) {
      parentPort.close();
      return;
    }
    try {
      const compileShader = await compilerPromise;
      const { lowerEngineSurfaceEntry } = await preparationPromise;
      const prepared = lowerEngineSurfaceEntry(message.file, message.options.imports ?? {}, workerData.fallbackImports, message.options.defines);
      const result = await compileShader(prepared.source, { ...message.options, imports: prepared.imports });
      if (result.ok) {
        parentPort.postMessage({ id: message.id, result: { ok: true, value: result.value } });
        return;
      }
      const error = result.error;
      parentPort.postMessage({
        id: message.id,
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
        error: { message: error instanceof Error ? error.message : String(error), ...error },
      });
    }
  });
});
`;

interface ShaderCompileWorkerResponse {
  readonly id: number;
  readonly result?: MaterialCompileResult;
  readonly error?: { readonly message: string };
}

function runShaderCompileWorkerJob(
  worker: Worker,
  id: number,
  job: MaterialCompileJob,
): Promise<MaterialCompileResult> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ShaderCompileWorkerResponse): void => {
      if (message.id !== id) return;
      cleanup();
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
      reject(error);
    };
    const onExit = (code: number): void => {
      cleanup();
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

export async function compileMaterialSources(
  jobs: readonly MaterialCompileJob[],
  fallbackImports: Readonly<Record<string, string>>,
): Promise<MaterialCompileResult[]> {
  const requestedWorkers = Number.parseInt(process.env.FORGEAX_SHADER_COMPILE_WORKERS ?? '', 10);
  const workerCount = Math.min(
    jobs.length,
    MAX_SHADER_COMPILE_WORKERS,
    Number.isFinite(requestedWorkers) && requestedWorkers > 0
      ? requestedWorkers
      : Math.max(1, availableParallelism() - 1),
  );
  if (workerCount <= 1) {
    const compileShader = createShaderProgramCompiler();
    const results: MaterialCompileResult[] = [];
    for (const job of jobs) {
      const prepared = lowerEngineSurfaceEntry(
        job.file,
        job.options.imports ?? {},
        fallbackImports,
        job.options.defines,
      );
      results.push(
        await compileShader(prepared.source, { ...job.options, imports: prepared.imports }),
      );
    }
    return results;
  }

  const workers = Array.from(
    { length: workerCount },
    () =>
      new Worker(SHADER_COMPILE_WORKER_SOURCE, {
        eval: true,
        workerData: { fallbackImports },
      } as never),
  );
  const results: Array<MaterialCompileResult | undefined> = Array.from(
    { length: jobs.length },
    () => undefined,
  );
  // Variant costs differ by an order of magnitude, so workers pull from one
  // shared cursor instead of a static stride; results stay index-ordered.
  let nextJob = 0;
  const tasks = workers.map(async (worker) => {
    for (let jobIndex = nextJob++; jobIndex < jobs.length; jobIndex = nextJob++) {
      results[jobIndex] = await runShaderCompileWorkerJob(
        worker,
        jobIndex,
        jobs[jobIndex] as MaterialCompileJob,
      );
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
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`shader compile worker missed job ${index}`);
    return result;
  });
}
