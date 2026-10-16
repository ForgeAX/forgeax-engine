import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

interface WorkerRecord {
  readonly postMessage: (message: unknown, transferList?: readonly ArrayBuffer[]) => void;
  readonly on: (event: string, handler: (data: unknown) => void) => void;
  readonly off: (event: string, handler: (data: unknown) => void) => void;
  readonly terminate: () => Promise<number>;
}

const workerState = vi.hoisted(() => ({ current: undefined as WorkerRecord | undefined }));

vi.mock('node:worker_threads', () => ({
  Worker: class {
    private get current(): WorkerRecord {
      if (workerState.current === undefined) throw new Error('fake worker is not configured');
      return workerState.current;
    }

    postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void {
      this.current.postMessage(message, transferList);
    }

    on(event: string, handler: (data: unknown) => void): void {
      this.current.on(event, handler);
    }

    off(event: string, handler: (data: unknown) => void): void {
      this.current.off(event, handler);
    }

    terminate(): Promise<number> {
      return this.current.terminate();
    }
  },
}));

import { NodeWorkerAdapter } from '../node-worker-adapter.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface FakeWorker extends WorkerRecord {
  readonly postMessage: Mock<WorkerRecord['postMessage']>;
  readonly on: Mock<WorkerRecord['on']>;
  readonly off: Mock<WorkerRecord['off']>;
  readonly terminate: Mock<WorkerRecord['terminate']>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeWorker(termination: Promise<number>): FakeWorker {
  return {
    postMessage: vi.fn<WorkerRecord['postMessage']>(),
    on: vi.fn<WorkerRecord['on']>(),
    off: vi.fn<WorkerRecord['off']>(),
    terminate: vi.fn<WorkerRecord['terminate']>(() => termination),
  };
}

function createAdapter(worker: FakeWorker): NodeWorkerAdapter {
  workerState.current = worker;
  return new NodeWorkerAdapter(new URL('file:///fake-font-worker.mjs'));
}

describe('NodeWorkerAdapter', () => {
  beforeEach(() => {
    workerState.current = undefined;
  });

  it('forwards messages and transfer lists before termination', () => {
    const worker = fakeWorker(Promise.resolve(0));
    const adapter = createAdapter(worker);
    const message = { type: 'APPLY', value: 42 };
    const transfer = new ArrayBuffer(8);

    adapter.postMessage(message, [transfer]);

    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(message, [transfer]);
  });

  it('shares the pending termination completion without terminating twice', async () => {
    const termination = deferred<number>();
    const worker = fakeWorker(termination.promise);
    const adapter = createAdapter(worker);

    const first = adapter.terminate();
    const duplicate = adapter.terminate();
    let duplicateSettled = false;
    void duplicate.then(() => {
      duplicateSettled = true;
    });
    await Promise.resolve();

    expect(duplicate).toBe(first);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(duplicateSettled).toBe(false);

    termination.resolve(23);
    await expect(first).resolves.toBe(23);
    await expect(duplicate).resolves.toBe(23);
    expect(adapter.terminate()).toBe(first);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('shares the first termination rejection', async () => {
    const termination = deferred<number>();
    const worker = fakeWorker(termination.promise);
    const adapter = createAdapter(worker);
    const failure = new Error('worker termination failed');

    const first = adapter.terminate();
    const duplicate = adapter.terminate();
    const firstResult = expect(first).rejects.toBe(failure);
    const duplicateResult = expect(duplicate).rejects.toBe(failure);
    termination.reject(failure);

    await Promise.all([firstResult, duplicateResult]);
    expect(duplicate).toBe(first);
    expect(adapter.terminate()).toBe(first);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not touch the worker after termination starts', () => {
    const termination = deferred<number>();
    const worker = fakeWorker(termination.promise);
    const adapter = createAdapter(worker);

    void adapter.terminate();
    adapter.postMessage({ type: 'RELEASE' });

    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
