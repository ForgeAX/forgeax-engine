import { Worker } from 'node:worker_threads';
import type { BakeExecutor, BakeFailure, BakeRows } from '@forgeax/engine-modeling';
import type { BakeWorkerData, BakeWorkerReply } from './bake-worker';

export interface BakeWorkersOptions {
  /** Worker threads (1 to 64). */
  readonly workers: number;
}

type Outcome = Awaited<ReturnType<BakeExecutor>>;

const failed = (failure: BakeFailure): Outcome => ({ ok: false, failure });

/**
 * Worker-thread executor of `bakeMapsParallel` (U38, Node only; the bake twin of
 * `runCapture`'s capture Worker): `workers` threads each prepare the bake once and take
 * tile rows from a shared queue, one row at a time, until every row is sampled. Rows are
 * independent and merged by position, so the result is byte-identical to `bakeMaps` for
 * any worker count and completion order. The budget spans all Workers; cancellation
 * terminates them between rows.
 */
export function bakeWorkers(options: BakeWorkersOptions): BakeExecutor {
  const count = options.workers;
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
    return new Promise<Outcome>((resolve) => {
      const queue = [...rows];
      const parts: BakeRows[] = [];
      let work = 0;
      let pending = rows.length;
      let done = false;
      const workers: Worker[] = [];
      const finish = (outcome: Outcome) => {
        if (done) return;
        done = true;
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
        worker.on('error', (cause) => {
          finish(
            failed({
              code: 'model-capability-unavailable',
              expected: 'bake Workers run',
              detail: { cause: String(cause) },
              hint: 'run bakeMaps serially, or check the Worker heap',
            }),
          );
        });
      }
    });
  };
}
