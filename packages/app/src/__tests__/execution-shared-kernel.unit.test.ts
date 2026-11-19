import { defineComponent, type QuerySpan, World } from '@forgeax/engine-ecs';
import {
  bindSharedSpan,
  defineSharedKernel,
  type KernelDispatchSpan,
} from '@forgeax/engine-ecs/shared';
import {
  createTaskPool,
  serveTaskWorker,
  type TaskPool,
  type TaskPoolToWorkerMessage,
  type TaskWorkerFactory,
} from '@forgeax/engine-platform';
import { describe, expect, it, vi } from 'vitest';
import {
  createSharedKernelSliceExecutor,
  createSharedKernelSlices,
  type KernelLoader,
  kernelSliceRanges,
  spanFromBinding,
} from '../execution/shared-kernel-slices';

const Position = defineComponent('ExecutionKernelPosition', { x: 'f32' });

function runPositionKernel(spans: readonly QuerySpan[]): void {
  for (const span of spans) {
    const position = span.mut(Position);
    for (let index = 0; index < span.length; index += 1) {
      position.x[index] = (position.x[index] ?? 0) * 3 + 2;
    }
  }
}

const MODULE_URL = 'https://example.test/position-kernel.mjs';
const kernel = defineSharedKernel(MODULE_URL, {
  name: 'execution-position-kernel',
  queries: [{ write: [Position] }],
  minimumRows: 1,
  run: runPositionKernel,
});

const loadPosition: KernelLoader = async () => ({
  queries: kernel.queries,
  run: runPositionKernel,
});
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it('binds same-label columns through Worker-local declarations and rejects foreign components', () => {
  const First = defineComponent('SameSliceComponent', { x: 'f32' });
  const Second = defineComponent('SameSliceComponent', { x: 'f32' });
  const LocalFirst = defineComponent('SameSliceComponent', { x: 'f32' });
  const LocalSecond = defineComponent('SameSliceComponent', { x: 'f32' });
  const world = new World({ storage: 'shared' });
  world
    .spawn({ component: First, data: { x: 3 } }, { component: Second, data: { x: 30 } })
    .unwrap();
  const descriptor = { write: [First, Second] };
  const host = defineSharedKernel(MODULE_URL, {
    name: 'same-label',
    queries: [descriptor],
    run() {},
  });
  const source = [...world.query(descriptor).unwrap().spans().unwrap()][0];
  if (source === undefined) throw new Error('Missing source span');
  const local = { queries: [{ write: [LocalFirst, LocalSecond] }], run() {} };
  const span = spanFromBinding(local, bindSharedSpan(host, source, 0));
  expect(Array.from(span.mut(LocalFirst).x)).toEqual([3]);
  expect(Array.from(span.mut(LocalSecond).x)).toEqual([30]);
  expect(() => span.mut(First)).toThrow('not declared');
  expect(() => span.get(LocalFirst)).toThrow('not declared');
});

function sharedDispatchSpans(rows = 8): {
  readonly world: World;
  readonly spans: readonly KernelDispatchSpan[];
} {
  const world = new World({ storage: 'shared' });
  for (let index = 0; index < rows; index += 1) {
    world.spawn({ component: Position, data: { x: index } }).unwrap();
  }
  const query = world.query({ write: [Position] }).unwrap();
  return {
    world,
    spans: [...query.spans().unwrap()].map((span) => ({ queryIndex: 0, span })),
  };
}

const positions = (world: World): number[] =>
  Array.from(world.query({ read: [Position] }).unwrap(), (row) => row.get(Position).x);

/**
 * Pool Workers served by the real Worker runtime in this realm. Messages are
 * delivered synchronously, so a Worker joins a slice job inside the caller's
 * post — before the caller claims anything.
 */
