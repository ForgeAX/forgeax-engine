import { defineComponent, World } from '@forgeax/engine-ecs';
import { defineSharedKernel, type KernelDispatchSpan } from '@forgeax/engine-ecs/shared';
import { describe, expect, it, vi } from 'vitest';
import { createKernelPool } from '../execution/kernel-pool';

const Position = defineComponent('ExecutionKernelPosition', { x: 'f32' });

function runPositionKernel(spans: readonly import('@forgeax/engine-ecs').QuerySpan[]): void {
  for (const span of spans) {
    const position = span.mut(Position);
    for (let index = 0; index < span.length; index += 1) {
      position.x[index] = (position.x[index] ?? 0) + 2;
    }
  }
}

const kernel = defineSharedKernel('https://example.test/position-kernel.mjs', {
  name: 'execution-position-kernel',
  queries: [{ write: [Position] }],
  minimumRows: 1,
  run: runPositionKernel,
});

interface TestMessage {
  readonly kind: 'kernel-init' | 'kernel-preload' | 'kernel-job';
  readonly ready?: Int32Array;
  readonly control?: Int32Array;
  readonly status?: Int32Array;
  readonly jobIndex?: number;
}

interface TestJob {
  readonly kind: 'kernel-job';
  readonly binding: {
    readonly length: number;
    readonly write: Readonly<Record<string, Readonly<Record<string, Float32Array>>>>;
  };
  readonly control: Int32Array;
  readonly status: Int32Array;
  readonly jobIndex: number;
}

function sharedDispatchSpans(): {
  readonly world: World;
  readonly spans: readonly KernelDispatchSpan[];
} {
  const world = new World({ storage: 'shared' });
  for (let index = 0; index < 8; index += 1) {
    world.spawn({ component: Position, data: { x: index } }).unwrap();
  }
  const query = world.query({ write: [Position] }).unwrap();
  return {
    world,
    spans: [...query.spans().unwrap()].map((span) => ({ queryIndex: 0, span })),
  };
}

function workerFactory(run: (job: TestJob) => void, preloadStatus = 1): () => Worker {
  return () =>
    ({
      postMessage(message: TestMessage): void {
        if (message.kind === 'kernel-init' && message.ready !== undefined) {
          Atomics.add(message.ready, 0, 1);
          Atomics.notify(message.ready, 0);
          return;
        }
        if (
          message.kind === 'kernel-preload' &&
          message.control !== undefined &&
          message.status !== undefined &&
          message.jobIndex !== undefined
        ) {
          Atomics.store(message.status, message.jobIndex, preloadStatus);
          Atomics.add(message.control, 0, 1);
          Atomics.notify(message.control, 0);
          return;
        }
        run(message as TestJob);
        Atomics.add(message.control as Int32Array, 0, 1);
        Atomics.notify(message.control as Int32Array, 0);
      },
      terminate(): void {},
    }) as unknown as Worker;
}

