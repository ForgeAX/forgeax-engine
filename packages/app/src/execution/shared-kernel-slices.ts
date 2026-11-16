import type { QueryDescriptor, QuerySpan } from '@forgeax/engine-ecs';
import type {
  KernelDispatchFailure,
  KernelDispatchResult,
  KernelDispatchSpan,
  SharedKernelDispatch,
  SharedKernelExecutor,
  SharedSpanBinding,
} from '@forgeax/engine-ecs/shared';
import { bindSharedSpan, isSharedSpan, sliceSharedSpan } from '@forgeax/engine-ecs/shared';
import type { SliceModule, SliceRegistry, TaskPool } from '@forgeax/engine-platform';

/** Slice kind that runs SharedKernel rows on the task pool. */
export const SHARED_KERNEL_SLICES = 'ecs.shared-kernel';

/** One slice job: row ranges over unsplit span bindings. */
export interface SharedKernelSliceInput {
  readonly moduleUrl: string;
  readonly spans: readonly SharedSpanBinding[];
  /** Triples of span index, first row, end row. */
  readonly ranges: Int32Array;
}

export interface LoadedKernel {
  readonly queries: readonly QueryDescriptor[];
  readonly run: (spans: readonly QuerySpan[]) => unknown;
}

export type KernelLoader = (moduleUrl: string) => Promise<LoadedKernel>;

export const importKernel: KernelLoader = async (moduleUrl) => {
  const module = await import(/* @vite-ignore */ moduleUrl);
  const candidate = (module.default ?? module) as { run?: unknown; queries?: unknown };
  if (typeof candidate.run !== 'function') {
    throw new TypeError('SharedKernel module default export has no run function.');
  }
  if (!Array.isArray(candidate.queries))
    throw new TypeError('SharedKernel module default export has no query declarations.');
  return candidate as LoadedKernel;
};

export function spanFromBinding(kernel: LoadedKernel, binding: SharedSpanBinding): QuerySpan {
  const query = kernel.queries[binding.queryIndex];
  if (query === undefined) throw new Error(`Missing kernel query ${binding.queryIndex}.`);
  return {
    entities: binding.entities,
    length: binding.length,
    tableId: -1,
    rowStart: 0,
    get(component) {
      const fields = binding.read[query.read?.indexOf(component) ?? -1];
      if (fields === undefined)
        throw new Error(`Kernel read access is not declared for ${component.name}.`);
      return fields as never;
    },
    mut(component) {
      const fields = binding.write[query.write?.indexOf(component) ?? -1];
      if (fields === undefined)
        throw new Error(`Kernel write access is not declared for ${component.name}.`);
      return fields as never;
    },
  };
}

/** Run one slice: the kernel sees exactly that row range as its only span. */
export function runKernelSlice(
  kernel: LoadedKernel,
  input: SharedKernelSliceInput,
  index: number,
): void {
  const at = index * 3;
  const binding = input.spans[input.ranges[at] as number] as SharedSpanBinding;
  const span = sliceSharedSpan(
    binding,
    input.ranges[at + 1] as number,
    input.ranges[at + 2] as number,
  );
  const returned = kernel.run([spanFromBinding(kernel, span)]);
  if (returned instanceof Promise) throw new TypeError('SharedKernel run must be synchronous.');
}

/** The pool Worker side: modules load once on `prepare`, then serve slices. */
export function createSharedKernelSlices(load: KernelLoader = importKernel): SliceRegistry {
  const loaded = new Map<string, LoadedKernel>();
  const loading = new Map<string, Promise<void>>();
  const module: SliceModule<SharedKernelSliceInput, string> = {
    prepare(moduleUrl) {
      let pending = loading.get(moduleUrl);
      if (pending === undefined) {
        pending = load(moduleUrl).then((kernel) => {
          loaded.set(moduleUrl, kernel);
        });
        pending.catch(() => loading.delete(moduleUrl));
        loading.set(moduleUrl, pending);
      }
      return pending;
    },
    ready: (input) => loaded.has(input.moduleUrl),
    run(input, index) {
      runKernelSlice(loaded.get(input.moduleUrl) as LoadedKernel, input, index);
    },
  };
  return { [SHARED_KERNEL_SLICES]: module };
}

/** Batches per participant when rows allow; more batches even out uneven cores. */
const BATCHES_PER_PARTICIPANT = 6;

/** Row ranges covering every span, in batches of one size across spans. */
export function kernelSliceRanges(
  spans: readonly SharedSpanBinding[],
  participants: number,
): Int32Array {
  const rows = spans.reduce((sum, span) => sum + span.length, 0);
  const batch = Math.max(1, Math.ceil(rows / (participants * BATCHES_PER_PARTICIPANT)));
  const ranges: number[] = [];
  for (const [index, span] of spans.entries()) {
    for (let start = 0; start < span.length; start += batch) {
      ranges.push(index, start, Math.min(start + batch, span.length));
    }
  }
  return Int32Array.from(ranges);
}

export interface SharedKernelSliceExecutor extends SharedKernelExecutor {
  /** Settles once every warmed module loaded; rejects on the first that failed. */
  ready(): Promise<void>;
  takeLastDispatch(): KernelDispatchResult | null;
  /** Forget every preflighted module; later dispatches run inline. */
  dispose(): void;
}

export interface SharedKernelSliceExecutorOptions {
  readonly pool: () => TaskPool;
  readonly load?: KernelLoader;
  /** How long a dispatch waits for Workers once the caller ran out of rows. Default 5 s. */
  readonly timeoutMs?: number;
  /** Budget for module preflight, from executor creation; null waits indefinitely. Default 5 s. */
  readonly startupTimeoutMs?: number | null;
  readonly now?: () => number;
}

