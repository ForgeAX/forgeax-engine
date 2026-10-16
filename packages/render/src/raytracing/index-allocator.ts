/** Half-open tile, row or word index run. */
export interface IndexRun {
  readonly first: number;
  readonly end: number;
}

/**
 * Fixed-capacity run allocator over `[0, capacity)`: first fit over freed runs,
 * then append at the high-water mark `end`, which never shrinks. `undefined`
 * means the run does not fit; the caller then rebuilds with a larger capacity.
 */
export interface IndexAllocator {
  readonly capacity: number;
  /** High-water mark: every index ever allocated is below it. */
  readonly end: number;
  allocate(count: number): IndexRun | undefined;
  free(run: IndexRun): void;
}

export function createIndexAllocator(capacity: number, end = 0): IndexAllocator {
  if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(end) || end < 0 || end > capacity)
    throw new Error('index allocator requires 0 <= end <= capacity');
  let high = end;
  let holes: { first: number; end: number }[] = [];
  return {
    capacity,
    get end() {
      return high;
    },
    allocate(count) {
      if (!Number.isSafeInteger(count) || count < 1) return undefined;
      const hole = holes.findIndex((run) => run.end - run.first >= count);
      const found = holes[hole];
      if (found !== undefined) {
        const run = { first: found.first, end: found.first + count };
        if (run.end === found.end) holes.splice(hole, 1);
        else found.first = run.end;
        return run;
      }
      if (high + count > capacity) return undefined;
      const run = { first: high, end: high + count };
      high = run.end;
      return run;
    },
    free(run) {
      if (run.end <= run.first) return;
      if (run.first < 0 || run.end > high) throw new Error('freed run lies outside the allocation');
      const sorted = [...holes, { ...run }].sort((a, b) => a.first - b.first);
      holes = [];
      for (const next of sorted) {
        const last = holes[holes.length - 1];
        if (last !== undefined && next.first < last.end)
          throw new Error('freed run overlaps a free run');
        if (last !== undefined && next.first === last.end) last.end = next.end;
        else holes.push(next);
      }
    },
  };
}
