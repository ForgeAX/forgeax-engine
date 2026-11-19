import { createHash, getCiphers } from 'node:crypto';
import { availableParallelism, freemem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { isMainThread, Worker } from 'node:worker_threads';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { MaterialAsset } from '@forgeax/engine-types';
import { ShaderError } from '../errors.js';
import type { MaterialPackCookProfile, MaterialSourceSnapshot } from './pack-cooker.js';
import { normalizeMaterialAsset } from './pack-material-contract.js';

const GiB = 1024 ** 3;

/** One process-wide budget for material execution and program compilation. */
function workerBudget(): { materials: number; programs: number } {
  if (!isMainThread) return { materials: 1, programs: 1 };
  const requested = Number(process.env.FORGEAX_SHADER_COMPILE_WORKERS);
  const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : undefined;
  const cpu = Math.max(1, availableParallelism() - (limit === undefined ? 1 : 0));
  const free = process.availableMemory?.() ?? freemem();
  const memory = Math.max(1, Math.floor((free - 2 * GiB) / (2 * GiB)));
  const admitted = Math.min(cpu, limit ?? 4);
  // An explicit budget can reserve up to two slots for programs within the
  // first material while keeping at least two material slots when available.
  const materialSlots = limit === undefined ? 4 : Math.min(4, Math.max(2, admitted - 2));
  const materials = Math.min(memory, admitted, materialSlots);
  // Only the first material receives spare program slots.
  const spareMemory = Math.max(0, free - (2 + materials * 2) * GiB);
  const programs = Math.max(
    1,
    Math.min(6, admitted - materials + 1, Math.floor(spareMemory / (GiB / 2)) + 1),
  );
  return { materials, programs };
}

interface Job {
  /** Program identity without uniform values; equal keys compile the same programs. */
  readonly program: string;
  readonly roots: readonly string[];
  readonly profile: MaterialPackCookProfile | undefined;
  readonly sourceSnapshot: MaterialSourceSnapshot | undefined;
  readonly input: unknown;
  readonly resolve: (draft: NativeCookDraft) => void;
  readonly reject: (error: unknown) => void;
}
interface Lane {
  readonly worker: Worker;
  job: Job | undefined;
  sourceSnapshotIdentity?: string | undefined;
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
let key, cooker, capturedSnapshot;
parentPort.on('message', async ({ roots, profile, input, sourceSnapshot, sourceSnapshotIdentity }) => {
  try {
    const { createMaterialPackCooker } = await api;
    if (sourceSnapshot !== undefined) capturedSnapshot = sourceSnapshot;
    if (sourceSnapshotIdentity === undefined) capturedSnapshot = undefined;
    const nextKey = JSON.stringify([roots, profile, sourceSnapshotIdentity]);
    if (nextKey !== key) {
      cooker = createMaterialPackCooker(roots, { ...(profile === undefined ? {} : { profile }), ...(capturedSnapshot === undefined ? {} : {sourceSnapshot: capturedSnapshot}) });
      key = nextKey;
    }
    const draft = await cooker.cook(input);
    // Publication encodes fresh WGSL buffers for this draft. Its retained
    // compiler cache owns source strings and never reuses the encoded bytes.
    const buffers = new Set();
    for (const { bytes } of Object.values(draft.artifacts)) {
      if (bytes.buffer instanceof ArrayBuffer && !Buffer.isBuffer(bytes) &&
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        buffers.add(bytes.buffer);
      }
    }
    parentPort.postMessage({ draft }, [...buffers]);
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

/** Bound on remembered program-to-lane assignments; older programs are forgotten first. */
const MAX_PROGRAM_AFFINITY = 1024;

/**
 * The queued job an idle lane takes next: the oldest job whose program the lane already
 * compiled, else the oldest job whose program no lane holds. A job whose program another
 * lane holds waits for that lane, where its per-Worker program reuse turns a repeated
 * composition into a hit; the result is identical on any lane.
 * @internal
 */
export function selectAffineJob<J extends { readonly program: string }>(
  queue: readonly J[],
  lane: object,
  affinity: ReadonlyMap<string, object>,
): number {
  let unassigned = -1;
  for (const [index, job] of queue.entries()) {
    const owner = affinity.get(job.program);
    if (owner === lane) return index;
    if (owner === undefined && unassigned < 0) unassigned = index;
  }
  return unassigned;
}

class MaterialCookPool {
  private readonly lanes: Lane[] = [];
  private readonly queue: Job[] = [];
  private readonly affinity = new Map<string, Lane>();
  private pumpQueued = false;

  constructor(
    private readonly limit: number,
    private readonly firstLanePrograms: number,
  ) {
    // Initialize OpenSSL providers before concurrent Worker imports.
    getCiphers();
  }

  run(job: Job): void {
    this.queue.push(job);
    if (this.pumpQueued) return;
    // See all sibling submissions before assigning a cold contract to a lane
    // that has warm work in the same batch.
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    for (;;) {
      for (const lane of this.lanes) {
        if (lane.job === undefined) this.dispatch(lane);
      }
      // Spawn another lane only for work no existing lane holds.
      if (this.lanes.length >= this.limit) return;
      const index = selectAffineJob(this.queue, {}, this.affinity);
      if (index < 0) return;
      try {
        this.spawn();
      } catch (error) {
        // A failed Worker start must settle the queued cook even when the
        // scheduler is draining a batch outside that cook's call stack.
        this.queue.splice(index, 1)[0]?.reject(error);
      }
    }
  }

  private spawn(): void {
    const programs = this.lanes.length === 0 ? this.firstLanePrograms : 1;
    const worker = new Worker(workerSource, {
      eval: true,
      env: { ...process.env, FORGEAX_SHADER_COMPILE_WORKERS: String(programs) },
      resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 },
    });
    const owner: Lane = { worker, job: undefined };
    this.lanes.push(owner);
    const fail = (error: Error): void => {
      const index = this.lanes.indexOf(owner);
      if (index < 0) return;
      this.lanes.splice(index, 1);
      for (const [program, held] of this.affinity) {
        if (held === owner) this.affinity.delete(program);
      }
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

  private dispatch(lane: Lane): void {
    const index = selectAffineJob(this.queue, lane, this.affinity);
    if (index < 0) return;
    const [job] = this.queue.splice(index, 1);
    if (job === undefined) return;
    this.affinity.delete(job.program);
    this.affinity.set(job.program, lane);
    if (this.affinity.size > MAX_PROGRAM_AFFINITY) {
      const oldest = this.affinity.keys().next().value;
      if (oldest !== undefined) this.affinity.delete(oldest);
    }
    lane.job = job;
    lane.worker.ref();
    try {
      lane.worker.postMessage({
        roots: job.roots,
        profile: job.profile,
        input: job.input,
        sourceSnapshotIdentity: job.sourceSnapshot?.identity,
        ...(lane.sourceSnapshotIdentity === job.sourceSnapshot?.identity
          ? {}
          : { sourceSnapshot: job.sourceSnapshot }),
      });
      lane.sourceSnapshotIdentity = job.sourceSnapshot?.identity;
    } catch (error) {
      lane.job = undefined;
      lane.worker.unref();
      job.reject(error);
    }
  }
}

let pool: MaterialCookPool | undefined;

/** JSON with sorted object keys: equal content yields equal text regardless of insertion order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : nested,
  );
}

/**
 * Routing identity of one cook: the SHA-256 of the canonical content that selects its
 * programs (roots, profile, source directory, parent table and normalized material
 * contract), without uniform values or the publication name. Shorthand value names
 * can select parameter declarations, so use the same normalization as the cooker.
 * The key only routes work. Each Worker's compiler decides whether cached
 * programs still satisfy the current request.
 * @internal
 */
export function programAffinityKey(
  roots: readonly string[],
  profile: MaterialPackCookProfile | undefined,
  input: unknown,
): string {
  const { source, table, sourcePath } = (input ?? {}) as {
    readonly source?: unknown;
    readonly table?: unknown;
    readonly sourcePath?: unknown;
  };
  const directory = typeof sourcePath === 'string' ? dirname(resolve(sourcePath)) : undefined;
  let text: string;
  try {
    const contract =
      source !== null && typeof source === 'object'
        ? { ...normalizeMaterialAsset(source as MaterialAsset), values: undefined }
        : source;
    text = canonicalJson([
      roots,
      profile ?? null,
      directory ?? null,
      table ?? null,
      contract ?? null,
    ]);
  } catch {
    // Invalid or non-JSON declarations still go through the cooker's diagnostics.
    text = Object.prototype.toString.call(source);
  }
  return createHash('sha256').update(text).digest('hex');
}

/** Move Surface preparation and hashing with compilation, once per material. */
export function withNodeMaterialWorkers(
  cooker: NativeCooker,
  roots: readonly string[],
  profile?: MaterialPackCookProfile,
  sourceSnapshot?: MaterialSourceSnapshot,
): NativeCooker {
  const budget = workerBudget();
  if (budget.materials === 1) return cooker;
  pool ??= new MaterialCookPool(budget.materials, budget.programs);
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
      const affinity = programAffinityKey(capturedRoots, profile, captured);
      const program =
        sourceSnapshot === undefined
          ? affinity
          : createHash('sha256').update(sourceSnapshot.identity).update(affinity).digest('hex');
      return new Promise((resolve, reject) => {
        owner.run({
          program,
          roots: capturedRoots,
          profile,
          sourceSnapshot,
          input: captured,
          resolve,
          reject,
        });
      });
    },
  };
}
