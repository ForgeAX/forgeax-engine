import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { BasisEncodeOptions } from '@forgeax/engine-codec/encode';
import {
  type ImageEncodeRequest,
  type ImageEncodeResponse,
  type ImageEncodeResult,
  imageEncodeFailure,
} from './node-encode-wire.js';

const GIB = 1024 ** 3;
interface Task {
  readonly request: ImageEncodeRequest;
  readonly bytes: number;
  readonly finish: (result: ImageEncodeResult) => void;
  detach(): void;
}
interface Slot {
  readonly worker: ChildProcess;
  task: Task | undefined;
  retiring: boolean;
  closed: boolean;
}
export interface NodeImageEncoderPool {
  readonly maxWorkers: number;
  readonly maxObservedHeapBytes: number;
  encode(
    pixels: Uint8Array,
    options: BasisEncodeOptions,
    request?: { readonly signal?: AbortSignal },
  ): Promise<ImageEncodeResult>;
  dispose(): Promise<void>;
}
/** Node-only producer owner. Runtime/browser image entries never import this module. */
export function createNodeImageEncoderPool(
  options: { readonly maxWorkers?: number; readonly memoryBudgetBytes?: number } = {},
): NodeImageEncoderPool {
  return new ImageEncoderPool(options);
}
function workerUrl(): URL {
  const built = new URL('./node-encode-worker.mjs', import.meta.url);
  return existsSync(fileURLToPath(built))
    ? built
    : new URL('../dist/node-encode-worker.mjs', import.meta.url);
}
/** V8 heap/stack limits belong to explicit child flags, not inherited caller flags. */
function workerExecArgv(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    const name = arg.split('=', 1)[0]?.replaceAll('_', '-');
    if (
      name === '--input-type' ||
      name === '--eval' ||
      name === '-e' ||
      name === '--print' ||
      name === '-p' ||
      name === '--max-old-space-size' ||
      name === '--max-semi-space-size' ||
      name === '--stack-size'
    ) {
      if (!arg.includes('=')) index++;
      continue;
    }
    result.push(arg);
  }
  return result;
}
function admission(options: { readonly maxWorkers?: number; readonly memoryBudgetBytes?: number }) {
  const physical = Math.min(totalmem(), process.constrainedMemory() || totalmem());
  const available = Math.min(physical / 4, freemem() / 2);
  const budget = Math.floor(Math.min(available, options.memoryBudgetBytes ?? available));
  const requested = options.maxWorkers ?? 4;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 4)
    throw new RangeError('Image encoder maxWorkers must be in 1..4');
  if (!Number.isSafeInteger(budget) || budget < GIB + 16 * 1024 ** 2)
    throw new RangeError('Image encoder requires one GiB worker reserve and bounded source memory');
  const workers = Math.min(
    requested,
    Math.max(1, availableParallelism() - 1),
    Math.floor(budget / (GIB + 256 * 1024 ** 2)) || 1,
  );
  return { workers, inputBytes: budget - workers * GIB };
}
class ImageEncoderPool implements NodeImageEncoderPool {
  readonly maxWorkers: number;
  private readonly inputLimit: number;
  private inputBytes = 0;
  private observedHeap = 0;
  get maxObservedHeapBytes(): number {
    return this.observedHeap;
  }
  private nextId = 0;
  private closing = false;
  private readonly queue: Task[] = [];
  private readonly slots = new Set<Slot>();
  private readonly retirements = new Set<Promise<unknown>>();
  private disposal?: Promise<void>;
  constructor(options: { readonly maxWorkers?: number; readonly memoryBudgetBytes?: number }) {
    const capacity = admission(options);
    this.maxWorkers = capacity.workers;
    this.inputLimit = capacity.inputBytes;
  }
  encode(
    pixels: Uint8Array,
    options: BasisEncodeOptions,
    request: { readonly signal?: AbortSignal } = {},
  ): Promise<ImageEncodeResult> {
    const bytes =
      pixels.byteLength + (options.levels ?? []).reduce((sum, level) => sum + level.byteLength, 0);
    if (this.closing || request.signal?.aborted)
      return Promise.resolve(
        imageEncodeFailure(options.mode, 'image encoding owner closed or request aborted'),
      );
    if (this.queue.length >= this.maxWorkers * 2)
      return Promise.resolve(
        imageEncodeFailure(options.mode, 'image encoding queue capacity exhausted'),
      );
    if (!Number.isSafeInteger(bytes) || bytes > this.inputLimit - this.inputBytes)
      return Promise.resolve(
        imageEncodeFailure(options.mode, 'image encoding input memory budget exhausted'),
      );
    const owned = {
      id: ++this.nextId,
      pixels: new Uint8Array(pixels),
      options: {
        ...options,
        ...(options.levels === undefined
          ? {}
          : { levels: options.levels.map((level) => new Uint8Array(level)) }),
      },
    };
    this.inputBytes += bytes;
    return new Promise((resolve) => {
      const task: Task = { request: owned, bytes, finish: resolve, detach: () => {} };
      const abort = () => this.abort(task);
      task.detach = () => request.signal?.removeEventListener('abort', abort);
      request.signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }
  private settle(task: Task, result: ImageEncodeResult): void {
    task.detach();
    this.inputBytes -= task.bytes;
    task.finish(result);
  }
  private abort(task: Task): void {
    const index = this.queue.indexOf(task);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.settle(
        task,
        imageEncodeFailure(task.request.options.mode, 'image encoding aborted before dispatch'),
      );
      return;
    }
    for (const slot of this.slots)
      if (slot.task === task) {
        slot.task = undefined;
        this.settle(task, imageEncodeFailure(task.request.options.mode, 'image encoding aborted'));
        this.retire(slot);
        this.pump();
        return;
      }
  }
  private createSlot(): Slot {
    const worker = fork(workerUrl(), [], {
      execArgv: [...workerExecArgv(process.execArgv), '--max-old-space-size=1024'],
      env: { ...process.env },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const slot: Slot = { worker, retiring: false, closed: false, task: undefined };
    this.slots.add(slot);
    worker.on('message', (response: ImageEncodeResponse) => this.complete(slot, response));
    worker.on('error', () => this.fail(slot));
    worker.once('close', () => {
      slot.closed = true;
      if (!slot.retiring) this.fail(slot);
    });
    worker.on('exit', () => {
      if (!slot.retiring) this.fail(slot);
    });
    return slot;
  }
  private complete(slot: Slot, response: ImageEncodeResponse): void {
    const task = slot.task;
    if (slot.retiring || task === undefined || response.id !== task.request.id) return;
    slot.task = undefined;
    this.observedHeap = Math.max(this.observedHeap, response.heapLimitBytes);
    this.settle(task, response.result);
    this.pump();
  }
  private fail(slot: Slot): void {
    if (slot.retiring) return;
    const task = slot.task;
    slot.task = undefined;
    if (task !== undefined)
      this.settle(
        task,
        imageEncodeFailure(
          task.request.options.mode,
          'image encoder worker exited before completion',
        ),
      );
    this.retire(slot);
    this.pump();
  }
  private retire(slot: Slot): void {
    if (slot.retiring) return;
    slot.retiring = true;
    this.slots.delete(slot);
    const pending = new Promise<void>((resolve) => {
      if (slot.closed) {
        resolve();
        return;
      }
      slot.worker.once('close', () => resolve());
      slot.worker.kill('SIGKILL');
    });
    this.retirements.add(pending);
    const finished = () => {
      this.retirements.delete(pending);
      this.pump();
    };
    void pending.then(finished, finished);
  }
  private pump(): void {
    if (this.closing) return;
    while (this.queue.length > 0) {
      let slot = [...this.slots].find((row) => row.task === undefined);
      if (slot === undefined && this.slots.size + this.retirements.size < this.maxWorkers) {
        try {
          slot = this.createSlot();
        } catch {
          const task = this.queue.shift();
          if (task)
            this.settle(
              task,
              imageEncodeFailure(task.request.options.mode, 'image encoder worker could not start'),
            );
          continue;
        }
      }
      if (slot === undefined) return;
      const task = this.queue.shift();
      if (task === undefined) return;
      slot.task = task;
      try {
        slot.worker.send(task.request, (error) => {
          if (error && slot.task === task) this.fail(slot);
        });
      } catch {
        if (slot.task === task) this.fail(slot);
      }
    }
  }
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closing = true;
    for (const task of this.queue.splice(0))
      this.settle(
        task,
        imageEncodeFailure(task.request.options.mode, 'image encoding owner disposed'),
      );
    for (const slot of this.slots) {
      const task = slot.task;
      slot.task = undefined;
      if (task)
        this.settle(
          task,
          imageEncodeFailure(task.request.options.mode, 'image encoding owner disposed'),
        );
      this.retire(slot);
    }
    this.disposal = Promise.allSettled([...this.retirements]).then(() => {});
    return this.disposal;
  }
}
