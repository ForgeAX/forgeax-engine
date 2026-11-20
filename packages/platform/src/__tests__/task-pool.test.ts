import type { TaskModule, TaskRegistry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createSliceControl, drainSlices, SLICE_CALLER, SLICE_STATE } from '../slices.js';
import {
  createTaskClient,
  createTaskPool,
  defaultTaskWorkerCount,
  serveTaskClient,
  serveTaskWorker,
  type TaskPoolToWorkerMessage,
  type TaskWorkerFactory,
  type TaskWorkerListener,
} from '../task-pool.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const echo: TaskModule<number, number> = { run: (input) => ({ value: input * 2 }) };

interface ManualWorker {
  readonly listener: TaskWorkerListener;
  readonly messages: TaskPoolToWorkerMessage[];
  terminated: boolean;
  /** Complete the most recent run with `value`. */
  finish(value?: unknown): void;
}

/** `adopt: false` models a host that never creates the Worker it was asked for. */
function manualWorkers({ adopt = true } = {}): {
  factory: TaskWorkerFactory;
  workers: ManualWorker[];
} {
  const workers: ManualWorker[] = [];
  const factory: TaskWorkerFactory = (listener) => {
    const worker: ManualWorker = {
      listener,
      messages: [],
      terminated: false,
      finish(value) {
        const run = [...worker.messages].reverse().find((message) => message.t === 'run');
        if (run === undefined) throw new Error('no run');
        listener.message({ t: 'done', id: run.id, value });
      },
    };
    workers.push(worker);
    if (adopt) queueMicrotask(() => listener.message({ t: 'ready' }));
    return {
      postMessage: (message) => worker.messages.push(message),
      terminate: () => {
        worker.terminated = true;
      },
    };
  };
  return { factory, workers };
}

/** Workers that execute through the real Worker-side runtime, in this realm. */
function servedWorkers(registry: TaskRegistry): {
  factory: TaskWorkerFactory;
  spawned: () => number;
} {
  let spawned = 0;
  const factory: TaskWorkerFactory = (listener) => {
    spawned++;
    const port = {
      onmessage: null as ((event: MessageEvent<TaskPoolToWorkerMessage>) => void) | null,
      postMessage: (data: unknown) => queueMicrotask(() => listener.message(data as never)),
    };
    serveTaskWorker(port, registry);
    return {
      postMessage: (message) =>
        queueMicrotask(() => port.onmessage?.({ data: message } as MessageEvent)),
      terminate: () => {},
    };
  };
  return { factory, spawned: () => spawned };
}

describe('task pool sizing', () => {
  it('keeps three realms free and caps at four Workers', () => {
    expect(defaultTaskWorkerCount(2)).toBe(1);
    expect(defaultTaskWorkerCount(4)).toBe(1);
    expect(defaultTaskWorkerCount(6)).toBe(3);
    expect(defaultTaskWorkerCount(16)).toBe(4);
  });
});

