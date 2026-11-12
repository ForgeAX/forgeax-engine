import { parentPort, workerData } from 'node:worker_threads';
import {
  type BakeFailure,
  type BakeRows,
  bakePhases,
  type ComputeJobRequest,
  type ModelingError,
  WorkMeter,
} from '@forgeax/engine-modeling';

/**
 * One bake Worker: prepares the request it was started with exactly like the serial
 * job, then samples each batch of tile rows it is sent and returns the sums (transferred).
 * Failures travel as plain data; the main thread rebuilds the `ModelingError`.
 */
export interface BakeWorkerData {
  readonly request: ComputeJobRequest<'bake'>;
  readonly budget: number;
}

export type BakeWorkerReply =
  | { readonly status: 'ready' }
  | { readonly status: 'rows'; readonly part: BakeRows; readonly work: number }
  | { readonly status: 'error'; readonly failure: BakeFailure };

const port = parentPort;
if (port === null) throw new Error('bake-worker runs as a Worker');
const { request, budget } = workerData as BakeWorkerData;
const failure = (error: ModelingError): BakeWorkerReply => ({
  status: 'error',
  failure: {
    code: error.code,
    expected: error.expected,
    detail: { ...error.detail },
    hint: error.hint,
  },
});
const prepared = bakePhases.prepare(request, new WorkMeter(Number.POSITIVE_INFINITY));
if (!prepared.ok) {
  port.postMessage(failure(prepared.error));
} else {
  port.postMessage({ status: 'ready' } satisfies BakeWorkerReply);
  port.on('message', (rows: readonly number[]) => {
    const work = new WorkMeter(budget);
    const part = bakePhases.rows(prepared.value, rows, work);
    if (!part.ok) {
      port.postMessage(failure(part.error));
      return;
    }
    const p = part.value;
    const buffers = [
      ...p.sums,
      p.weight,
      p.island,
      p.point,
      p.normal,
      p.hits,
      p.counts,
      p.findings,
      p.stack,
    ].map((a) => a.buffer as ArrayBuffer);
    port.postMessage(
      { status: 'rows', part: p, work: work.units } satisfies BakeWorkerReply,
      buffers,
    );
  });
}