function servedPool(
  workers: number,
  load: KernelLoader = loadPosition,
): { pool: TaskPool; posted: TaskPoolToWorkerMessage[] } {
  const posted: TaskPoolToWorkerMessage[] = [];
  const factory: TaskWorkerFactory = (listener) => {
    const port = {
      onmessage: null as ((event: MessageEvent<TaskPoolToWorkerMessage>) => void) | null,
      postMessage: (data: unknown) => queueMicrotask(() => listener.message(data as never)),
    };
    serveTaskWorker(port, {}, { slices: createSharedKernelSlices(load) });
    return {
      postMessage: (message) => {
        posted.push(message);
        port.onmessage?.({ data: message } as MessageEvent<TaskPoolToWorkerMessage>);
      },
      terminate: () => {},
    };
  };
  return { pool: createTaskPool({ kinds: {}, workerFactory: factory, workers }), posted };
}

async function warmed(workers: number, load?: KernelLoader) {
  const { pool, posted } = servedPool(workers, load);
  const executor = createSharedKernelSliceExecutor({ pool: () => pool, load: loadPosition });
  executor.warmup?.(kernel);
  await executor.ready();
  for (let tick = 0; tick < 8; tick += 1) await flush();
  return { pool, posted, executor };
}

describe('shared kernel slices', () => {
  it('sizes batches for six per participant without crossing spans', () => {
    const ranges = kernelSliceRanges([{ length: 100 } as never, { length: 7 } as never], 3);
    // ceil(107 / 18) = 6 rows per batch.
    expect(Array.from(ranges.subarray(0, 6))).toEqual([0, 0, 6, 0, 6, 12]);
    expect(Array.from(ranges.subarray(ranges.length - 6))).toEqual([1, 0, 6, 1, 6, 7]);
    let covered = 0;
    for (let at = 0; at < ranges.length; at += 3)
      covered += (ranges[at + 2] ?? 0) - (ranges[at + 1] ?? 0);
    expect(covered).toBe(107);
  });

  it('slices rows across the caller and every pool Worker with output identical to one run', async () => {
    const reference = sharedDispatchSpans(1000);
    runPositionKernel(reference.spans.map(({ span }) => span));
    const expected = positions(reference.world);

    const { pool, posted, executor } = await warmed(2);
    expect(pool.sliceHelpers).toBe(2);
    const { world, spans } = sharedDispatchSpans(1000);
    const result = executor.execute(kernel, spans);
    expect(result).toMatchObject({ mode: 'shared', dispatched: 18, completed: 18 });
    expect(executor.takeLastDispatch()).toEqual(result);
    expect(executor.takeLastDispatch()).toBeNull();
    expect(positions(world)).toEqual(expected);
    // Each Worker was prepared once, then received this one job.
    expect(posted.filter((message) => message.t === 'prepare')).toHaveLength(2);
    expect(posted.filter((message) => message.t === 'slices')).toHaveLength(2);
    executor.dispose();
    pool.dispose();
  });

  it('runs every slice in this realm when no Worker is ready for the module', async () => {
    const { pool, executor } = await warmed(1, () => new Promise(() => {}));
    const { world, spans } = sharedDispatchSpans();
    expect(executor.execute(kernel, spans)).toMatchObject({
      mode: 'shared',
      dispatched: 8,
      completed: 8,
    });
    expect(positions(world)).toEqual([2, 5, 8, 11, 14, 17, 20, 23]);
    pool.dispose();
  });

  it('forces inline dispatch before preflight or before any Worker started', async () => {
    const { pool } = servedPool(1);
    const executor = createSharedKernelSliceExecutor({ pool: () => pool, load: loadPosition });
    const { spans } = sharedDispatchSpans();
    const early = executor.execute(kernel, spans);
    expect(String((early as { cause: unknown }).cause)).toContain('not preflighted');
    expect(early).toMatchObject({ partialWrite: false });
    await executor.ready();
    const cold = createSharedKernelSliceExecutor({
      pool: () => createTaskPool({ kinds: {} }),
      load: loadPosition,
    });
    cold.warmup?.(kernel);
    await cold.ready();
    expect(String((cold.execute(kernel, spans) as { cause: unknown }).cause)).toContain(
      'workers were not warmed',
    );
    pool.dispose();
  });

  it('joins a slice that finishes between the counter observation and the wait', async () => {
    const { pool, posted, executor } = await warmed(1);
    const { spans } = sharedDispatchSpans();
    const load = Atomics.load;
    let raced = false;
    const observation = vi.spyOn(Atomics, 'load').mockImplementation(((
      array: Int32Array,
      index: number,
    ) => {
      const value = load(array, index);
      const job = posted.findLast((message) => message.t === 'slices') as
        | { control: Int32Array }
        | undefined;
      if (array === job?.control && index === 1 && !raced) {
        raced = true;
        // A read one short of the total immediately before the last finisher
        // publishes: waiting on the real counter would have no notifier left.
        return value - 1;
      }
      return value;
    }) as typeof Atomics.load);
    try {
      expect(executor.execute(kernel, spans)).toMatchObject({ mode: 'shared', completed: 8 });
      expect(raced).toBe(true);
    } finally {
      observation.mockRestore();
      pool.dispose();
    }
  });

  it('reports a partial write when one slice fails after others completed', async () => {
    let calls = 0;
    const failing: KernelLoader = async () => ({
      queries: kernel.queries,
      run: (spans) => {
        if (++calls === 2) throw new Error('row failure');
        runPositionKernel(spans);
      },
    });
    const { pool } = servedPool(1, failing);
    const executor = createSharedKernelSliceExecutor({ pool: () => pool, load: failing });
    executor.warmup?.(kernel);
    await executor.ready();
    for (let tick = 0; tick < 8; tick += 1) await flush();
    const { spans } = sharedDispatchSpans();
    const result = executor.execute(kernel, spans);
    expect(result).toMatchObject({ dispatched: 8, completed: 7, partialWrite: true });
    expect(executor.takeLastDispatch()).toMatchObject({ mode: 'forced-inline' });
    pool.dispose();
  });

  it('fails at the deadline and replaces only the Worker still holding a slice', async () => {
    const terminate = vi.fn();
    const factory: TaskWorkerFactory = (listener) => {
      queueMicrotask(() => listener.message({ t: 'ready' }));
      return {
        postMessage: (message) => {
          if (message.t !== 'slices') return;
          // Claim one slice and never finish it.
          const index = Atomics.add(message.control, 0, 1);
          Atomics.store(message.control, 2 + index, message.owner);
        },
        terminate,
      };
    };
    const pool = createTaskPool({ kinds: {}, workerFactory: factory, workers: 1 });
    const executor = createSharedKernelSliceExecutor({
      pool: () => pool,
      load: loadPosition,
      timeoutMs: 5,
    });
    executor.warmup?.(kernel);
    await executor.ready();
    for (let tick = 0; tick < 8; tick += 1) await flush();
    const { spans } = sharedDispatchSpans();
    const result = executor.execute(kernel, spans);
    expect(result).toMatchObject({ dispatched: 8, completed: 7, partialWrite: true });
    expect(String((result as { cause: unknown }).cause)).toContain('deadline exceeded after 5ms');
    expect(terminate).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it('rejects an invalid module during readiness before any dispatch', async () => {
    const { pool } = servedPool(1);
    const invalid: KernelLoader = async () => {
      throw new TypeError('SharedKernel module default export has no run function.');
    };
    const executor = createSharedKernelSliceExecutor({ pool: () => pool, load: invalid });
    executor.warmup?.(kernel);
    await expect(executor.ready()).rejects.toThrow('module preflight failed');
    const { spans } = sharedDispatchSpans();
    expect(String((executor.execute(kernel, spans) as { cause: unknown }).cause)).toContain(
      'incomplete or failed',
    );
    pool.dispose();
  });

  it('bounds module preflight by the startup budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const pool = createTaskPool({ kinds: {} });
      const executor = createSharedKernelSliceExecutor({
        pool: () => pool,
        load: () => new Promise(() => {}),
        startupTimeoutMs: 50,
      });
      executor.warmup?.(kernel);
      const ready = executor.ready().then(
        () => null,
        (cause: unknown) => cause,
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(String(await ready)).toContain('did not complete within 50ms');
    } finally {
      vi.useRealTimers();
    }
  });
});