describe('inline task pool', () => {
  it('runs tasks in priority order, FIFO within a priority', async () => {
    const order: string[] = [];
    const pool = createTaskPool({
      kinds: {
        log: {
          load: () => ({
            run: (input: string) => {
              order.push(input);
              return { value: input };
            },
          }),
        },
      },
    });
    expect(pool.mode).toBe('inline');
    const results = [
      pool.submit('log', 'b1', { priority: 'background' }).result,
      pool.submit('log', 'n1').result,
      pool.submit('log', 'c1', { priority: 'critical' }).result,
      pool.submit('log', 'n2').result,
      pool.submit('log', 'c2', { priority: 'critical' }).result,
    ];
    await Promise.all(results);
    expect(order).toEqual(['c1', 'c2', 'n1', 'n2', 'b1']);
  });

  it('initializes each kind once with its shared value', async () => {
    const init = vi.fn();
    const shared = vi.fn(() => 'module');
    const pool = createTaskPool({
      kinds: { k: { load: () => ({ shared, init, run: (n: number) => ({ value: n }) }) } },
    });
    expect(await Promise.all([1, 2, 3].map((n) => pool.submit('k', n).result))).toEqual([1, 2, 3]);
    expect(shared).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({ shared: 'module' });
  });

  it('withdraws a queued task and discards a running one', async () => {
    let release!: () => void;
    let observed: { aborted: boolean } | undefined;
    const pool = createTaskPool({
      kinds: {
        slow: {
          load: () => ({
            run: async (_: void, context) => {
              observed = context;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return { value: 'late' };
            },
          }),
        },
        fast: { load: () => echo },
      },
    });
    const running = pool.submit('slow', undefined);
    const queued = pool.submit<number, number>('fast', 4);
    await flush();
    expect(queued.cancel()).toBe(true);
    await expect(queued.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(running.cancel()).toBe(false);
    expect(observed?.aborted).toBe(true);
    await expect(running.result).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(running.cancel()).toBe(false);
    expect(await pool.submit('fast', 5).result).toBe(10);
  });

  it('honors an abort signal and rejects everything on dispose', async () => {
    const pool = createTaskPool({ kinds: { fast: { load: () => echo } } });
    const controller = new AbortController();
    const aborted = pool.submit('fast', 1, { signal: controller.signal });
    controller.abort();
    await expect(aborted.result).rejects.toMatchObject({ name: 'AbortError' });
    const pending = pool.submit('fast', 2);
    pool.dispose();
    await expect(pending.result).rejects.toThrow('task pool disposed');
    await expect(pool.submit('fast', 3).result).rejects.toThrow('task pool disposed');
  });

  it('yields to the event loop when a slice is spent', async () => {
    let clock = 0;
    const yields: Array<() => void> = [];
    const pool = createTaskPool({
      kinds: {
        work: {
          load: () => ({
            run: async (cost: number, context) => {
              clock += cost;
              await context.yield();
              return { value: cost };
            },
          }),
        },
      },
      sliceMs: 8,
      now: () => clock,
      yieldTask: (resume) => yields.push(resume),
    });
    const first = pool.submit('work', 3).result;
    const second = pool.submit('work', 10).result;
    expect(await first).toBe(3);
    await flush();
    expect(yields.length).toBe(1);
    yields.shift()?.();
    expect(await second).toBe(10);
  });

  it('delivers to a reply port and reports unknown kinds', async () => {
    const pool = createTaskPool({ kinds: { fast: { load: () => echo } } });
    const channel = new MessageChannel();
    const delivered = new Promise((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });
    expect(await pool.submit('fast', 21, { replyTo: channel.port2 }).result).toBeUndefined();
    expect(await delivered).toEqual({ value: 42 });
    channel.port1.close();
    await expect(pool.submit('missing', 0).result).rejects.toThrow("unknown task kind 'missing'");
  });
});

describe('worker task pool', () => {
  it('spawns lazily, reuses the most recently idle Worker and caps a kind', async () => {
    const { factory, workers } = manualWorkers();
    const pool = createTaskPool({
      kinds: { k: { load: () => echo, maxInFlight: 2 } },
      workerFactory: factory,
      workers: 3,
    });
    expect(pool.mode).toBe('worker');
    expect(workers.length).toBe(0);
    const tasks = [1, 2, 3].map((n) => pool.submit('k', n));
    await flush();
    expect(workers.length).toBe(2);
    workers[0]?.finish('a');
    expect(await tasks[0]?.result).toBe('a');
    await flush();
    // The third task waited for the kind's cap, then took the freed Worker.
    expect(workers.length).toBe(2);
    expect(workers[0]?.messages.filter((m) => m.t === 'run').length).toBe(2);
    workers[0]?.finish('c');
    workers[1]?.finish('b');
    expect(await Promise.all(tasks.slice(1).map((task) => task?.result))).toEqual(['b', 'c']);
    // Worker 1 went idle last, so it serves the next task.
    pool.submit('k', 4);
    await flush();
    expect(workers[1]?.messages.filter((m) => m.t === 'run').length).toBe(2);
  });

  it('keeps one Worker out of background reach', async () => {
    const { factory, workers } = manualWorkers();
    const pool = createTaskPool({
      kinds: { k: { load: () => echo } },
      workerFactory: factory,
      workers: 2,
    });
    pool.submit('k', 1, { priority: 'background' });
    pool.submit('k', 2, { priority: 'background' });
    await flush();
    expect(workers.length).toBe(1);
    pool.submit('k', 3, { priority: 'critical' });
    await flush();
    expect(workers.length).toBe(2);
    expect(workers[1]?.messages[0]).toMatchObject({ t: 'run', input: 3 });
  });

  it('sends the shared value once per Worker and kind', async () => {
    const { factory, workers } = manualWorkers();
    const pool = createTaskPool({
      kinds: { k: { load: () => ({ ...echo, shared: () => 'wasm' }) } },
      workerFactory: factory,
      workers: 1,
    });
    const first = pool.submit('k', 1);
    await flush();
    workers[0]?.finish(1);
    await first.result;
    pool.submit('k', 2);
    await flush();
    const runs = workers[0]?.messages.filter((m) => m.t === 'run') ?? [];
    expect(runs[0]).toMatchObject({ shared: { value: 'wasm' } });
    expect(runs[1]).not.toHaveProperty('shared');
  });

  it('forwards cancellation to a running Worker and discards its value', async () => {
    const { factory, workers } = manualWorkers();
    const pool = createTaskPool({
      kinds: { k: { load: () => echo } },
      workerFactory: factory,
      workers: 1,
    });
    const running = pool.submit('k', 1);
    const queued = pool.submit('k', 2);
    await flush();
    expect(queued.cancel()).toBe(true);
    await expect(queued.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(running.cancel()).toBe(false);
    expect(workers[0]?.messages.at(-1)).toEqual({ t: 'cancel', id: 0 });
    await expect(running.result).rejects.toMatchObject({ name: 'AbortError' });
    workers[0]?.finish('ignored');
    const next = pool.submit('k', 3);
    await flush();
    workers[0]?.finish('next');
    expect(await next.result).toBe('next');
  });

  it('replaces a crashed Worker without retrying, then degrades the kind inline', async () => {
    const { factory, workers } = manualWorkers();
    const run = vi.fn((n: number) => ({ value: n * 10 }));
    const pool = createTaskPool({
      kinds: { k: { load: () => ({ run }) } },
      workerFactory: factory,
      workers: 1,
      crashLimit: 2,
    });
    const first = pool.submit('k', 1);
    await flush();
    workers[0]?.listener.error(new Error('boom'));
    await expect(first.result).rejects.toThrow("task worker crashed while running 'k'");
    expect(workers[0]?.terminated).toBe(true);
    const second = pool.submit('k', 2);
    await flush();
    expect(workers.length).toBe(2);
    workers[1]?.listener.error(new Error('boom'));
    await expect(second.result).rejects.toThrow('crashed');
    expect(await pool.submit('k', 3).result).toBe(30);
    expect(run).toHaveBeenCalledWith(3, expect.anything());
    expect(workers.length).toBe(2);
  });

  it('rejects running tasks and terminates Workers on dispose', async () => {
    const { factory, workers } = manualWorkers();
    const pool = createTaskPool({
      kinds: { k: { load: () => echo } },
      workerFactory: factory,
      workers: 1,
    });
    const running = pool.submit('k', 1);
    const queued = pool.submit('k', 2);
    await flush();
    pool.dispose();
    await expect(running.result).rejects.toThrow('task pool disposed');
    await expect(queued.result).rejects.toThrow('task pool disposed');
    expect(workers[0]?.terminated).toBe(true);
  });

  it('runs through the Worker runtime with module init once per Worker', async () => {
    const init = vi.fn();
    const registry: TaskRegistry = {
      k: { load: () => ({ shared: () => 7, init, run: (n: number) => ({ value: n + 1 }) }) },
      bad: {
        load: () => ({
          run: () => {
            throw new TypeError('bad input');
          },
        }),
      },
    };
    const { factory, spawned } = servedWorkers(registry);
    const pool = createTaskPool({ kinds: registry, workerFactory: factory, workers: 2 });
    expect(await Promise.all([1, 2, 3, 4].map((n) => pool.submit('k', n).result))).toEqual([
      2, 3, 4, 5,
    ]);
    expect(spawned()).toBe(2);
    expect(init).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenCalledWith({ shared: 7 });
    await expect(pool.submit('bad', 0).result).rejects.toThrow('bad input');
  });
});

describe('Worker-only tasks', () => {
  const workerOnly = { load: () => echo, workerOnly: true };

  it('rejects a Worker-only kind in an inline pool', async () => {
    const load = vi.fn(() => echo);
    const pool = createTaskPool({ kinds: { k: { ...workerOnly, load } } });
    await expect(pool.submit('k', 2).result).rejects.toThrow('requires a Worker');
    expect(load).not.toHaveBeenCalled();
    pool.dispose();
  });

  it('rejects queued Worker-only jobs on startup failure and runs flexible jobs inline', async () => {
    const { factory, workers } = manualWorkers({ adopt: false });
    const pool = createTaskPool({
      kinds: { required: workerOnly, flexible: { load: () => echo } },
      workerFactory: factory,
    });
    const required = expect(
      pool.submit('required', 2, { priority: 'background' }).result,
    ).rejects.toThrow('requires a Worker');
    const flexible = pool.submit('flexible', 3).result;
    await flush();
    workers[0]?.listener.error(new Error('script failed to load'));
    await required;
    expect(await flexible).toBe(6);
    pool.dispose();
  });

  it('rejects queued and future Worker-only jobs after repeated crashes', async () => {
    const { factory, workers } = manualWorkers();
    const pool = createTaskPool({
      kinds: { k: workerOnly },
      workerFactory: factory,
      workers: 1,
      crashLimit: 1,
    });
    const running = expect(pool.submit('k', 1).result).rejects.toThrow('crashed');
    const queued = expect(pool.submit('k', 2).result).rejects.toThrow('requires a Worker');
    await flush();
    workers[0]?.listener.error(new Error('crashed'));
    await Promise.all([running, queued]);
    await expect(pool.submit('k', 3).result).rejects.toThrow('requires a Worker');
    expect(workers).toHaveLength(1);
    pool.dispose();
  });
});

describe('worker startup failure', () => {
  it('runs inline when the host never adopts the first Worker', async () => {
    const { factory, workers } = manualWorkers({ adopt: false });
    const pool = createTaskPool({
      kinds: { k: { load: () => echo } },
      workerFactory: factory,
      workers: 2,
      startupTimeoutMs: 20,
    });
    const tasks = [1, 2].map((n) => pool.submit<number, number>('k', n).result);
    await flush();
    // Nothing is sent to a Worker before it reports ready.
    expect(workers.length).toBe(1);
    expect(workers[0]?.messages).toEqual([]);
    expect(await Promise.all(tasks)).toEqual([2, 4]);
    expect(pool.mode).toBe('inline');
    expect(workers[0]?.terminated).toBe(true);
    expect(await pool.submit('k', 3).result).toBe(6);
    expect(workers.length).toBe(1);
  });

  it('runs inline when the first Worker fails to load or cannot be created', async () => {
    const { factory, workers } = manualWorkers({ adopt: false });
    const failing = createTaskPool({
      kinds: { k: { load: () => echo } },
      workerFactory: factory,
      workers: 1,
    });
    const first = failing.submit('k', 5).result;
    await flush();
    workers[0]?.listener.error(new Error('script failed to load'));
    expect(await first).toBe(10);
    expect(failing.mode).toBe('inline');

    const throwing = createTaskPool({
      kinds: { k: { load: () => echo } },
      workerFactory: () => {
        throw new Error('Worker unavailable');
      },
    });
    expect(await throwing.submit('k', 7).result).toBe(14);
    expect(throwing.mode).toBe('inline');
  });

  it('keeps Workers once one started; a later start failure only drops that Worker', async () => {
    let adopt = true;
    const workers: ManualWorker[] = [];
    const { factory: base } = manualWorkers();
    const factory: TaskWorkerFactory = (listener) => {
      const proxy: TaskWorkerListener = {
        message: (data) => (adopt || data.t !== 'ready' ? listener.message(data) : undefined),
        error: listener.error,
      };
      const link = base(proxy);
      workers.push({
        listener: proxy,
        messages: [],
        terminated: false,
        finish: () => {},
      });
      return link;
    };
    const pool = createTaskPool({
      kinds: { k: { load: () => ({ run: async (n: number) => ({ value: n }) }) } },
      workerFactory: factory,
      workers: 2,
      startupTimeoutMs: 20,
    });
    const pending = [pool.submit('k', 1).result];
    await flush();
    expect(workers.length).toBe(1);
    adopt = false;
    pending.push(pool.submit('k', 2).result);
    await flush();
    expect(workers.length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(pool.mode).toBe('worker');
    pool.dispose();
    await Promise.allSettled(pending);
  });
});

describe('remote task client', () => {
  it('submits through a dispatcher port and receives values directly', async () => {
    const registry: TaskRegistry = {
      bytes: {
        load: () => ({
          run: (input: Uint8Array) => {
            const out = input.map((value) => value + 1);
            return { value: out, transfer: [out.buffer] };
          },
        }),
      },
      bad: { load: () => ({ run: () => Promise.reject(new Error('remote failure')) }) },
    };
    const { factory } = servedWorkers(registry);
    const pool = createTaskPool({ kinds: registry, workerFactory: factory, workers: 1 });
    const channel = new MessageChannel();
    const release = serveTaskClient(channel.port2, pool);
    const client = createTaskClient(channel.port1);
    const input = new Uint8Array([1, 2, 3]);
    const handle = client.submit<Uint8Array, Uint8Array>('bytes', input, {
      transfer: [input.buffer],
    });
    expect(input.byteLength).toBe(0);
    expect([...(await handle.result)]).toEqual([2, 3, 4]);
    await expect(client.submit('bad', 0).result).rejects.toThrow('remote failure');
    const canceled = client.submit('bytes', new Uint8Array(1));
    expect(canceled.cancel()).toBe(true);
    await expect(canceled.result).rejects.toMatchObject({ name: 'AbortError' });
    const pending = client.submit('bytes', new Uint8Array(1));
    client.dispose();
    await expect(pending.result).rejects.toThrow('task client disposed');
    release();
    pool.dispose();
  });
});

/** Workers whose `slices` handler runs synchronously inside `postMessage`. */
function sliceWorkers(join: (message: Extract<TaskPoolToWorkerMessage, { t: 'slices' }>) => void): {
  factory: TaskWorkerFactory;
  messages: TaskPoolToWorkerMessage[][];
  terminated: boolean[];
} {
  const messages: TaskPoolToWorkerMessage[][] = [];
  const terminated: boolean[] = [];
  const factory: TaskWorkerFactory = (listener) => {
    const at = messages.length;
    messages.push([]);
    terminated.push(false);
    queueMicrotask(() => listener.message({ t: 'ready' }));
    return {
      postMessage: (message) => {
        messages[at]?.push(message);
        if (message.t === 'slices') join(message);
      },
      terminate: () => {
        terminated[at] = true;
      },
    };
  };
  return { factory, messages, terminated };
}

const job = (count: number, run: (index: number) => void, timeoutMs = 50) => ({
  kind: 'rows',
  input: null,
  count,
  run,
  timeoutMs,
});

describe('slice jobs', () => {
  it('runs every index in this realm without Workers', () => {
    const pool = createTaskPool({ kinds: {} });
    const seen: number[] = [];
    const outcome = pool.parallelFor(
      job(4, (index) => {
        if (index === 2) throw new Error('row 2');
        seen.push(index);
      }),
    );
    expect(seen).toEqual([0, 1, 3]);
    expect(outcome).toMatchObject({ count: 4, completed: 3, failed: 1, helpers: 0 });
    expect(String(outcome.failure)).toContain('row 2');
    expect(pool.sliceHelpers).toBe(0);
  });

  it('grows to full size on prepare and replays prepared values to late Workers', async () => {
    const { factory, messages } = sliceWorkers(() => {});
    const pool = createTaskPool({ kinds: {}, workerFactory: factory, workers: 3 });
    pool.prepareSlices('rows', 'module-a');
    for (let tick = 0; tick < 6; tick++) await flush();
    expect(pool.sliceHelpers).toBe(3);
    for (const worker of messages) {
      expect(worker).toEqual([{ t: 'prepare', kind: 'rows', value: 'module-a' }]);
    }
    pool.prepareSlices('rows', 'module-b');
    for (const worker of messages) expect(worker).toHaveLength(2);
    pool.dispose();
  });

  it('shares one cursor between this realm and the Workers; each index runs once', async () => {
    const owners: number[] = [];
    // Each Worker claims two indices before the caller starts claiming.
    const { factory } = sliceWorkers((message) => {
      for (let claimed = 0; claimed < 2; claimed++) {
        const index = Atomics.add(message.control, 0, 1);
        Atomics.store(message.control, SLICE_STATE + index, message.owner);
        owners[index] = message.owner;
        Atomics.store(message.control, SLICE_STATE + index, -1);
        Atomics.add(message.control, 1, 1);
      }
    });
    const pool = createTaskPool({ kinds: {}, workerFactory: factory, workers: 2 });
    pool.prepareSlices('rows', null);
    for (let tick = 0; tick < 6; tick++) await flush();
    const outcome = pool.parallelFor(
      job(7, (index) => {
        expect(owners[index]).toBeUndefined();
        owners[index] = SLICE_CALLER;
      }),
    );
    expect(outcome).toMatchObject({
      count: 7,
      completed: 7,
      failed: 0,
      helpers: 2,
      timedOut: false,
    });
    expect(owners).toEqual([2, 2, 3, 3, 1, 1, 1]);
    pool.dispose();
  });

  it('reports failures and replaces only the Worker that still holds an index', async () => {
    let stuck = true;
    const { factory, terminated } = sliceWorkers((message) => {
      if (!stuck) return;
      stuck = false;
      // Claim one index and never finish it.
      const index = Atomics.add(message.control, 0, 1);
      Atomics.store(message.control, SLICE_STATE + index, message.owner);
    });
    const pool = createTaskPool({ kinds: {}, workerFactory: factory, workers: 2 });
    pool.prepareSlices('rows', null);
    for (let tick = 0; tick < 6; tick++) await flush();
    expect(pool.sliceHelpers).toBe(2);
    const ran: number[] = [];
    const outcome = pool.parallelFor(job(6, (index) => ran.push(index), 5));
    expect(outcome).toMatchObject({
      count: 6,
      completed: 5,
      failed: 0,
      helpers: 2,
      timedOut: true,
    });
    expect(ran).toEqual([1, 2, 3, 4, 5]);
    // The holder is replaced; the pool starts a fresh Worker in its place.
    expect(terminated).toEqual([true, false, false]);
    expect(pool.sliceHelpers).toBe(1);
    for (let tick = 0; tick < 6; tick++) await flush();
    expect(pool.sliceHelpers).toBe(2);
    pool.dispose();
  });
});

describe('Worker-side slices', () => {
  it('joins a prepared kind and leaves unprepared jobs to the caller', async () => {
    const ran: number[] = [];
    let loaded = false;
    const port = {
      onmessage: null as ((event: MessageEvent<TaskPoolToWorkerMessage>) => void) | null,
      postMessage: () => {},
    };
    serveTaskWorker(
      port,
      {},
      {
        slices: {
          rows: {
            prepare: async () => {
              loaded = true;
            },
            ready: () => loaded,
            run: (_input: unknown, index: number) => {
              ran.push(index);
            },
          },
        },
      },
    );
    const send = (message: TaskPoolToWorkerMessage) =>
      port.onmessage?.({ data: message } as MessageEvent<TaskPoolToWorkerMessage>);
    const early = createSliceControl(3);
    send({ t: 'slices', kind: 'rows', input: null, control: early, owner: 2 });
    send({ t: 'slices', kind: 'other', input: null, control: early, owner: 2 });
    expect(Atomics.load(early, 0)).toBe(0);
    send({ t: 'prepare', kind: 'rows', value: null });
    await flush();
    const control = createSliceControl(3);
    send({ t: 'slices', kind: 'rows', input: null, control, owner: 2 });
    expect(ran).toEqual([0, 1, 2]);
    expect(Array.from(control.subarray(SLICE_STATE))).toEqual([-1, -1, -1]);
    expect(drainSlices(control, SLICE_CALLER, () => {})).toBeUndefined();
  });
});
