import { readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import type {
  AssetsJobError,
  MeshJobExecutor,
  MeshJobRequest,
  MeshJobSetResult,
} from '@forgeax/engine-modeling';
import { type Asset, type ByteCache, err, ok } from '@forgeax/engine-types';
import type {
  MeshJobCacheMessage,
  MeshJobWorkerData,
  MeshJobWorkerFailure,
  MeshJobWorkerJob,
  MeshJobWorkerReply,
} from './mesh-job-worker';

const GiB = 1024 ** 3;

export interface MeshJobWorkersOptions {
  /** Worker threads, and so builds running at once (1 to 16, default 4). */
  readonly maxJobs?: number;
  /**
   * Host memory a new build must leave free, in GiB: `FORGEAX_HEAVY_MIN_FREE_GB` (the
   * floor `forgeax-heavy` uses) or 12. A build starts only when available memory, less
   * the expected remaining growth of running builds and its own expected peak, stays above it.
   */
  readonly minFreeGb?: number;
  /** Expected peak of a job with no record yet, in GiB (default 3). */
  readonly defaultPeakGb?: number;
  /** V8 heap limit of one job Worker, in MiB (default 8192). */
  readonly maxHeapMb?: number;
  /** Longest wait of one synchronous cache read before it counts as a miss (default 5000 ms). */
  readonly cacheWaitMs?: number;
  /** Available host memory in bytes (default: Linux MemAvailable, else `os.freemem()`). */
  readonly memAvailable?: () => number;
  /** Diagnostics: cache read timeouts, inline fallbacks. Default: stderr. */
  readonly log?: (message: string) => void;
}

function memAvailable(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (match?.[1] !== undefined) return Number(match[1]) * 1024;
  } catch {}
  return freemem();
}

function envFloor(): number {
  const value = Number(process.env.FORGEAX_HEAVY_MIN_FREE_GB);
  return Number.isFinite(value) && value >= 0 ? value : 12;
}

/** Scheduling record of one job; its absence or corruption only selects the default estimate. */
const peakKey = (request: MeshJobRequest) => `peak:${request.job}@${request.identity}`;

function readPeak(cache: ByteCache | undefined, request: MeshJobRequest): number | undefined {
  try {
    const bytes = cache?.get(peakKey(request));
    if (bytes === undefined) return undefined;
    const record = JSON.parse(new TextDecoder().decode(bytes)) as { bytes?: unknown };
    const peak = record.bytes;
    return typeof peak === 'number' && Number.isFinite(peak) && peak > 0 && peak < 2 ** 50
      ? peak
      : undefined;
  } catch {
    return undefined;
  }
}

/** The cooker reports `code: expected` with detail, as for an inline failure. */
const failure = (failed: MeshJobWorkerFailure): MeshJobSetResult => err(failed as AssetsJobError);

const typeStrippedModule = /\.[cm]?ts$/;

interface Pending {
  readonly request: MeshJobRequest;
  readonly cache: ByteCache | undefined;
  readonly estimate: number;
  readonly resolve: (result: MeshJobSetResult) => void;
}
interface Active extends Pending {
  readonly id: number;
  current: number;
  peak: number;
}
interface Lane {
  readonly worker: Worker;
  readonly port: MessagePort;
  /** Job modules this Worker has loaded; their module-level state stays warm. */
  readonly modules: Set<string>;
  job: Active | undefined;
}

/**
 * Worker-thread executor of `createMeshJobCooker` (Node only): up to `maxJobs` Workers
 * each build one rig or assets job at a time, importing the job's `module` and returning
 * the outputs `buildMeshJobSet` returns inline. Workers stay alive between builds and a
 * build prefers an idle Worker that already loaded its module, so state a job module
 * shares between its jobs (a common base form) is computed once per Worker. The cook
 * host's store reaches a Worker through one synchronous channel, so the compute cache
 * keeps its single owner.
 *
 * Admission is by memory, not cores: builds start in request order while available
 * memory, less the expected remaining growth of running builds and the new build's
 * expected peak, stays above `minFreeGb`; one build always may (no stall on a small
 * host). A job's expected peak is its last measured peak (committed heap plus external
 * memory, sampled every 0.5 s and at the end) recorded as `peak:<job>@<identity>` in the
 * store, else `defaultPeakGb`. Records only schedule; they never reach outputs.
 *
 * `maxHeapMb` bounds the V8 heap only: a heap OOM ends that Worker and fails its build,
 * but external memory (the kernel's typed arrays) is not capped and can still exhaust the
 * build process. Admission estimates include it for that reason.
 *
 * A cache read waits at most `cacheWaitMs` for the owner thread; jobs that build inline
 * on that thread (no `module`) delay replies, and a timed-out read is a miss, never a hang.
 * A `.ts` module needs Node type stripping (Node >= 23.6); without it every request is
 * declined and the cooker builds inline, with one diagnostic.
 */
