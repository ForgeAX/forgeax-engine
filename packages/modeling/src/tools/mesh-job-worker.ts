import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import {
  type MessagePort,
  parentPort,
  receiveMessageOnPort,
  workerData,
} from 'node:worker_threads';
// Self-reference keeps one modeling module instance shared with the job's own imports.
import { buildMeshJobSet, type MeshJobRequest } from '@forgeax/engine-modeling';
import type { ByteCache } from '@forgeax/engine-types';

/** One Worker serves builds one at a time; job modules stay loaded between them. */
export interface MeshJobWorkerData {
  /** Cache channel to the cooker's thread. */
  readonly port: MessagePort;
  readonly signal: SharedArrayBuffer;
  readonly cacheWaitMs: number;
}

export interface MeshJobWorkerJob {
  readonly id: number;
  readonly request: MeshJobRequest;
  /** Whether this build's cook has a store behind the channel. */
  readonly cache: boolean;
}

/** A failure as plain data: structured clone drops the fields of error objects. */
export interface MeshJobWorkerFailure {
  readonly code: string;
  readonly expected: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly hint?: string;
}

export type MeshJobWorkerReply =
  | {
      readonly status: 'built';
      readonly id: number;
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly heapBytes: number;
    }
  | {
      readonly status: 'failed';
      readonly id: number;
      readonly failure: MeshJobWorkerFailure;
      readonly heapBytes: number;
    }
  | { readonly status: 'diagnostic'; readonly message: string };

/** Cache requests from this Worker to the store's owner; replies carry the request id. */
export type MeshJobCacheMessage =
  | { readonly type: 'get'; readonly id: number; readonly key: string }
  | { readonly type: 'put'; readonly key: string; readonly bytes: Uint8Array };

const parent = parentPort;
if (parent === null) throw new Error('mesh-job-worker runs as a Worker');
const data = workerData as MeshJobWorkerData;
const control = new Int32Array(data.signal);
const post = (reply: MeshJobWorkerReply) => parent.postMessage(reply);

function plainFailure(error: unknown): MeshJobWorkerFailure {
  const e = (error ?? {}) as Partial<MeshJobWorkerFailure> & { message?: unknown };
  return {
    code: typeof e.code === 'string' ? e.code : 'model-capability-unavailable',
    expected:
      typeof e.expected === 'string' ? e.expected : String(e.message ?? 'the job build completes'),
    ...(e.detail !== null && typeof e.detail === 'object' ? { detail: e.detail } : {}),
    ...(typeof e.hint === 'string' ? { hint: e.hint } : {}),
  };
}

/** Committed heap plus external memory: the measure the executor's samples use. */
function heapBytes(): number {
  const stats = getHeapStatistics() as { total_heap_size: number; external_memory?: number };
  return stats.total_heap_size + (stats.external_memory ?? 0);
}

let nextRead = 0;

/**
 * The cooker's store, read synchronously: a get blocks on the signal until the owner
 * thread replies, at most `cacheWaitMs`. A busy owner turns the read into a miss (the
 * job recomputes), never a hang. Puts are posted; the channel keeps their order ahead of
 * any later get.
 */
function channelCache(job: string): ByteCache {
  let reported = false;
  return {
    get(key) {
      const id = ++nextRead;
      let observed = Atomics.load(control, 0);
      data.port.postMessage({ type: 'get', id, key } satisfies MeshJobCacheMessage);
      const deadline = Date.now() + data.cacheWaitMs;
      for (;;) {
        // Replies to earlier, timed-out reads are dropped here.
        for (
          let received = receiveMessageOnPort(data.port);
          received !== undefined;
          received = receiveMessageOnPort(data.port)
        ) {
          const reply = received.message as { id: number; bytes?: Uint8Array };
          if (reply.id === id) return reply.bytes;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          if (!reported) {
            reported = true;
            post({
              status: 'diagnostic',
              message: `mesh job ${job}: the cache owner did not answer within ${data.cacheWaitMs} ms; reads time out as misses`,
            });
          }
          return undefined;
        }
        Atomics.wait(control, 0, observed, left);
        observed = Atomics.load(control, 0);
      }
    },
    put(key, bytes) {
      data.port.postMessage({ type: 'put', key, bytes } satisfies MeshJobCacheMessage);
    },
  };
}

type Outcome =
  | { readonly status: 'built'; readonly outputs: Readonly<Record<string, unknown>> }
  | { readonly status: 'failed'; readonly failure: MeshJobWorkerFailure };

async function build({ request, cache }: MeshJobWorkerJob): Promise<Outcome> {
  let exports: Record<string, unknown>;
  try {
    exports = await import(
      isAbsolute(request.module) ? pathToFileURL(request.module).href : request.module
    );
  } catch (cause) {
    return {
      status: 'failed',
      failure: {
        code: 'model-capability-unavailable',
        expected: `the job module ${request.module} loads in a Worker`,
        detail: { module: request.module, cause: String(cause) },
        hint: 'a .ts module needs Node type stripping (Node >= 23.6) and erasable TypeScript only',
      },
    };
  }
  const job = Object.values(exports)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .find(
      (value): value is Parameters<typeof buildMeshJobSet>[0] =>
        value !== null &&
        typeof value === 'object' &&
        (value as { name?: unknown }).name === request.job &&
        ['rig', 'assets'].includes((value as { kind?: unknown }).kind as string),
    );
  if (job === undefined) {
    return {
      status: 'failed',
      failure: {
        code: 'model-invalid-argument',
        expected: `the module ${request.module} exports the rig or assets job ${request.job}`,
        detail: { module: request.module, job: request.job },
        hint: "set the job's module to the file that exports it",
      },
    };
  }
  const built = await buildMeshJobSet(job, {
    key: request.key,
    packageId: request.packageId,
    params: request.params,
    ...(cache ? { cache: channelCache(request.job) } : {}),
  });
  return built.ok
    ? { status: 'built', outputs: built.value }
    : { status: 'failed', failure: plainFailure(built.error) };
}

parent.on('message', (job: MeshJobWorkerJob) => {
  build(job).then(
    (outcome) => post({ ...outcome, id: job.id, heapBytes: heapBytes() }),
    (cause: unknown) =>
      post({ status: 'failed', id: job.id, failure: plainFailure(cause), heapBytes: heapBytes() }),
  );
});
