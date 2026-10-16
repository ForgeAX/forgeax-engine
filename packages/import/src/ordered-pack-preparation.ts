/** Refill idle lanes while retaining at most two windows of unpublished products. */
export async function* orderedPackPreparation<T, R>(
  inputs: readonly T[],
  concurrency: number,
  prepare: (input: T) => Promise<R>,
  fatal: (value: R) => boolean,
): AsyncGenerator<PromiseSettledResult<R>> {
  const pending = new Map<number, Promise<PromiseSettledResult<R>>>();
  let next = 0;
  let consumed = 0;
  let active = 0;
  let stopped = false;
  const window = concurrency === 1 ? 1 : 2 * concurrency;
  const fill = (): void => {
    while (!stopped && active < concurrency && next < inputs.length && next - consumed < window) {
      const index = next++;
      active++;
      const task = Promise.resolve()
        .then(() => prepare(inputs[index] as T))
        .then(
          (value): PromiseSettledResult<R> => {
            if (fatal(value)) stopped = true;
            return { status: 'fulfilled', value };
          },
          (reason: unknown): PromiseSettledResult<R> => {
            stopped = true;
            return { status: 'rejected', reason };
          },
        )
        .then((outcome) => {
          active--;
          fill();
          return outcome;
        });
      pending.set(index, task);
    }
  };
  fill();
  try {
    while (consumed < next) {
      const task = pending.get(consumed);
      if (task === undefined) throw new Error('missing admitted Pack preparation');
      const outcome = await task;
      // Publication by the consumer finishes before the window advances.
      yield outcome;
      pending.delete(consumed++);
      fill();
    }
  } finally {
    stopped = true;
    // No background work may outlive an error return or cache-write failure.
    await Promise.all(pending.values());
  }
}