describe('shared kernel pool', () => {
  it('honors the startup budget without extending the running kernel deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const terminate = vi.fn();
    const options = {
      lanes: 1,
      timeoutMs: 5,
      startupTimeoutMs: 50,
      workerFactory: () => {
        const lane = workerFactory(() => {})();
        return {
          postMessage(message: TestMessage) {
            if (message.kind !== 'kernel-job')
              setTimeout(() => lane.postMessage(message), message.kind === 'kernel-init' ? 10 : 15);
          },
          terminate,
        } as unknown as Worker;
      },
    };
    const pool = createKernelPool(options);
    const ready = pool.ready().then(
      () => null,
      (cause: unknown) => cause,
    );
    try {
      pool.warmup?.(kernel);
      await vi.advanceTimersByTimeAsync(20);
      expect(await ready).toBeNull();
      const { spans } = sharedDispatchSpans();
      const result = pool.execute(kernel, spans);
      expect(result).toMatchObject({ dispatched: 1, completed: 0, partialWrite: true });
      if (!('cause' in result)) throw new Error('stalled dispatch was accepted');
      expect(String(result.cause)).toContain('deadline exceeded after 5ms');
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      pool.dispose();
      vi.useRealTimers();
    }
  });

  it('shares one startup deadline across initialization and module preflight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const terminate = vi.fn();
    const options = {
      lanes: 1,
      timeoutMs: 5,
      startupTimeoutMs: 50,
      workerFactory: () => {
        const lane = workerFactory(() => {})();
        return {
          postMessage(message: TestMessage) {
            if (message.kind === 'kernel-init') setTimeout(() => lane.postMessage(message), 40);
          },
          terminate,
        } as unknown as Worker;
      },
    };
    const pool = createKernelPool(options);
    const ready = pool.ready().then(
      () => null,
      (cause: unknown) => cause,
    );
    try {
      pool.warmup?.(kernel);
      await vi.advanceTimersByTimeAsync(50);
      expect(String(await ready)).toContain('SharedKernel module preflight');
      expect(String(await ready)).toContain('within 50ms');
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      pool.dispose();
      vi.useRealTimers();
    }
  });

  it('joins a lane that completes between the counter observation and the wait', () => {
    const { spans } = sharedDispatchSpans();
    let control: Int32Array | undefined;
    const pool = createKernelPool({
      lanes: 1,
      timeoutMs: 10,
      workerFactory: workerFactory((job) => {
        control = job.control;
        Atomics.store(job.status, job.jobIndex, 1);
      }),
    });
    pool.warmup?.(kernel);
    const load = Atomics.load;
    let raced = false;
    const observation = vi.spyOn(Atomics, 'load').mockImplementation(((
      array: Int32Array,
      index: number,
    ) => {
      const value = load(array, index);
      if (array === control && !raced) {
        raced = true;
        // Model a read of zero immediately before the final lane publishes one.
        // Keep the real shared counter and Atomics.wait: waiting on one has no
        // future notifier, whereas waiting on the observed zero is not-equal.
        return value - 1;
      }
      return value;
    }) as typeof Atomics.load);
    try {
      expect(pool.execute(kernel, spans)).toMatchObject({
        mode: 'shared',
        dispatched: 1,
        completed: 1,
      });
      expect(raced).toBe(true);
    } finally {
      observation.mockRestore();
      pool.dispose();
    }
  });

  it('shards SAB spans without copying and joins all lanes', () => {
    const { world, spans } = sharedDispatchSpans();
    const pool = createKernelPool({
      lanes: 2,
      workerFactory: workerFactory((job) => {
        const x = job.binding.write.ExecutionKernelPosition?.x;
        if (x === undefined) throw new Error('position binding missing');
        for (let index = 0; index < job.binding.length; index += 1) {
          x[index] = (x[index] ?? 0) + 2;
        }
        Atomics.store(job.status, job.jobIndex, 1);
      }),
    });
    pool.warmup?.(kernel);

    const result = pool.execute(kernel, spans);
    expect(result).toMatchObject({ mode: 'shared', dispatched: 2, completed: 2 });
    expect(pool.takeLastDispatch()).toEqual(result);
    expect(pool.takeLastDispatch()).toBeNull();
    expect(
      Array.from(world.query({ read: [Position] }).unwrap(), (row) => row.get(Position).x),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    pool.dispose();
  });

  it('reports a partial write when one lane fails after another completes', () => {
    const { spans } = sharedDispatchSpans();
    const pool = createKernelPool({
      lanes: 2,
      workerFactory: workerFactory((job) => {
        Atomics.store(job.status, job.jobIndex, job.jobIndex === 0 ? 1 : -1);
      }),
    });
    pool.warmup?.(kernel);

    expect(pool.execute(kernel, spans)).toMatchObject({
      dispatched: 2,
      completed: 1,
      partialWrite: true,
    });
    pool.dispose();
  });

  it('fails a non-responsive lane at the bounded Atomics deadline', () => {
    const { spans } = sharedDispatchSpans();
    const pool = createKernelPool({
      lanes: 1,
      timeoutMs: 1,
      workerFactory: () =>
        ({
          postMessage(message: TestMessage): void {
            if (message.kind === 'kernel-init' && message.ready !== undefined) {
              Atomics.add(message.ready, 0, 1);
              Atomics.notify(message.ready, 0);
            }
            if (
              message.kind === 'kernel-preload' &&
              message.control !== undefined &&
              message.status !== undefined &&
              message.jobIndex !== undefined
            ) {
              Atomics.store(message.status, message.jobIndex, 1);
              Atomics.add(message.control, 0, 1);
              Atomics.notify(message.control, 0);
            }
          },
          terminate(): void {},
        }) as unknown as Worker,
    });
    pool.warmup?.(kernel);

    expect(pool.execute(kernel, spans)).toMatchObject({
      dispatched: 1,
      completed: 0,
      partialWrite: true,
    });
    pool.dispose();
  });

  it('rejects an invalid module during readiness before any kernel dispatch', async () => {
    let dispatched = false;
    const pool = createKernelPool({
      lanes: 1,
      workerFactory: workerFactory(() => {
        dispatched = true;
      }, -1),
    });
    pool.warmup?.(kernel);

    await expect(pool.ready()).rejects.toThrow('module preflight failed');
    expect(dispatched).toBe(false);
    pool.dispose();
  });
});
