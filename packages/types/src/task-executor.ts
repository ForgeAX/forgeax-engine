/**
 * Asynchronous task execution contract. A task kind names a registered module;
 * functions never cross realms, only the kind name, the input and its result.
 * Executors may run tasks on pooled Workers or inline in the submitting realm;
 * callers observe the same results and cancellation semantics either way.
 */

/** Dispatch order: critical before normal before background, FIFO within one. */
export type TaskPriority = 'critical' | 'normal' | 'background';

/**
 * An object whose ownership `postMessage` can move (ArrayBuffer, MessagePort,
 * ImageBitmap, ...). Named structurally so the contract needs no DOM library.
 */
export type TaskTransferable = object;

/**
 * The part of a MessagePort that a task reply uses. Worker executors transfer
 * the port, so callers pass a real MessagePort.
 */
export interface TaskReplyPort {
  postMessage(message: unknown, transfer: TaskTransferable[]): void;
  close(): void;
}

export interface TaskSubmitOptions {
  readonly priority?: TaskPriority;
  /**
   * Input objects whose ownership moves with the task. Inline executors leave
   * them attached, so callers must not reuse transferred memory either way.
   */
  readonly transfer?: readonly TaskTransferable[];
  /** Aborting is equivalent to `cancel()`. */
  readonly signal?: AbortSignal;
  /**
   * Deliver the value as `{ value }` on this port instead of through `result`;
   * `result` then resolves to `undefined` once the value has been posted.
   * Failures still reject `result`.
   */
  readonly replyTo?: TaskReplyPort;
  readonly debugName?: string;
}

export interface TaskHandle<O> {
  readonly result: Promise<O>;
  /**
   * Rejects `result` with an `AbortError` unless it has already settled.
   * Returns true when the task was withdrawn before it started; a task that is
   * already running finishes in the background and its value is discarded.
   */
  cancel(): boolean;
}

export interface TaskExecutor {
  submit<I, O>(kind: string, input: I, options?: TaskSubmitOptions): TaskHandle<O>;
}

/** A task's value plus the objects whose ownership moves back with it. */
export interface TaskResult<O> {
  readonly value: O;
  readonly transfer?: readonly TaskTransferable[];
}

export interface TaskContext {
  /** Set once the task has been cancelled; long tasks may stop early. */
  readonly aborted: boolean;
  /**
   * Cooperative checkpoint. Resolves immediately while the current time slice
   * has budget left, otherwise yields to the realm's event loop first.
   */
  yield(): Promise<void>;
}

export interface TaskInitContext<S> {
  /** The value produced once by `shared()` in the dispatching realm. */
  readonly shared: S | undefined;
}

/**
 * One task kind. `shared` runs once where tasks are dispatched and its value
 * (for example a compiled WebAssembly.Module) is cloned to each executing realm;
 * `init` runs once per executing realm before its first `run`.
 */
export interface TaskModule<I, O, S = unknown> {
  shared?(): S | undefined | Promise<S | undefined>;
  init?(context: TaskInitContext<S>): void | Promise<void>;
  run(input: I, context: TaskContext): TaskResult<O> | Promise<TaskResult<O>>;
}

/** Built-in kinds are registered statically so every realm resolves them alike. */
export interface TaskKindRegistration {
  // biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous kinds.
  readonly load: () => TaskModule<any, any, any> | Promise<TaskModule<any, any, any>>;
  /** Upper bound on simultaneously running tasks of this kind. */
  readonly maxInFlight?: number;
  /** Fail when the pool cannot execute this kind in a Worker. */
  readonly workerOnly?: boolean;
}

export type TaskRegistry = Readonly<Record<string, TaskKindRegistration>>;

/** The rejection reason of a cancelled task. */
export function taskAbortError(message = 'task cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
