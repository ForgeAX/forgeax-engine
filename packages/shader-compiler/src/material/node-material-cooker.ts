import { getCiphers } from 'node:crypto';
import { availableParallelism, freemem } from 'node:os';
import { isMainThread, Worker } from 'node:worker_threads';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { ShaderError } from '../errors.js';
import type { MaterialPackCookProfile } from './pack-cooker.js';

const GiB = 1024 ** 3;

/** One process-wide material pool; Pack parallelism never multiplies this limit. */
function workerCount(): number {
  if (!isMainThread) return 1;
  const requested = Number(process.env.FORGEAX_SHADER_COMPILE_WORKERS);
  const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : undefined;
  const cpu = Math.max(1, Math.min(4, availableParallelism() - (limit === undefined ? 1 : 0)));
  const memory = Math.max(
    1,
    Math.floor(
      (Math.min(freemem(), process.availableMemory?.() ?? Infinity) - 2 * GiB) / (2 * GiB),
    ),
  );
  return Math.min(cpu, memory, limit ?? 4);
}

interface Job {
  readonly affinity: string;
  readonly roots: readonly string[];
  readonly profile: MaterialPackCookProfile | undefined;
  readonly input: unknown;
  readonly resolve: (draft: NativeCookDraft) => void;
  readonly reject: (error: unknown) => void;
}
interface Lane {
  affinity: string | undefined;
  readonly worker: Worker;
  job: Job | undefined;
}
interface Failure {
  readonly shader: boolean;
  readonly error: boolean;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const compilerModule = import.meta.resolve('@forgeax/engine-shader-compiler');
const workerSource = `
import('node:worker_threads').then(({ parentPort }) => {
const api = import(${JSON.stringify(compilerModule)});
let key, cooker;
parentPort.on('message', async ({ roots, profile, input }) => {
  try {
    const { createMaterialPackCooker } = await api;
    const nextKey = JSON.stringify([roots, profile]);
    if (nextKey !== key) {
      cooker = createMaterialPackCooker(roots, profile === undefined ? {} : { profile });
      key = nextKey;
    }
    const draft = await cooker.cook(input);
    parentPort.postMessage({ draft });
  } catch (error) {
    parentPort.postMessage({ failure: {
      shader: error?.name === 'ShaderError', error: error instanceof Error,
      message: error instanceof Error ? error.message : String(error),
      fields: error !== null && typeof error === 'object'
        ? { ...error, ...(error instanceof Error ? { message: error.message } : {}) }
        : { value: error }
    } });
  }
});
});
`;

class MaterialCookPool {
  private readonly lanes: Lane[] = [];
  private readonly queue: Job[] = [];

  constructor(private readonly limit: number) {
    // Initialize OpenSSL providers before concurrent Worker imports.
    getCiphers();
  }

  run(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0) {
      // Uniform-only siblings reuse one lane's compiled variants. Other
      // contracts can use idle lanes while that existing owner is occupied.
      const index = this.queue.findIndex(
        (job) =>
          !this.lanes.some((lane) => lane.affinity === job.affinity && lane.job !== undefined),
      );
      const next = this.queue[index];
      if (next === undefined) return;
      let lane =
        this.lanes.find((candidate) => candidate.affinity === next.affinity) ??
        this.lanes.find((candidate) => candidate.job === undefined);
      if (lane === undefined) {
        if (this.lanes.length >= this.limit) return;
        const worker = new Worker(workerSource, {
          eval: true,
          // The complete material is the parallel unit. Do not spawn another
          // shader pool inside each material Worker.
          env: { ...process.env, FORGEAX_SHADER_COMPILE_WORKERS: '1' },
          resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 },
        });
        lane = { worker, job: undefined, affinity: undefined };
        this.lanes.push(lane);
        const owner = lane;
        const fail = (error: Error): void => {
          const index = this.lanes.indexOf(owner);
          if (index < 0) return;
          this.lanes.splice(index, 1);
          owner.job?.reject(error);
          owner.job = undefined;
          worker.unref();
          this.pump();
        };
        worker.on('error', fail);
        worker.on('exit', (code) => fail(new Error(`material cook Worker exited: ${code}`)));
        worker.on('message', (reply: { draft?: NativeCookDraft; failure?: Failure }) => {
          const job = owner.job;
          if (job === undefined) return;
          owner.job = undefined;
          worker.unref();
          if (reply.failure !== undefined) {
            const error = reply.failure;
            job.reject(
              error.shader
                ? new ShaderError(
                    error.fields as unknown as ConstructorParameters<typeof ShaderError>[0],
                  )
                : error.error
                  ? Object.assign(new Error(error.message), error.fields)
                  : 'value' in error.fields
                    ? error.fields.value
                    : error.fields,
            );
          } else if (reply.draft !== undefined) job.resolve(reply.draft);
          else job.reject(new Error('material cook Worker returned no draft'));
          this.pump();
        });
      }
      const [job] = this.queue.splice(index, 1);
      if (job === undefined) return;
      lane.job = job;
      lane.affinity = job.affinity;
      lane.worker.ref();
      try {
        lane.worker.postMessage({ roots: job.roots, profile: job.profile, input: job.input });
      } catch (error) {
        lane.job = undefined;
        lane.worker.unref();
        job.reject(error);
      }
    }
  }
}

let pool: MaterialCookPool | undefined;

/** Move Surface preparation and hashing with compilation, once per material. */
export function withNodeMaterialWorkers(
  cooker: NativeCooker,
  roots: readonly string[],
  profile?: MaterialPackCookProfile,
): NativeCooker {
  const count = workerCount();
  if (count === 1) return cooker;
  pool ??= new MaterialCookPool(count);
  const owner = pool;
  const capturedRoots = [...roots];
  return {
    ...cooker,
    cook(input) {
      let captured: unknown;
      try {
        captured = structuredClone(input);
      } catch {
        return cooker.cook(input);
      }
      // Lane placement never admits output. Preserve the ordinary observation
      // and diagnostic path for inputs without a detached JSON contract.
      let affinity: string;
      try {
        const source =
          captured !== null && typeof captured === 'object'
            ? (captured as { readonly source?: unknown }).source
            : undefined;
        const contract =
          source !== null && typeof source === 'object' ? { ...source, values: undefined } : source;
        affinity = JSON.stringify([capturedRoots, profile, contract]);
      } catch {
        return cooker.cook(input);
      }
      return new Promise((resolve, reject) => {
        owner.run({ affinity, roots: capturedRoots, profile, input: captured, resolve, reject });
      });
    },
  };
}
