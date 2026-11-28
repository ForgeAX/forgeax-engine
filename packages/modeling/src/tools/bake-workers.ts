import { Worker } from 'node:worker_threads';
import type { BakeExecutor, BakeFailure, BakeRows } from '@forgeax/engine-modeling';
import type { BakeWorkerData, BakeWorkerReply } from './bake-worker';
import { MAX_DEADLINE_MS } from './protocol';

export interface BakeWorkersOptions {
  /** Worker threads (1 to 64). */
  readonly workers: number;
  /** Longest the whole bake may take before its Workers are terminated (default 600000 ms, at most 2^31-1). */
  readonly timeoutMs?: number;
  /** V8 old-generation limit of one Worker, in MiB (default 4096). */
  readonly maxHeapMb?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_HEAP_MB = 4096;

type Outcome = Awaited<ReturnType<BakeExecutor>>;

const failed = (failure: BakeFailure): Outcome => ({ ok: false, failure });

/**
 * Worker-thread executor of `bakeMapsParallel` (U38, Node only; the bake twin of
 * `runCapture`'s capture Worker): `workers` threads each prepare the bake once and take
 * tile rows from a shared queue, one row at a time, until every row is sampled. Rows are
 * independent and merged by position, so the result is byte-identical to `bakeMaps` for
 * any worker count and completion order. The budget spans all Workers; cancellation
 * terminates them between rows. A Worker that exits, errors or sends an unreadable
 * message before the rows are done, or a bake that outlives `timeoutMs`, fails the bake
 * and terminates every Worker; a Worker is capped at `maxHeapMb` of V8 heap.
 */
export function bakeWorkers(options: BakeWorkersOptions): BakeExecutor {
  const count = options.workers;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHeapMb = options.maxHeapMb ?? DEFAULT_HEAP_MB;
  return (request, rows, { budget, signal }) => {
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      return Promise.resolve(
        failed({
          code: 'model-invalid-argument',
          expected: 'workers is an integer in [1, 64]',
          detail: { workers: count },
          hint: 'pass a Worker count between 1 and 64',
        }),
      );
    }
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_DEADLINE_MS ||
      !Number.isFinite(maxHeapMb) ||
      maxHeapMb < 16
    ) {
      return Promise.resolve(
        failed({
          code: 'model-invalid-argument',
          expected: `timeoutMs is milliseconds in (0, ${MAX_DEADLINE_MS}] and maxHeapMb is at least 16`,
          detail: { timeoutMs, maxHeapMb },
          hint: 'pass a positive deadline and a Worker heap limit in MiB',
        }),
      );
    }
    return new Promise<Outcome>((resolve) => {
      const queue = [...rows];
      const parts: BakeRows[] = [];
      let work = 0;
      let pending = rows.length;
      let done = false;
      const workers: Worker[] = [];
      const deadline = setTimeout(
        () =>
          finish(
            failed({
              code: 'model-work-budget',
              expected: `the bake finishes within ${timeoutMs} ms`,
              detail: { timeoutMs, pending },
              hint: 'raise timeoutMs, bake fewer tiles per call, or reduce the sample count',
            }),
          ),
        timeoutMs,
      );
      deadline.unref();
      const lost = (detail: Record<string, unknown>) =>
        finish(
          failed({
            code: 'model-capability-unavailable',
            expected: 'bake Workers run',
            detail,
            hint: 'run bakeMaps serially, or check the Worker heap',
          }),
        );
      const finish = (outcome: Outcome) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        for (const w of workers) void w.terminate();
        resolve(outcome);
      };
      if (pending === 0) {
        finish({ ok: true, parts, work });
        return;
      }
      const next = (worker: Worker) => {
        if (signal?.aborted === true) {
          finish(
            failed({
              code: 'model-cancelled',
              expected: 'the build is not cancelled',
              detail: {},
              hint: 'the bake was cancelled between tile rows',
            }),
          );
          return;
        }
        const row = queue.shift();
        if (row !== undefined) worker.postMessage([row]);
      };
      const data: BakeWorkerData = { request, budget };
      for (let k = 0; k < Math.min(count, rows.length); k++) {
        const worker = new Worker(new URL('./bake-worker.mjs', import.meta.url), {
          workerData: data,
          resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
        });
        workers.push(worker);
        worker.on('message', (reply: BakeWorkerReply) => {
          if (reply.status === 'error') {
            finish(failed(reply.failure));
            return;
          }
          if (reply.status === 'rows') {
            parts.push(reply.part);
            work += reply.work;
            pending--;
            if (work > budget) {
              finish(
                failed({
                  code: 'model-work-budget',
                  expected: `the job stays within ${budget} work units`,
                  detail: { units: work },
                  hint: 'reduce the operand detail or raise the budget',
                }),
              );
              return;
            }
            if (pending === 0) {
              finish({ ok: true, parts, work });
              return;
            }
          }
          next(worker);
        });
        worker.on('error', (cause) => lost({ cause: String(cause) }));
        worker.on('messageerror', (cause) =>
          lost({ cause: `unreadable message: ${String(cause)}` }),
        );
        worker.on('exit', (exitCode) => lost({ exitCode, pending }));
      }
    });
  };
}
