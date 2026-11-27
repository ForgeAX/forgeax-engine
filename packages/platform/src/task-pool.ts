import {
  type TaskContext,
  type TaskExecutor,
  type TaskHandle,
  type TaskModule,
  type TaskPriority,
  type TaskRegistry,
  type TaskResult,
  type TaskSubmitOptions,
  taskAbortError,
} from '@forgeax/engine-types';
import { nowMs } from './clock.js';
import {
  awaitSlices,
  createSliceControl,
  drainSlices,
  SLICE_CALLER,
  type SliceRegistry,
  tallySlices,
} from './slices.js';

/** Pool to Worker messages. `shared` accompanies a kind's first run on a Worker. */
export type TaskPoolToWorkerMessage =
  | {
      readonly t: 'run';
      readonly id: number;
      readonly kind: string;
      readonly input: unknown;
      readonly shared?: { readonly value: unknown };
      readonly reply?: MessagePort;
    }
  | { readonly t: 'cancel'; readonly id: number }
  /** Ready a slice kind for later jobs; replayed to every Worker that starts later. */
  | { readonly t: 'prepare'; readonly kind: string; readonly value: unknown }
  /** Join a slice job: claim indices from `control` until none remain. */
  | {
      readonly t: 'slices';
      readonly kind: string;
      readonly input: unknown;
      readonly control: Int32Array;
      readonly owner: number;
    };

/**
 * Worker to pool messages; `delivered` means the value went to the reply port.
 * `ready` is posted once the Worker serves its port; it receives no task before.
 */
export type TaskWorkerToPoolMessage =
  | { readonly t: 'ready' }
  | { readonly t: 'done'; readonly id: number; readonly value?: unknown; readonly delivered?: true }
  | { readonly t: 'fail'; readonly id: number; readonly error: unknown };

export interface TaskWorkerListener {
  message(data: TaskWorkerToPoolMessage): void;
  /** The Worker died; its running task is lost. */
  error(cause: unknown): void;
}

