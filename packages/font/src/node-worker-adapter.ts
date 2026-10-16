import { Worker } from 'node:worker_threads';

interface MessageEventLike {
  readonly data: unknown;
  readonly origin: string;
}

type MessageListener = (event: MessageEventLike) => void;

/** Comlink's browser Worker-shaped endpoint backed by a Node worker thread. */
export class NodeWorkerAdapter {
  private readonly worker: Worker;
  private readonly listeners = new Map<MessageListener, (data: unknown) => void>();
  private terminationPromise?: Promise<number>;

  public constructor(url: string | URL) {
    this.worker = new Worker(url);
  }

  public postMessage(message: unknown, transferList: readonly ArrayBuffer[] = []): void {
    if (this.terminationPromise !== undefined) {
      return;
    }
    this.worker.postMessage(message, [...transferList]);
  }

  public addEventListener(type: string, listener: MessageListener): void {
    if (type !== 'message') return;
    const handler = (data: unknown) => listener({ data, origin: '*' });
    this.listeners.set(listener, handler);
    this.worker.on('message', handler);
  }

  public removeEventListener(type: string, listener: MessageListener): void {
    if (type !== 'message') return;
    const handler = this.listeners.get(listener);
    if (handler === undefined) return;
    this.listeners.delete(listener);
    this.worker.off('message', handler);
  }

  public terminate(): Promise<number> {
    if (this.terminationPromise === undefined) {
      this.terminationPromise = this.worker.terminate();
    }
    return this.terminationPromise;
  }
}
