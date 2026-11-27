import { createHash, getCiphers } from 'node:crypto';
import { once } from 'node:events';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { compileShader } from '../compile.js';
import { err, ok, ShaderError } from '../errors.js';
import { createShaderProgramCompiler } from '../program-compiler.js';

type Compilation = Awaited<ReturnType<typeof compileShader>>;
type SerializedShaderError = ConstructorParameters<typeof ShaderError>[0];
interface WorkerReply {
  readonly id: number;
  readonly result?:
    | Extract<Compilation, { ok: true }>
    | { readonly ok: false; readonly error: SerializedShaderError };
  readonly error?: { readonly message: string };
}

const compilerModule = import.meta.resolve('@forgeax/engine-shader-compiler');
const workerSource = `
const compiler = import(${JSON.stringify(compilerModule)})
  .then(({ createShaderProgramCompiler }) => createShaderProgramCompiler());
import('node:worker_threads').then(({ parentPort }) => {
  parentPort.on('message', async (job) => {
    if (job === null) { parentPort.close(); return; }
    try {
      const compile = await compiler;
      const result = await compile(job.source, job.options);
      if (result.ok) { parentPort.postMessage({ id: job.id, result }); return; }
      const { code, expected, hint, message, lineNum, linePos, detail } = result.error;
      parentPort.postMessage({ id: job.id, result: {
        ok: false, error: { code, expected, hint, message, lineNum, linePos, detail }
      } });
    } catch (error) {
      parentPort.postMessage({ id: job.id, error: {
        message: error instanceof Error ? error.message : String(error)
      } });
    }
  });
});
`;

interface PendingJob {
  readonly resolve: (result: Compilation) => void;
  readonly reject: (error: Error) => void;
}
interface CompilerWorker {
  readonly worker: Worker;
  readonly jobs: Map<number, PendingJob>;
}

/** Node Pack production only: browser compilation and the serial compiler stay unchanged. */
export function createNodeMaterialProgramCompiler(workerLimit?: number): {
  readonly compile: typeof compileShader;
  readonly concurrency: number;
  readonly close: () => Promise<void>;
} {
  const requested = workerLimit ?? Number(process.env.FORGEAX_SHADER_COMPILE_WORKERS);
  const cores = availableParallelism();
  // The material scheduler passes a bounded share of the process-wide budget.
  // A share of one keeps compilation inline.
  const concurrency = Math.min(
    6,
    cores,
    Number.isSafeInteger(requested) && requested > 0
      ? requested
      : Math.max(1, Math.min(2, cores - 1)),
  );
  const serial = createShaderProgramCompiler();
  const workers = new Map<number, CompilerWorker>();
  const routes = new Map<string, number>();
  const pending = new Set<Promise<Compilation>>();
  let nextId = 0;
  let closed = false;
  let initializedCrypto = false;

  const getWorker = (index: number): CompilerWorker => {
    const previous = workers.get(index);
    if (previous !== undefined) return previous;
    // Initialize OpenSSL providers on the parent before concurrent Worker imports.
    if (!initializedCrypto) {
      getCiphers();
      initializedCrypto = true;
    }
    const worker = new Worker(workerSource, { eval: true });
    const owner: CompilerWorker = { worker, jobs: new Map() };
    workers.set(index, owner);
    const fail = (error: Error): void => {
      if (workers.get(index) === owner) workers.delete(index);
      for (const job of owner.jobs.values()) job.reject(error);
      owner.jobs.clear();
      worker.unref();
    };
    worker.on('message', (reply: WorkerReply) => {
      const job = owner.jobs.get(reply.id);
      if (job === undefined) return;
      owner.jobs.delete(reply.id);
      if (owner.jobs.size === 0) worker.unref();
      if (reply.error !== undefined) job.reject(new Error(reply.error.message));
      else if (reply.result === undefined)
        job.reject(new Error('material compiler returned no result'));
      else if (reply.result.ok) job.resolve(ok(reply.result.value));
      else job.resolve(err(new ShaderError(reply.result.error)));
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      fail(new Error(`material compiler worker exited before returning its jobs: ${code}`));
    });
    worker.unref();
    return owner;
  };

  const route = (digest: Buffer): number => {
    const key = digest.toString('hex');
    const previous = routes.get(key);
    if (previous !== undefined) {
      routes.delete(key);
      routes.set(key, previous);
      return previous;
    }
    // Give new source compositions the least occupied Worker. Equal requests
    // retain that Worker's cache and in-flight compilation through the same route.
    const preferred = digest.readUInt32LE(0) % concurrency;
    let selected = preferred;
    let queued = workers.get(preferred)?.jobs.size ?? 0;
    for (let offset = 1; offset < concurrency && queued > 0; offset++) {
      const index = (preferred + offset) % concurrency;
      const pending = workers.get(index)?.jobs.size ?? 0;
      if (pending < queued) {
        selected = index;
        queued = pending;
      }
    }
    // A route stores only a digest and index. Bound it independently of the
    // compiled program caches while giving active sources stable affinity.
    if (routes.size >= 4096) {
      const oldest = routes.keys().next().value;
      if (oldest !== undefined) routes.delete(oldest);
    }
    routes.set(key, selected);
    return selected;
  };

  const compile: typeof compileShader = (source, options = {}) => {
    if (closed) return Promise.reject(new Error('material compiler is closed'));
    if (concurrency === 1) {
      const promise = serial(source, options);
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    }
    // Imports still enter the compiler's exact content key. Entry selectors
    // and diagnostic IDs share the same shader body and Worker route.
    const digest = createHash('sha256')
      .update(JSON.stringify([source, options.defines]))
      .digest();
    const owner = getWorker(route(digest));
    const id = nextId++;
    const promise = new Promise<Compilation>((resolve, reject) => {
      owner.jobs.set(id, { resolve, reject });
      owner.worker.ref();
      try {
        // postMessage takes its immutable input snapshot immediately, including queued work.
        owner.worker.postMessage({ id, source, options });
      } catch (error) {
        owner.jobs.delete(id);
        if (owner.jobs.size === 0) owner.worker.unref();
        reject(error);
      }
    });
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };

  return {
    compile,
    concurrency,
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      await Promise.all(
        [...workers.values()].map(async ({ worker }) => {
          if (worker.threadId === -1) return;
          worker.ref();
          const exited = once(worker, 'exit');
          worker.postMessage(null);
          const [code] = await exited;
          if (code !== 0) throw new Error(`material compiler worker shutdown failed: ${code}`);
        }),
      );
      workers.clear();
      routes.clear();
    },
  };
}

/** Bound speculative context work, drain it, then preserve authored result/error order. */
export async function mapMaterialVariants<T, R>(
  inputs: readonly T[],
  concurrency: number,
  operation: (input: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('material variant concurrency must be a positive integer');
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(inputs.length, concurrency) }, async () => {
      for (let index = next++; index < inputs.length; index = next++) {
        try {
          results[index] = { status: 'fulfilled', value: await operation(inputs[index] as T) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
