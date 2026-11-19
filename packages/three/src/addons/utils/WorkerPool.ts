import { WorkerPool as OriginalWorkerPool } from 'three/examples/jsm/utils/WorkerPool.js';

export interface WorkerPool
  extends Omit<OriginalWorkerPool, 'quene' | 'workerCreator' | '_getIdleWorker'> {
  queue: Array<{
    resolve: (event: MessageEvent<unknown>) => void;
    msg: unknown;
    transfer?: Transferable[];
  }>;
  workerCreator: (() => Worker) | null;
  /** @internal */
  _getIdleWorker(): number;
}
export const WorkerPool = OriginalWorkerPool as unknown as Omit<
  typeof OriginalWorkerPool,
  'prototype'
> & {
  new (pool?: number): WorkerPool;
  readonly prototype: WorkerPool;
};