export function meshJobWorkers(options: MeshJobWorkersOptions = {}): MeshJobExecutor {
  const maxJobs = options.maxJobs ?? 4;
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 16)
    throw new RangeError('meshJobWorkers: maxJobs is an integer in [1, 16]');
  const floor = (options.minFreeGb ?? envFloor()) * GiB;
  const defaultPeak = (options.defaultPeakGb ?? 3) * GiB;
  const maxHeapMb = options.maxHeapMb ?? 8192;
  const cacheWaitMs = options.cacheWaitMs ?? 5000;
  const available = options.memAvailable ?? memAvailable;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  let declinedTypes = false;
  let nextId = 0;
  const lanes: Lane[] = [];
  const queue: Pending[] = [];
  let retrying = false;

  const settle = (lane: Lane, result: MeshJobSetResult, measured: number) => {
    const job = lane.job;
    if (job === undefined) return;
    lane.job = undefined;
    lane.worker.unref();
    const peak = Math.max(job.peak, measured);
    if (peak > 0)
      job.cache?.put(
        peakKey(job.request),
        new TextEncoder().encode(JSON.stringify({ bytes: peak })),
      );
    job.resolve(result);
    pump();
  };

  const retire = (lane: Lane, result: MeshJobSetResult) => {
    const index = lanes.indexOf(lane);
    if (index < 0) return;
    lanes.splice(index, 1);
    lane.port.close();
    void lane.worker.terminate();
    settle(lane, result, 0);
  };

  const spawn = (): Lane => {
    const channel = new MessageChannel();
    const signal = new SharedArrayBuffer(4);
    const control = new Int32Array(signal);
    const data: MeshJobWorkerData = { port: channel.port2, signal, cacheWaitMs };
    const worker = new Worker(new URL('./mesh-job-worker.mjs', import.meta.url), {
      workerData: data,
      transferList: [channel.port2],
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    });
    const lane: Lane = { worker, port: channel.port1, modules: new Set(), job: undefined };
    // Node 24 Worker API (not yet in @types/node).
    const heap = worker as Worker & {
      getHeapStatistics(): Promise<{ total_heap_size: number; external_memory?: number }>;
    };
    const sampler = setInterval(() => {
      const job = lane.job;
      if (job === undefined) return;
      heap.getHeapStatistics().then(
        (stats) => {
          const used = stats.total_heap_size + (stats.external_memory ?? 0);
          job.current = used;
          job.peak = Math.max(job.peak, used);
        },
        () => undefined,
      );
    }, 500);
    sampler.unref();
    channel.port1.on('message', (message: MeshJobCacheMessage) => {
      const cache = lane.job?.cache;
      if (message.type === 'put') {
        cache?.put(message.key, message.bytes);
        return;
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = cache?.get(message.key);
      } catch {
        bytes = undefined;
      }
      channel.port1.postMessage({ id: message.id, ...(bytes === undefined ? {} : { bytes }) });
      Atomics.add(control, 0, 1);
      Atomics.notify(control, 0);
    });
    channel.port1.unref();
    worker.on('message', (reply: MeshJobWorkerReply) => {
      if (reply.status === 'diagnostic') {
        log(reply.message);
        return;
      }
      if (reply.id !== lane.job?.id) return;
      settle(
        lane,
        reply.status === 'built'
          ? ok(reply.outputs as Readonly<Record<string, Asset>>)
          : failure(reply.failure),
        reply.heapBytes,
      );
    });
    const lost = (detail: Record<string, unknown>) => {
      clearInterval(sampler);
      const job = lane.job?.request.job ?? 'none';
      retire(
        lane,
        failure({
          code: 'model-capability-unavailable',
          expected: `the job ${job} completes in its Worker`,
          detail: { job, ...detail },
          hint: 'a heap OOM raises maxHeapMb; external memory is bounded only by the host',
        }),
      );
    };
    worker.on('error', (cause) => lost({ cause: String(cause) }));
    worker.on('exit', (exitCode) => lost({ exitCode }));
    worker.unref();
    lanes.push(lane);
    return lane;
  };

  const start = (lane: Lane, pending: Pending) => {
    const job: Active = { ...pending, id: ++nextId, current: 0, peak: 0 };
    lane.job = job;
    lane.modules.add(pending.request.module);
    lane.worker.ref();
    lane.worker.postMessage({
      id: job.id,
      request: pending.request,
      cache: pending.cache !== undefined,
    } satisfies MeshJobWorkerJob);
  };

  function pump(): void {
    while (queue.length > 0) {
      const head = queue[0];
      if (head === undefined) return;
      const running = lanes.flatMap((lane) => (lane.job === undefined ? [] : [lane.job]));
      const growth = running.reduce((sum, job) => sum + Math.max(0, job.estimate - job.current), 0);
      const idle = lanes.filter((lane) => lane.job === undefined);
      const admit =
        running.length === 0 ||
        (running.length < maxJobs && available() - growth - head.estimate >= floor);
      if (!admit || (idle.length === 0 && lanes.length >= maxJobs)) {
        if (!admit && !retrying) {
          retrying = true;
          setTimeout(() => {
            retrying = false;
            pump();
          }, 1000).unref();
        }
        return;
      }
      queue.shift();
      // A warm Worker for this module first, then a new Worker while there is room,
      // then any idle one.
      const lane =
        idle.find((candidate) => candidate.modules.has(head.request.module)) ??
        (lanes.length < maxJobs ? spawn() : idle[0]);
      if (lane === undefined) {
        queue.unshift(head);
        return;
      }
      start(lane, head);
    }
  }

  return (request, { cache }) => {
    if (
      typeStrippedModule.test(request.module) &&
      !(process.features as { typescript?: unknown }).typescript
    ) {
      if (!declinedTypes) {
        declinedTypes = true;
        log(
          `meshJobWorkers: Node ${process.version} cannot import ${request.module} without type stripping (Node >= 23.6); mesh jobs build inline`,
        );
      }
      return Promise.resolve(undefined);
    }
    const estimate = readPeak(cache, request) ?? defaultPeak;
    return new Promise<MeshJobSetResult>((resolve) => {
      queue.push({ request, cache, estimate, resolve });
      pump();
    });
  };
}