export interface TaskWorkerLink {
  postMessage(message: TaskPoolToWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

export type TaskWorkerFactory = (listener: TaskWorkerListener) => TaskWorkerLink;

export interface TaskPoolOptions {
  readonly kinds: TaskRegistry;
  /** Absent: every task runs inline in this realm. */
  readonly workerFactory?: TaskWorkerFactory;
  /** Worker count; defaults to {@link defaultTaskWorkerCount}. */
  readonly workers?: number;
  /** Consecutive Worker crashes after which a kind runs inline. Default 3. */
  readonly crashLimit?: number;
  /**
   * How long a new Worker may take to report ready. If the first Worker fails
   * to start (or `crashLimit` consecutive ones do), the pool runs inline from
   * then on, including the tasks that were waiting. Default 10 s.
   */
  readonly startupTimeoutMs?: number;
  /** Inline time slice before yielding to the event loop. Default 8 ms. */
  readonly sliceMs?: number;
  readonly now?: () => number;
  /** Resume after yielding to the event loop. Default `setTimeout(resume, 0)`. */
  readonly yieldTask?: (resume: () => void) => void;
}

export interface SliceJob<I> {
  readonly kind: string;
  readonly input: I;
  readonly count: number;
  /** The calling realm's body for one index; Workers run the kind's `run`. */
  run(index: number): void;
  /** How long the caller blocks for Workers after it ran out of indices. */
  readonly timeoutMs: number;
}

export interface SliceOutcome {
  readonly count: number;
  readonly completed: number;
  readonly failed: number;
  /** Pool Workers that received the job. */
  readonly helpers: number;
  readonly timedOut: boolean;
  /** First error raised by the calling realm's indices. */
  readonly failure: unknown;
}

export interface TaskPool extends TaskExecutor {
  readonly mode: 'worker' | 'inline';
  /** Started Workers that would join a slice job now. */
  readonly sliceHelpers: number;
  /**
   * Announce a slice kind's value to every Worker, now and as they start.
   * The pool grows to full size so later jobs find helpers.
   */
  prepareSlices(kind: string, value: unknown): void;
  /**
   * Run `count` indices across this realm and the pool, blocking until all
   * finished. The caller claims indices too, so the job completes even when
   * no Worker joins. A Worker still holding an index at the deadline is
   * replaced.
   */
  parallelFor<I>(job: SliceJob<I>): SliceOutcome;
  /** Reject every unfinished task and release all Workers. Idempotent. */
  dispose(): void;
}

const PRIORITIES: readonly TaskPriority[] = ['critical', 'normal', 'background'];

/** Three realms are already busy (page, engine, render); at most four helpers. */
export function defaultTaskWorkerCount(
  hardwareConcurrency = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency ?? 4,
): number {
  return Math.max(1, Math.min(hardwareConcurrency - 3, 4));
}

function defaultYield(resume: () => void): void {
  setTimeout(resume, 0);
}

/** Errors cross realms as structured clones; fall back to their message. */
export function cloneableTaskError(cause: unknown): unknown {
  try {
    structuredClone(cause);
    return cause;
  } catch {
    return { name: 'Error', message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function reviveTaskError(error: unknown): Error {
  if (error instanceof Error) return error;
  const record = error as { name?: unknown; message?: unknown } | null;
  const revived = new Error(typeof record?.message === 'string' ? record.message : String(error));
  if (typeof record?.name === 'string') revived.name = record.name;
  return revived;
}

/** Time-sliced checkpoint shared by inline runs and Worker runs. */
function createSlicer(now: () => number, sliceMs: number, yieldTask: (resume: () => void) => void) {
  let sliceStart = now();
  return {
    restart(): void {
      sliceStart = now();
    },
    expired(): boolean {
      return now() - sliceStart >= sliceMs;
    },
    yield(): Promise<void> {
      if (now() - sliceStart < sliceMs) return Promise.resolve();
      return new Promise((resolve) =>
        yieldTask(() => {
          sliceStart = now();
          resolve();
        }),
      );
    },
  };
}

interface KindState {
  // biome-ignore lint/suspicious/noExplicitAny: kinds are heterogeneous.
  module?: TaskModule<any, any, any>;
  shared?: { readonly value: unknown };
  failure?: unknown;
  loading: boolean;
  inFlight: number;
  crashes: number;
  degraded: boolean;
  /** Inline realm: init has completed for this kind. */
  inlineReady?: Promise<void> | undefined;
}

interface Slot {
  /** Owner id in slice controls. */
  readonly owner: number;
  readonly link: TaskWorkerLink | undefined;
  task: Task | undefined;
  readonly sent: Set<string>;
  /** Pending startup deadline; undefined once the Worker reported ready. */
  startup: ReturnType<typeof setTimeout> | undefined;
}

interface Task {
  readonly id: number;
  readonly kind: string;
  readonly priority: TaskPriority;
  input: unknown;
  transfer: Transferable[];
  reply: MessagePort | undefined;
  readonly debugName: string | undefined;
  settled: boolean;
  started: boolean;
  control: { aborted: boolean } | undefined;
  resolve(value: unknown): void;
  reject(cause: unknown): void;
}

/**
 * Asynchronous task pool. Queues are per priority and FIFO; idle Workers are
 * reused most-recently-idle first and spawned lazily up to the pool size. One
 * Worker stays out of background reach while the pool has more than one, and
 * each kind may cap its simultaneously running tasks. Without a Worker factory
 * the same queues drain inline, time-sliced on the realm's event loop.
 */
export function createTaskPool(options: TaskPoolOptions): TaskPool {
  const factory = options.workerFactory;
  const size = factory === undefined ? 1 : Math.max(1, options.workers ?? defaultTaskWorkerCount());
  const crashLimit = Math.max(1, options.crashLimit ?? 3);
  const now = options.now ?? nowMs;
  const yieldTask = options.yieldTask ?? defaultYield;
  const slicer = createSlicer(now, options.sliceMs ?? 8, yieldTask);
  const queues: Record<TaskPriority, Task[]> = { critical: [], normal: [], background: [] };
  const kinds = new Map<string, KindState>();
  const idle: Slot[] = [];
  const slots = new Set<Slot>();
  // Inline execution: the whole pool without a factory, or crash-degraded kinds.
  const inline: Slot = {
    owner: SLICE_CALLER,
    link: undefined,
    task: undefined,
    sent: new Set(),
    startup: undefined,
  };
  const prepared: { readonly kind: string; readonly value: unknown }[] = [];
  let slicing = false;
  let nextOwner = SLICE_CALLER + 1;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  let inlineScheduled = false;
  let nextId = 0;
  let disposed = false;
  // Workers depend on the host adopting them; until one reports ready the
  // pool cannot tell a slow start from a host that never creates Workers.
  let workerReady = false;
  let startFailures = 0;
  let workersFailed = false;

  const kindState = (kind: string): KindState => {
    let state = kinds.get(kind);
    if (state !== undefined) return state;
    state = {
      loading: false,
      inFlight: 0,
      crashes: 0,
      degraded: factory === undefined || workersFailed,
    };
    kinds.set(kind, state);
    return state;
  };

  const taskFailure = (kind: string, state: KindState): unknown =>
    state.degraded && options.kinds[kind]?.workerOnly
      ? new Error(`task kind '${kind}' requires a Worker`)
      : state.failure;

  const settle = (task: Task): boolean => {
    if (task.settled) return false;
    task.settled = true;
    task.input = undefined;
    task.transfer = [];
    task.reply?.close();
    task.reply = undefined;
    return true;
  };
  const fail = (task: Task, cause: unknown): void => {
    if (settle(task)) task.reject(cause);
  };
  const succeed = (task: Task, value: unknown): void => {
    if (settle(task)) task.resolve(value);
  };

  const load = (kind: string, state: KindState): void => {
    if (state.loading || state.module !== undefined || state.failure !== undefined) return;
    const registration = options.kinds[kind];
    if (registration === undefined) {
      state.failure = new Error(`unknown task kind '${kind}'`);
      return;
    }
    state.loading = true;
    void (async () => {
      const module = await registration.load();
      return { module, shared: await module.shared?.() };
    })().then(
      ({ module, shared }) => {
        state.loading = false;
        state.module = module;
        state.shared = { value: shared };
        pump();
      },
      (cause: unknown) => {
        state.loading = false;
        state.failure = cause;
        pump();
      },
    );
  };

  const capacity = (state: KindState, kind: string): boolean =>
    state.inFlight < (options.kinds[kind]?.maxInFlight ?? Number.POSITIVE_INFINITY);

  /** Workers this dispatch may take: idle ones plus those not yet spawned. */
  const available = (): number => idle.length + size - slots.size;

  const starting = (): boolean => {
    for (const slot of slots) if (slot.startup !== undefined) return true;
    return false;
  };

  /** Start one Worker; it joins `idle` when it reports ready. */
  const spawn = (): void => {
    if (factory === undefined || slots.size >= size || starting()) return;
    const slot: Slot = {
      owner: nextOwner++,
      link: undefined,
      task: undefined,
      sent: new Set(),
      startup: undefined,
    };
    const listener: TaskWorkerListener = {
      message: (data) => receive(slot, data),
      error: (cause) => crash(slot, cause),
    };
    slots.add(slot);
    slot.startup = setTimeout(() => startFailed(slot), startupTimeoutMs);
    try {
      (slot as { link: TaskWorkerLink }).link = factory(listener);
    } catch {
      startFailed(slot);
    }
  };

  const terminate = (slot: Slot): void => {
    if (slot.startup !== undefined) clearTimeout(slot.startup);
    slot.startup = undefined;
    try {
      slot.link?.terminate();
    } catch {
      // The Worker is already gone.
    }
  };

  /** Every kind runs inline from now on; queued tasks drain in this realm. */
  const runWorkersInline = (): void => {
    workersFailed = true;
    for (const state of kinds.values()) state.degraded = true;
  };

  /** A Worker never reported ready: the host did not adopt it, or it failed to load. */
  const startFailed = (slot: Slot): void => {
    if (!slots.delete(slot)) return;
    terminate(slot);
    if (!workerReady || ++startFailures >= crashLimit) runWorkersInline();
    pump();
  };

  const ready = (slot: Slot): void => {
    if (slot.startup === undefined) return;
    clearTimeout(slot.startup);
    slot.startup = undefined;
    workerReady = true;
    startFailures = 0;
    for (const { kind, value } of prepared) post(slot, { t: 'prepare', kind, value });
    idle.push(slot);
    pump();
  };

  /** A message whose loss only costs this Worker its share of slice work. */
  const post = (slot: Slot, message: TaskPoolToWorkerMessage): boolean => {
    try {
      (slot.link as TaskWorkerLink).postMessage(message);
      return true;
    } catch {
      return false;
    }
  };

  const started = (): Slot[] => [...slots].filter((slot) => slot.startup === undefined);

  const release = (slot: Slot): void => {
    const task = slot.task;
    slot.task = undefined;
    if (task !== undefined) kindState(task.kind).inFlight--;
    if (slot !== inline && slots.has(slot)) idle.push(slot);
  };

  const receive = (slot: Slot, data: TaskWorkerToPoolMessage): void => {
    if (data.t === 'ready') {
      ready(slot);
      return;
    }
    const task = slot.task;
    if (task === undefined || data.id !== task.id) return;
    release(slot);
    const state = kindState(task.kind);
    state.crashes = 0;
    if (data.t === 'done') succeed(task, data.delivered === true ? undefined : data.value);
    else fail(task, reviveTaskError(data.error));
    pump();
  };

  const crash = (slot: Slot, cause: unknown): void => {
    if (slot.startup !== undefined) {
      startFailed(slot);
      return;
    }
    if (!slots.delete(slot)) return;
    const at = idle.indexOf(slot);
    if (at >= 0) idle.splice(at, 1);
    terminate(slot);
    const task = slot.task;
    slot.task = undefined;
    if (task !== undefined) {
      const state = kindState(task.kind);
      state.inFlight--;
      if (++state.crashes >= crashLimit) state.degraded = true;
      fail(task, new Error(`task worker crashed while running '${task.kind}'`, { cause }));
    }
    pump();
  };

  const startOnWorker = (slot: Slot, task: Task, state: KindState): void => {
    slot.task = task;
    task.started = true;
    state.inFlight++;
    const transfer = [...task.transfer];
    if (task.reply !== undefined) transfer.push(task.reply);
    const first = !slot.sent.has(task.kind);
    slot.sent.add(task.kind);
    const message: TaskPoolToWorkerMessage = {
      t: 'run',
      id: task.id,
      kind: task.kind,
      input: task.input,
      ...(first && state.shared !== undefined ? { shared: state.shared } : {}),
      ...(task.reply === undefined ? {} : { reply: task.reply }),
    };
    task.input = undefined;
    task.transfer = [];
    task.reply = undefined;
    try {
      (slot.link as TaskWorkerLink).postMessage(message, transfer);
    } catch (cause) {
      release(slot);
      fail(task, cause);
    }
  };

  const runInline = async (task: Task, state: KindState): Promise<void> => {
    inline.task = task;
    task.started = true;
    state.inFlight++;
    const control = { aborted: false };
    task.control = control;
    const context: TaskContext = {
      get aborted() {
        return control.aborted;
      },
      yield: () => slicer.yield(),
    };
    const input = task.input;
    const reply = task.reply;
    task.input = undefined;
    task.transfer = [];
    task.reply = undefined;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: kinds are heterogeneous.
      const module = state.module as TaskModule<any, any, any>;
      state.inlineReady ??= Promise.resolve(module.init?.({ shared: state.shared?.value })).catch(
        (cause: unknown) => {
          state.inlineReady = undefined;
          throw cause;
        },
      );
      await state.inlineReady;
      const out: TaskResult<unknown> = await module.run(input, context);
      release(inline);
      if (control.aborted || task.settled) return;
      if (reply !== undefined) {
        reply.postMessage({ value: out.value }, [...(out.transfer ?? [])]);
        reply.close();
        succeed(task, undefined);
      } else succeed(task, out.value);
    } catch (cause) {
      if (inline.task === task) release(inline);
      fail(task, cause);
    }
  };

  const drainInline = async (): Promise<void> => {
    slicer.restart();
    for (;;) {
      if (disposed) return;
      const next = select(true);
      if (next === undefined) return;
      await runInline(next.task, next.state);
      if (slicer.expired()) {
        await new Promise<void>((resolve) => yieldTask(resolve));
        slicer.restart();
      }
    }
  };

  const scheduleInline = (): void => {
    if (inlineScheduled || inline.task !== undefined) return;
    inlineScheduled = true;
    queueMicrotask(() => {
      void drainInline().finally(() => {
        inlineScheduled = false;
        if (!disposed && select(true, true) !== undefined) scheduleInline();
      });
    });
  };

  /**
   * The first dispatchable task in priority order. `inlineOnly` selects kinds
   * that run in this realm; otherwise kinds that run on Workers, honoring the
   * background reservation. `peek` leaves the task queued.
   */
  const select = (
    inlineOnly: boolean,
    peek = false,
  ): { task: Task; state: KindState } | undefined => {
    for (const priority of PRIORITIES) {
      if (!inlineOnly && priority === 'background' && size > 1 && available() <= 1) return;
      const queue = queues[priority];
      for (let index = 0; index < queue.length; index++) {
        const task = queue[index] as Task;
        if (task.settled) {
          queue.splice(index--, 1);
          continue;
        }
        const state = kindState(task.kind);
        const failure = taskFailure(task.kind, state);
        if (failure !== undefined) {
          queue.splice(index--, 1);
          fail(task, failure);
          continue;
        }
        if (state.module === undefined || state.degraded !== inlineOnly) continue;
        if (!capacity(state, task.kind)) continue;
        if (!peek) queue.splice(index, 1);
        return { task, state };
      }
    }
    return undefined;
  };

  const pump = (): void => {
    if (disposed) return;
    for (;;) {
      if (available() === 0) break;
      const next = select(false, true);
      if (next === undefined) break;
      const slot = idle.pop();
      if (slot === undefined) {
        // One Worker starts at a time; the task waits for it to report ready.
        spawn();
        break;
      }
      select(false);
      startOnWorker(slot, next.task, next.state);
    }
    if (slicing && !workersFailed) spawn();
    if (select(true, true) !== undefined) scheduleInline();
  };

  const cancel = (task: Task): boolean => {
    if (task.settled) return false;
    const queued = !task.started;
    fail(task, taskAbortError());
    if (queued) return true;
    if (task.control !== undefined) task.control.aborted = true;
    for (const slot of slots) {
      if (slot.task === task) {
        try {
          slot.link?.postMessage({ t: 'cancel', id: task.id });
        } catch {
          // The result is discarded regardless.
        }
      }
    }
    return false;
  };

  /** Replace the Workers still holding an index; the rest return on their own. */
  const abandon = (control: Int32Array): void => {
    const { running } = tallySlices(control);
    for (const slot of [...slots]) {
      if (running.has(slot.owner)) crash(slot, new Error('slice job deadline exceeded'));
    }
  };

  const parallelFor = <I>(job: SliceJob<I>): SliceOutcome => {
    const helpers = disposed || workersFailed ? [] : started();
    if (helpers.length === 0 || typeof SharedArrayBuffer === 'undefined') {
      let failed = 0;
      let failure: unknown;
      for (let index = 0; index < job.count; index++) {
        try {
          job.run(index);
        } catch (cause) {
          failed++;
          failure ??= cause;
        }
      }
      const completed = job.count - failed;
      return { count: job.count, completed, failed, helpers: 0, timedOut: false, failure };
    }
    const control = createSliceControl(job.count);
    let joined = 0;
    for (const slot of helpers) {
      const message = {
        t: 'slices' as const,
        kind: job.kind,
        input: job.input,
        control,
        owner: slot.owner,
      };
      if (post(slot, message)) joined++;
    }
    const failure = drainSlices(control, SLICE_CALLER, (index) => job.run(index));
    const finished = awaitSlices(control, now() + job.timeoutMs, now);
    if (!finished) abandon(control);
    const { completed, failed } = tallySlices(control);
    return { count: job.count, completed, failed, helpers: joined, timedOut: !finished, failure };
  };

  return {
    get mode() {
      return factory === undefined || workersFailed ? 'inline' : 'worker';
    },
    get sliceHelpers() {
      return disposed || workersFailed ? 0 : started().length;
    },
    prepareSlices(kind: string, value: unknown): void {
      if (disposed) return;
      prepared.push({ kind, value });
      for (const slot of started()) post(slot, { t: 'prepare', kind, value });
      slicing = true;
      pump();
    },
    parallelFor,
    submit<I, O>(kind: string, input: I, submitOptions: TaskSubmitOptions = {}): TaskHandle<O> {
      let resolve!: (value: unknown) => void;
      let reject!: (cause: unknown) => void;
      const result = new Promise<O>((res, rej) => {
        resolve = res as (value: unknown) => void;
        reject = rej;
      });
      const task: Task = {
        id: nextId++,
        kind,
        priority: submitOptions.priority ?? 'normal',
        input,
        transfer: [...(submitOptions.transfer ?? [])],
        reply: submitOptions.replyTo as MessagePort | undefined,
        debugName: submitOptions.debugName,
        settled: false,
        started: false,
        control: undefined,
        resolve,
        reject,
      };
      const handle: TaskHandle<O> = { result, cancel: () => cancel(task) };
      const signal = submitOptions.signal;
      if (disposed) {
        fail(task, new Error('task pool disposed'));
        return handle;
      }
      if (signal?.aborted) {
        fail(task, taskAbortError());
        return handle;
      }
      if (signal !== undefined) {
        const onAbort = () => cancel(task);
        signal.addEventListener('abort', onAbort, { once: true });
        void result.then(
          () => signal.removeEventListener('abort', onAbort),
          () => signal.removeEventListener('abort', onAbort),
        );
      }
      const state = kindState(kind);
      const failure = taskFailure(kind, state);
      if (failure !== undefined) {
        fail(task, failure);
        return handle;
      }
      queues[task.priority].push(task);
      load(kind, state);
      pump();
      return handle;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const reason = new Error('task pool disposed');
      for (const priority of PRIORITIES) {
        for (const task of queues[priority]) fail(task, reason);
        queues[priority].length = 0;
      }
      if (inline.task !== undefined) {
        if (inline.task.control !== undefined) inline.task.control.aborted = true;
        fail(inline.task, reason);
      }
      for (const slot of slots) {
        if (slot.task !== undefined) fail(slot.task, reason);
        terminate(slot);
      }
      slots.clear();
      idle.length = 0;
    },
  };
}

export interface ServeTaskWorkerOptions
  extends Pick<TaskPoolOptions, 'sliceMs' | 'now' | 'yieldTask'> {
  /** Slice kinds this Worker joins; jobs of other kinds are left to the caller. */
  readonly slices?: SliceRegistry;
}

/**
 * Join a slice job when its kind is prepared here; otherwise the caller and
 * other Workers take every index.
 */
function joinSlices(
  slices: SliceRegistry,
  message: Extract<TaskPoolToWorkerMessage, { t: 'slices' }>,
): void {
  const module = slices[message.kind];
  if (module === undefined || module.ready?.(message.input) === false) return;
  drainSlices(message.control, message.owner, (index) => module.run(message.input, index));
}

/** Prepare failures surface on the job: the Worker never reports ready for that input. */
function prepareSlices(
  slices: SliceRegistry,
  message: Extract<TaskPoolToWorkerMessage, { t: 'prepare' }>,
): void {
  try {
    void Promise.resolve(slices[message.kind]?.prepare?.(message.value)).catch(() => {});
  } catch {
    // Same as a rejected prepare.
  }
}

/** Serve tasks inside a pool Worker; one run at a time, modules initialized once. */
export function serveTaskWorker(
  port: Pick<MessagePort, 'postMessage'> & {
    onmessage: ((event: MessageEvent<TaskPoolToWorkerMessage>) => void) | null;
  },
  registry: TaskRegistry,
  options: ServeTaskWorkerOptions = {},
): void {
  const slices = options.slices ?? {};
  const now = options.now ?? nowMs;
  const slicer = createSlicer(now, options.sliceMs ?? 8, options.yieldTask ?? defaultYield);
  // biome-ignore lint/suspicious/noExplicitAny: kinds are heterogeneous.
  const ready = new Map<string, Promise<TaskModule<any, any, any>>>();
  const running = new Map<number, { aborted: boolean }>();
  const moduleFor = (kind: string, shared: { readonly value: unknown } | undefined) => {
    let module = ready.get(kind);
    if (module === undefined) {
      const registration = registry[kind];
      if (registration === undefined)
        return Promise.reject(new Error(`unknown task kind '${kind}'`));
      module = Promise.resolve(registration.load()).then(async (loaded) => {
        await loaded.init?.({ shared: shared?.value });
        return loaded;
      });
      module.catch(() => ready.delete(kind));
      ready.set(kind, module);
    }
    return module;
  };
  port.onmessage = (event) => {
    const message = event.data;
    if (message.t === 'slices') {
      joinSlices(slices, message);
      return;
    }
    if (message.t === 'prepare') {
      prepareSlices(slices, message);
      return;
    }
    if (message.t === 'cancel') {
      const control = running.get(message.id);
      if (control !== undefined) control.aborted = true;
      return;
    }
    const control = { aborted: false };
    running.set(message.id, control);
    const context: TaskContext = {
      get aborted() {
        return control.aborted;
      },
      yield: () => slicer.yield(),
    };
    void (async () => {
      try {
        const module = await moduleFor(message.kind, message.shared);
        slicer.restart();
        const out: TaskResult<unknown> = await module.run(message.input, context);
        if (control.aborted) port.postMessage({ t: 'done', id: message.id });
        else if (message.reply !== undefined) {
          message.reply.postMessage({ value: out.value }, [...(out.transfer ?? [])]);
          message.reply.close();
          port.postMessage({ t: 'done', id: message.id, delivered: true });
        } else
          port.postMessage({ t: 'done', id: message.id, value: out.value }, [
            ...(out.transfer ?? []),
          ]);
      } catch (cause) {
        message.reply?.close();
        port.postMessage({ t: 'fail', id: message.id, error: cloneableTaskError(cause) });
      } finally {
        running.delete(message.id);
      }
    })();
  };
  port.postMessage({ t: 'ready' });
}

/** Requester to dispatcher messages for an executor in another realm. */
export type TaskClientMessage =
  | {
      readonly t: 'submit';
      readonly id: number;
      readonly kind: string;
      readonly input: unknown;
      readonly transfer: readonly Transferable[];
      readonly reply: MessagePort;
      readonly priority?: TaskPriority;
      readonly debugName?: string;
    }
  | { readonly t: 'cancel'; readonly id: number };

export type TaskServerMessage = {
  readonly t: 'fail';
  readonly id: number;
  readonly error: unknown;
};

type TaskPortLike = Pick<MessagePort, 'postMessage' | 'close'> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

export interface TaskClient extends TaskExecutor {
  /** Reject unfinished tasks and close the port. */
  dispose(): void;
}

/**
 * An executor whose tasks run in the dispatcher at the other end of `port`.
 * Values return on a per-task channel straight from the executing realm.
 * `cancel()` cannot observe whether the remote task had started; it reports
 * true whenever the task was still unsettled.
 */
export function createTaskClient(port: TaskPortLike): TaskClient {
  const pending = new Map<number, { reply: MessagePort; reject(cause: unknown): void }>();
  let nextId = 0;
  let disposed = false;
  port.onmessage = (event: MessageEvent<TaskServerMessage>) => {
    const entry = pending.get(event.data.id);
    if (entry === undefined) return;
    pending.delete(event.data.id);
    entry.reply.close();
    entry.reject(reviveTaskError(event.data.error));
  };
  return {
    submit<I, O>(kind: string, input: I, options: TaskSubmitOptions = {}): TaskHandle<O> {
      const id = nextId++;
      let resolve!: (value: O) => void;
      let reject!: (cause: unknown) => void;
      const result = new Promise<O>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const cancel = (): boolean => {
        const entry = pending.get(id);
        if (entry === undefined) return false;
        pending.delete(id);
        entry.reply.close();
        try {
          port.postMessage({ t: 'cancel', id } satisfies TaskClientMessage);
        } catch {
          // The dispatcher is gone; nothing remains to withdraw.
        }
        entry.reject(taskAbortError());
        return true;
      };
      if (disposed) {
        reject(new Error('task client disposed'));
        return { result, cancel };
      }
      if (options.signal?.aborted) {
        reject(taskAbortError());
        return { result, cancel };
      }
      const channel = new MessageChannel();
      const reply = channel.port1;
      pending.set(id, { reply, reject });
      reply.onmessage = (event: MessageEvent<{ value: unknown }>) => {
        if (!pending.delete(id)) return;
        reply.close();
        resolve(event.data.value as O);
      };
      const transfer = [...(options.transfer ?? [])];
      try {
        port.postMessage(
          {
            t: 'submit',
            id,
            kind,
            input,
            transfer,
            reply: channel.port2,
            ...(options.priority === undefined ? {} : { priority: options.priority }),
            ...(options.debugName === undefined ? {} : { debugName: options.debugName }),
          } satisfies TaskClientMessage,
          [...transfer, channel.port2],
        );
      } catch (cause) {
        pending.delete(id);
        reply.close();
        reject(cause);
      }
      if (options.signal !== undefined) {
        const signal = options.signal;
        const onAbort = () => cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        void result.then(
          () => signal.removeEventListener('abort', onAbort),
          () => signal.removeEventListener('abort', onAbort),
        );
      }
      return { result, cancel };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const reason = new Error('task client disposed');
      for (const entry of pending.values()) {
        entry.reply.close();
        entry.reject(reason);
      }
      pending.clear();
      port.onmessage = null;
      port.close();
    },
  };
}

/** Forward a client's tasks into `executor`; returns the release. */
export function serveTaskClient(port: TaskPortLike, executor: TaskExecutor): () => void {
  const handles = new Map<number, TaskHandle<unknown>>();
  port.onmessage = (event: MessageEvent<TaskClientMessage>) => {
    const message = event.data;
    if (message.t === 'cancel') {
      handles.get(message.id)?.cancel();
      return;
    }
    const handle = executor.submit<unknown, unknown>(message.kind, message.input, {
      transfer: message.transfer,
      replyTo: message.reply,
      ...(message.priority === undefined ? {} : { priority: message.priority }),
      ...(message.debugName === undefined ? {} : { debugName: message.debugName }),
    });
    handles.set(message.id, handle);
    handle.result.then(
      () => handles.delete(message.id),
      (cause: unknown) => {
        handles.delete(message.id);
        try {
          port.postMessage({
            t: 'fail',
            id: message.id,
            error: cloneableTaskError(cause),
          } satisfies TaskServerMessage);
        } catch {
          // The client is gone.
        }
      },
    );
  };
  return () => {
    port.onmessage = null;
    for (const handle of handles.values()) handle.cancel();
    handles.clear();
    port.close();
  };
}
