import { PhysicsFixedError } from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';
import type { RapierSolverWorkerRequest, RapierSolverWorkerResponse } from './solver-worker.js';

export class SolverWorkerDriver {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (cause: unknown) => void;
  private pending:
    | {
        sequence: number;
        resolve(value: RapierSolverWorkerResponse): void;
        reject(cause: unknown): void;
      }
    | undefined;
  private disposed = false;
  private readonly readyTimeout: ReturnType<typeof setTimeout>;

  constructor(url: string) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(new URL('./solver-worker-entry.mjs', import.meta.url), {
      type: 'module',
      name: 'forgeax-physics-solver',
    });
    this.readyTimeout = setTimeout(
      () => this.fail(new Error('Physics solver worker initialization timed out')),
      30_000,
    );
    this.worker.postMessage({ kind: 'initialize', processorModuleUrl: url });
    void this.ready.catch(() => undefined);
    this.worker.onmessage = ({ data }) => {
      if (data.kind === 'ready') {
        clearTimeout(this.readyTimeout);
        this.resolveReady();
        return;
      }
      if (data.kind === 'initialize-failed') {
        this.fail(new Error(data.reason));
        return;
      }
      const pending = this.pending;
      if (!pending || pending.sequence !== data.sequence) return;
      this.pending = undefined;
      if (data.kind === 'failed') pending.reject(new Error(data.reason));
      else pending.resolve(data as RapierSolverWorkerResponse);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message);
      this.fail(error);
    };
  }

  private fail(error: Error): void {
    clearTimeout(this.readyTimeout);
    this.rejectReady(error);
    this.pending?.reject(error);
    this.pending = undefined;
    this.worker.terminate();
    this.disposed = true;
  }

  async step(request: RapierSolverWorkerRequest): Promise<RapierSolverWorkerResponse> {
    await this.ready;
    if (this.disposed || this.pending) throw new Error('Physics solver worker is unavailable');
    const completed = new Promise<RapierSolverWorkerResponse>((resolve, reject) => {
      this.pending = { sequence: request.sequence, resolve, reject };
    });
    this.worker.postMessage(request, [request.snapshot.buffer as ArrayBuffer]);
    const response = await completed;
    return {
      ...response,
      outputs: response.outputs.map((output) => ({
        ...output,
        result: output.result.ok
          ? ok(output.result.value)
          : err(new PhysicsFixedError(output.result.error.code, output.result.error.detail)),
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.readyTimeout);
    const error = new Error('Physics solver worker was disposed');
    this.rejectReady(error);
    this.pending?.reject(error);
    this.pending = undefined;
    this.worker.terminate();
  }
}