interface Preflight {
  kernel: LoadedKernel | undefined;
  readonly settled: Promise<void>;
}

const FORCED_INLINE: KernelDispatchResult = Object.freeze({
  mode: 'forced-inline',
  dispatched: 0,
  completed: 0,
  waitMs: 0,
});

function forcedInline(message: string): KernelDispatchFailure {
  return { cause: new Error(message), dispatched: 0, completed: 0, partialWrite: false };
}

/**
 * SharedKernel dispatch over the task pool. Each frame's rows are cut into
 * slices that this realm and every started pool Worker claim from one cursor;
 * this realm blocks until all slices finished.
 */
export function createSharedKernelSliceExecutor(
  options: SharedKernelSliceExecutorOptions,
): SharedKernelSliceExecutor {
  const load = options.load ?? importKernel;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? (() => performance.now());
  const preflights = new Map<string, Preflight>();
  let latest: KernelDispatchResult | null = null;
  const startupTimeoutMs =
    options.startupTimeoutMs === undefined ? timeoutMs : options.startupTimeoutMs;
  const startupDeadline = startupTimeoutMs === null ? null : now() + startupTimeoutMs;

  /** One preflight, bounded by the startup deadline shared by all of them. */
  const settle = async (moduleUrl: string, preflight: Preflight): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline =
      startupDeadline === null
        ? []
        : [
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `SharedKernel module preflight for ${moduleUrl} did not complete within ${startupTimeoutMs}ms.`,
                    ),
                  ),
                Math.max(0, startupDeadline - now()),
              );
            }),
          ];
    try {
      await Promise.race([
        preflight.settled.catch((cause: unknown) => {
          throw new Error(`SharedKernel module preflight failed for ${moduleUrl}.`, { cause });
        }),
        ...deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const preflighted = (moduleUrl: string): LoadedKernel | KernelDispatchFailure => {
    const preflight = preflights.get(moduleUrl);
    if (preflight === undefined)
      return forcedInline('SharedKernel module was not preflighted before frame dispatch.');
    if (preflight.kernel === undefined)
      return forcedInline('SharedKernel module preflight is incomplete or failed.');
    return preflight.kernel;
  };

  const dispatch = (
    kernel: LoadedKernel,
    moduleUrl: string,
    bindings: readonly SharedSpanBinding[],
    pool: TaskPool,
  ): KernelDispatchResult | KernelDispatchFailure => {
    const started = now();
    const input: SharedKernelSliceInput = {
      moduleUrl,
      spans: bindings,
      ranges: kernelSliceRanges(bindings, pool.sliceHelpers + 1),
    };
    const outcome = pool.parallelFor({
      kind: SHARED_KERNEL_SLICES,
      input,
      count: input.ranges.length / 3,
      run: (index) => runKernelSlice(kernel, input, index),
      timeoutMs,
    });
    const { count, completed } = outcome;
    if (outcome.timedOut) {
      const cause = new Error(`SharedKernel deadline exceeded after ${timeoutMs}ms.`);
      return { cause, dispatched: count, completed, partialWrite: true };
    }
    if (outcome.failed > 0) {
      const cause = outcome.failure ?? new Error('SharedKernel worker failed.');
      return { cause, dispatched: count, completed, partialWrite: true };
    }
    const mode = outcome.helpers > 0 ? 'shared' : 'forced-inline';
    latest = { mode, dispatched: count, completed, waitMs: now() - started };
    return latest;
  };

  const executor: SharedKernelSliceExecutor = {
    warmup(kernel: SharedKernelDispatch): void {
      const { moduleUrl } = kernel;
      if (preflights.has(moduleUrl)) return;
      const preflight: Preflight = {
        kernel: undefined,
        settled: load(moduleUrl).then((loaded) => {
          preflight.kernel = loaded;
        }),
      };
      preflight.settled.catch(() => {});
      preflights.set(moduleUrl, preflight);
      options.pool().prepareSlices(SHARED_KERNEL_SLICES, moduleUrl);
    },
    async ready(): Promise<void> {
      for (const [moduleUrl, preflight] of preflights) await settle(moduleUrl, preflight);
    },
    takeLastDispatch(): KernelDispatchResult | null {
      const result = latest;
      latest = null;
      return result;
    },
    dispose(): void {
      preflights.clear();
      latest = null;
    },
    execute(
      kernel: SharedKernelDispatch,
      spans: readonly KernelDispatchSpan[],
    ): KernelDispatchResult | KernelDispatchFailure {
      latest = FORCED_INLINE;
      const loaded = preflighted(kernel.moduleUrl);
      if (!('run' in loaded)) {
        if (!preflights.has(kernel.moduleUrl)) executor.warmup?.(kernel);
        return loaded;
      }
      const pool = options.pool();
      if (pool.sliceHelpers === 0)
        return forcedInline('SharedKernel workers were not warmed before frame dispatch.');
      const bindings = spans
        .map(({ queryIndex, span }) => bindSharedSpan(kernel, span, queryIndex))
        .filter((binding) => binding.length > 0);
      if (bindings.length === 0) return FORCED_INLINE;
      if (!bindings.every(isSharedSpan))
        return forcedInline('SharedKernel received a non-SAB QuerySpan.');
      return dispatch(loaded, kernel.moduleUrl, bindings, pool);
    },
  };
  return executor;
}
